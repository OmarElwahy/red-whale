// GET /api/nodes/:id/delete-preview, DELETE /api/nodes/:id, GET /api/deletions (graph editing, docs/architecture.md §6).
import { join } from 'node:path';
import {
  deleteConflictSchema,
  deletePreviewSchema,
  deleteResponseSchema,
  deletionsResponseSchema,
  jobDetailResponseSchema,
  nodeDetailResponseSchema,
  scopeRuleSchema,
  wsEventSchema,
  type WsEvent,
} from '@redwhale/shared';
import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/client';
import { ingestDocument } from '../../src/ingest/ingest';
import { loadCatalog } from '../../src/runner/catalog';
import { FakeRuntime } from '../fakeRuntime';
import { baseDoc, counts, migrateTo, tempDir, type Doc } from '../helpers';
import { HOST, body, error, idOf, testApi, type TestApi } from './helpers';

const sub = (value: string) => ({
  type: 'subdomain',
  value,
  parent: { type: 'domain', value: 'example.com' },
  relation: 'has_subdomain',
});

/**
 * example.com → a, b, c (subdomains). a → 10.0.0.1 (shared with b), a → 10.0.0.2 → 10.0.0.2:80/tcp, a → http://a.example.com/.
 * A second tool also reports a, so its edge has two edge observations.
 */
function alpha(): Doc {
  return baseDoc({
    tool: 'alpha',
    findings: [
      { type: 'domain', value: 'example.com' },
      sub('a.example.com'),
      sub('b.example.com'),
      sub('c.example.com'),
      { type: 'ip', value: '10.0.0.1', parent: { type: 'subdomain', value: 'a.example.com' }, relation: 'resolves_to' },
      { type: 'ip', value: '10.0.0.1', parent: { type: 'subdomain', value: 'b.example.com' }, relation: 'resolves_to' },
      { type: 'ip', value: '10.0.0.2', parent: { type: 'subdomain', value: 'a.example.com' }, relation: 'resolves_to' },
      { type: 'port', value: '10.0.0.2:80/tcp', parent: { type: 'ip', value: '10.0.0.2' }, relation: 'has_port' },
      { type: 'url', value: 'http://a.example.com/', parent: { type: 'subdomain', value: 'a.example.com' }, relation: 'serves' },
    ],
  });
}

function beta(): Doc {
  return baseDoc({ tool: 'beta', finished_at: '2026-10-29T11:00:00Z', started_at: '2026-10-29T10:59:00Z', findings: [sub('a.example.com')] });
}

function ingest(api: TestApi, doc: Doc): void {
  const r = ingestDocument(api.db, doc);
  if (r.status !== 'ingested') throw new Error(`not ingested: ${JSON.stringify(r)}`);
}

async function setup(): Promise<TestApi> {
  const api = await testApi();
  ingest(api, alpha());
  ingest(api, beta());
  return api;
}

const del = (api: TestApi, url: string) => api.request({ method: 'DELETE', url });

function rowCount(api: TestApi, query: string, ...params: unknown[]): number {
  return (api.db.$client.prepare(query).get(...params) as { n: number }).n;
}

describe('delete a node (node mode)', () => {
  test('removes the node, its edges and both kinds of observations; scans stay; orphans become roots', async () => {
    const api = await setup();
    const a = idOf(api.db, 'a.example.com');
    const before = counts(api.db);

    const res = body(await del(api, `/api/nodes/${a}?mode=node`), 200, deleteResponseSchema);
    expect(res.nodeIds).toEqual([a]);
    expect(res.edgeIds).toHaveLength(4); // domain → a, a → 10.0.0.1, a → 10.0.0.2, a → url
    expect(res.cancelledJobs).toEqual([]);

    error(await api.get(`/api/nodes/${a}`), 404);
    expect(counts(api.db)).toEqual({ ...before, nodes: before.nodes - 1, edges: before.edges - 4, observations: before.observations - 2 });
    expect(rowCount(api, 'SELECT COUNT(*) AS n FROM observations WHERE node_id = ?', a)).toBe(0);
    for (const e of res.edgeIds) expect(rowCount(api, 'SELECT COUNT(*) AS n FROM edge_observations WHERE edge_id = ?', e)).toBe(0);
    expect(counts(api.db).scans).toBe(2);

    // 10.0.0.2 and the URL had only a as parent: now roots. 10.0.0.1 still hangs under b.
    const parents = async (label: string) =>
      body(await api.get(`/api/nodes/${idOf(api.db, label)}`), 200, nodeDetailResponseSchema).edges.filter((e) => e.direction === 'in')
        .length;
    expect(await parents('10.0.0.2')).toBe(0);
    expect(await parents('http://a.example.com/')).toBe(0);
    expect(await parents('10.0.0.1')).toBe(1);
  });

  test('404 for an unknown node, 400 for a bad group ID or mode', async () => {
    const api = await setup();
    error(await del(api, '/api/nodes/0000000000000000?mode=node'), 404);
    error(await del(api, '/api/nodes/agg:nope?mode=node'), 400, 'not an aggregate ID');
    error(await del(api, `/api/nodes/${idOf(api.db, 'a.example.com')}?mode=all`), 400);
    error(await del(api, `/api/nodes/${idOf(api.db, 'a.example.com')}`), 400);
  });
});

