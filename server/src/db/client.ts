import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';
import * as schema from './schema';

export const DEFAULT_DB_PATH = './data/redwhale.db';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Migrations that can't carry existing rows forward. Until there is real engagement data, schema changes
 * don't get backfills (CLAUDE.md): a database with observations from before one of these is refused.
 */
const BREAKING_MIGRATIONS: ReadonlySet<string> = new Set(['0001_observation_role', '0003_edge_observations']);

const journalSchema = z.object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) });

export class OutdatedDatabaseError extends Error {
  constructor(path: string) {
    super(
      `Database is from an older schema. Delete ${path.replace(/^\.[\\/]/, '')} and run pnpm mock ` +
        '(or re-ingest your files).',
    );
    this.name = 'OutdatedDatabaseError';
  }
}

/** Throws if a pending breaking migration would run on a database that already holds observations. */
function refuseOutdatedData(sqlite: Database.Database, path: string): void {
  const hasTable = (name: string) =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (!hasTable('__drizzle_migrations') || !hasTable('observations')) return;

  // Same bookkeeping as Drizzle's migrator: a migration is applied if its `when` is not after the last one run.
  const last = z
    .object({ last: z.number().nullable() })
    .parse(sqlite.prepare('SELECT MAX(created_at) AS last FROM __drizzle_migrations').get()).last;
  const journal = journalSchema.parse(JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')));
  const pending = journal.entries.filter((e) => last === null || e.when > last);
  if (!pending.some((e) => BREAKING_MIGRATIONS.has(e.tag))) return;

  if (sqlite.prepare('SELECT 1 FROM observations LIMIT 1').get() !== undefined) throw new OutdatedDatabaseError(path);
}

/**
 * Opens (or creates) a workspace database and brings it up to the latest migration.
 * Throws OutdatedDatabaseError, before changing anything, if that would need a backfill.
 */
export function openDb(path: string = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    refuseOutdatedData(sqlite, path);
  } catch (e) {
    sqlite.close();
    throw e;
  }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export type Db = ReturnType<typeof openDb>;
