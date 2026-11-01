import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runIngestCli } from '../src/cli/ingest';
import { INVALID_DIR, examplePath, schema0000Db, tempDir } from './helpers';

function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runIngestCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, env);
  return { code, out, err };
}

test('ingests a valid file and reports counts', () => {
  const db = join(tempDir(), 'cli.db');
  const result = run([examplePath('nmap'), '--db', db]);
  expect(result.code).toBe(0);
  expect(result.out).toEqual([
    expect.stringMatching(/as scan [0-9a-f-]{36}: 5 nodes \(5 new\), 4 edges \(4 new\), 5 observations, 4 edge observations$/),
  ]);
  expect(result.err).toEqual([]);
});

test('a second run of the same file exits 0 and says it is already ingested', () => {
  const db = join(tempDir(), 'cli.db');
  run([examplePath('nmap'), `--db=${db}`]);
  const second = run(['--', examplePath('nmap'), `--db=${db}`]);
  expect(second.code).toBe(0);
  expect(second.out).toEqual([expect.stringMatching(/^Already ingested as scan /)]);
});

test('REDWHALE_DB is used when --db is not given', () => {
  const db = join(tempDir(), 'env.db');
  run([examplePath('subfinder')], { REDWHALE_DB: db });
  expect(run([examplePath('subfinder')], { REDWHALE_DB: db }).out[0]).toMatch(/^Already ingested/);
});

test('an invalid file exits 1 and prints each error', () => {
  const db = join(tempDir(), 'cli.db');
  const result = run([join(INVALID_DIR, 'finding-has-id.json'), '--db', db]);
  expect(result.code).toBe(1);
  expect(result.err).toEqual([
    expect.stringMatching(/^Rejected .*finding-has-id\.json: 1 error\(s\)$/),
    '  findings[1]: do not create IDs; the server generates them',
  ]);
});

test.each([
  ['no arguments', []],
  ['two files', ['a.json', 'b.json']],
  ['--db without a path', ['a.json', '--db']],
  ['an unknown option', ['a.json', '--force']],
])('usage error (%s) exits 2', (_name, argv) => {
  const result = run(argv);
  expect(result.code).toBe(2);
  expect(result.err.at(-1)).toMatch(/^usage: /);
});

test('a missing file exits 2', () => {
  const result = run([join(tempDir(), 'nope.json'), '--db', join(tempDir(), 'x.db')]);
  expect(result.code).toBe(2);
  expect(result.err[0]).toMatch(/^cannot read /);
});

test('a database from an older schema exits 2 with the message', () => {
  const db = schema0000Db(true);
  const result = run([examplePath('nmap'), '--db', db]);
  expect(result.code).toBe(2);
  expect(result.err).toEqual([expect.stringMatching(/^Database is from an older schema\. Delete .*old\.db and run pnpm mock/)]);
});
