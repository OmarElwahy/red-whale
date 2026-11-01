import {
  MAX_LAYOUT_POSITIONS,
  SEVERITIES,
  graphResponseSchema,
  layoutResponseSchema,
  nodeDetailResponseSchema,
  nodeId,
  nodeListResponseSchema,
  type AggregateNode,
  type GraphNode,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { exampleDoc } from '../helpers';
import { body, error, idOf, ingestExamples, ingestMock, testApi } from './helpers';

async function examples() {
  const api = await testApi();
  ingestExamples(api.db);
  return api;
}

describe('GET /api/nodes/:id', () => {
  test('node, edges in both directions, and every observation with its command', async () => {
    const api = await examples();
    const id = idOf(api.db, 'api.example.com');
    const d = body(await api.get(`/api/nodes/${id}`), 200, nodeDetailResponseSchema);
    expect(d.node).toMatchObject({
      id,
      type: 'subdomain',
      value: 'api.example.com',
      confidence: 'discovered',
      sourceCount: 1,
      effectiveSeverity: null,
      notes: '',
    });
    expect(d.edges.map((e) => [e.direction, e.relation, e.other.label])).toEqual([
      ['in', 'has_subdomain', 'example.com'],
      ['out', 'resolves_to', '93.184.216.34'],
      ['out', 'serves', 'https://api.example.com/'],
    ]);
    // nmap and httpx only name it as a parent: kept as provenance, but they don't corroborate it.
    expect(d.observations.map((o) => [o.tool, o.role])).toEqual([
      ['subfinder', 'finding'],
      ['nmap', 'parent'],
      ['httpx', 'parent'],
    ]);
    expect(d.observations[0]).toMatchObject({ command: 'subfinder -d example.com -oJ -silent', data: { source: 'crtsh' } });
  });

  test('effective severity of the domain comes from the finding below it', async () => {
    const api = await examples();
    const d = body(await api.get(`/api/nodes/${idOf(api.db, 'example.com')}`), 200, nodeDetailResponseSchema);
    expect(d.node).toMatchObject({ severity: null, effectiveSeverity: 'medium' });
  });

  test('unknown node → 404', async () => {
    const api = await examples();
    error(await api.get('/api/nodes/0000000000000000'), 404, 'node 0000000000000000 not found');
  });
});

describe('PATCH /api/nodes/:id', () => {
  async function patch(body: unknown) {
    const api = await examples();
    const id = idOf(api.db, 'api.example.com');
    return { api, id, res: await api.send('PATCH', `/api/nodes/${id}`, body) };
  }

  test('tag: set, then clear with null', async () => {
    const { api, id, res } = await patch({ tag: 'interesting' });
    expect(body(res, 200, nodeDetailResponseSchema).node.tag).toBe('interesting');
    expect(body(await api.get(`/api/nodes/${id}`), 200, nodeDetailResponseSchema).node.tag).toBe('interesting');
    const cleared = await api.send('PATCH', `/api/nodes/${id}`, { tag: null });
    expect(body(cleared, 200, nodeDetailResponseSchema).node.tag).toBeNull();
  });

  test('notes are saved as given', async () => {
    const notes = '# Login page\n\n- default creds?\n';
    const { res } = await patch({ notes });
    expect(body(res, 200, nodeDetailResponseSchema).node.notes).toBe(notes);
  });

  test('position: set, then clear', async () => {
    const { api, id, res } = await patch({ posX: 12.5, posY: -40 });
    expect(body(res, 200, nodeDetailResponseSchema).node).toMatchObject({ posX: 12.5, posY: -40 });
    const cleared = await api.send('PATCH', `/api/nodes/${id}`, { posX: null, posY: null });
    expect(body(cleared, 200, nodeDetailResponseSchema).node).toMatchObject({ posX: null, posY: null });
  });

  test('verified survives a later ingest that touches the node', async () => {
    const { api, id, res } = await patch({ confidence: 'verified' });
    expect(body(res, 200, nodeDetailResponseSchema).node.confidence).toBe('verified');
    const rerun = { ...exampleDoc('subfinder'), command: 'subfinder -d example.com -all', finished_at: '2026-10-30T10:01:12Z' };
    expect((await api.send('POST', '/api/ingest', rerun)).statusCode).toBe(201);
    const after = body(await api.get(`/api/nodes/${id}`), 200, nodeDetailResponseSchema);
    expect(after.node).toMatchObject({ confidence: 'verified', sourceCount: 1 });
    expect(after.observations).toHaveLength(4);
  });

  test.each([
    [{}, 'nothing to update'],
    [{ color: 'red' }, 'Unrecognized key: "color"'],
    [{ confidence: 'corroborated' }, 'confidence'],
    [{ tag: 'starred' }, 'tag'],
    [{ posX: '12' }, 'posX'],
    [{ notes: 'x'.repeat(100_001) }, 'notes'],
  ])('%j → 400', async (payload, message) => {
    const { res } = await patch(payload);
    error(res, 400, message);
  });

  test('unknown node → 404', async () => {
    const api = await examples();
    error(await api.send('PATCH', '/api/nodes/0000000000000000', { tag: 'checked' }), 404, 'not found');
  });

  test('tagging a node inside a collapsed group leaves it there: groups have no sticky members', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const list = body(await api.get('/api/nodes?types=subdomain&pageSize=1'), 200, nodeListResponseSchema);
    const member = list.items[0];
    if (!member) throw new Error('no subdomain');

    await api.send('PATCH', `/api/nodes/${member.id}`, { tag: 'interesting' });
    const after = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const agg = after.nodes.find((n): n is AggregateNode => n.type === 'aggregate' && n.childType === 'subdomain');
    expect(after.nodes.map((n) => n.id)).not.toContain(member.id);
    expect(agg).toMatchObject({ count: 60, expanded: false });
  });
});

