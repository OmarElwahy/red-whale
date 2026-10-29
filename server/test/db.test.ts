import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openDb, type Db } from '../src/db/client';

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

test('creates all four tables with foreign keys on', () => {
  const db = open();
  expect(names(db, 'table')).toEqual(expect.arrayContaining(['scans', 'nodes', 'edges', 'observations']));
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
  expect(migrations).toEqual({ n: 1 });
  expect(second.$client.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 1 });
});

test('has the unique indexes that keep ingest idempotent', () => {
  const db = open();
  expect(names(db, 'index')).toEqual(
    expect.arrayContaining(['scans_file_hash_unique', 'edges_source_relation_target_uq', 'observations_node_scan_uq']),
  );

  const unique = (index: string) =>
    db.$client
      .prepare<[], { name: string }>(`PRAGMA index_info(${index})`)
      .all()
      .map((r) => r.name);
  expect(unique('scans_file_hash_unique')).toEqual(['file_hash']);
  expect(unique('edges_source_relation_target_uq')).toEqual(['source_id', 'relation', 'target_id']);
  expect(unique('observations_node_scan_uq')).toEqual(['node_id', 'scan_id']);
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
    "INSERT INTO edges VALUES (?, ?, ?, ?, '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z')",
  );
  expect(() => insertEdge.run('e1', 'a', 'b', 'links_to')).toThrow(/CHECK constraint failed/);
  expect(() => insertEdge.run('e2', 'a', 'missing', 'has_subdomain')).toThrow(/FOREIGN KEY constraint failed/);
  expect(() => insertEdge.run('e3', 'a', 'b', 'has_subdomain')).not.toThrow();
  expect(() => insertEdge.run('e4', 'a', 'b', 'has_subdomain')).toThrow(/UNIQUE constraint failed/);
});
