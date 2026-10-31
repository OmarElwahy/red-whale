import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateContract } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { ingestText } from '../src/ingest/ingest';
import { runMockCli } from '../src/mock/cli';
import { MOCK_DEFAULTS, generateMock, mockFileText, type MockOptions } from '../src/mock/generate';
import { findPython, validateWithPython } from '../src/mock/python';
import { counts, freshDb, tempDir } from './helpers';
import { openDb, type Db } from '../src/db/client';

const options = (overrides: Partial<MockOptions> = {}): MockOptions => ({ ...MOCK_DEFAULTS, ...overrides });
const texts = (o: MockOptions) => generateMock(o).map(mockFileText);

function ingestMock(db: Db, o: MockOptions) {
  return generateMock(o).map((f) => ingestText(db, mockFileText(f)));
}

function query<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.$client.prepare(sql).all(...params) as T[];
}

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runMockCli('large', argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {});
  return { code, out, err };
}

describe('generator', () => {
  test('the same options give byte-identical files', () => {
    expect(texts(options())).toEqual(texts(options()));
  });

  test('a different seed gives different files', () => {
    expect(texts(options({ seed: 1 }))).not.toEqual(texts(options({ seed: 2 })));
  });

  test('seven tools, in ingest order', () => {
    expect(generateMock(options({ subdomains: 10 })).map((f) => f.tool)).toEqual([
      'subfinder', 'amass', 'dnsx', 'naabu', 'nmap', 'httpx', 'nuclei',
    ]);
  });

  test.each([1, 30, 400])('--subdomains %i: every file passes Zod with no warnings', (subdomains) => {
    for (const file of generateMock(options({ subdomains }))) {
      const result = validateContract(JSON.parse(mockFileText(file)));
      expect(result.ok ? result.warnings : result.errors, file.tool).toEqual([]);
    }
  });

  test.each([0, -1, 1.5, 20_001])('rejects subdomains = %d', (subdomains) => {
    expect(() => generateMock(options({ subdomains }))).toThrow(RangeError);
  });
});

const python = findPython();
describe.skipIf(!python)('tools/validate_output.py', () => {
  test.each([1, 400])('accepts every file for --subdomains %i', (subdomains) => {
    const result = run(['--subdomains', String(subdomains), '--out', tempDir(), '--no-ingest']);
    expect(result.code, result.err.join('\n')).toBe(0);
    expect(result.out).toContain('tools/validate_output.py: all files pass');
  });

  test('reports a file it rejects', () => {
    const dir = tempDir();
    run(['--subdomains', '5', '--out', dir, '--no-ingest', '--skip-python']);
    const bad = join(dir, 'bad.json');
    const doc = JSON.parse(readFileSync(join(dir, 'dnsx.json'), 'utf8')) as Record<string, unknown>;
    expect(validateWithPython(python ?? [], [join(dir, 'dnsx.json')])).toEqual({ ok: true });
    doc.tool = 'DNSX';
    writeFileSync(bad, JSON.stringify(doc));
    expect(validateWithPython(python ?? [], [bad])).toMatchObject({ ok: false });
  });
});

describe('after ingest', () => {
  test.each([1, 60, 400])('--subdomains %i: exactly that many subdomains and one domain', (subdomains) => {
    const db = freshDb();
    ingestMock(db, options({ subdomains }));
    const byType = new Map(
      query<{ type: string; n: number }>(db, 'SELECT type, COUNT(*) AS n FROM nodes GROUP BY type').map((r) => [
        r.type,
        r.n,
      ]),
    );
    expect(byType.get('subdomain')).toBe(subdomains);
    expect(byType.get('domain')).toBe(1);
  });

  test('some subdomains are discovered and some corroborated', () => {
    const db = freshDb();
    ingestMock(db, options());
    const rows = query<{ confidence: string; n: number }>(
      db,
      "SELECT confidence, COUNT(*) AS n FROM nodes WHERE type = 'subdomain' GROUP BY confidence ORDER BY confidence",
    );
    expect(rows.map((r) => r.confidence)).toEqual(['corroborated', 'discovered']);
    for (const r of rows) expect(r.n).toBeGreaterThan(20);
  });

  test('a vulnerability is corroborated by nmap and nuclei', () => {
    const db = freshDb();
    ingestMock(db, options());
    const vulns = query<{ value: string }>(
      db,
      "SELECT value FROM nodes WHERE type = 'vulnerability' AND confidence = 'corroborated'",
    );
    expect(vulns.map((v) => v.value)).toContain('CVE-2021-41773');
  });

  test('nmap "nginx/1.18.0" and httpx "Nginx/1.18.0" are one node with two sources', () => {
    const db = freshDb();
    ingestMock(db, options());
    const rows = query<{ source_count: number }>(
      db,
      "SELECT source_count FROM nodes WHERE type = 'technology' AND value = 'nginx/1.18.0'",
    );
    expect(rows).toEqual([{ source_count: 2 }]);
  });

  test.each([1, 400])('--subdomains %i: medium, high and critical vulnerabilities all exist', (subdomains) => {
    const db = freshDb();
    ingestMock(db, options({ subdomains }));
    const severities = query<{ severity: string }>(
      db,
      "SELECT DISTINCT severity FROM nodes WHERE type = 'vulnerability'",
    ).map((r) => r.severity);
    expect(severities).toEqual(expect.arrayContaining(['medium', 'high', 'critical']));
  });

  test('ingesting the mock twice changes nothing', () => {
    const db = freshDb();
    ingestMock(db, options({ subdomains: 60 }));
    const before = counts(db);
    expect(ingestMock(db, options({ subdomains: 60 })).map((r) => r.status)).toEqual(Array(7).fill('duplicate'));
    expect(counts(db)).toEqual(before);
  });
});

