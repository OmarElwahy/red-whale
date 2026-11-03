// Container spec, hardening and argv building (docs/architecture.md §11): pure, no Docker.
import { describe, expect, test } from 'vitest';
import { toolDefSchema, type ToolDef } from '../src/runner/defs';
import { ArgumentInjection, DEFAULT_LIMITS, buildArgv, containerSpec, safeArgValue } from '../src/runner/spec';
import { ScopeViolation, authorize, type ScopedTarget } from '../src/scope/authorize';
import { addRule } from '../src/scope/store';
import { toolsNetwork } from '../src/runner/network';
import { FakeRuntime } from './fakeRuntime';
import { freshDb } from './helpers';

const DEF: ToolDef = toolDefSchema.parse({
  name: 'subfinder',
  group: 'subdomain',
  label: 'subfinder',
  mode: 'passive',
  accepts: ['domain'],
  argv: ['python3', '-I', '/opt/redwhale/subdomain/subfinder/run.py', '--target', '{target}', '--out', '/out'],
  timeoutSec: 600,
  external: ['many passive sources'],
  outputDir: '/out',
});

function scopedTarget(value = 'example.com', type: 'domain' | 'subdomain' = 'domain'): ScopedTarget {
  const db = freshDb();
  addRule(db, { kind: 'domain', value: 'example.com', action: 'include' });
  addRule(db, { kind: 'wildcard', value: '*.example.com', action: 'include' });
  const result = authorize(db, { type, value }, 'passive');
  if (!result.ok) throw new Error(result.reason);
  return result.target;
}

const spec = (target = scopedTarget()) =>
  containerSpec({ def: DEF, target, image: 'redwhale-tools/subdomain:abc', jobId: 'job-1', workspaceId: 'ws-1' });

describe('tool definitions', () => {
  const base = { ...DEF };
  test.each([
    [{ argv: ['python3', 'run.py'] }, 'exactly once'],
    [{ argv: ['python3', '{target}', '{target}'] }, 'exactly once'],
    [{ argv: ['python3', '--target={target}'] }, 'whole argv item'],
    [{ argv: ['{target}', 'x'] }, 'program'],
    [{ accepts: ['technology'] }, 'accepts'],
    [{ mode: 'loud' }, 'mode'],
    [{ name: 'Sub Finder' }, 'name'],
    [{ outputDir: 'out' }, 'outputDir'],
    [{ extra: true }, 'extra'],
  ])('%j is refused (%s)', (patch, hint) => {
    const result = toolDefSchema.safeParse({ ...base, ...patch });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(hint);
  });
});

describe('argv', () => {
  test('the target is one argv item, the canonical value authorize() judged', () => {
    expect(buildArgv(DEF, scopedTarget('Example.COM.'))).toEqual([
      'python3', '-I', '/opt/redwhale/subdomain/subfinder/run.py', '--target', 'example.com', '--out', '/out',
    ]);
  });

  test('a value that would be read as an option never reaches argv (argument injection)', () => {
    // Layer 1: the scope guard can't even judge it, so it is refused (fails closed) and logged.
    const db = freshDb();
    addRule(db, { kind: 'wildcard', value: '*.example.com', action: 'include' });
    const result = authorize(db, { type: 'subdomain', value: '-oX.example.com' }, 'passive');
    expect(result).toMatchObject({ ok: false, decision: 'out' });
    // Layer 2: the runner refuses it again on its own (safeArgValue is what buildArgv applies to every value).
    expect(() => safeArgValue('-ox.example.com')).toThrow(/starts with "-"/);
  });

  test.each(['-', '--help', '-d', '', 'a b', 'a\tb', 'a\nb', 'a\u0000b'])('safeArgValue refuses %j', (value) => {
    expect(() => safeArgValue(value)).toThrow(ArgumentInjection);
  });

  test.each(['example.com', 'a-b.example.com', '203.0.113.5', 'https://example.com/x?a=-1'])('safeArgValue keeps %j', (v) => {
    expect(safeArgValue(v)).toBe(v);
  });

  test('a forged target is refused before argv is built', () => {
    const real = scopedTarget();
    const forged = { ...real } as typeof real; // a spread is not what authorize() issued
    expect(() => buildArgv(DEF, forged)).toThrow(ScopeViolation);
  });

  test('a target type the tool does not accept is refused', () => {
    expect(() => buildArgv(DEF, scopedTarget('api.example.com', 'subdomain'))).toThrow(/does not accept subdomain/);
  });
});

