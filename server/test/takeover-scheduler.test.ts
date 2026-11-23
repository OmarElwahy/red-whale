// The automatic takeover checks (TW-2) with a fake container runtime and a fake clock.
import { nodeId, type WsEvent } from '@redwhale/shared';
import { asc } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { jobs as jobsTable } from '../src/db/schema';
import { jobDto } from '../src/routes/jobs';
import { ingestDocument } from '../src/ingest/ingest';
import { toolDefSchema, type GroupDef, type ToolDef } from '../src/runner/defs';
import { Orchestrator, type JobRow, type ToolCatalog } from '../src/runner/orchestrator';
import { addRule, setSettings } from '../src/scope/store';
import { AUTO_OFF_ERROR, TakeoverScheduler, autoMaxQueued } from '../src/takeover/scheduler';
import { FakeRuntime, type FakeBehavior } from './fakeRuntime';
import { baseDoc, freshDb } from './helpers';

const IMAGE = 'redwhale-tools/dns:test';
const OWN = 'northwind.example';
const sub = (n: string) => `${n}.${OWN}`;
const idOf = (n: string) => nodeId('subdomain', sub(n));

function def(name: string, mode: 'passive' | 'active' = 'passive'): ToolDef {
  return toolDefSchema.parse({
    name,
    group: 'dns',
    label: name,
    mode,
    accepts: ['subdomain'],
    argv: ['python3', `/opt/redwhale/dns/${name}/run.py`, '--target', '{target}', '--out', '/out'],
    timeoutSec: 300,
    external: [],
    outputDir: '/out',
    ...(mode === 'passive' ? {} : { contacts: 'probes {target}' }),
  });
}

function catalog(): ToolCatalog {
  const defs = [def('takeover-check'), def('dnsx')];
  const group: GroupDef = { name: 'dns', label: 'DNS', image: 'redwhale-tools/dns', tools: defs.map((d) => d.name) };
  return { tool: (n) => defs.find((d) => d.name === n), group: (n) => (n === 'dns' ? group : undefined), imageRef: () => IMAGE };
}

class Clock {
  t = new Date('2026-12-01T12:00:00.000Z').getTime();
  now = () => new Date(this.t);
  hours(h: number) {
    this.t += h * 3_600_000;
  }
}

/** Lets the queue's async steps run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(options: { names?: string[]; behave?: FakeBehavior; maxQueued?: number; maxConcurrent?: number } = {}) {
  const db = freshDb();
  const clock = new Clock();
  const names = options.names ?? ['a', 'b', 'c', 'd', 'e'];
  ingestDocument(
    db,
    baseDoc({
      tool: 'subfinder',
      target: OWN,
      findings: [
        ...names.map((n) => ({ type: 'subdomain', value: sub(n), parent: { type: 'domain', value: OWN }, relation: 'has_subdomain' })),
        { type: 'subdomain', value: 'x.elsewhere.example', parent: { type: 'domain', value: 'elsewhere.example' }, relation: 'has_subdomain' },
      ],
    }),
    clock.now(),
  );
  addRule(db, { kind: 'wildcard', value: `*.${OWN}`, action: 'include' });
  const rt = new FakeRuntime(() => options.behave ?? { hang: true });
  rt.addImage(IMAGE);
  const events: WsEvent[] = [];
  let scheduler: TakeoverScheduler | null = null;
  const orch = new Orchestrator({
    db,
    runtime: rt,
    catalog: catalog(),
    maxConcurrent: options.maxConcurrent ?? 1,
    now: clock.now,
    onJob: (j) => {
      const event: WsEvent = { type: 'job.updated', job: jobDto(j) };
      events.push(event);
      scheduler?.onEvent(event);
    },
  });
  scheduler = new TakeoverScheduler({ db, orchestrator: orch, maxQueued: options.maxQueued ?? 3, now: clock.now });
  const s = scheduler;
  const jobs = (): JobRow[] => db.select().from(jobsTable).orderBy(asc(jobsTable.id)).all();
  const byStatus = (status: string, trigger = 'auto') => jobs().filter((j) => j.status === status && j.trigger === trigger);
  return { db, rt, orch, s, clock, events, jobs, byStatus };
}

/** A takeover-check scan of one subdomain, finished at the clock's time minus `hoursAgo`. */
function checked(env: ReturnType<typeof setup>, name: string, hoursAgo: number) {
  const at = new Date(env.clock.t - hoursAgo * 3_600_000).toISOString();
  ingestDocument(env.db, baseDoc({ tool: 'takeover-check', target: sub(name), command: `tc ${name} ${at}`, started_at: at, finished_at: at }), env.clock.now());
}

