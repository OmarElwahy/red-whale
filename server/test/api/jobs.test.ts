// /api/tools, /api/jobs, /api/runner (docs/architecture.md §6, §11), on the real tool catalog (tools/) and a fake
// container runtime.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  jobConfirmRequiredResponseSchema,
  jobDetailResponseSchema,
  jobRefusedResponseSchema,
  jobsCreatedResponseSchema,
  jobsResponseSchema,
  nodeDetailResponseSchema,
  runnerStatusSchema,
  scansResponseSchema,
  scopeLogResponseSchema,
  scopeRuleSchema,
  toolsResponseSchema,
  wsEventSchema,
  type WsEvent,
} from '@redwhale/shared';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { TOOLS_DIR, loadCatalog } from '../../src/runner/catalog';
import { FakeRuntime, type FakeBehavior } from '../fakeRuntime';
import { baseDoc, tempDir } from '../helpers';
import { HOST, body, error, idOf, ingestExamples, testApi } from './helpers';

const catalog = loadCatalog();
const IMAGE = catalog.imageRef('subdomain');

function result(tool: string, subs: string[]): string {
  return JSON.stringify(
    baseDoc({
      tool,
      command: `${tool} example.com`,
      findings: subs.map((s) => ({ type: 'subdomain', value: s, parent: { type: 'domain', value: 'example.com' }, relation: 'has_subdomain' })),
    }),
  );
}

/** Each tool finds shared.example.com, plus one of its own. */
const finds = (tool: string): FakeBehavior => ({ files: { 'result.json': result(tool, ['shared.example.com', `${tool}.example.com`]), 'raw.txt': `raw of ${tool}\n` }, stderr: `[run] ${tool}\n` });

async function setup(
  behave: (tool: string) => FakeBehavior = finds,
  { image = true, scope = true, maxJobs = 2, tools = catalog } = {},
) {
  const rt = new FakeRuntime((spec) => behave(spec.body.Labels['redwhale.tool'] ?? ''));
  if (image) rt.addImage(tools.imageRef('subdomain'), { 'redwhale.group': 'subdomain' });
  const jobsDir = join(tempDir(), 'jobs');
  const api = await testApi({ runner: { runtime: rt, catalog: tools, jobsDir, maxJobs } });
  ingestExamples(api.db);
  if (scope) body(await api.send('POST', '/api/scope/rules', { kind: 'domain', value: 'example.com', action: 'include' }), 201, scopeRuleSchema);
  const domain = idOf(api.db, 'example.com');
  const orch = api.app.orchestrator;
  if (!orch) throw new Error('no orchestrator');
  return { api, rt, orch, domain, jobsDir };
}

describe('GET /api/tools and /api/runner/status', () => {
  test('lists the groups and their tools, with modes, accepted types, external services, contacts and the image', async () => {
    const { api } = await setup();
    const tools = body(await api.get('/api/tools'), 200, toolsResponseSchema);
    expect(tools.groups).toEqual([
      { name: 'http', label: 'HTTP probing', image: catalog.imageRef('http'), imageStatus: 'missing', tools: ['httpx'] },
      { name: 'subdomain', label: 'subdomain enumeration', image: IMAGE, imageStatus: 'built', tools: ['subfinder', 'assetfinder', 'findomain', 'crtsh'] },
    ]);
    expect(tools.tools.find((t) => t.name === 'httpx')).toMatchObject({
      mode: 'active',
      external: [],
      contacts: 'sends HTTP(S) requests to {target} on ports 80 and 443 (GET /, at most 5 per second; redirects are not followed)',
    });
    expect(tools.tools.find((t) => t.name === 'subfinder')?.contacts).toBeNull();
    expect(tools.tools.map((t) => [t.name, t.mode, t.accepts])).toEqual([
      ['httpx', 'active', ['domain', 'subdomain']],
      ['subfinder', 'passive', ['domain']],
      ['assetfinder', 'passive', ['domain']],
      ['findomain', 'passive', ['domain']],
      ['crtsh', 'passive', ['domain']],
    ]);
    expect(tools.tools.find((t) => t.name === 'crtsh')?.external).toEqual(['crt.sh']);
  });

  test('image missing, outdated, and Docker down', async () => {
    const { api, rt } = await setup(finds, { image: false });
    expect(body(await api.get('/api/tools'), 200, toolsResponseSchema).groups.find((g) => g.name === 'subdomain')?.imageStatus).toBe('missing');
    rt.addImage('redwhale-tools/subdomain:000000000000', { 'redwhale.group': 'subdomain' });
    expect(body(await api.get('/api/runner/status'), 200, runnerStatusSchema)).toMatchObject({
      docker: { reachable: true, version: 'fake-27.0', error: null },
      images: [
        { group: 'http', image: catalog.imageRef('http'), status: 'missing' },
        { group: 'subdomain', image: IMAGE, status: 'outdated' },
      ],
      running: 0,
      queued: 0,
      maxConcurrent: 2,
    });
    rt.reachable = false;
    const down = body(await api.get('/api/runner/status'), 200, runnerStatusSchema);
    expect(down.docker).toEqual({ reachable: false, version: null, error: 'Docker is not running' });
    expect(down.images[0]?.status).toBe('unknown');
  });

  test('without the runner the routes say so (503)', async () => {
    const api = await testApi();
    error(await api.get('/api/tools'), 503, 'not enabled');
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: 'x' }), 503);
  });
});

