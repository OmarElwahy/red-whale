// What happens after a tool's container exits (docs/architecture.md §11): fetch /out and the logs (size caps
// enforced while reading), keep the raw output under data/jobs/<id>/, and put result.json through the normal
// ingest. A result that fails validation fails the job with the exact issues; nothing is "fixed" here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateContract } from '@redwhale/shared';
import type { Db } from '../db/client';
import { ingestText, type IngestResult } from '../ingest/ingest';
import type { FinishHook, FinishResult } from './orchestrator';
import type { CappedText, FetchedFile } from './runtime';

export const RAW_CAP_BYTES = 5 * 1024 * 1024;
/** Same as the API's upload limit. result.json is never truncated: over this, the job fails. */
export const RESULT_CAP_BYTES = 50 * 1024 * 1024;
/** Stop reading /out after this much, whatever is in it. */
export const OUTPUT_TOTAL_CAP_BYTES = RESULT_CAP_BYTES + RAW_CAP_BYTES + 1024 * 1024;

/** The raw files kept per job, as GET /jobs/:id/output/:stream names them. */
export const OUTPUT_STREAMS = { stdout: 'stdout.txt', stderr: 'stderr.txt', raw: 'raw.txt' } as const;
export type OutputStream = keyof typeof OUTPUT_STREAMS;

/** Raw job output lives next to the database: <db dir>/jobs/<id>/ (data/jobs/ by default). */
export function jobsDirFor(dbPath: string): string {
  return join(dirname(resolve(dbPath)), 'jobs');
}

export function jobDir(jobsDir: string, jobId: number): string {
  return join(jobsDir, String(jobId));
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function truncationNote(kept: number, size: number): string {
  return `\n[RED WHALE: truncated: kept the first ${String(kept)} of ${String(size)} bytes]\n`;
}

function save(dir: string, name: string, content: Buffer, size: number, truncated: boolean): void {
  writeFileSync(join(dir, name), truncated ? Buffer.concat([content, Buffer.from(truncationNote(content.length, size))]) : content);
}

const saveText = (dir: string, name: string, t: CappedText) => {
  const data = Buffer.from(t.text);
  save(dir, name, data, t.size, t.truncated);
};
const saveFile = (dir: string, name: string, f: FetchedFile) => {
  save(dir, name, f.data, f.size, f.truncated);
};

export interface IngestFinishOptions {
  db: Db;
  /** Where data/jobs/<id>/ lives. */
  jobsDir: string;
  /** After a file was ingested (to broadcast scan.ingested / graph.updated). */
  onIngested?: (result: Extract<IngestResult, { status: 'ingested' }>, tool: string) => void;
}

/** The finish hook the server uses: raw output kept, result.json ingested, the scan linked to the job. */
export function ingestFinish({ db, jobsDir, onIngested }: IngestFinishOptions): FinishHook {
  return async (runtime, { job, def, containerId, exitCode }) => {
    const dir = jobDir(jobsDir, job.id);
    mkdirSync(dir, { recursive: true });
    const notes: string[] = [];

    const logs = await runtime.logs(containerId, RAW_CAP_BYTES);
    saveText(dir, OUTPUT_STREAMS.stdout, logs.stdout);
    saveText(dir, OUTPUT_STREAMS.stderr, logs.stderr);

    const out = await runtime.fetchOutput(containerId, def.outputDir, {
      files: { 'result.json': RESULT_CAP_BYTES + 1, 'raw.txt': RAW_CAP_BYTES },
      maxTotalBytes: OUTPUT_TOTAL_CAP_BYTES,
    });
    const raw = out.files.get('raw.txt');
    if (raw) saveFile(dir, OUTPUT_STREAMS.raw, raw);
    if (raw?.truncated) notes.push(`raw.txt was ${mb(raw.size)}; kept the first ${mb(RAW_CAP_BYTES)}`);
    if (out.skipped.length > 0) {
      const list = out.skipped.map((s) => `${s.name} (${mb(s.size)})`).join(', ');
      notes.push(`ignored other files in ${def.outputDir}: ${list}`);
    }
    if (out.overLimit) notes.push(`${def.outputDir} held more than ${mb(OUTPUT_TOTAL_CAP_BYTES)}; stopped reading it`);

    const fail = (error: string, extra: Partial<FinishResult> = {}): FinishResult => ({
      status: 'failed',
      error: [error, ...notes].join('; '),
      ...extra,
    });

    const result = out.files.get('result.json');
    if (!result) return fail(`no result.json in ${def.outputDir} (exit code ${String(exitCode)})`);
    if (result.truncated) return fail(`result.json is ${mb(result.size)}, over the ${mb(RESULT_CAP_BYTES)} limit`);
    writeFileSync(join(dir, 'result.json'), result.data);

    const text = result.data.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined; // ingest reports the JSON error in its own words
    }
    // The tool name decides corroboration: a script must not report under another tool's name.
    const declared = typeof parsed === 'object' && parsed !== null && 'tool' in parsed ? parsed.tool : def.name;
    if (declared !== def.name) return fail(`result.json says tool ${JSON.stringify(declared)}, but this job ran '${def.name}'`);

    const ingested = ingestText(db, text);
    if (ingested.status === 'invalid') return fail('result.json does not follow the contract', { issues: ingested.errors });
    const doc = validateContract(parsed);
    const { status, errors: toolErrors } = doc.ok ? doc.data : { status: 'success', errors: [] };

    let linked: Partial<FinishResult>;
    if (ingested.status === 'duplicate') {
      linked = { scanId: ingested.scanId, nodesCreated: 0, nodesUpdated: 0 };
      notes.push('the same result was already ingested');
    } else {
      linked = {
        scanId: ingested.scanId,
        nodesCreated: ingested.created.nodes,
        nodesUpdated: ingested.nodeIds.length - ingested.created.nodes,
      };
      onIngested?.(ingested, def.name);
    }
    if (status === 'failed') return fail(`${def.name} reported failure: ${toolErrors.join('; ') || 'no reason given'}`, linked);
    if (status === 'partial') notes.unshift(`partial result: ${toolErrors.join('; ')}`);
    if (exitCode !== 0) notes.push(`exit code ${String(exitCode)}`);
    return { status: 'succeeded', error: notes.length > 0 ? notes.join('; ') : null, ...linked };
  };
}
