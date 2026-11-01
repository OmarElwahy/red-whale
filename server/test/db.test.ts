import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_DB_PATH, OutdatedDatabaseError, openDb, type Db } from '../src/db/client';
import { migrateTo, schema0000Db, schema0001Db, schema0002Db } from './helpers';

const opened: Db[] = [];
const tempDirs: string[] = [];

function open(path = ':memory:'): Db {
  const db = openDb(path);
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function names(db: Db, kind: 'table' | 'index'): string[] {
  return db.$client
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
    .all(kind)
    .map((r) => r.name);
}

const validNode = {
  id: 'n1',
  type: 'domain',
  value: 'example.com',
  label: 'example.com',
  first_seen: '2026-10-29T10:00:00.000Z',
  last_seen: '2026-10-29T10:00:00.000Z',
};

function insertNode(db: Db, overrides: Record<string, string> = {}) {
  const row = { ...validNode, ...overrides };
  const cols = Object.keys(row);
  db.$client
    .prepare(`INSERT INTO nodes (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
    .run(row);
}

test('creates the graph tables with foreign keys on', () => {
  const db = open();
  expect(names(db, 'table')).toEqual(
    expect.arrayContaining(['scans', 'nodes', 'edges', 'observations', 'edge_observations']),
  );
  expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
});

test('running migrations on an existing database is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redwhale-'));
  tempDirs.push(dir);
  const path = join(dir, 'nested', 'test.db');

  const first = open(path);
  insertNode(first);
  first.$client.close();
  opened.length = 0;

  const second = open(path);
  const migrations = second.$client.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get();
  expect(migrations).toEqual({ n: 4 });
  expect(second.$client.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 1 });
});

test('has the unique indexes that keep ingest idempotent', () => {
  const db = open();
  expect(names(db, 'index')).toEqual(
    expect.arrayContaining([
      'scans_file_hash_unique',
      'edges_source_relation_target_uq',
      'observations_node_scan_uq',
      'edge_observations_edge_scan_uq',
    ]),
  );

  const unique = (index: string) =>
    db.$client
      .prepare<[], { name: string }>(`PRAGMA index_info(${index})`)
      .all()
      .map((r) => r.name);
  expect(unique('scans_file_hash_unique')).toEqual(['file_hash']);
  expect(unique('edges_source_relation_target_uq')).toEqual(['source_id', 'relation', 'target_id']);
  expect(unique('observations_node_scan_uq')).toEqual(['node_id', 'scan_id']);
  expect(unique('edge_observations_edge_scan_uq')).toEqual(['edge_id', 'scan_id']);
  expect(names(db, 'index')).toEqual(
    expect.arrayContaining(['edge_observations_edge_idx', 'edge_observations_scan_idx', 'edge_observations_observed_at_idx']),
  );
});

test('fills node defaults', () => {
  const db = open();
  insertNode(db);
  const row = db.$client.prepare('SELECT confidence, source_count, data, notes, tag, severity FROM nodes').get();
  expect(row).toEqual({ confidence: 'discovered', source_count: 0, data: '{}', notes: '', tag: null, severity: null });
});

test.each([
  ['type', 'hostname'],
  ['confidence', 'maybe'],
  ['severity', 'HIGH'],
  ['tag', 'todo'],
])('CHECK rejects nodes.%s = %s', (column, value) => {
  const db = open();
  expect(() => {
    insertNode(db, { [column]: value });
  }).toThrow(/CHECK constraint failed/);
});

test('CHECK rejects an unknown edge relation; foreign keys reject dangling edges', () => {
  const db = open();
  insertNode(db, { id: 'a' });
  insertNode(db, { id: 'b', value: 'example.org' });
  const insertEdge = db.$client.prepare(
    "INSERT INTO edges (id, source_id, target_id, relation, first_seen, last_seen) VALUES (?, ?, ?, ?, 'x', 'x')",
  );
  expect(() => insertEdge.run('e1', 'a', 'b', 'links_to')).toThrow(/CHECK constraint failed/);
  expect(() => insertEdge.run('e2', 'a', 'missing', 'has_subdomain')).toThrow(/FOREIGN KEY constraint failed/);
  expect(() => insertEdge.run('e3', 'a', 'b', 'has_subdomain')).not.toThrow();
  expect(() => insertEdge.run('e4', 'a', 'b', 'has_subdomain')).toThrow(/UNIQUE constraint failed/);
  expect(db.$client.prepare("SELECT confidence, source_count FROM edges WHERE id = 'e3'").get()).toEqual({
    confidence: 'discovered',
    source_count: 0,
  });
  expect(() => db.$client.prepare("UPDATE edges SET confidence = 'verified' WHERE id = 'e3'").run()).toThrow(
    /CHECK constraint failed/,
  );
});

test('edge_observations: one row per (edge, scan), foreign keys to edges and scans', () => {
  const db = open();
  insertNode(db, { id: 'a' });
  insertNode(db, { id: 'b', value: 'example.org' });
  db.$client
    .prepare("INSERT INTO edges (id, source_id, target_id, relation, first_seen, last_seen) VALUES ('e1', 'a', 'b', 'has_subdomain', 'x', 'x')")
    .run();
  db.$client
    .prepare(
      `INSERT INTO scans (id, tool, target, command, status, errors, started_at, finished_at, ingested_at, file_hash, raw)
       VALUES ('s1', 't', 'x', 'c', 'success', '[]', 'a', 'b', 'c', 'h', '{}')`,
    )
    .run();
  const insert = db.$client.prepare("INSERT INTO edge_observations (edge_id, scan_id, tool, data, observed_at) VALUES (?, ?, 't', '{}', 'x')");
  expect(() => insert.run('e1', 's1')).not.toThrow();
  expect(() => insert.run('e1', 's1')).toThrow(/UNIQUE constraint failed/);
  expect(() => insert.run('missing', 's1')).toThrow(/FOREIGN KEY constraint failed/);
  expect(() => insert.run('e1', 'missing')).toThrow(/FOREIGN KEY constraint failed/);
});

describe('a database from before a breaking migration', () => {
  test('with observations: refused with a clear message, and left untouched', () => {
    const path = schema0000Db(true);
    expect(() => open(path)).toThrow(OutdatedDatabaseError);
    expect(() => open(path)).toThrow(
      `Database is from an older schema. Delete ${path} and run pnpm mock (or re-ingest your files).`,
    );

    const raw = new Database(path, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
    raw.close();
  });

  test('empty: migrates normally', () => {
    const db = open(schema0000Db(false));
    expect(db.$client.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({ n: 4 });
    const columns = db.$client.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('observations')").all();
    expect(columns.map((c) => c.name)).toContain('role');
  });

  test('the message names the default database as data/redwhale.db', () => {
    expect(new OutdatedDatabaseError(DEFAULT_DB_PATH).message).toBe(
      'Database is from an older schema. Delete data/redwhale.db and run pnpm mock (or re-ingest your files).',
    );
  });
});

test('observations.role only accepts finding or parent', () => {
  const db = open();
  insertNode(db);
  db.$client
    .prepare(
      `INSERT INTO scans (id, tool, target, command, status, errors, started_at, finished_at, ingested_at, file_hash, raw)
       VALUES ('s1', 't', 'x', 'c', 'success', '[]', 'a', 'b', 'c', 'h', '{}')`,
    )
    .run();
  const insert = db.$client.prepare(
    "INSERT INTO observations (node_id, scan_id, tool, role, data, observed_at) VALUES ('n1', 's1', 't', ?, '{}', 'x')",
  );
  expect(() => insert.run('owner')).toThrow(/CHECK constraint failed/);
  expect(() => insert.run('parent')).not.toThrow();
});

describe('edge provenance (0003_edge_observations)', () => {
  test('a database with observations from before it: refused with the message, and left untouched', () => {
    const path = schema0002Db(true);
    expect(() => open(path)).toThrow(
      `Database is from an older schema. Delete ${path} and run pnpm mock (or re-ingest your files).`,
    );
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({ n: 3 });
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'edge_observations'").get()).toBeUndefined();
    raw.close();
  });

  test('an empty one from before it migrates normally', () => {
    const db = open(schema0002Db(false));
    expect(names(db, 'table')).toContain('edge_observations');
    const columns = db.$client.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('edges')").all();
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(['confidence', 'source_count']));
  });
});

describe('scope tables (0002_scope)', () => {
  test('an existing database with data upgrades to 0002: new tables only, data kept', () => {
    // Up to 0002 only: 0003 is breaking, so openDb would (rightly) refuse this database now.
    const path = schema0001Db();
    migrateTo(path, 3);
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
    const tables = raw.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['scope_rules', 'scope_log', 'scope_settings']));
    expect(raw.prepare('SELECT id, passive_only FROM scope_settings').all()).toEqual([{ id: 1, passive_only: 1 }]);
    raw.close();
  });

  test('a fresh database starts passive-only, with one settings row that can not be duplicated', () => {
    const db = open();
    const row = db.$client.prepare<[], { passive_only: number; updated_at: string }>('SELECT * FROM scope_settings').get();
    expect(row?.passive_only).toBe(1);
    expect(row?.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(() => db.$client.prepare("INSERT INTO scope_settings VALUES (2, 0, 'x')").run()).toThrow(/CHECK constraint failed/);
  });

  test('CHECK constraints and the active-rule unique index', () => {
    const db = open();
    const insert = db.$client.prepare(
      "INSERT INTO scope_rules (kind, value, action, created_at, removed_at) VALUES (?, ?, ?, 'now', ?)",
    );
    expect(() => insert.run('regex', 'x', 'include', null)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run('domain', 'x.com', 'allow', null)).toThrow(/CHECK constraint failed/);
    insert.run('domain', 'a.com', 'include', null);
    expect(() => insert.run('domain', 'a.com', 'include', null)).toThrow(/UNIQUE constraint failed/);
    // Removed rows don't count, and the same value as an exclude is another rule.
    insert.run('domain', 'b.com', 'include', 'then');
    insert.run('domain', 'b.com', 'include', null);
    insert.run('domain', 'a.com', 'exclude', null);

    const log = db.$client.prepare(
      "INSERT INTO scope_log (source, target_type, target_value, mode, decision, rule_id, reason, at) VALUES (?, 'ip', '1.2.3.4', ?, ?, ?, 'r', 'now')",
    );
    expect(() => log.run('audit', 'passive', 'in', null)).toThrow(/CHECK constraint failed/);
    expect(() => log.run('check', 'loud', 'in', null)).toThrow(/CHECK constraint failed/);
    expect(() => log.run('check', 'passive', 'maybe', null)).toThrow(/CHECK constraint failed/);
    expect(() => log.run('run', 'passive', 'out', 999)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => log.run('run', 'passive', 'n/a', 1)).not.toThrow();
  });
});
