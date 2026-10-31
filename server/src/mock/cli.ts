// `pnpm mock` (the small showcase) and `pnpm mock:large` (the big seeded generator): generate mock tool
// output, validate it twice (Zod and the team's Python validator), wipe the workspace, then ingest it.
// The wipe refuses to touch a database that holds scans a mock didn't make (real files), unless --force.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIDENCE_LEVELS, checkValue, nodeId, validateContract } from '@redwhale/shared';
import type { CliIo } from '../cli/ingest';
import { DEFAULT_DB_PATH, OutdatedDatabaseError, openDb, type Db } from '../db/client';
import { updateNode } from '../graph/update';
import { ingestText } from '../ingest/ingest';
import { MAX_SUBDOMAINS, MOCK_DEFAULTS, generateMock, mockFileText, type MockFile, type MockOptions } from './generate';
import { findPython, validateWithPython } from './python';
import { SHOWCASE_ANNOTATIONS, SHOWCASE_DOMAIN, generateShowcase } from './showcase';

export type MockKind = 'showcase' | 'large';

export const DEFAULT_MOCK_DIRS: Record<MockKind, string> = {
  showcase: './data/mock/showcase',
  large: './data/mock/large',
};

const COMMON_USAGE = '[--out dir] [--db path] [--no-ingest] [--skip-python] [--force]';
const USAGE: Record<MockKind, string> = {
  showcase: `usage: pnpm mock -- ${COMMON_USAGE}`,
  large: `usage: pnpm mock:large -- [--subdomains N] [--seed N] [--domain name.example] ${COMMON_USAGE}`,
};

/**
 * Mock data only ever targets the reserved `.example` TLD (RFC 2606), so a scan whose target is anything else
 * came from a real file. Targets may be a domain, an IP, a CIDR or a URL.
 */
export function isMockTarget(target: string): boolean {
  let host = target;
  if (/^https?:\/\//i.test(target)) {
    try {
      host = new URL(target).hostname;
    } catch {
      return false;
    }
  }
  return /(^|\.)example$/i.test(host);
}

interface ForeignScan {
  tool: string;
  target: string;
  ingested_at: string;
}

/** Scans that no mock generator could have made, oldest first. */
export function foreignScans(db: Db): ForeignScan[] {
  const rows = db.$client
    .prepare('SELECT tool, target, ingested_at FROM scans ORDER BY ingested_at, tool')
    .all() as ForeignScan[];
  return rows.filter((r) => !isMockTarget(r.target));
}

/** Deletes every scan, node, edge and observation in one transaction. Returns how many scans were removed. */
export function wipeWorkspace(db: Db): number {
  const sqlite = db.$client;
  return sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM observations').run();
    sqlite.prepare('DELETE FROM edges').run();
    sqlite.prepare('DELETE FROM nodes').run();
    return sqlite.prepare('DELETE FROM scans').run().changes;
  })();
}

interface MockArgs extends MockOptions {
  out: string;
  db: string | undefined;
  ingest: boolean;
  python: boolean;
  force: boolean;
}

type Parsed = { ok: true; args: MockArgs } | { ok: false; error: string };

function parseInteger(name: string, raw: string, min: number, max: number): number | string {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return `${name} must be an integer from ${String(min)} to ${String(max)}`;
  }
  return n;
}

const LARGE_ONLY = ['--subdomains', '--seed', '--domain'];

function parseArgs(kind: MockKind, argv: readonly string[]): Parsed {
  const args: MockArgs = {
    ...MOCK_DEFAULTS,
    out: DEFAULT_MOCK_DIRS[kind],
    db: undefined,
    ingest: true,
    python: true,
    force: false,
  };
  const flags: Record<string, () => void> = {
    '--no-ingest': () => (args.ingest = false),
    '--skip-python': () => (args.python = false),
    '--force': () => (args.force = true),
  };
  const valueOptions = ['--out', '--db', ...LARGE_ONLY];

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? '';
    if (arg === '--') continue;
    const flag = flags[arg];
    if (flag) {
      flag();
      continue;
    }

    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (!valueOptions.includes(arg)) return { ok: false, error: `unknown option '${arg}'` };
    if (kind === 'showcase' && LARGE_ONLY.includes(arg)) {
      return { ok: false, error: `${arg} is for pnpm mock:large; pnpm mock is a fixed showcase` };
    }
    value ??= argv[++i];
    if (value === undefined) return { ok: false, error: `${arg} needs a value` };

    switch (arg) {
      case '--subdomains': {
        const n = parseInteger(arg, value, 1, MAX_SUBDOMAINS);
        if (typeof n === 'string') return { ok: false, error: n };
        args.subdomains = n;
        break;
      }
      case '--seed': {
        const n = parseInteger(arg, value, 0, 2 ** 32 - 1);
        if (typeof n === 'string') return { ok: false, error: n };
        args.seed = n;
        break;
      }
      case '--domain': {
        const error = checkValue('domain', value);
        if (error) return { ok: false, error: `--domain '${value}' ${error}` };
        if (!isMockTarget(value)) {
          return { ok: false, error: `--domain '${value}' must end in .example (mock data never uses real names)` };
        }
        args.domain = value;
        break;
      }
      case '--out':
        args.out = value;
        break;
      case '--db':
        args.db = value;
        break;
    }
  }
  return { ok: true, args };
}