describe('delete with everything below (subtree mode)', () => {
  test('keeps a shared node; the preview says so first', async () => {
    const api = await setup();
    const a = idOf(api.db, 'a.example.com');
    const preview = body(await api.get(`/api/nodes/${a}/delete-preview`), 200, deletePreviewSchema);
    expect(preview.target).toEqual({ kind: 'node', id: a, type: 'subdomain', label: 'a.example.com', members: 1, hiddenByFilters: 0 });
    expect(preview.node).toMatchObject({ nodes: 1, edges: 4, orphans: 2, keptShared: 0, runningJobs: [], queuedJobs: 0 });
    expect(preview.subtree).toMatchObject({ nodes: 4, edges: 5, orphans: 0, keptShared: 1 });

    const res = body(await del(api, `/api/nodes/${a}?mode=subtree&expect=4`), 200, deleteResponseSchema);
    expect(res.nodeIds).toHaveLength(4);
    for (const label of ['a.example.com', '10.0.0.2', '10.0.0.2:80/tcp', 'http://a.example.com/']) {
      expect(() => idOf(api.db, label)).toThrow();
    }
    expect(idOf(api.db, '10.0.0.1')).toBeTruthy();
    expect(idOf(api.db, 'b.example.com')).toBeTruthy();
  });

  test('expect: a 409 with a fresh preview when the count changed since the preview', async () => {
    const api = await setup();
    const a = idOf(api.db, 'a.example.com');
    const res = body(await del(api, `/api/nodes/${a}?mode=subtree&expect=3`), 409, deleteConflictSchema);
    expect(res.reason).toBe('changed');
    expect(res.error).toContain('4 nodes, not 3');
    expect(res.preview.subtree.nodes).toBe(4);
    expect(idOf(api.db, 'a.example.com')).toBe(a);
  });
});

describe('delete a group', () => {
  test('deletes the members the filters keep (every one) and keeps the hidden ones', async () => {
    const api = await setup();
    const domain = idOf(api.db, 'example.com');
    body(await api.send('PATCH', `/api/nodes/${idOf(api.db, 'c.example.com')}`, { tag: 'ignored' }), 200, nodeDetailResponseSchema);
    const group = `agg:${domain}:has_subdomain:subdomain`;

    const preview = body(await api.get(`/api/nodes/${group}/delete-preview?excludeTag=ignored`), 200, deletePreviewSchema);
    expect(preview.target).toEqual({
      kind: 'group',
      id: group,
      type: 'subdomain',
      label: '2 subdomains under example.com',
      members: 2,
      hiddenByFilters: 1,
    });
    expect(preview.node.nodes).toBe(2);
    // a and b, and below them 10.0.0.2, its port and the URL; 10.0.0.1 hung only under a and b, so it goes too.
    expect(preview.subtree.nodes).toBe(6);

    const members = [idOf(api.db, 'a.example.com'), idOf(api.db, 'b.example.com')].sort();
    const res = body(await del(api, `/api/nodes/${group}?mode=node&excludeTag=ignored&expect=2`), 200, deleteResponseSchema);
    expect(res.nodeIds.sort()).toEqual(members);
    expect(idOf(api.db, 'c.example.com')).toBeTruthy();
    expect(() => idOf(api.db, 'a.example.com')).toThrow();
    expect(() => idOf(api.db, 'b.example.com')).toThrow();

    const log = body(await api.get('/api/deletions'), 200, deletionsResponseSchema);
    expect(log.items[0]).toMatchObject({
      kind: 'group',
      mode: 'node',
      rootType: 'subdomain',
      rootValue: 'example.com',
      rootLabel: '2 subdomains under example.com',
      nodeCount: 2,
      removed: [
        { type: 'subdomain', value: 'a.example.com' },
        { type: 'subdomain', value: 'b.example.com' },
      ],
    });
  });

  test('a group with no members under the filters is a 404', async () => {
    const api = await setup();
    const group = `agg:${idOf(api.db, 'example.com')}:has_subdomain:subdomain`;
    error(await api.get(`/api/nodes/${group}/delete-preview?types=ip`), 404, 'no members');
  });
});