describe('CLI', () => {
  test('writes, validates and ingests; a second run wipes and ends with the same graph', () => {
    const dir = tempDir();
    const db = join(dir, 'mock.db');
    const argv = ['--', '--subdomains', '20', '--out', join(dir, 'out'), '--db', db, '--skip-python'];
    const first = run(argv);
    expect(first.code, first.err.join('\n')).toBe(0);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(
      ['amass', 'dnsx', 'httpx', 'naabu', 'nmap', 'nuclei', 'subfinder'].map((t) => `${t}.json`),
    );
    expect(first.out.some((l) => l.startsWith('Wiped'))).toBe(false);
    const summary = first.out.at(-1);
    expect(summary).toMatch(/: \d+ nodes \(\d+ discovered, \d+ corroborated, 0 verified\)$/);

    const second = run(argv);
    expect(second.code).toBe(0);
    expect(second.out).toContain(`Wiped ${db} (7 scans)`);
    expect(second.out.filter((l) => l.endsWith('already ingested'))).toEqual([]);
    expect(second.out.at(-1)).toBe(summary);
  });

  test('a different --subdomains run replaces the previous one instead of adding to it', () => {
    const dir = tempDir();
    const db = join(dir, 'mock.db');
    const common = ['--out', join(dir, 'out'), '--db', db, '--skip-python'];
    expect(run(['--subdomains', '40', ...common]).code).toBe(0);
    expect(run(['--subdomains', '10', ...common]).code).toBe(0);
    const open = openDb(db);
    expect(query<{ n: number }>(open, "SELECT COUNT(*) AS n FROM nodes WHERE type = 'subdomain'")).toEqual([{ n: 10 }]);
    open.$client.close();
  });

  test('the files on disk are exactly the generated text', () => {
    const dir = tempDir();
    run(['--subdomains=15', '--seed=7', `--out=${dir}`, '--no-ingest', '--skip-python']);
    for (const f of generateMock(options({ subdomains: 15, seed: 7 }))) {
      expect(readFileSync(join(dir, `${f.tool}.json`), 'utf8')).toBe(mockFileText(f));
    }
  });

  test('--no-ingest does not create the database', () => {
    const dir = tempDir();
    const db = join(dir, 'never.db');
    expect(run(['--subdomains', '5', '--out', dir, '--db', db, '--no-ingest', '--skip-python']).code).toBe(0);
    expect(existsSync(db)).toBe(false);
  });

  test('--skip-python says so', () => {
    const result = run(['--subdomains', '5', '--out', tempDir(), '--no-ingest', '--skip-python']);
    expect(result.err).toContain('warning: skipped tools/validate_output.py (--skip-python)');
  });

  test.each([
    [['--subdomains', '0'], '--subdomains must be an integer from 1 to 20000'],
    [['--subdomains', '-1'], '--subdomains must be an integer from 1 to 20000'],
    [['--subdomains', 'abc'], '--subdomains must be an integer from 1 to 20000'],
    [['--subdomains', '20001'], '--subdomains must be an integer from 1 to 20000'],
    [['--subdomains'], '--subdomains needs a value'],
    [['--seed', '1.5'], '--seed must be an integer from 0 to 4294967295'],
    [['--domain', 'Not A Domain'], "--domain 'Not A Domain' must be lowercase"],
    [['--domain', 'acme.com'], "--domain 'acme.com' must end in .example (mock data never uses real names)"],
    [['--fresh'], "unknown option '--fresh'"],
  ])('%j exits 2', (argv, message) => {
    const result = run(argv);
    expect(result.code).toBe(2);
    expect(result.err[0]).toBe(message);
  });
});