describe('POST /api/jobs', () => {
  test('queues, runs and ingests one tool; the job links its scan, its counts and its raw output', async () => {
    const { api, orch, domain } = await setup();
    const created = body(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain }), 201, jobsCreatedResponseSchema);
    expect(created.jobs).toHaveLength(1);
    expect(created.jobs[0]).toMatchObject({ id: 1, tool: 'subfinder', group: 'subdomain', targetValue: 'example.com', mode: 'passive' });
    await orch.idle();

    const detail = body(await api.get('/api/jobs/1'), 200, jobDetailResponseSchema);
    expect(detail.job).toMatchObject({ status: 'succeeded', nodesCreated: 2, nodesUpdated: 1, exitCode: 0, image: IMAGE });
    expect(detail.tails).toEqual({ stdout: '', stderr: '[run] subfinder\n', raw: 'raw of subfinder\n' });

    const raw = await api.get('/api/jobs/1/output/raw');
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(raw.body).toBe('raw of subfinder\n');
    error(await api.get('/api/jobs/1/output/core'), 400);
    error(await api.get('/api/jobs/9/output/raw'), 404);

    // Provenance points back at the job (and so at its raw output).
    const node = body(await api.get(`/api/nodes/${idOf(api.db, 'shared.example.com')}`), 200, nodeDetailResponseSchema);
    expect(node.observations.map((o) => [o.tool, o.jobId])).toEqual([['subfinder', 1]]);
    const scans = body(await api.get('/api/scans'), 200, scansResponseSchema).scans;
    expect(scans.find((s) => s.id === detail.job.scanId)?.jobId).toBe(1);
    expect(scans.filter((s) => s.jobId === null)).toHaveLength(4); // the uploaded examples
  });

  test('an out-of-scope target is a 403 with the reason; the refused job is kept; no container is created', async () => {
    const { api, rt, domain } = await setup(finds, { scope: false });
    const refused = body(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain }), 403, jobRefusedResponseSchema);
    expect(refused.decision).toBe('out');
    expect(refused.error).toMatch(/^out of scope: /);
    expect(refused.jobs[0]).toMatchObject({ status: 'refused', tool: 'subfinder' });
    expect(rt.created).toEqual([]);
    const log = body(await api.get('/api/scope/log'), 200, scopeLogResponseSchema);
    expect(log.items[0]).toMatchObject({ source: 'run', decision: 'out', targetValue: 'example.com' });
  });

  test('Docker down is a 503 and an unbuilt image a 409: no job, and no scope decision logged', async () => {
    const { api, rt, domain } = await setup(finds, { image: false });
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain }), 409, 'run pnpm tools:build subdomain');
    rt.reachable = false;
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain }), 503, 'Docker is not running');
    expect(body(await api.get('/api/jobs'), 200, jobsResponseSchema).total).toBe(0);
    expect(body(await api.get('/api/scope/log'), 200, scopeLogResponseSchema).total).toBe(0);
  });

  test('unknown tool or node is a 404; a node type the tool does not take is a 400; bad input is a 400', async () => {
    const { api, domain } = await setup();
    error(await api.send('POST', '/api/jobs', { tool: 'nmap', nodeId: domain }), 404, "tool 'nmap'");
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: 'nope' }), 404, 'node nope');
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: idOf(api.db, 'api.example.com') }), 400, "can't be run against a subdomain");
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder' }), 400);
    error(await api.send('POST', '/api/jobs/group', { group: 'ports', nodeId: domain }), 404);
  });

  test('a foreign Origin is refused like on every other route', async () => {
    const { api, domain, rt } = await setup();
    const res = await api.request({
      method: 'POST',
      url: '/api/jobs',
      payload: { tool: 'subfinder', nodeId: domain },
      headers: { origin: 'http://evil.example' },
    });
    error(res, 403, "origin 'http://evil.example' is not allowed");
    expect(rt.created).toEqual([]);
  });
});