describe('after a delete', () => {
  test('a new scan reporting the node creates it fresh; re-ingesting an old file does not', async () => {
    const api = await setup();
    const a = idOf(api.db, 'a.example.com');
    body(
      await api.send('PATCH', `/api/nodes/${a}`, { tag: 'interesting', notes: 'look here', confidence: 'verified', posX: 10, posY: 20 }),
      200,
      nodeDetailResponseSchema,
    );
    body(await del(api, `/api/nodes/${a}?mode=node`), 200, deleteResponseSchema);

    expect(ingestDocument(api.db, alpha()).status).toBe('duplicate');
    expect(ingestDocument(api.db, beta()).status).toBe('duplicate');
    error(await api.get(`/api/nodes/${a}`), 404);

    ingest(api, baseDoc({ tool: 'gamma', started_at: '2026-10-30T10:00:00Z', finished_at: '2026-10-30T10:01:00Z', findings: [sub('a.example.com')] }));
    const d = body(await api.get(`/api/nodes/${a}`), 200, nodeDetailResponseSchema);
    expect(d.node).toMatchObject({ tag: null, notes: '', posX: null, posY: null, confidence: 'discovered', sourceCount: 1 });
    expect(d.observations.map((o) => o.tool)).toEqual(['gamma']);
    expect(d.edges.map((e) => [e.direction, e.relation, e.sourceCount])).toEqual([['in', 'has_subdomain', 1]]);
  });

  test('the deletion log records what was removed, newest first, paged', async () => {
    const api = await setup();
    body(await del(api, `/api/nodes/${idOf(api.db, 'a.example.com')}?mode=subtree`), 200, deleteResponseSchema);
    body(await del(api, `/api/nodes/${idOf(api.db, 'c.example.com')}?mode=node`), 200, deleteResponseSchema);

    const log = body(await api.get('/api/deletions?pageSize=1'), 200, deletionsResponseSchema);
    expect(log).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(log.items[0]).toMatchObject({ kind: 'node', mode: 'node', rootValue: 'c.example.com', nodeCount: 1, edgeCount: 1 });
    const first = body(await api.get('/api/deletions?pageSize=1&page=2'), 200, deletionsResponseSchema).items[0];
    expect(first).toMatchObject({
      kind: 'node',
      mode: 'subtree',
      rootType: 'subdomain',
      rootValue: 'a.example.com',
      rootLabel: 'a.example.com',
      nodeCount: 4,
      edgeCount: 5,
      removed: [
        { type: 'subdomain', value: 'a.example.com' },
        { type: 'ip', value: '10.0.0.2' },
        { type: 'port', value: '10.0.0.2:80/tcp' },
        { type: 'url', value: 'http://a.example.com/' },
      ],
    });
    error(await api.get('/api/deletions?pageSize=500'), 400);
  });

  test('broadcasts graph.deleted', async () => {
    const api = await setup();
    const events: WsEvent[] = [];
    const socket = await api.app.injectWS('/api/ws', { headers: { host: HOST } });
    socket.on('message', (data: Buffer) => {
      events.push(wsEventSchema.parse(JSON.parse(data.toString())));
    });
    const res = body(await del(api, `/api/nodes/${idOf(api.db, 'a.example.com')}?mode=node`), 200, deleteResponseSchema);
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: 'graph.deleted', nodeIds: res.nodeIds, edgeIds: res.edgeIds });
    });
    socket.terminate();
  });
});