describe('which subdomains are due', () => {
  test('in scope only; never checked first, then the oldest check; a check in the last 24 h is skipped', async () => {
    const env = setup();
    await env.orch.recover();
    checked(env, 'a', 30);
    checked(env, 'b', 48);
    checked(env, 'c', 2);
    expect(env.s.due().map((d) => d.value)).toEqual([sub('d'), sub('e'), sub('b'), sub('a')]);
  });

  test('a queued or running job (any trigger) and an auto attempt in 24 h (failed too) block it; a cancel by turning off does not', async () => {
    const env = setup({ behave: { exitCode: 1 }, maxConcurrent: 2 });
    await env.orch.recover();
    env.orch.enqueue('takeover-check', idOf('a'), { trigger: 'auto' }); // fails at once
    await settle();
    expect(env.jobs()[0]).toMatchObject({ status: 'failed', trigger: 'auto' });
    env.rt.behave = () => ({ hang: true });
    env.orch.enqueue('dnsx', idOf('b')); // another tool: doesn't block
    env.orch.enqueue('takeover-check', idOf('c')); // manual, running
    await settle();
    env.db.$client
      .prepare(
        `INSERT INTO jobs (tool, tool_group, node_id, target_type, target_value, mode, status, trigger, queued_scope_log_id, timeout_sec, created_at, error)
         VALUES ('takeover-check', 'dns', ?, 'subdomain', ?, 'passive', 'cancelled', 'auto', 1, 300, ?, ?)`,
      )
      .run(idOf('d'), sub('d'), env.clock.now().toISOString(), AUTO_OFF_ERROR);
    expect(env.s.due().map((d) => d.value)).toEqual([sub('b'), sub('d'), sub('e')]);

    // The failed auto attempt is retried after 24 h, like a success.
    env.clock.hours(25);
    expect(env.s.due().map((d) => d.value)).toContain(sub('a'));
  });
});

