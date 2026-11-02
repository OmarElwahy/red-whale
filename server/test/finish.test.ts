// A job's result through the normal ingest (docs/architecture.md §12), with the fake runtime: scan linked, raw output
// kept and capped, invalid results failing with their issues, and two tools corroborating a subdomain.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { edgeId, nodeId } from '@redwhale/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { edges, nodes, scans } from '../src/db/schema';
import { ingestDocument } from '../src/ingest/ingest';
import { toolDefSchema, type ToolDef } from '../src/runner/defs';
import { RAW_CAP_BYTES, RESULT_CAP_BYTES, ingestFinish } from '../src/runner/finish';
import { Orchestrator, type ToolCatalog } from '../src/runner/orchestrator';
import { addRule } from '../src/scope/store';
import { FakeRuntime, type FakeBehavior } from './fakeRuntime';
import { baseDoc, freshDb, tempDir } from './helpers';

const IMAGE = 'redwhale-tools/subdomain:test';
const TOOLS = ['subfinder', 'crtsh'];
const DOMAIN = nodeId('domain', 'example.com');

function def(name: string): ToolDef {
  return toolDefSchema.parse({
    name, group: 'subdomain', label: name, mode: 'passive', accepts: ['domain'],
    argv: ['python3', `/opt/redwhale/subdomain/${name}/run.py`, '--target', '{target}', '--out', '/out'],
    timeoutSec: 600, external: [], outputDir: '/out',
  });
}

const catalog: ToolCatalog = {
  tool: (name) => (TOOLS.includes(name) ? def(name) : undefined),
  group: (name) => (name === 'subdomain' ? { name, label: 'subdomain enumeration', image: 'redwhale-tools/subdomain', tools: TOOLS } : undefined),
  imageRef: () => IMAGE,
};

/** The result.json a subdomain tool writes. */
function result(tool: string, subs: string[], patch: Record<string, unknown> = {}): string {
  return JSON.stringify(
    baseDoc({
      tool,
      command: `${tool} -d example.com`,
      findings: subs.map((s) => ({ type: 'subdomain', value: s, parent: { type: 'domain', value: 'example.com' }, relation: 'has_subdomain' })),
      ...patch,
    }),
  );
}

function setup(behave: (tool: string) => FakeBehavior, options: { timeoutMs?: () => number } = {}) {
  const db = freshDb();
  ingestDocument(db, baseDoc({ tool: 'seed', findings: [{ type: 'domain', value: 'example.com' }] }));
  addRule(db, { kind: 'domain', value: 'example.com', action: 'include' });
  const jobsDir = join(tempDir(), 'jobs');
  const ingested: string[] = [];
  const rt = new FakeRuntime((spec) => behave(spec.body.Labels['redwhale.tool'] ?? ''));
  rt.addImage(IMAGE);
  const orch = new Orchestrator({
    db,
    runtime: rt,
    catalog,
    finish: ingestFinish({ db, jobsDir, onIngested: (r, tool) => ingested.push(`${tool}:${r.scanId}`) }),
    ...options,
  });
  return { db, rt, orch, jobsDir, ingested };
}

const file = (jobsDir: string, id: number, name: string) => readFileSync(join(jobsDir, String(id), name), 'utf8');