describe('POST /api/jobs/group', () => {
  test('one job per tool, at most 2 at once, job.updated live, and shared subdomains end up corroborated', async () => {
    const { api, orch, domain } = await setup((tool) => ({ ...finds(tool), delayMs: 10 }));
    const events: WsEvent[] = [];
    const socket = await api.app.injectWS('/api/ws', { headers: { host: HOST } });
    socket.on('message', (data: Buffer) => {
      events.push(wsEventSchema.parse(JSON.parse(data.toString())));
    });

    const created = body(await api.send('POST', '/api/jobs/group', { group: 'subdomain', nodeId: domain }), 201, jobsCreatedResponseSchema);
    expect(created.jobs.map((j) => j.tool)).toEqual(['subfinder', 'assetfinder', 'findomain', 'crtsh']);
    expect(body(await api.get('/api/runner/status'), 200, runnerStatusSchema)).toMatchObject({ running: 2, queued: 2 });
    await orch.idle();

    const list = body(await api.get('/api/jobs'), 200, jobsResponseSchema);
    expect(list.items.map((j) => [j.id, j.status])).toEqual([[4, 'succeeded'], [3, 'succeeded'], [2, 'succeeded'], [1, 'succeeded']]);
    const shared = body(await api.get(`/api/nodes/${idOf(api.db, 'shared.example.com')}`), 200, nodeDetailResponseSchema);
    expect(shared.node).toMatchObject({ confidence: 'corroborated', sourceCount: 4 });
    expect(body(await api.get(`/api/nodes/${idOf(api.db, 'crtsh.example.com')}`), 200, nodeDetailResponseSchema).node.confidence).toBe('discovered');

    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === 'job.updated' && e.job.status === 'succeeded')).toHaveLength(4);
    });
    expect(events.some((e) => e.type === 'scan.ingested' && e.tool === 'crtsh')).toBe(true);
    expect(events.some((e) => e.type === 'graph.updated')).toBe(true);
    socket.terminate();
  });
});

describe('GET /api/jobs, cancel, and scope changes', () => {
  test('paged newest first, filtered by status and node', async () => {
    const { api, orch, domain } = await setup();
    await api.send('POST', '/api/jobs/group', { group: 'subdomain', nodeId: domain });
    await orch.idle();
    const page = body(await api.get('/api/jobs?pageSize=3&page=2'), 200, jobsResponseSchema);
    expect(page).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(page.items.map((j) => j.id)).toEqual([1]);
    expect(body(await api.get('/api/jobs?status=failed'), 200, jobsResponseSchema).total).toBe(0);
    expect(body(await api.get(`/api/jobs?status=succeeded,failed&nodeId=${domain}`), 200, jobsResponseSchema).total).toBe(4);
    error(await api.get('/api/jobs?status=exploded'), 400);
  });

  test('cancel a running job (killed, cancelled, nothing ingested); a finished one is a 409', async () => {
    const { api, rt, orch, domain } = await setup(() => ({ hang: true }));
    await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain });
    await vi.waitFor(() => {
      expect(rt.running()).toBe(1);
    });
    expect(body(await api.send('POST', '/api/jobs/1/cancel', {}), 200, jobDetailResponseSchema.pick({ job: true })).job.id).toBe(1);
    await orch.idle();
    expect(body(await api.get('/api/jobs/1'), 200, jobDetailResponseSchema).job).toMatchObject({ status: 'cancelled', scanId: null });
    expect(rt.calls.some((c) => c.op === 'kill')).toBe(true);
    error(await api.send('POST', '/api/jobs/1/cancel', {}), 409, 'already cancelled');
    error(await api.send('POST', '/api/jobs/99/cancel', {}), 404);
  });

  test('removing the rule through the API cancels the queued jobs it covered', async () => {
    const { api, rt, orch, domain } = await setup(() => ({ hang: true }), { maxJobs: 1 });
    await api.send('POST', '/api/jobs/group', { group: 'subdomain', nodeId: domain });
    await vi.waitFor(() => {
      expect(rt.running()).toBe(1);
    });
    await api.send('PATCH', '/api/scope/rules/1', { removed: true });
    const jobs = body(await api.get('/api/jobs'), 200, jobsResponseSchema).items;
    expect(jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'running']);
    expect(jobs[0]?.error).toMatch(/^scope changed: /);
    await api.send('POST', '/api/jobs/1/cancel', {});
    await orch.idle();
  });
});