describe('a tick', () => {
  test('queues at most maxQueued auto jobs (queued, not running), through authorize()', async () => {
    const env = setup({ maxQueued: 3 });
    await env.orch.recover();
    const created = await env.s.tick();
    await settle();
    expect(created.map((j) => j.targetValue)).toEqual([sub('a'), sub('b'), sub('c')]);
    expect(env.byStatus('running').map((j) => j.targetValue)).toEqual([sub('a')]);
    expect(env.byStatus('queued').map((j) => j.targetValue)).toEqual([sub('b'), sub('c')]);
    for (const j of env.jobs()) expect(j.queuedScopeLogId).toBeGreaterThan(0);

    // One queued slot is free (a started): the next tick fills exactly that one.
    expect((await env.s.tick()).map((j) => j.targetValue)).toEqual([sub('d')]);
    expect(await env.s.tick()).toEqual([]);
    expect(env.byStatus('queued')).toHaveLength(3);
  });

  test('nothing, no job row and no scope log, while Docker is down, the image is missing or there is no takeover-check', async () => {
    const env = setup();
    env.rt.reachable = false;
    await env.orch.recover();
    expect(await env.s.tick()).toEqual([]);
    env.rt.reachable = true;
    await env.orch.checkRunner();
    env.rt.images.clear();
    expect(await env.s.tick()).toEqual([]);
    expect(env.jobs()).toEqual([]);
    expect(env.db.$client.prepare('SELECT COUNT(*) AS n FROM scope_log').get()).toEqual({ n: 0 });
  });

  test('out-of-scope subdomains are never queued or logged', async () => {
    const env = setup({ names: ['a'], maxQueued: 10 });
    await env.orch.recover();
    await env.s.tick();
    expect(env.jobs().map((j) => j.targetValue)).toEqual([sub('a')]);
    expect(env.db.$client.prepare("SELECT target_value FROM scope_log").all()).toEqual([{ target_value: sub('a') }, { target_value: sub('a') }]);
  });

  test('manual jobs start before queued auto jobs; a running auto job is not stopped', async () => {
    const env = setup({ maxQueued: 3 });
    await env.orch.recover();
    await env.s.tick();
    await settle();
    const manual = env.orch.enqueue('dnsx', idOf('e'));
    expect(manual.ok).toBe(true);
    await settle();
    expect(env.byStatus('running').map((j) => j.targetValue)).toEqual([sub('a')]);
    const running = env.byStatus('running')[0];
    if (!running) throw new Error('no running job');
    env.orch.cancel(running.id);
    await settle();
    expect(env.jobs().filter((j) => j.status === 'running').map((j) => [j.tool, j.trigger])).toEqual([['dnsx', 'manual']]);
  });

  test('turning the setting off cancels the queued auto jobs and queues nothing; on again, they come back', async () => {
    const env = setup({ maxQueued: 3 });
    await env.orch.recover();
    await env.s.tick();
    await settle();
    setSettings(env.db, { autoTakeoverChecks: false });
    expect(await env.s.tick()).toEqual([]);
    expect(env.byStatus('queued')).toEqual([]);
    expect(env.byStatus('cancelled').map((j) => [j.targetValue, j.error])).toEqual([
      [sub('b'), AUTO_OFF_ERROR],
      [sub('c'), AUTO_OFF_ERROR],
    ]);
    expect(env.byStatus('running')).toHaveLength(1); // not stopped
    setSettings(env.db, { autoTakeoverChecks: true });
    expect((await env.s.tick()).map((j) => j.targetValue)).toEqual([sub('b'), sub('c'), sub('d')]);
  });
});

describe('triggers', () => {
  test('start() ticks at once; idle before start()', async () => {
    const env = setup();
    await env.orch.recover();
    env.s.poke();
    await env.s.settled();
    expect(env.jobs()).toEqual([]);
    env.s.start();
    await env.s.settled();
    expect(env.jobs()).toHaveLength(3);
    env.s.stop();
  });

  test('an auto job finishing refills the queue until every due subdomain was checked once', async () => {
    const env = setup({ behave: {}, maxQueued: 2, maxConcurrent: 1 });
    await env.orch.recover();
    env.s.start();
    for (let i = 0; i < 20 && env.jobs().length < 5; i++) {
      await settle();
      await env.s.settled();
    }
    await env.orch.idle();
    await env.s.settled();
    expect(env.jobs().map((j) => [j.targetValue, j.status, j.trigger])).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((n) => [sub(n), 'succeeded', 'auto']),
    );
    env.s.stop();
  });

  test('graph.updated, scope.changed and Docker coming back ask for a tick; other events do not', () => {
    const env = setup();
    const asked: string[] = [];
    env.s.poke = () => asked.push('poke');
    env.s.onEvent({ type: 'graph.updated', nodeIds: [], edgeIds: [] });
    env.s.onEvent({ type: 'scope.changed' });
    env.s.onEvent({ type: 'runner.status', reachable: true, error: null });
    env.s.onEvent({ type: 'runner.status', reachable: false, error: 'down' });
    expect(asked).toHaveLength(3);
  });

  test('REDWHALE_AUTO_MAX_QUEUED: a positive integer, else 10', () => {
    expect(autoMaxQueued(undefined)).toBe(10);
    expect(autoMaxQueued('4')).toBe(4);
    expect(autoMaxQueued('0')).toBe(10);
    expect(autoMaxQueued('x')).toBe(10);
  });
});
