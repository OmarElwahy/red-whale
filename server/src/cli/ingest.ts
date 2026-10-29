// `pnpm ingest <file.json> [--db path]`: load one tool-output file into the workspace database.
import { readFileSync } from 'node:fs';
import { DEFAULT_DB_PATH, openDb } from '../db/client';
import { ingestText } from '../ingest/ingest';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = 'usage: pnpm ingest <file.json> [--db path]   (or set REDWHALE_DB)';

type Args = { ok: true; file: string; db: string | undefined } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let db: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') continue;
    if (arg === '--db') {
      db = argv[++i];
      if (db === undefined) return { ok: false, error: '--db needs a path' };
    } else if (arg.startsWith('--db=')) {
      db = arg.slice('--db='.length);
    } else if (arg.startsWith('-')) {
      return { ok: false, error: `unknown option '${arg}'` };
    } else {
      positional.push(arg);
    }
  }
  const [file, ...rest] = positional;
  if (file === undefined || rest.length > 0) return { ok: false, error: 'expected exactly one file' };
  return { ok: true, file, db };
}

/** Returns the exit code: 0 ingested or already ingested, 1 rejected, 2 usage / unreadable file. */
export function runIngestCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): number {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(args.error);
    io.err(USAGE);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(args.file, 'utf8');
  } catch (e) {
    io.err(`cannot read ${args.file}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const db = openDb(args.db ?? env.REDWHALE_DB ?? DEFAULT_DB_PATH);
  try {
    const result = ingestText(db, text);
    switch (result.status) {
      case 'invalid':
        io.err(`Rejected ${args.file}: ${String(result.errors.length)} error(s)`);
        for (const e of result.errors) io.err(`  ${e}`);
        return 1;
      case 'duplicate':
        io.out(`Already ingested as scan ${result.scanId}; nothing to do.`);
        break;
      case 'ingested':
        io.out(
          `Ingested ${args.file} as scan ${result.scanId}: ` +
            `${String(result.nodeIds.length)} nodes (${String(result.created.nodes)} new), ` +
            `${String(result.edgeIds.length)} edges (${String(result.created.edges)} new), ` +
            `${String(result.observations)} observations`,
        );
        break;
    }
    for (const w of result.warnings) io.err(`warning: ${w}`);
    return 0;
  } finally {
    db.$client.close();
  }
}
