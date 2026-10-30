import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateContract, type ContractFile } from '@redwhale/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach } from 'vitest';
import { openDb, type Db } from '../src/db/client';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const EXAMPLES_DIR = join(REPO_ROOT, 'contract/examples');
export const INVALID_DIR = join(REPO_ROOT, 'contract/invalid');
export const EXAMPLES = ['subfinder', 'nmap', 'httpx', 'nuclei'] as const;
export type ExampleName = (typeof EXAMPLES)[number];

export function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function examplePath(name: ExampleName): string {
  return join(EXAMPLES_DIR, `${name}.example.json`);
}

export function exampleText(name: ExampleName): string {
  return readFileSync(examplePath(name), 'utf8');
}

/** A mutable copy of an example file. */
export function exampleDoc(name: ExampleName): Doc {
  return JSON.parse(exampleText(name)) as Doc;
}

export type Doc = Record<string, unknown> & { findings: Record<string, unknown>[] };

/** A small valid file; tests mutate it. */
export function baseDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    contract_version: 1,
    tool: 'testtool',
    target: 'example.com',
    command: 'testtool example.com',
    started_at: '2026-10-29T10:00:00Z',
    finished_at: '2026-10-29T10:01:00Z',
    status: 'success',
    errors: [],
    findings: [],
    ...overrides,
  };
}

export function validated(doc: unknown): ContractFile {
  const result = validateContract(doc);
  if (!result.ok) throw new Error(`fixture is invalid:\n${result.errors.join('\n')}`);
  return result.data;
}

// Databases and temp dirs opened by a test are closed/removed after it.
const openDbs: Db[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function freshDb(): Db {
  const db = openDb(':memory:');
  openDbs.push(db);
  return db;
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redwhale-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Path to a database left at migration 0000 (before `observations.role`), as an older checkout made it.
 * With `withData` it holds one scan, node and observation.
 */
export function schema0000Db(withData: boolean): string {
  const dir = tempDir();
  const source = join(REPO_ROOT, 'server/drizzle');
  const migrations = join(dir, 'drizzle');
  mkdirSync(join(migrations, 'meta'), { recursive: true });
  copyFileSync(join(source, '0000_init.sql'), join(migrations, '0000_init.sql'));
  const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
  writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));

  const path = join(dir, 'old.db');
  const sqlite = new Database(path);
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  if (withData) {
    const t = '2026-10-29T10:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO scans (id, tool, target, command, status, errors, started_at, finished_at, ingested_at, file_hash, raw)
         VALUES ('s1', 'subfinder', 'example.com', 'subfinder', 'success', '[]', @t, @t, @t, 'h1', '{}')`,
      )
      .run({ t });
    sqlite
      .prepare(
        `INSERT INTO nodes (id, type, value, label, first_seen, last_seen)
         VALUES ('n1', 'domain', 'example.com', 'example.com', @t, @t)`,
      )
      .run({ t });
    sqlite
      .prepare(
        `INSERT INTO observations (node_id, scan_id, tool, severity, data, observed_at)
         VALUES ('n1', 's1', 'subfinder', NULL, '{}', @t)`,
      )
      .run({ t });
  }
  sqlite.close();
  return path;
}

export function counts(db: Db) {
  const count = (table: string) =>
    (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { scans: count('scans'), nodes: count('nodes'), edges: count('edges'), observations: count('observations') };
}

/**
 * Every table, sorted, without values that legitimately differ between runs
 * (scan UUIDs, ingested_at, observation row IDs). Scans are referred to by file hash instead.
 */
export function snapshot(db: Db) {
  const all = (query: string) => db.$client.prepare(query).all();
  return {
    scans: all(
      `SELECT tool, tool_version, target, command, status, errors, started_at, finished_at, file_hash, raw
       FROM scans ORDER BY file_hash`,
    ),
    nodes: all('SELECT * FROM nodes ORDER BY id'),
    edges: all('SELECT * FROM edges ORDER BY id'),
    observations: all(
      `SELECT o.node_id, s.file_hash, o.tool, o.role, o.severity, o.data, o.observed_at
       FROM observations o JOIN scans s ON s.id = o.scan_id ORDER BY o.node_id, s.file_hash`,
    ),
  };
}

export interface NodeRow {
  id: string;
  type: string;
  value: string;
  label: string;
  severity: string | null;
  confidence: string;
  source_count: number;
  data: string;
  first_seen: string;
  last_seen: string;
}

export function nodeByLabel(db: Db, label: string): NodeRow {
  const row = db.$client.prepare('SELECT * FROM nodes WHERE label = ?').get(label) as NodeRow | undefined;
  if (!row) throw new Error(`no node labelled ${label}`);
  return row;
}