describe('active runs: 428 confirm-required', () => {
  /** The real tools/, with findomain made active (an active tool in a group, before 6C-2 ships one). */
  function withActiveTool() {
    const dir = join(tempDir(), 'tools');
    cpSync(TOOLS_DIR, dir, { recursive: true });
    const path = join(dir, 'subdomain/findomain/tool.json');
    const def = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...def, mode: 'active', contacts: 'asks {target} itself' }));
    return loadCatalog(dir);
  }
  const counts = async (api: Awaited<ReturnType<typeof setup>>['api']) => ({
    jobs: body(await api.get('/api/jobs'), 200, jobsResponseSchema).total,
    log: body(await api.get('/api/scope/log?source=run,check'), 200, scopeLogResponseSchema).total,
  });

  test('a tool: no confirmActive (or false) is a 428, with no job stored and no scope decision logged', async () => {
    const { api, rt, domain } = await setup(finds, { tools: withActiveTool() });
    for (const extra of [{}, { confirmActive: false }]) {
      const res = body(await api.send('POST', '/api/jobs', { tool: 'findomain', nodeId: domain, ...extra }), 428, jobConfirmRequiredResponseSchema);
      expect(res.reason).toBe('confirm-required');
      expect(res.error).toMatch(/^findomain \(active\) would contact example\.com directly/);
    }
    expect(await counts(api)).toEqual({ jobs: 0, log: 0 });
    expect(rt.created).toEqual([]);
  });

  test('a group with an active tool that takes the node: 428 too; confirmed, every tool is queued', async () => {
    const { api, orch, domain } = await setup(finds, { tools: withActiveTool() });
    body(await api.send('POST', '/api/jobs/group', { group: 'subdomain', nodeId: domain }), 428, jobConfirmRequiredResponseSchema);
    expect(await counts(api)).toEqual({ jobs: 0, log: 0 });
    body(await api.send('PATCH', '/api/scope/settings', { passiveOnly: false }), 200, z.unknown());
    const created = body(
      await api.send('POST', '/api/jobs/group', { group: 'subdomain', nodeId: domain, confirmActive: true }),
      201,
      jobsCreatedResponseSchema,
    );
    expect(created.jobs.map((j) => [j.tool, j.mode, j.status])).toEqual([
      ['subfinder', 'passive', 'queued'],
      ['assetfinder', 'passive', 'queued'],
      ['findomain', 'active', 'queued'],
      ['crtsh', 'passive', 'queued'],
    ]);
    await orch.idle();
  });

  test('confirmed while passive-only is on: the scope guard still refuses it (403, logged)', async () => {
    const { api, domain } = await setup(finds, { tools: withActiveTool() });
    const refused = body(await api.send('POST', '/api/jobs', { tool: 'findomain', nodeId: domain, confirmActive: true }), 403, jobRefusedResponseSchema);
    expect(refused.jobs[0]).toMatchObject({ status: 'refused', mode: 'active' });
    expect(await counts(api)).toEqual({ jobs: 1, log: 1 });
  });

  test('the image and Docker checks come first (409, 503), then the confirmation', async () => {
    const { api, rt, domain } = await setup(finds, { tools: withActiveTool(), image: false });
    error(await api.send('POST', '/api/jobs', { tool: 'findomain', nodeId: domain }), 409, 'run pnpm tools:build subdomain');
    rt.reachable = false;
    error(await api.send('POST', '/api/jobs', { tool: 'findomain', nodeId: domain }), 503);
    expect(await counts(api)).toEqual({ jobs: 0, log: 0 });
  });

  test('passive tools need no confirmation; confirmActive must be a boolean', async () => {
    const { api, orch, domain } = await setup();
    body(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain }), 201, jobsCreatedResponseSchema);
    body(await api.send('POST', '/api/jobs', { tool: 'crtsh', nodeId: domain, confirmActive: true }), 201, jobsCreatedResponseSchema);
    error(await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain, confirmActive: 'yes' }), 400);
    await orch.idle();
  });
});