describe('container hardening', () => {
  test('every option on the list', () => {
    const { body, volume, name } = spec();
    expect(name).toBe('redwhale-ws-1-job-job-1');
    expect(body.User).toBe('10001:10001');
    expect(body.Entrypoint).toEqual(['python3']);
    expect(body.Cmd).toEqual(['-I', '/opt/redwhale/subdomain/subfinder/run.py', '--target', 'example.com', '--out', '/out']);
    expect(body.Labels).toEqual({ 'redwhale.job': 'job-1', 'redwhale.workspace': 'ws-1', 'redwhale.tool': 'subfinder' });
    expect(volume).toEqual({ Name: 'redwhale-ws-1-job-job-1', Labels: body.Labels });

    const h = body.HostConfig;
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.CapDrop).toEqual(['ALL']);
    expect(h.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(h.Privileged).toBe(false);
    expect(h.Memory).toBe(1024 ** 3);
    expect(h.MemorySwap).toBe(h.Memory);
    expect(h.NanoCpus).toBe(1e9);
    expect(h.PidsLimit).toBe(DEFAULT_LIMITS.pidsLimit);
    expect(Object.keys(h.Tmpfs)).toEqual(['/tmp']);
    expect(h.Tmpfs['/tmp']).toMatch(/noexec/);
    expect(h.Mounts).toEqual([{ Type: 'volume', Source: 'redwhale-ws-1-job-job-1', Target: '/out', ReadOnly: false }]);
    expect(h.NetworkMode).toBe('redwhale-tools'); // the tools network, never the default bridge
    expect(h.AutoRemove).toBe(false);
  });

  test('no bind mounts, no Docker socket, no host namespaces, anywhere in the spec', () => {
    const text = JSON.stringify(spec());
    expect(text).not.toMatch(/Binds|docker\.sock|docker_engine|"host"|PidMode|IpcMode|CapAdd|Devices/);
  });

  test('the script gets a timeout shorter than the hard kill', () => {
    expect(spec().body.Env).toContain('REDWHALE_TOOL_TIMEOUT=570');
  });
});

describe('fake runtime', () => {
  test('runs a scripted container and records every call', async () => {
    const rt = new FakeRuntime(() => ({ files: { 'result.json': '{}', 'big.bin': 'x'.repeat(10) }, exitCode: 3 }));
    rt.addImage('redwhale-tools/subdomain:abc');
    await rt.ensureNetwork(toolsNetwork({}));
    const id = await rt.create(spec());
    await rt.start(id);
    expect(await rt.wait(id)).toEqual({ exitCode: 3 });
    const out = await rt.fetchOutput(id, '/out', { files: { 'result.json': 1 }, maxTotalBytes: 100 });
    expect(out.files.get('result.json')).toMatchObject({ size: 2, truncated: true });
    expect(out.skipped).toEqual([{ name: 'big.bin', size: 10 }]);
    expect((await rt.listByLabel('redwhale.workspace', 'ws-1')).volumes).toHaveLength(1);
    await rt.removeContainer(id);
    await rt.removeVolume('redwhale-ws-1-job-job-1');
    expect(await rt.listByLabel('redwhale.job')).toEqual({ containers: [], volumes: [] });
    expect(rt.created).toHaveLength(1);
  });

  test('a hanging container exits only when killed', async () => {
    const rt = new FakeRuntime(() => ({ hang: true }));
    rt.addImage('redwhale-tools/subdomain:abc');
    await rt.ensureNetwork(toolsNetwork({}));
    const id = await rt.create(spec());
    await rt.start(id);
    const waited = rt.wait(id);
    await rt.kill(id);
    expect(await waited).toEqual({ exitCode: 137 });
  });
});
