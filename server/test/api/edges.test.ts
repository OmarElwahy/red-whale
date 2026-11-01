import {
  edgeDetailResponseSchema,
  edgeId,
  exportResponseSchema,
  graphResponseSchema,
  nodeDetailResponseSchema,
  nodeId,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { ingestDocument, ingestText } from '../../src/ingest/ingest';
import { baseDoc, exampleText } from '../helpers';
import { body, error, testApi, type TestApi } from './helpers';

const DOMAIN = nodeId('domain', 'example.com');
const API = nodeId('subdomain', 'api.example.com');
const API_EDGE = edgeId(DOMAIN, 'has_subdomain', API);
const SUB_GROUP = `agg:${DOMAIN}:has_subdomain:subdomain`;

const sub = (value: string) => ({
  type: 'subdomain',
  value,
  parent: { type: 'domain', value: 'example.com' },
  relation: 'has_subdomain',
});

/**
 * subfinder's example (example.com → api, dev, mail), then amass reporting api again and crtsh reporting a new
 * one: api's edge is corroborated, the others have one source each.
 */
async function corroborated(): Promise<TestApi> {
  const api = await testApi();
  const ok = (r: { status: string }) => {
    expect(r.status).toBe('ingested');
  };
  ok(ingestText(api.db, exampleText('subfinder')));
  ok(
    ingestDocument(
      api.db,
      baseDoc({ tool: 'amass', command: 'amass enum -d example.com', finished_at: '2026-10-29T11:00:00Z', findings: [sub('api.example.com')] }),
    ),
  );
  ok(
    ingestDocument(
      api.db,
      baseDoc({ tool: 'crtsh', command: 'crtsh example.com', finished_at: '2026-10-29T12:00:00Z', findings: [sub('www.example.com')] }),
    ),
  );
  return api;
}

describe('GET /api/edges/:id', () => {
  test('relation, both ends, derived fields and every scan that reported it, oldest first', async () => {
    const api = await corroborated();
    const d = body(await api.get(`/api/edges/${API_EDGE}`), 200, edgeDetailResponseSchema);
    expect(d.edge).toEqual({
      id: API_EDGE,
      relation: 'has_subdomain',
      source: { id: DOMAIN, type: 'domain', label: 'example.com' },
      target: { id: API, type: 'subdomain', label: 'api.example.com' },
      sourceCount: 2,
      confidence: 'corroborated',
      firstSeen: '2026-10-29T10:01:12.000Z',
      lastSeen: '2026-10-29T11:00:00.000Z',
    });
    expect(d.observations.map((o) => [o.tool, o.command, o.observedAt, o.data])).toEqual([
      ['subfinder', 'subfinder -d example.com -oJ -silent', '2026-10-29T10:01:12.000Z', {}],
      ['amass', 'amass enum -d example.com', '2026-10-29T11:00:00.000Z', {}],
    ]);
    expect(new Set(d.observations.map((o) => o.scanId)).size).toBe(2);
  });

  test('a single-source edge is discovered, with one observation', async () => {
    const api = await corroborated();
    const www = edgeId(DOMAIN, 'has_subdomain', nodeId('subdomain', 'www.example.com'));
    const d = body(await api.get(`/api/edges/${www}`), 200, edgeDetailResponseSchema);
    expect(d.edge).toMatchObject({ sourceCount: 1, confidence: 'discovered' });
    expect(d.observations.map((o) => o.tool)).toEqual(['crtsh']);
  });

  test('unknown edge → 404', async () => {
    const api = await corroborated();
    error(await api.get('/api/edges/0000000000000000'), 404, 'edge 0000000000000000 not found');
  });

  test('a foreign Host is refused like every route', async () => {
    const api = await corroborated();
    const res = await api.request({ method: 'GET', url: `/api/edges/${API_EDGE}`, headers: { host: 'evil.test' } });
    error(res, 403, 'is not allowed');
  });
});

test('GET /api/nodes/:id: each edge carries source count, confidence, first and last seen', async () => {
  const api = await corroborated();
  const d = body(await api.get(`/api/nodes/${API}`), 200, nodeDetailResponseSchema);
  expect(d.edges).toEqual([
    expect.objectContaining({
      id: API_EDGE,
      direction: 'in',
      sourceCount: 2,
      confidence: 'corroborated',
      firstSeen: '2026-10-29T10:01:12.000Z',
      lastSeen: '2026-10-29T11:00:00.000Z',
    }),
  ]);
});

describe('graph edges', () => {
  test('a group edge carries the union of its member edges’ tools and their count, even while collapsed', async () => {
    const api = await corroborated();
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    expect(g.edges).toEqual([
      {
        id: `edge:${SUB_GROUP}`,
        source: DOMAIN,
        target: SUB_GROUP,
        relation: 'has_subdomain',
        kind: 'group',
        sourceCount: null,
        confidence: null,
        tools: ['amass', 'crtsh', 'subfinder'],
        edgeCount: 4,
      },
    ]);
  });

  test('the union follows the filters: members a filter removes do not count', async () => {
    const api = await corroborated();
    const www = nodeId('subdomain', 'www.example.com');
    expect((await api.send('PATCH', `/api/nodes/${www}`, { tag: 'ignored' })).statusCode).toBe(200);
    const g = body(await api.get('/api/graph?excludeTag=ignored'), 200, graphResponseSchema);
    expect(g.edges.find((e) => e.kind === 'group')).toMatchObject({ tools: ['amass', 'subfinder'], edgeCount: 3 });
  });

  test('real edges carry their own source count and confidence; member edges carry nothing', async () => {
    const api = await corroborated();
    const g = body(
      await api.send('POST', '/api/graph/view', { expand: [{ id: SUB_GROUP, pages: 1, pins: [] }] }),
      200,
      graphResponseSchema,
    );
    const member = g.edges.find((e) => e.kind === 'member');
    expect(member).toMatchObject({ sourceCount: null, confidence: null, tools: null, edgeCount: null });

    // A single child is drawn with its real edge: amass alone, as the only tool reporting api.
    const only = body(await api.get('/api/graph?tool=amass'), 200, graphResponseSchema);
    expect(only.edges).toEqual([
      expect.objectContaining({ id: API_EDGE, kind: 'relation', sourceCount: 2, confidence: 'corroborated', tools: null }),
    ]);
  });
});

test('GET /api/export includes every edge observation and the edges’ derived fields', async () => {
  const api = await corroborated();
  const d = body(await api.get('/api/export'), 200, exportResponseSchema);
  expect(d.edgeObservations).toHaveLength(5);
  expect(d.edgeObservations.filter((o) => o.edgeId === API_EDGE).map((o) => o.tool)).toEqual(['subfinder', 'amass']);
  expect(d.edges.find((e) => e.id === API_EDGE)).toMatchObject({ sourceCount: 2, confidence: 'corroborated' });
});