describe('a finished job', () => {
  test('is ingested, linked to its scan, counted, and its raw output kept', async () => {
    const { db, orch, jobsDir, ingested } = setup(() => ({
      files: { 'result.json': result('subfinder', ['a.example.com', 'b.example.com']), 'raw.txt': '{"host":"a.example.com"}\n' },
      stdout: '',
      stderr: '[run] subfinder -d example.com\n',
    }));
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    const job = orch.get(1);
    expect(job).toMatchObject({ status: 'succeeded', error: null, nodesCreated: 2, nodesUpdated: 1 });
    expect(job?.scanId).toBeTruthy();
    expect(db.select().from(scans).where(eq(scans.id, job?.scanId ?? '')).get()).toMatchObject({ tool: 'subfinder' });
    expect(ingested).toEqual([`subfinder:${job?.scanId ?? ''}`]);
    expect(file(jobsDir, 1, 'raw.txt')).toBe('{"host":"a.example.com"}\n');
    expect(file(jobsDir, 1, 'stderr.txt')).toContain('[run] subfinder');
    expect(file(jobsDir, 1, 'stdout.txt')).toBe('');
    expect(JSON.parse(file(jobsDir, 1, 'result.json'))).toMatchObject({ tool: 'subfinder' });
  });

  test('two tools reporting the same subdomain make it (and its edge) corroborated', async () => {
    const { db, orch } = setup((tool) => ({
      files: { 'result.json': result(tool, tool === 'subfinder' ? ['shared.example.com', 'only-sf.example.com'] : ['shared.example.com']) },
    }));
    const group = orch.enqueueGroup('subdomain', DOMAIN);
    expect(group.ok && group.jobs.length).toBe(2);
    await orch.idle();
    expect([orch.get(1)?.status, orch.get(2)?.status]).toEqual(['succeeded', 'succeeded']);
    const node = (v: string) => db.select().from(nodes).where(eq(nodes.id, nodeId('subdomain', v))).get();
    expect(node('shared.example.com')).toMatchObject({ confidence: 'corroborated', sourceCount: 2 });
    expect(node('only-sf.example.com')).toMatchObject({ confidence: 'discovered', sourceCount: 1 });
    const edge = db.select().from(edges).where(eq(edges.id, edgeId(DOMAIN, 'has_subdomain', nodeId('subdomain', 'shared.example.com')))).get();
    expect(edge).toMatchObject({ confidence: 'corroborated', sourceCount: 2 });
    expect(orch.get(2)).toMatchObject({ nodesCreated: 0, nodesUpdated: 2 });
  });

  test('an invalid result.json fails the job with the exact issues, and ingests nothing', async () => {
    const bad = JSON.parse(result('subfinder', ['a.example.com'])) as { findings: { value: string }[] };
    bad.findings.push({ type: 'subdomain', value: '*.example.com' } as never);
    const { db, orch } = setup(() => ({ files: { 'result.json': JSON.stringify(bad) } }));
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    const job = orch.get(1);
    expect(job).toMatchObject({ status: 'failed', error: 'result.json does not follow the contract', scanId: null });
    expect(job?.issues?.join('\n')).toMatch(/findings\[1\]\.value: .*wildcards like/);
    expect(db.select().from(scans).all().map((s) => s.tool)).toEqual(['seed']);
  });

  test('a result under another tool name is refused (no borrowed corroboration)', async () => {
    const { db, orch } = setup(() => ({ files: { 'result.json': result('crtsh', ['a.example.com']) } }));
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'failed', error: `result.json says tool "crtsh", but this job ran 'subfinder'` });
    expect(db.select().from(scans).all()).toHaveLength(1);
  });

  test('no result.json fails with the exit code; not JSON fails through ingest', async () => {
    const { orch } = setup((tool) => (tool === 'subfinder' ? { exitCode: 3, stderr: 'boom' } : { files: { 'result.json': '{oops' } }));
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('crtsh', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'failed', error: 'no result.json in /out (exit code 3)' });
    expect(orch.get(2)).toMatchObject({ status: 'failed' });
    expect(orch.get(2)?.issues?.[0]).toMatch(/^not valid JSON/);
  });

  test('a tool that reports failure fails the job, but its scan is still provenance', async () => {
    const { orch } = setup(() => ({ files: { 'result.json': result('subfinder', [], { status: 'failed', errors: ['rate limited'] }) } }));
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'failed', error: 'subfinder reported failure: rate limited', nodesCreated: 0 });
    expect(orch.get(1)?.scanId).toBeTruthy();
  });

  test('a partial result succeeds with a note; a repeat of the same file links the existing scan', async () => {
    const doc = result('subfinder', ['a.example.com'], { status: 'partial', errors: ['source x timed out'] });
    const { orch } = setup(() => ({ files: { 'result.json': doc } }));
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'succeeded', error: 'partial result: source x timed out' });
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(2)).toMatchObject({ status: 'succeeded', scanId: orch.get(1)?.scanId, nodesCreated: 0, nodesUpdated: 0 });
    expect(orch.get(2)?.error).toContain('the same result was already ingested');
  });

  test('size caps: raw.txt is truncated with a note, extra files are reported, an oversized result fails', async () => {
    const big = 'r'.repeat(RAW_CAP_BYTES + 10);
    const { orch, jobsDir } = setup((tool): FakeBehavior =>
      tool === 'subfinder'
        ? { files: { 'result.json': result('subfinder', ['a.example.com']), 'raw.txt': big, 'core.dump': Buffer.alloc(3 * 1024 * 1024) } }
        : { files: { 'result.json': `${' '.repeat(RESULT_CAP_BYTES + 5)}{}` } },
    );
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('crtsh', DOMAIN);
    await orch.idle();
    expect(orch.get(1)?.status).toBe('succeeded');
    expect(orch.get(1)?.error).toBe('raw.txt was 5.0 MB; kept the first 5.0 MB; ignored other files in /out: core.dump (3.0 MB)');
    const raw = file(jobsDir, 1, 'raw.txt');
    expect(raw.startsWith('r'.repeat(1000))).toBe(true);
    expect(raw).toContain(`[RED WHALE: truncated: kept the first ${String(RAW_CAP_BYTES)} of ${String(RAW_CAP_BYTES + 10)} bytes]`);
    expect(orch.get(2)).toMatchObject({ status: 'failed', error: 'result.json is 50.0 MB, over the 50.0 MB limit' });
  });

  test('a timed-out tool that still wrote a partial result: failed, but what it found is ingested', async () => {
    const { orch, jobsDir } = setup(() => ({ hang: true, files: { 'result.json': result('subfinder', ['a.example.com'], { status: 'partial', errors: ['timed out'] }) } }), {
      timeoutMs: () => 20,
    });
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    const job = orch.get(1);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/^timed out after 600 s; the container was killed; partial result: timed out/);
    expect(job?.scanId).toBeTruthy();
    expect(existsSync(join(jobsDir, '1', 'stdout.txt'))).toBe(true);
  });
});