describe('PUT /api/layout', () => {
  test('saves every position in one call', async () => {
    const api = await examples();
    const ids = ['example.com', 'api.example.com', 'dev.example.com'].map((l) => idOf(api.db, l));
    const positions = ids.map((id, i) => ({ id, x: i * 100, y: 5 - i }));
    expect(body(await api.send('PUT', '/api/layout', { positions }), 200, layoutResponseSchema)).toEqual({ updated: 3 });
    for (const [i, id] of ids.entries()) {
      const d = body(await api.get(`/api/nodes/${id}`), 200, nodeDetailResponseSchema);
      expect(d.node).toMatchObject({ posX: i * 100, posY: 5 - i });
    }
  });

  test('an unknown ID rejects the whole batch and saves nothing', async () => {
    const api = await examples();
    const known = idOf(api.db, 'example.com');
    const res = await api.send('PUT', '/api/layout', {
      positions: [
        { id: known, x: 1, y: 1 },
        { id: '0000000000000000', x: 2, y: 2 },
      ],
    });
    error(res, 400, "unknown node '0000000000000000'");
    expect(body(await api.get(`/api/nodes/${known}`), 200, nodeDetailResponseSchema).node.posX).toBeNull();
  });

  test('an aggregate ID is not a node: the batch is rejected (the UI leaves aggregates out)', async () => {
    const api = await examples();
    const known = idOf(api.db, 'example.com');
    const aggId = `agg:${known}:has_subdomain:subdomain`;
    const res = await api.send('PUT', '/api/layout', {
      positions: [
        { id: known, x: 1, y: 1 },
        { id: aggId, x: 2, y: 2 },
      ],
    });
    error(res, 400, `unknown node '${aggId}'`);
    expect(body(await api.get(`/api/nodes/${known}`), 200, nodeDetailResponseSchema).node.posX).toBeNull();
  });

  test('an empty list is fine', async () => {
    const api = await examples();
    expect(body(await api.send('PUT', '/api/layout', { positions: [] }), 200, layoutResponseSchema)).toEqual({ updated: 0 });
  });

  test('duplicate IDs → 400', async () => {
    const api = await examples();
    const id = idOf(api.db, 'example.com');
    const res = await api.send('PUT', '/api/layout', { positions: [{ id, x: 1, y: 1 }, { id, x: 2, y: 2 }] });
    error(res, 400, 'duplicate id');
  });

  test(`more than ${String(MAX_LAYOUT_POSITIONS)} positions → 400`, async () => {
    const api = await examples();
    const positions = Array.from({ length: MAX_LAYOUT_POSITIONS + 1 }, (_, i) => ({ id: `n${String(i)}`, x: 0, y: 0 }));
    error(await api.send('PUT', '/api/layout', { positions }), 400, 'positions');
  });

  test('a non-number coordinate → 400', async () => {
    const api = await examples();
    const id = idOf(api.db, 'example.com');
    error(await api.send('PUT', '/api/layout', { positions: [{ id, x: 'left', y: 0 }] }), 400, 'positions[0].x');
  });
});

