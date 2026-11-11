// Every tool's parser against its saved real output (tools/<group>/<tool>/fixtures/): replayed through run.py, the
// result must follow the contract (Zod and the team validator) and equal fixtures/expected.json. Skipped without
// Python 3.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateContract } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { findPython } from '../src/mock/python';
import { TOOLS_DIR, loadCatalog } from '../src/runner/catalog';
import { tempDir } from './helpers';

const python = findPython();

const expectedSchema = z.object({
  target: z.string(),
  /** Passed as --target-type, for tools whose argv has {targetType} (httpx, dnsx). */
  target_type: z.string().optional(),
  status: z.string(),
  errors: z.array(z.string()),
  findings: z.array(z.record(z.string(), z.unknown())),
});

/** Tools that have a fixture: the single fixtures/raw.* file. */
const withFixtures = loadCatalog().groups.flatMap((g) =>
  g.tools.flatMap((t) => {
    const dir = join(TOOLS_DIR, g.def.name, t.name);
    const fixtures = join(dir, 'fixtures');
    if (!existsSync(fixtures)) return [];
    const raw = readdirSync(fixtures).find((f) => f.startsWith('raw.'));
    return raw ? [{ tool: t.name, dir, raw: join(fixtures, raw), expected: join(fixtures, 'expected.json') }] : [];
  }),
);

/** The same value under two parents (nginx on http:// and https://) is two findings. */
const sortKey = (f: Record<string, unknown>) => `${String(f.type)}:${String(f.value)}:${JSON.stringify(f.parent ?? null)}`;
const sortFindings = (findings: Record<string, unknown>[]) =>
  [...findings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

describe.skipIf(!python)('tool parsers against their saved real output', () => {
  test('every repo tool has a fixture', () => {
    expect(withFixtures.map((t) => t.tool)).toEqual(['dnsx', 'httpx', 'naabu', 'subfinder', 'assetfinder', 'findomain', 'crtsh']);
  });

  test.each(withFixtures)('$tool', ({ tool, dir, raw, expected }) => {
    expect(existsSync(join(raw, '..', 'NOTE.md')), 'fixtures/NOTE.md says where the sample came from').toBe(true);
    const want = expectedSchema.parse(JSON.parse(readFileSync(expected, 'utf8')));
    const out = tempDir();
    const [exe = '', ...args] = python ?? [];
    const typeArgs = want.target_type === undefined ? [] : ['--target-type', want.target_type];
    const r = spawnSync(exe, [...args, '-I', join(dir, 'run.py'), '--target', want.target, ...typeArgs, '--out', out, '--replay', raw], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(join(out, 'result.json'), 'utf8');
    const doc: unknown = JSON.parse(text);
    const valid = validateContract(doc);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    if (!valid.ok) return;
    expect(valid.data.tool).toBe(tool);
    expect(valid.data.target).toBe(want.target);
    expect(valid.data.status).toBe(want.status);
    expect(valid.data.errors).toEqual(want.errors);
    expect(sortFindings(valid.data.findings as Record<string, unknown>[])).toEqual(sortFindings(want.findings));
    expect(readFileSync(join(out, 'raw.txt'), 'utf8')).toBe(readFileSync(raw, 'utf8'));
  });
});

describe.skipIf(!python)('tools/check.py (pnpm tools:check)', () => {
  function check(toolsDir: string, args: string[]) {
    const [exe = '', ...pre] = python ?? [];
    const r = spawnSync(exe, [...pre, '-I', join(toolsDir, 'check.py'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 120_000,
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  /** A throwaway copy of tools/, to break things in. */
  function copy(): string {
    const dir = join(tempDir(), 'tools');
    cpSync(TOOLS_DIR, dir, { recursive: true });
    return dir;
  }

  test('every tool in the repo passes', () => {
    const r = check(TOOLS_DIR, ['--all']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ all 7 passed');
  });

  test('a parser change that loses findings fails, naming them', () => {
    const dir = copy();
    const run = join(dir, 'subdomain/assetfinder/run.py');
    writeFileSync(run, readFileSync(run, 'utf8').replace('if host:', 'if host and not host.startswith("api."):'));
    const r = check(dir, ['assetfinder']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ result differs from fixtures/expected.json');
    expect(r.out).toContain('missing finding  subdomain api.northwind.example');
  });

  test('a parser that emits invalid values fails (the helper skips them and reports an error); --update rewrites expected.json', () => {
    const dir = copy();
    const run = join(dir, 'subdomain/findomain/run.py');
    writeFileSync(run, readFileSync(run, 'utf8').replace('run.add_subdomain(host, target)', 'run.add("ip", "999.1.1.1")'));
    const r = check(dir, ['findomain']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ result differs');
    rmSync(join(dir, 'subdomain/findomain/fixtures/expected.json'));
    expect(check(dir, ['findomain']).out).toContain('✗ fixtures/expected.json missing');
    const updated = check(dir, ['findomain', '--update']);
    expect(updated.out).toContain('✓ wrote fixtures/expected.json');
    expect(check(dir, ['findomain']).code).toBe(0);
  });

  test('missing files and unknown tools are reported', () => {
    const dir = copy();
    rmSync(join(dir, 'subdomain/subfinder/fixtures/NOTE.md'));
    const r = check(dir, ['subfinder']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('fixtures/NOTE.md');
    expect(check(dir, ['nmap']).code).toBe(2);
  });
});
