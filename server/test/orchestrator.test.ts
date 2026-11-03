// The job queue with a fake container runtime (docs/architecture.md §11): scope at queue and at start, concurrency,
// timeouts, cancelling, restarts and orphans.
import { nodeId } from '@redwhale/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { scopeLog } from '../src/db/schema';
import { ingestDocument } from '../src/ingest/ingest';
import { toolDefSchema, type GroupDef, type ToolDef } from '../src/runner/defs';
import { Orchestrator, RESTART_ERROR, type OrchestratorOptions, type ToolCatalog } from '../src/runner/orchestrator';
import { toolsNetwork } from '../src/runner/network';
import { LABEL_JOB, LABEL_WORKSPACE } from '../src/runner/spec';
import { addRule, patchRule, setSettings } from '../src/scope/store';
import { FakeRuntime, type FakeBehavior } from './fakeRuntime';
import { baseDoc, freshDb } from './helpers';

const IMAGE = 'redwhale-tools/subdomain:test';
const TOOLS = ['subfinder', 'assetfinder', 'findomain', 'crtsh'];

function def(name: string, patch: Partial<ToolDef> = {}): ToolDef {
  return toolDefSchema.parse({
    name,
    group: 'subdomain',
    label: name,
    mode: 'passive',
    accepts: ['domain'],
    argv: ['python3', `/opt/redwhale/subdomain/${name}/run.py`, '--target', '{target}', '--out', '/out'],
    timeoutSec: 600,
    external: [],
    outputDir: '/out',
    // active/intrusive tools must say what a run touches
    ...(patch.mode !== undefined && patch.mode !== 'passive' ? { contacts: 'probes {target}' } : {}),
    ...patch,
  });
}

function catalog(defs: ToolDef[] = TOOLS.map((n) => def(n))): ToolCatalog {
  const group: GroupDef = { name: 'subdomain', label: 'subdomain enumeration', image: 'redwhale-tools/subdomain', tools: defs.map((d) => d.name) };
  return {
    tool: (name) => defs.find((d) => d.name === name),
    group: (name) => (name === 'subdomain' ? group : undefined),
    imageRef: () => IMAGE,
  };
}

const DOMAIN = nodeId('domain', 'example.com');
const OTHER = nodeId('domain', 'other.example');
const SUB = nodeId('subdomain', 'a.example.com');

function setup(behave?: (name: string) => FakeBehavior, options: Partial<OrchestratorOptions> = {}) {
  const db = freshDb();
  ingestDocument(
    db,
    baseDoc({
      findings: [
        { type: 'domain', value: 'example.com' },
        { type: 'domain', value: 'other.example' },
        { type: 'subdomain', value: 'a.example.com', parent: { type: 'domain', value: 'example.com' }, relation: 'has_subdomain' },
      ],
    }),
  );
  const rule = addRule(db, { kind: 'domain', value: 'example.com', action: 'include' });
  const other = addRule(db, { kind: 'domain', value: 'other.example', action: 'include' });
  const rt = new FakeRuntime((spec) => behave?.(spec.body.Labels['redwhale.tool'] ?? '') ?? {});
  rt.addImage(IMAGE);
  const events: { id: number; status: string }[] = [];
  const orch = new Orchestrator({
    db,
    runtime: rt,
    catalog: catalog(),
    onJob: (j) => events.push({ id: j.id, status: j.status }),
    ...options,
  });
  return { db, rt, orch, rule, other, events };
}

