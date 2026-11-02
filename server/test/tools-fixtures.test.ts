// Every tool's parser against its saved real output (tools/<group>/<tool>/fixtures/): replayed through run.py, the
// result must follow the contract (Zod and the team validator) and equal fixtures/expected.json. Skipped without
// Python 3.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const sortFindings = (findings: Record<string, unknown>[]) =>
  [...findings].sort((a, b) => `${String(a.type)}:${String(a.value)}`.localeCompare(`${String(b.type)}:${String(b.value)}`));

describe.skipIf(!python)('tool parsers against their saved real output', () => {
  test('the subdomain tools have fixtures', () => {
    expect(withFixtures.map((t) => t.tool)).toEqual(['subfinder', 'assetfinder', 'findomain', 'crtsh']);
  });

  test.each(withFixtures)('$tool', ({ tool, dir, raw, expected }) => {
    expect(existsSync(join(raw, '..', 'NOTE.md')), 'fixtures/NOTE.md says where the sample came from').toBe(true);
    const want = expectedSchema.parse(JSON.parse(readFileSync(expected, 'utf8')));
    const out = tempDir();
    const [exe = '', ...args] = python ?? [];
    const r = spawnSync(exe, [...args, '-I', join(dir, 'run.py'), '--target', want.target, '--out', out, '--replay', raw], {
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
