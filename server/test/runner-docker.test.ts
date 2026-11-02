// The pure parts of the Docker runner, without Docker: reading /out with size caps, splitting the log stream,
// and loading the tool catalog.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { describe, expect, test } from 'vitest';
import { CatalogError, inBuildContext, loadCatalog, TOOLS_DIR } from '../src/runner/catalog';
import { demuxLogs, readOutputArchive } from '../src/runner/docker';
import { tempDir } from './helpers';

/** A tar like getArchive('/out') sends: a directory entry, then its files. */
async function archive(files: Record<string, string>, extra: { name: string; type: 'directory' | 'symlink' }[] = []): Promise<Readable> {
  const pack = tar.pack();
  // Read while writing: entries wait for the pack to be drained.
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  });
  const ended = new Promise<void>((resolve) => {
    pack.on('end', () => {
      resolve();
    });
  });
  pack.entry({ name: 'out/', type: 'directory' });
  for (const e of extra) pack.entry({ name: e.name, type: e.type, ...(e.type === 'symlink' ? { linkname: '/etc/passwd' } : {}) });
  for (const [name, content] of Object.entries(files)) pack.entry({ name: `out/${name}` }, content);
  pack.finalize();
  await ended;
  // In 16 KB chunks, like a socket.
  const all = Buffer.concat(chunks);
  const parts: Buffer[] = [];
  for (let i = 0; i < all.length; i += 16_384) parts.push(all.subarray(i, i + 16_384));
  return Readable.from(parts, { objectMode: false });
}

describe('reading /out', () => {
  test('keeps the wanted files, capped, and reports the others with their real sizes', async () => {
    const out = await readOutputArchive(
      await archive({ 'result.json': '{"a":1}', 'raw.txt': 'x'.repeat(100), 'core.dump': 'y'.repeat(70) }, [
        { name: 'out/sub/', type: 'directory' },
        { name: 'out/link', type: 'symlink' },
      ]),
      { files: { 'result.json': 1000, 'raw.txt': 10 }, maxTotalBytes: 1 << 20 },
    );
    expect(out.overLimit).toBe(false);
    expect(out.files.get('result.json')).toEqual({ data: Buffer.from('{"a":1}'), size: 7, truncated: false });
    expect(out.files.get('raw.txt')).toMatchObject({ size: 100, truncated: true });
    expect(out.files.get('raw.txt')?.data.toString()).toBe('x'.repeat(10));
    expect(out.skipped).toEqual(expect.arrayContaining([{ name: 'core.dump', size: 70 }, { name: 'link', size: 0 }]));
  });

  test('a runaway output stops the read at the total cap (what was read before stays)', async () => {
    const out = await readOutputArchive(await archive({ 'result.json': '{}', 'raw.txt': 'z'.repeat(200_000) }), {
      files: { 'result.json': 1000, 'raw.txt': 1000 },
      maxTotalBytes: 50_000,
    });
    expect(out.overLimit).toBe(true);
    expect(out.files.get('result.json')?.data.toString()).toBe('{}');
  });

  test('files in subfolders are not taken for top-level ones', async () => {
    const out = await readOutputArchive(await archive({ 'nested/result.json': '{"evil":1}' }), {
      files: { 'result.json': 1000 },
      maxTotalBytes: 1 << 20,
    });
    expect(out.files.size).toBe(0);
  });
});

describe('logs', () => {
  const frame = (stream: 1 | 2, text: string) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };

  test('splits stdout and stderr and caps each', () => {
    const logs = demuxLogs(Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, 'world')]), 8);
    expect(logs.stdout).toEqual({ text: 'hello wo', size: 11, truncated: true });
    expect(logs.stderr).toEqual({ text: 'oops', size: 4, truncated: false });
  });
});

describe('tool catalog', () => {
  test('the repo tools load: the subdomain group with its four tools, in run order', () => {
    const catalog = loadCatalog();
    expect(catalog.groups.map((g) => g.def.name)).toEqual(['subdomain']);
    expect(catalog.tools().map((t) => t.name)).toEqual(['subfinder', 'assetfinder', 'findomain', 'crtsh']);
    const info = catalog.info('subdomain');
    expect(info?.imageRef).toMatch(/^redwhale-tools\/subdomain:[0-9a-f]{12}$/);
    expect(info?.contextFiles).toEqual(expect.arrayContaining(['.dockerignore', 'validate_output.py', 'lib/redwhale_tool.py', 'subdomain/Dockerfile']));
    expect(info?.contextFiles.some((f) => /fixtures|test_|README|NOTE/.test(f))).toBe(false);
    for (const t of catalog.tools()) expect(t.argv).toContain(`/opt/redwhale/subdomain/${t.name}/run.py`);
  });

  test.each([
    ['subdomain/subfinder/run.py', true],
    ['lib/redwhale_tool.py', true],
    ['subdomain/subfinder/fixtures/raw.jsonl', false],
    ['subdomain/crtsh/test_crtsh.py', false],
    ['subdomain/README.md', false],
    ['lib/__pycache__/x.pyc', false],
  ])('build context: %s → %s', (path, expected) => {
    expect(inBuildContext(path)).toBe(expected);
  });

  function copyTools(): string {
    const dir = join(tempDir(), 'tools');
    cpSync(TOOLS_DIR, dir, { recursive: true });
    return dir;
  }

  test('the image tag follows the scripts, not fixtures or docs', () => {
    const dir = copyTools();
    const before = loadCatalog(dir).imageRef('subdomain');
    mkdirSync(join(dir, 'subdomain/subfinder/fixtures'), { recursive: true });
    writeFileSync(join(dir, 'subdomain/subfinder/fixtures/raw.jsonl'), 'new sample');
    writeFileSync(join(dir, 'subdomain/README.md'), 'changed');
    expect(loadCatalog(dir).imageRef('subdomain')).toBe(before);
    writeFileSync(join(dir, 'lib/redwhale_tool.py'), '# changed');
    expect(loadCatalog(dir).imageRef('subdomain')).not.toBe(before);
  });

  test('inconsistent definitions fail together, each named', () => {
    const dir = copyTools();
    writeFileSync(join(dir, 'subdomain/subfinder/tool.json'), JSON.stringify({ name: 'subfinder2', group: 'ports' }));
    rmSync(join(dir, 'subdomain/crtsh'), { recursive: true });
    mkdirSync(join(dir, 'subdomain/amass'));
    writeFileSync(
      join(dir, 'subdomain/amass/tool.json'),
      JSON.stringify({
        name: 'amass', group: 'subdomain', label: 'amass', mode: 'passive', accepts: ['domain'],
        argv: ['amass', '-d', '{target}'], timeoutSec: 60, external: [], outputDir: '/out',
      }),
    );
    let error: unknown;
    try {
      loadCatalog(dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CatalogError);
    const issues = (error as CatalogError).issues.join('\n');
    expect(issues).toContain('tools/subdomain/subfinder/tool.json');
    expect(issues).toContain("lists 'crtsh', but there is no tools/subdomain/crtsh/tool.json");
    expect(issues).toContain("tools/subdomain/amass has a tool.json but tools/subdomain/group.json doesn't list it");
  });
});