/** Lets the queue's async steps (create, start) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const logRow = (db: ReturnType<typeof freshDb>, id: number | null) =>
  db.select().from(scopeLog).where(eq(scopeLog.id, id ?? -1)).get();

describe('scope', () => {
  test('an out-of-scope target is refused at queueing, logged, and no container is created', async () => {
    const { db, rt, orch, rule } = setup();
    patchRule(db, rule.id, { removed: true });
    const result = orch.enqueue('subfinder', DOMAIN);
    expect(result).toMatchObject({ ok: false, code: 'refused' });
    if (result.ok || result.code !== 'refused') return;
    const [job] = result.jobs;
    expect(job).toMatchObject({ status: 'refused', tool: 'subfinder', targetValue: 'example.com' });
    expect(job?.error).toMatch(/^out of scope: /);
    expect(logRow(db, job?.queuedScopeLogId ?? null)).toMatchObject({ source: 'run', decision: 'out', targetValue: 'example.com' });
    await orch.idle();
    expect(rt.created).toEqual([]);
    expect(rt.calls.filter((c) => c.op === 'create')).toEqual([]);
  });

  test('an in-scope job is authorized twice (queue, start), runs, and leaves nothing behind', async () => {
    const { db, rt, orch } = setup();
    const result = orch.enqueue('subfinder', DOMAIN);
    expect(result.ok).toBe(true);
    await orch.idle();
    const job = orch.get(1);
    expect(job).toMatchObject({ status: 'succeeded', exitCode: 0, image: IMAGE });
    expect(job?.argv).toEqual(['python3', '/opt/redwhale/subdomain/subfinder/run.py', '--target', 'example.com', '--out', '/out']);
    expect(job?.scopeLogId).not.toBe(job?.queuedScopeLogId);
    expect(logRow(db, job?.scopeLogId ?? null)).toMatchObject({ source: 'run', decision: 'in' });
    expect(rt.created).toHaveLength(1);
    expect(rt.containers.size).toBe(0);
    expect(rt.volumes.size).toBe(0);
  });

  test('every job joins the tools network, ensured right before its container is created', async () => {
    const { rt, orch } = setup();
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    const ops = rt.calls.map((c) => c.op);
    expect(ops.indexOf('ensureNetwork')).toBeGreaterThan(-1);
    expect(ops.indexOf('ensureNetwork')).toBeLessThan(ops.indexOf('create'));
    expect(rt.calls.find((c) => c.op === 'ensureNetwork')?.arg).toBe('redwhale-tools');
    expect(rt.networks.get('redwhale-tools')?.subnet).toBe('172.29.250.0/24');
    expect(rt.created[0]?.body.HostConfig.NetworkMode).toBe('redwhale-tools');
  });

  test('the subnet comes from the orchestrator options (REDWHALE_NET_SUBNET in the server)', async () => {
    const { rt, orch } = setup(undefined, { network: toolsNetwork({ REDWHALE_NET_SUBNET: '10.77.0.0/16' }) });
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(rt.networks.get('redwhale-tools')?.subnet).toBe('10.77.0.0/16');
  });

  test('a network failure (subnet clash) fails the job with its message; no container is created', async () => {
    const { rt, orch } = setup();
    rt.networkError = "can't create the Docker network 'redwhale-tools': subnet 172.29.250.0/24 overlaps another Docker network";
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'failed', error: rt.networkError });
    expect(rt.created).toEqual([]);
    expect(rt.volumes.size).toBe(0);
  });

  describe('active runs need the analyst’s confirmation', () => {
    const rowCounts = (db: ReturnType<typeof freshDb>) => ({
      jobs: db.$client.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number },
      log: db.$client.prepare('SELECT count(*) AS n FROM scope_log').get() as { n: number },
    });
    const activeCatalog = () =>
      catalog([
        def('subfinder'),
        def('prober', { mode: 'active', accepts: ['domain', 'subdomain'] }),
        def('breaker', { mode: 'intrusive', accepts: ['subdomain'] }),
      ]);

    test.each(['prober', 'breaker'])('%s without confirmActive: confirm-required, before authorize (no job, no scope log)', async (tool) => {
      const { db, rt, orch } = setup(undefined, { catalog: activeCatalog() });
      setSettings(db, { passiveOnly: false });
      const result = orch.enqueue(tool, SUB);
      expect(result).toMatchObject({ ok: false, code: 'confirm-required' });
      if (!result.ok) expect(result.error).toMatch(new RegExp(`^${tool} \\((active|intrusive)\\) would contact a\\.example\\.com directly`));
      expect(orch.enqueue(tool, SUB, { confirmActive: false })).toMatchObject({ ok: false, code: 'confirm-required' });
      expect(rowCounts(db)).toEqual({ jobs: { n: 0 }, log: { n: 0 } });
      await orch.idle();
      expect(rt.created).toEqual([]);
    });

    test('confirmed, it is authorized and queued like any job (the scope still decides)', async () => {
      const { db, orch } = setup(undefined, { catalog: activeCatalog() });
      addRule(db, { kind: 'wildcard', value: '*.example.com', action: 'include' });
      // passive-only is on: confirmed, but the scope refuses it (logged, kept as refused)
      expect(orch.enqueue('prober', SUB, { confirmActive: true })).toMatchObject({ ok: false, code: 'refused' });
      setSettings(db, { passiveOnly: false });
      const ok = orch.enqueue('prober', SUB, { confirmActive: true });
      expect(ok).toMatchObject({ ok: true, jobs: [{ tool: 'prober', mode: 'active', status: 'queued' }] });
      await orch.idle();
      expect(orch.get(2)?.status).toBe('succeeded');
    });

    test('passive tools never need it', async () => {
      const { orch } = setup(undefined, { catalog: activeCatalog() });
      expect(orch.enqueue('subfinder', DOMAIN)).toMatchObject({ ok: true });
      await orch.idle();
    });

    test('a group needs it when a tool that takes the node is active; tools that don’t take it don’t count', async () => {
      const { db, orch } = setup(undefined, { catalog: activeCatalog() });
      setSettings(db, { passiveOnly: false });
      // on a domain: subfinder (passive) + prober (active) would run; breaker doesn't take domains
      expect(orch.enqueueGroup('subdomain', DOMAIN)).toMatchObject({ ok: false, code: 'confirm-required' });
      expect(rowCounts(db).jobs.n).toBe(0);
      const confirmed = orch.enqueueGroup('subdomain', DOMAIN, { confirmActive: true });
      expect(confirmed.ok && confirmed.jobs.map((j) => j.tool)).toEqual(['subfinder', 'prober']);

      const passiveOnlyGroup = setup(undefined, {
        catalog: catalog([def('subfinder'), def('breaker', { mode: 'intrusive', accepts: ['subdomain'] })]),
      });
      expect(passiveOnlyGroup.orch.enqueueGroup('subdomain', DOMAIN)).toMatchObject({ ok: true, jobs: [{ tool: 'subfinder' }] });
      await orch.idle();
      await passiveOnlyGroup.orch.idle();
    });
  });

  test('a scope change cancels a queued job that is now out of scope (not the running one)', async () => {
    const { db, orch, other } = setup((name) => (name === 'subfinder' ? { hang: true } : {}), { maxConcurrent: 1 });
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('assetfinder', OTHER);
    await Promise.resolve();
    expect(orch.get(2)?.status).toBe('queued');

    patchRule(db, other.id, { removed: true });
    const cancelled = orch.onScopeChanged();
    expect(cancelled.map((j) => j.id)).toEqual([2]);
    expect(orch.get(2)).toMatchObject({ status: 'cancelled' });
    expect(orch.get(2)?.error).toMatch(/^scope changed: /);
    expect(orch.get(1)?.status).toBe('running');
    orch.cancel(1);
    await orch.idle();
  });

  test('passive-only switching on cancels queued active jobs', async () => {
    const { db, orch } = setup(() => ({ hang: true }), {
      maxConcurrent: 1,
      catalog: catalog([def('subfinder'), def('probe', { mode: 'active' })]),
    });
    setSettings(db, { passiveOnly: false });
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('probe', DOMAIN, { confirmActive: true });
    expect(orch.get(2)?.status).toBe('queued');
    setSettings(db, { passiveOnly: true });
    expect(orch.onScopeChanged().map((j) => j.id)).toEqual([2]);
    orch.cancel(1);
    await orch.idle();
  });

  test('the re-check at start refuses a job that became out of scope, and creates no container for it', async () => {
    const { db, rt, orch, other } = setup((name) => (name === 'subfinder' ? { hang: true } : {}), { maxConcurrent: 1 });
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('assetfinder', OTHER);
    patchRule(db, other.id, { removed: true }); // no onScopeChanged(): only the start-time check stands in the way
    orch.cancel(1);
    await orch.idle();
    const job = orch.get(2);
    expect(job).toMatchObject({ status: 'refused' });
    expect(job?.error).toMatch(/^out of scope at start: /);
    expect(logRow(db, job?.scopeLogId ?? null)).toMatchObject({ source: 'run', decision: 'out' });
    expect(rt.created.map((s) => s.body.Labels['redwhale.tool'])).toEqual(['subfinder']);
  });
});

describe('queue', () => {
  test('a group run of 4 tools with cap 2 never has more than 2 running, and all finish', async () => {
    let maxRunning = 0;
    const { rt, orch } = setup(() => ({ delayMs: 15 }), {
      onJob: () => {
        maxRunning = Math.max(maxRunning, orch.counts().running);
      },
    });
    const result = orch.enqueueGroup('subdomain', DOMAIN);
    expect(result.ok && result.jobs.map((j) => j.tool)).toEqual(TOOLS);
    expect(orch.counts()).toEqual({ running: 2, queued: 2 });
    expect(rt.running()).toBeLessThanOrEqual(2);
    await orch.idle();
    expect(maxRunning).toBe(2);
    expect(orch.pending()).toEqual([]);
    expect(TOOLS.map((_, i) => orch.get(i + 1)?.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    // Each job its own decision at queueing and at start.
    const ids = TOOLS.flatMap((_, i) => [orch.get(i + 1)?.queuedScopeLogId, orch.get(i + 1)?.scopeLogId]);
    expect(new Set(ids).size).toBe(8);
  });

  test('a timeout kills the container and fails the job', async () => {
    const { rt, orch } = setup(() => ({ hang: true }), { timeoutMs: () => 20 });
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'failed', exitCode: 137 });
    expect(orch.get(1)?.error).toMatch(/^timed out after 600 s/);
    expect(rt.calls.some((c) => c.op === 'kill')).toBe(true);
    expect(rt.containers.size).toBe(0);
    expect(rt.volumes.size).toBe(0);
  });

  test('cancel: a queued job never starts; a running one is killed and not finished; a finished one says so', async () => {
    const { rt, orch } = setup(() => ({ hang: true }), { maxConcurrent: 1 });
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('assetfinder', DOMAIN);
    await tick();
    expect(orch.cancel(2)).toMatchObject({ ok: true, job: { status: 'cancelled' } });
    expect(orch.cancel(1)).toMatchObject({ ok: true });
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'cancelled', error: 'cancelled by the analyst', exitCode: 137 });
    expect(rt.created).toHaveLength(1);
    expect(orch.cancel(1)).toMatchObject({ ok: false, code: 'finished' });
    expect(orch.cancel(99)).toMatchObject({ ok: false, code: 'unknown' });
  });

  test('a non-zero exit fails the job; an engine error fails it with the message and still cleans up', async () => {
    const { rt, orch } = setup((name) => (name === 'subfinder' ? { exitCode: 2 } : { startError: 'OCI runtime create failed' }));
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('assetfinder', DOMAIN);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'failed', exitCode: 2, error: 'exited with code 2' });
    expect(orch.get(2)).toMatchObject({ status: 'failed', error: 'OCI runtime create failed' });
    expect(rt.containers.size).toBe(0);
    expect(rt.volumes.size).toBe(0);
  });

  test('unknown tool, unknown node and a type the tool does not take are errors without a job', () => {
    const { orch } = setup();
    expect(orch.enqueue('nmap', DOMAIN)).toMatchObject({ ok: false, code: 'unknown-tool' });
    expect(orch.enqueue('subfinder', 'nope')).toMatchObject({ ok: false, code: 'unknown-node' });
    expect(orch.enqueue('subfinder', SUB)).toMatchObject({ ok: false, code: 'wrong-type' });
    expect(orch.enqueueGroup('ports', DOMAIN)).toMatchObject({ ok: false, code: 'unknown-group' });
    expect(orch.get(1)).toBeUndefined();
  });

  test('every change is reported (job.updated)', async () => {
    const { orch, events } = setup();
    orch.enqueue('subfinder', DOMAIN);
    await orch.idle();
    expect(events.filter((e) => e.id === 1).map((e) => e.status)).toEqual(['queued', 'running', 'running', 'succeeded']);
  });
});

describe('restarts, orphans and Docker going away', () => {
  test('a restart fails running jobs, kills and removes our labeled containers and volumes, and resumes the queue', async () => {
    const { db, rt, orch } = setup(() => ({ hang: true }), { maxConcurrent: 1 });
    orch.enqueue('subfinder', DOMAIN);
    orch.enqueue('assetfinder', DOMAIN);
    await tick(); // network, then the container
    orch.stop(); // "the server died": the container keeps running, the row says running
    // Another workspace's container on the same Docker must survive our cleanup.
    rt.addImage('other');
    const [first] = rt.created;
    if (!first) throw new Error('job 1 has no container');
    const labels = { [LABEL_WORKSPACE]: 'someone-else', [LABEL_JOB]: '1' };
    const foreign = await rt.create({ name: 'x', volume: { Name: 'x', Labels: labels }, body: { ...first.body, Image: 'other', Labels: labels } });

    rt.behave = () => ({});
    const next = new Orchestrator({ db, runtime: rt, catalog: catalog(), maxConcurrent: 1 });
    await next.recover();
    expect(next.get(1)).toMatchObject({ status: 'failed', error: RESTART_ERROR });
    expect([...rt.containers.keys()]).toContain(foreign);
    expect(rt.calls.some((c) => c.op === 'kill' && c.arg === 'fake00000001')).toBe(true);
    expect(rt.calls.some((c) => c.op === 'removeContainer' && c.arg === 'fake00000001')).toBe(true);
    await next.idle();
    expect(next.get(2)).toMatchObject({ status: 'succeeded' });
    expect([...rt.volumes.keys()]).toEqual(['x']); // ours (job 1's and job 2's) are gone, the other workspace's stays
  });

  test('while Docker is unreachable jobs stay queued; when it comes back they start', async () => {
    const changes: boolean[] = [];
    const { rt, orch } = setup(undefined, { onRunnerChange: (p) => changes.push(p.ok) });
    rt.reachable = false;
    await orch.checkRunner();
    orch.enqueue('subfinder', DOMAIN);
    expect(orch.get(1)?.status).toBe('queued');
    rt.reachable = true;
    await orch.checkRunner();
    await orch.idle();
    expect(orch.get(1)?.status).toBe('succeeded');
    expect(changes).toEqual([false, true]);
  });
});