describe('GET /api/nodes', () => {
  const rank = (s: string | null) => (s === null ? -1 : SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]));

  test('defaults: page 1 of 50, riskiest first, then by label', async () => {
    const api = await examples();
    const r = body(await api.get('/api/nodes'), 200, nodeListResponseSchema);
    expect(r).toMatchObject({ page: 1, pageSize: 50, total: 11 });
    expect(r.items.slice(0, 4).map((n) => n.label)).toEqual([
      'dev.example.com',
      'example.com',
      'git-config-exposure',
      'https://dev.example.com/.git/config',
    ]);
  });

  test('pages cover the total exactly, with no overlap', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const first = body(await api.get('/api/nodes?pageSize=50'), 200, nodeListResponseSchema);
    const pages = Math.ceil(first.total / 50);
    const ids: string[] = [];
    for (let page = 1; page <= pages; page++) {
      const r = body(await api.get(`/api/nodes?pageSize=50&page=${String(page)}`), 200, nodeListResponseSchema);
      ids.push(...r.items.map((n) => n.id));
    }
    expect(ids).toHaveLength(first.total);
    expect(new Set(ids).size).toBe(first.total);
    const past = body(await api.get(`/api/nodes?pageSize=50&page=${String(pages + 1)}`), 200, nodeListResponseSchema);
    expect(past.items).toEqual([]);
  });

  test('q lists the matches only, without the path the graph keeps above them', async () => {
    const api = await examples();
    const r = body(await api.get('/api/nodes?q=API&sort=label'), 200, nodeListResponseSchema);
    expect(r.items.map((n) => n.label)).toEqual(['api.example.com', 'https://api.example.com/']);
  });

  test('sort=label and sort=-label', async () => {
    const api = await examples();
    const asc = body(await api.get('/api/nodes?sort=label'), 200, nodeListResponseSchema).items.map((n) => n.label);
    const desc = body(await api.get('/api/nodes?sort=-label'), 200, nodeListResponseSchema).items.map((n) => n.label);
    expect(asc).toEqual([...asc].sort());
    expect(desc).toEqual([...asc].reverse());
  });

  test('sort=-severity: the finding first; nodes without severity last', async () => {
    const api = await examples();
    const items = body(await api.get('/api/nodes?sort=-severity'), 200, nodeListResponseSchema).items;
    expect(items[0]?.label).toBe('git-config-exposure');
    expect(items.slice(1).every((n) => n.severity === null)).toBe(true);
    // Missing severities sort last in both directions.
    const ascending = body(await api.get('/api/nodes?sort=severity'), 200, nodeListResponseSchema).items;
    expect(ascending[0]?.label).toBe('git-config-exposure');
    expect(ascending.at(-1)?.severity).toBeNull();
  });

  test('sort=-sourceCount,label', async () => {
    const api = await examples();
    const items = body(await api.get('/api/nodes?sort=-sourceCount,label'), 200, nodeListResponseSchema).items;
    const counts = items.map((n) => n.sourceCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  test('effective severity sorting across the mock is non-increasing', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const items = body(await api.get('/api/nodes?pageSize=500'), 200, nodeListResponseSchema).items;
    const ranks = items.map((n: GraphNode) => rank(n.effectiveSeverity));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  test('filters work the same as /graph', async () => {
    const api = await examples();
    const r = body(await api.get('/api/nodes?types=port'), 200, nodeListResponseSchema);
    expect(r.total).toBe(2);
    expect(r.items.map((n) => n.id).sort()).toEqual(
      [nodeId('port', '93.184.216.34:22/tcp'), nodeId('port', '93.184.216.34:443/tcp')].sort(),
    );
  });

  test('at=<id> returns the page that holds the node, under the same sort and filters', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const all = body(await api.get('/api/nodes?pageSize=500&sort=label&types=subdomain'), 200, nodeListResponseSchema);
    const target = all.items[57];
    if (!target) throw new Error('mock too small');
    const r = body(
      await api.get(`/api/nodes?pageSize=20&page=1&sort=label&types=subdomain&at=${target.id}`),
      200,
      nodeListResponseSchema,
    );
    expect(r.page).toBe(3);
    expect(r.items.map((n) => n.id)).toEqual(all.items.slice(40, 60).map((n) => n.id));
    expect(r.items.map((n) => n.id)).toContain(target.id);
  });

  test('at=<id> for a node that is not listed falls back to the requested page', async () => {
    const api = await examples();
    const domain = idOf(api.db, 'example.com');
    const r = body(await api.get(`/api/nodes?pageSize=2&page=2&types=port&at=${domain}`), 200, nodeListResponseSchema);
    expect(r.page).toBe(2);
    expect(r.items).toEqual([]);
    const unknown = body(await api.get('/api/nodes?pageSize=5&page=2&at=0000000000000000'), 200, nodeListResponseSchema);
    expect(unknown.page).toBe(2);
  });

  test.each([
    ['at=', 'at'],
    ['sort=bogus', 'sort[0].field'],
    ['sort=-label,colour', 'sort[1].field'],
    ['page=0', 'page'],
    ['pageSize=501', 'pageSize'],
    ['pageSize=ten', 'pageSize'],
  ])('?%s → 400', async (query, message) => {
    const api = await examples();
    error(await api.get(`/api/nodes?${query}`), 400, message);
  });
});
