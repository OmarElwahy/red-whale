// `pnpm mock -- [--subdomains N] ...`: generate mock tool output, validate it twice (Zod and the team's
// Python validator), then ingest it. The files are deterministic, so running it again is a no-op.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIDENCE_LEVELS, checkValue, validateContract } from '@redwhale/shared';
import type { CliIo } from '../cli/ingest';
import { DEFAULT_DB_PATH, openDb } from '../db/client';
import { ingestText } from '../ingest/ingest';
import { MAX_SUBDOMAINS, MOCK_DEFAULTS, generateMock, mockFileText, type MockOptions } from './generate';
import { findPython, validateWithPython } from './python';

export const DEFAULT_MOCK_DIR = './data/mock';

const USAGE =
  'usage: pnpm mock -- [--subdomains N] [--seed N] [--domain name] [--out dir] [--db path] [--no-ingest] [--skip-python]';

interface MockArgs extends MockOptions {
  out: string;
  db: string | undefined;
  ingest: boolean;
  python: boolean;
}

type Parsed = { ok: true; args: MockArgs } | { ok: false; error: string };

function parseInteger(name: string, raw: string, min: number, max: number): number | string {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return `${name} must be an integer from ${String(min)} to ${String(max)}`;
  }
  return n;
}

function parseArgs(argv: readonly string[]): Parsed {
  const args: MockArgs = { ...MOCK_DEFAULTS, out: DEFAULT_MOCK_DIR, db: undefined, ingest: true, python: true };
  const valueOptions = ['--subdomains', '--seed', '--domain', '--out', '--db'];

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? '';
    if (arg === '--') continue;
    if (arg === '--no-ingest') {
      args.ingest = false;
      continue;
    }
    if (arg === '--skip-python') {
      args.python = false;
      continue;
    }

    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (!valueOptions.includes(arg)) return { ok: false, error: `unknown option '${arg}'` };
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

/** Returns the exit code: 0 done, 1 a file failed validation or ingest, 2 usage. */
export function runMockCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.error);
    io.err(USAGE);
    return 2;
  }
  const { args } = parsed;

  const files = generateMock(args).map((file) => ({
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
      `(${String(args.subdomains)} subdomains of ${args.domain}, seed ${String(args.seed)})`,
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
  const db = openDb(dbPath);
  try {
    for (const f of files) {
      const result = ingestText(db, f.text);
      switch (result.status) {
        case 'invalid':
          io.err(`${f.tool}: rejected by ingest:`);
          for (const e of result.errors) io.err(`  ${e}`);
          return 1;
        case 'duplicate':
          io.out(`  ${f.tool.padEnd(9)} already ingested`);
          break;
        case 'ingested':
          io.out(
            `  ${f.tool.padEnd(9)} ${String(f.doc.findings.length).padStart(5)} findings, ` +
              `${String(result.created.nodes)} new nodes, ${String(result.created.edges)} new edges`,
          );
          break;
      }
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