/** Returns the exit code: 0 done, 1 a file failed validation or ingest (or real scans are in the way), 2 usage. */
export function runMockCli(
  kind: MockKind,
  argv: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = parseArgs(kind, argv);
  if (!parsed.ok) {
    io.err(parsed.error);
    io.err(USAGE[kind]);
    return 2;
  }
  const { args } = parsed;

  const generated: MockFile[] = kind === 'showcase' ? generateShowcase() : generateMock(args);
  const files = generated.map((file) => ({
    ...file,
    path: join(args.out, `${file.tool}.json`),
    text: mockFileText(file),
  }));

  // Our own output must be clean: any Zod error or warning is a generator bug.
  for (const f of files) {
    const result = validateContract(f.doc);
    const problems = result.ok ? result.warnings : result.errors;
    if (problems.length > 0) {
      io.err(`${f.tool}: generated file is not clean:`);
      for (const p of problems) io.err(`  ${p}`);
      return 1;
    }
  }

  mkdirSync(args.out, { recursive: true });
  for (const f of files) writeFileSync(f.path, f.text);
  io.out(
    `Wrote ${String(files.length)} files to ${args.out} ` +
      (kind === 'showcase'
        ? `(showcase of ${SHOWCASE_DOMAIN})`
        : `(${String(args.subdomains)} subdomains of ${args.domain}, seed ${String(args.seed)})`),
  );

  if (args.python) {
    const python = findPython();
    if (!python) {
      io.err('Python 3 not found, so tools/validate_output.py could not run. Install it or pass --skip-python.');
      return 1;
    }
    const result = validateWithPython(
      python,
      files.map((f) => f.path),
    );
    if (!result.ok) {
      io.err('tools/validate_output.py rejected the mock files:');
      io.err(result.output);
      return 1;
    }
    io.out('tools/validate_output.py: all files pass');
  } else {
    io.err('warning: skipped tools/validate_output.py (--skip-python)');
  }

  if (!args.ingest) return 0;

  const dbPath = args.db ?? env.REDWHALE_DB ?? DEFAULT_DB_PATH;
  let db: Db;
  try {
    db = openDb(dbPath);
  } catch (e) {
    if (!(e instanceof OutdatedDatabaseError)) throw e;
    io.err(e.message);
    return 1;
  }
  try {
    const foreign = foreignScans(db);
    if (foreign.length > 0 && !args.force) {
      io.err(
        `${dbPath} holds ${String(foreign.length)} scan(s) that didn't come from a mock generator ` +
          '(their target is not under .example):',
      );
      for (const s of foreign.slice(0, 5)) io.err(`  ${s.tool} → ${s.target} (ingested ${s.ingested_at})`);
      if (foreign.length > 5) io.err(`  … and ${String(foreign.length - 5)} more`);
      io.err('The mock replaces the whole workspace. Pass --force to wipe them too, or --db <path> to use another database.');
      return 1;
    }
    const wiped = wipeWorkspace(db);
    if (wiped > 0) {
      io.out(`Wiped ${dbPath} (${String(wiped)} scans${foreign.length > 0 ? `, ${String(foreign.length)} not from a mock` : ''})`);
    }

    for (const f of files) {
      const result = ingestText(db, f.text);
      switch (result.status) {
        case 'invalid':
          io.err(`${f.tool}: rejected by ingest:`);
          for (const e of result.errors) io.err(`  ${e}`);
          return 1;
        case 'duplicate':
          // Only if one run produced the same file twice; never after the wipe.
          io.out(`  ${f.tool.padEnd(12)} already ingested`);
          break;
        case 'ingested':
          io.out(
            `  ${f.tool.padEnd(12)} ${String(f.doc.findings.length).padStart(5)} findings, ` +
              `${String(result.created.nodes)} new nodes, ${String(result.created.edges)} new edges`,
          );
          break;
      }
    }

    if (kind === 'showcase') {
      for (const a of SHOWCASE_ANNOTATIONS) {
        if (!updateNode(db, nodeId(a.type, a.value), a.patch)) {
          io.err(`showcase annotation: no ${a.type} node '${a.value}'`);
          return 1;
        }
      }
      io.out(`  annotated ${String(SHOWCASE_ANNOTATIONS.length)} nodes (verified, tags, notes)`);
    }

    const rows = db.$client.prepare('SELECT confidence, COUNT(*) AS n FROM nodes GROUP BY confidence').all() as {
      confidence: string;
      n: number;
    }[];
    const byConfidence = new Map(rows.map((r) => [r.confidence, r.n]));
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    const parts = CONFIDENCE_LEVELS.map((c) => `${String(byConfidence.get(c) ?? 0)} ${c}`).join(', ');
    io.out(`Database ${dbPath}: ${String(total)} nodes (${parts})`);
    return 0;
  } finally {
    db.$client.close();
  }
}