describe('jobs on deleted nodes', () => {
  /** A job row as the orchestrator would have written it. */
  function addJob(api: TestApi, nodeId: string, status: string): number {
    const sqlite = api.db.$client;
    const t = '2026-10-29T12:00:00.000Z';
    const log = sqlite
      .prepare(
        `INSERT INTO scope_log (source, target_type, target_value, mode, decision, reason, at)
         VALUES ('run', 'subdomain', 'a.example.com', 'passive', 'in', 'test', ?)`,
      )
      .run(t).lastInsertRowid;
    return Number(
      sqlite
        .prepare(
          `INSERT INTO jobs (tool, tool_group, node_id, target_type, target_value, mode, status, queued_scope_log_id, timeout_sec, created_at)
           VALUES ('subfinder', 'subdomain', ?, 'subdomain', 'a.example.com', 'passive', ?, ?, 60, ?)`,
        )
        .run(nodeId, status, log, t).lastInsertRowid,
    );
  }

  test('refused while a job runs on a node being deleted; queued ones are cancelled; every row keeps its target', async () => {
    const api = await setup();
    const a = idOf(api.db, 'a.example.com');
    const port = idOf(api.db, '10.0.0.2:80/tcp');
    const done = addJob(api, a, 'succeeded');
    const queued = addJob(api, a, 'queued');
    const running = addJob(api, port, 'running');

    // Node mode doesn't touch the port, so only the subtree delete is refused.
    const preview = body(await api.get(`/api/nodes/${a}/delete-preview`), 200, deletePreviewSchema);
    expect(preview.node.runningJobs).toEqual([]);
    expect(preview.node.queuedJobs).toBe(1);
    expect(preview.subtree.runningJobs.map((j) => j.id)).toEqual([running]);

    const refused = body(await del(api, `/api/nodes/${a}?mode=subtree`), 409, deleteConflictSchema);
    expect(refused.reason).toBe('jobs-running');
    expect(refused.error).toContain(`subfinder on a.example.com (job ${String(running)})`);
    expect(idOf(api.db, 'a.example.com')).toBe(a);

    api.db.$client.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(running);
    const res = body(await del(api, `/api/nodes/${a}?mode=subtree`), 200, deleteResponseSchema);
    expect(res.cancelledJobs).toEqual([queued]);

    const rows = api.db.$client.prepare('SELECT id, node_id, status, error, target_value FROM jobs ORDER BY id').all();
    expect(rows).toEqual([
      { id: done, node_id: null, status: 'succeeded', error: null, target_value: 'a.example.com' },
      { id: queued, node_id: null, status: 'cancelled', error: 'target node deleted', target_value: 'a.example.com' },
      { id: running, node_id: null, status: 'failed', error: null, target_value: 'a.example.com' },
    ]);
  });

  test('"Cancel job and delete": cancelJobs=1 stops the running job first, then deletes', async () => {
    const catalog = loadCatalog();
    const rt = new FakeRuntime(() => ({ hang: true }));
    rt.addImage(catalog.imageRef('subdomain'), { 'redwhale.group': 'subdomain' });
    const api = await testApi({ runner: { runtime: rt, catalog, jobsDir: join(tempDir(), 'jobs') } });
    ingest(api, alpha());
    body(await api.send('POST', '/api/scope/rules', { kind: 'domain', value: 'example.com', action: 'include' }), 201, scopeRuleSchema);
    const domain = idOf(api.db, 'example.com');
    expect((await api.send('POST', '/api/jobs', { tool: 'subfinder', nodeId: domain })).statusCode).toBe(201);
    await vi.waitFor(() => {
      expect(rt.running()).toBe(1);
    });

    expect(body(await del(api, `/api/nodes/${domain}?mode=node`), 409, deleteConflictSchema).reason).toBe('jobs-running');
    body(await del(api, `/api/nodes/${domain}?mode=node&cancelJobs=1`), 200, deleteResponseSchema);
    const job = body(await api.get('/api/jobs/1'), 200, jobDetailResponseSchema).job;
    expect(job).toMatchObject({ status: 'cancelled', nodeId: null, targetValue: 'example.com', scanId: null });
    error(await api.get(`/api/nodes/${domain}`), 404);
  });
});

describe('migration 0005_graph_editing', () => {
  test('keeps existing jobs (jobs.node_id becomes nullable) and adds the deletions table', () => {
    const path = join(tempDir(), 'old.db');
    migrateTo(path, 5); // up to 0004_jobs
    const sqlite = new Database(path);
    const t = '2026-10-29T10:00:00.000Z';
    sqlite.prepare(`INSERT INTO nodes (id, type, value, label, first_seen, last_seen) VALUES ('n1', 'domain', 'example.com', 'example.com', @t, @t)`).run({ t });
    sqlite
      .prepare(`INSERT INTO scope_log (source, target_type, target_value, mode, decision, reason, at) VALUES ('run', 'domain', 'example.com', 'passive', 'in', 'r', @t)`)
      .run({ t });
    sqlite
      .prepare(
        `INSERT INTO jobs (tool, tool_group, node_id, target_type, target_value, mode, status, queued_scope_log_id, timeout_sec, created_at)
         VALUES ('subfinder', 'subdomain', 'n1', 'domain', 'example.com', 'passive', 'succeeded', 1, 60, @t)`,
      )
      .run({ t });
    sqlite.close();

    const db = openDb(path);
    expect(db.$client.prepare('SELECT id, node_id, status FROM jobs').all()).toEqual([{ id: 1, node_id: 'n1', status: 'succeeded' }]);
    expect(db.$client.prepare('SELECT COUNT(*) AS n FROM deletions').get()).toEqual({ n: 0 });
    db.$client.prepare('UPDATE jobs SET node_id = NULL').run();
    db.$client.close();
  });
});
