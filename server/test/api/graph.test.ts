import {
  SEVERITIES,
  expandResponseSchema,
  graphResponseSchema,
  neighborsResponseSchema,
  nodeId,
  type AggregateNode,
  type GraphNode,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { body, error, idOf, ingestExamples, ingestMock, testApi } from './helpers';

const rank = (s: string | null) => (s === null ? -1 : SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]));
const isAggregate = (n: GraphNode | AggregateNode): n is AggregateNode => n.type === 'aggregate';
const DOMAIN = nodeId('domain', 'northwind.example');
const SUB_AGG = `agg:${DOMAIN}:has_subdomain:subdomain`;

describe('GET /api/graph', () => {
  test('empty database', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/graph'), 200, graphResponseSchema)).toEqual({
      nodes: [],
      edges: [],
      truncated: false,
      threshold: 25,
      totals: { nodes: 0, edges: 0 },
    });
  });

  test('the four examples come back whole, with no aggregates', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    expect(g.nodes).toHaveLength(11);
    expect(g.edges).toHaveLength(11);
    expect(g.nodes.filter(isAggregate)).toEqual([]);
    expect(g.totals).toEqual({ nodes: 11, edges: 11 });
  });

  test('effective severity reaches the domain through the path to the medium finding', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const eff = Object.fromEntries(g.nodes.flatMap((n) => (isAggregate(n) ? [] : [[n.label, n.effectiveSeverity]])));
    expect(eff).toMatchObject({
      'example.com': 'medium',
      'dev.example.com': 'medium',
      'git-config-exposure': 'medium',
      'api.example.com': null,
    });
  });

  test('mock with 60 subdomains: the domain, one aggregate, and the risky subdomains', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const agg = g.nodes.filter(isAggregate).find((n) => n.id === SUB_AGG);
    const risky = g.nodes.filter((n): n is GraphNode => n.type === 'subdomain');
    expect(risky.length).toBeGreaterThan(0);
    for (const s of risky) expect(rank(s.effectiveSeverity) >= rank('medium') || s.tag === 'interesting').toBe(true);
    expect(agg).toMatchObject({ total: 60, count: 60 - risky.length, parentId: DOMAIN, relation: 'has_subdomain' });
    expect(g.nodes.some((n) => n.id === DOMAIN)).toBe(true);
    expect(g.edges).toContainEqual({ id: `edge:${SUB_AGG}`, source: DOMAIN, target: SUB_AGG, relation: 'has_subdomain' });
  });

  describe('filters', () => {
    async function examples() {
      const api = await testApi();
      ingestExamples(api.db);
      return api;
    }
    const labels = (g: { nodes: (GraphNode | AggregateNode)[] }) => g.nodes.map((n) => n.label).sort();

    test('types', async () => {
      const api = await examples();
      const g = body(await api.get('/api/graph?types=subdomain,ip'), 200, graphResponseSchema);
      expect(new Set(g.nodes.map((n) => n.type))).toEqual(new Set(['subdomain', 'ip']));
      expect(g.nodes).toHaveLength(4);
    });

    test('types given twice (?types=a&types=b)', async () => {
      const api = await examples();
      const g = body(await api.get('/api/graph?types=subdomain&types=ip'), 200, graphResponseSchema);
      expect(g.nodes).toHaveLength(4);
    });

    test('minSeverity keeps the path down to the finding', async () => {
      const api = await examples();
      const g = body(await api.get('/api/graph?minSeverity=medium'), 200, graphResponseSchema);
      expect(labels(g)).toEqual(['dev.example.com', 'example.com', 'git-config-exposure', 'https://dev.example.com/.git/config']);
      expect(g.edges).toHaveLength(3);
    });

    test('confidence', async () => {
      const api = await examples();
      const g = body(await api.get('/api/graph?confidence=corroborated'), 200, graphResponseSchema);
      expect(labels(g)).toEqual(['nginx/1.18.0']);
      for (const n of g.nodes) expect(n).toMatchObject({ confidence: 'corroborated' });
    });

    test('tool: nodes nuclei reported, including as a parent', async () => {
      const api = await examples();
      const g = body(await api.get('/api/graph?tool=nuclei'), 200, graphResponseSchema);
      expect(labels(g)).toEqual(['dev.example.com', 'git-config-exposure', 'https://dev.example.com/.git/config']);
    });

    test('tag and excludeTag', async () => {
      const api = await examples();
      const api1 = idOf(api.db, 'api.example.com');
      await api.send('PATCH', `/api/nodes/${api1}`, { tag: 'interesting' });
      await api.send('PATCH', `/api/nodes/${idOf(api.db, 'mail.example.com')}`, { tag: 'ignored' });
      const tagged = body(await api.get('/api/graph?tag=interesting'), 200, graphResponseSchema);
      expect(labels(tagged)).toEqual(['api.example.com']);
      const rest = body(await api.get('/api/graph?excludeTag=ignored'), 200, graphResponseSchema);
      expect(labels(rest)).not.toContain('mail.example.com');
      expect(rest.nodes).toHaveLength(10);
    });

    test('q: case-insensitive substring of value or label', async () => {
      const api = await examples();
      const g = body(await api.get('/api/graph?q=API'), 200, graphResponseSchema);
      expect(labels(g)).toEqual(['api.example.com', 'https://api.example.com/']);
    });

    test.each([
      ['types=bogus', 'types[0]'],
      ['minSeverity=urgent', 'minSeverity'],
      ['confidence=maybe', 'confidence[0]'],
      ['tag=starred', 'tag[0]'],
      ['tool=NMAP', 'tool names are lowercase'],
      ['q=', 'q'],
      ['foo=1', "Unrecognized key: \"foo\""],
    ])('?%s → 400', async (query, issue) => {
      const api = await examples();
      error(await api.get(`/api/graph?${query}`), 400, issue);
    });
  });

  test('over maxElements the server aggregates harder and says so', async () => {
    const api = await testApi({ maxElements: 50 });
    ingestMock(api.db, 60);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    expect(g.truncated).toBe(true);
    expect(g.threshold).toBeLessThan(25);
    expect(g.nodes.length + g.edges.length).toBeLessThanOrEqual(50);
  });

  test('a large mock stays under 2,000 elements', async () => {
    const api = await testApi();
    ingestMock(api.db, 400);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    expect(g.totals.nodes).toBeGreaterThan(900);
    expect(g.nodes.length + g.edges.length).toBeLessThanOrEqual(2000);
  });
});

describe('GET /api/graph/expand/:aggregateId', () => {
  test('pages through every member, riskiest first, with no overlap', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const pages = await Promise.all(
      [1, 2, 3].map(async (page) =>
        body(await api.get(`/api/graph/expand/${SUB_AGG}?page=${String(page)}&pageSize=25`), 200, expandResponseSchema),
      ),
    );
    expect(pages.map((p) => p.nodes.length)).toEqual([25, 25, 10]);
    expect(pages.map((p) => p.total)).toEqual([60, 60, 60]);
    const all = pages.flatMap((p) => p.nodes);
    expect(new Set(all.map((n) => n.id)).size).toBe(60);
    const ranks = all.map((n) => rank(n.effectiveSeverity));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(pages[0]?.aggregate).toEqual({ id: SUB_AGG, parentId: DOMAIN, relation: 'has_subdomain', childType: 'subdomain' });
  });

  test('each member comes with its edge from the parent', async () => {
    const api = await testApi();
    ingestMock(api.db, 30);
    const r = body(await api.get(`/api/graph/expand/${SUB_AGG}`), 200, expandResponseSchema);
    expect(r).toMatchObject({ page: 1, pageSize: 200, total: 30 });
    expect(r.edges.map((e) => e.target)).toEqual(r.nodes.map((n) => n.id));
    for (const e of r.edges) expect(e).toMatchObject({ source: DOMAIN, relation: 'has_subdomain' });
  });

  test('a root aggregate expands to the parentless nodes of that type', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const g = body(await api.get('/api/graph?types=subdomain'), 200, graphResponseSchema);
    expect(g.nodes.filter(isAggregate).map((n) => n.id)).toEqual(['agg:root:subdomain']);
    const r = body(await api.get('/api/graph/expand/agg:root:subdomain?types=subdomain'), 200, expandResponseSchema);
    expect(r.total).toBe(60);
    expect(r.edges).toEqual([]);
  });

  test.each([
    ['agg:xyz', 400, 'is not an aggregate ID'],
    [`agg:${DOMAIN}:has_port:subdomain`, 400, "'has_port' never links to subdomain"],
    [`agg:${DOMAIN}:has_port:port`, 400, "'has_port' never starts at a domain"],
    ['agg:root:planet', 400, 'unknown node type'],
    ['agg:0000000000000000:has_subdomain:subdomain', 404, 'node 0000000000000000 not found'],
    [`${SUB_AGG}?pageSize=501`, 400, 'pageSize'],
    [`${SUB_AGG}?page=0`, 400, 'page'],
  ])('%s → %i', async (path, status, message) => {
    const api = await testApi();
    ingestMock(api.db, 30);
    error(await api.get(`/api/graph/expand/${path}`), status, message);
  });
});

describe('GET /api/graph/neighbors/:nodeId', () => {
  async function examples() {
    const api = await testApi();
    ingestExamples(api.db);
    return api;
  }
  const labelsOf = (g: { nodes: (GraphNode | AggregateNode)[] }) => g.nodes.map((n) => n.label).sort();

  test('depth 1 (the default) of a subdomain: its domain, IP and URL', async () => {
    const api = await examples();
    const center = idOf(api.db, 'api.example.com');
    const g = body(await api.get(`/api/graph/neighbors/${center}`), 200, neighborsResponseSchema);
    expect(g.center).toBe(center);
    expect(labelsOf(g)).toEqual(['93.184.216.34', 'api.example.com', 'example.com', 'https://api.example.com/']);
    expect(g.edges).toHaveLength(3);
  });

  test('depth 2 reaches the ports, the technology and the sibling subdomains', async () => {
    const api = await examples();
    const g = body(
      await api.get(`/api/graph/neighbors/${idOf(api.db, 'api.example.com')}?depth=2`),
      200,
      neighborsResponseSchema,
    );
    expect(labelsOf(g)).toEqual(
      expect.arrayContaining(['93.184.216.34:22/tcp', '93.184.216.34:443/tcp', 'nginx/1.18.0', 'dev.example.com', 'mail.example.com']),
    );
  });

  test('a big neighbourhood is aggregated, with the centre always present', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const g = body(await api.get(`/api/graph/neighbors/${DOMAIN}`), 200, neighborsResponseSchema);
    expect(g.nodes.map((n) => n.id)).toContain(DOMAIN);
    expect(g.nodes.filter(isAggregate).map((n) => n.id)).toContain(SUB_AGG);
  });

  test.each(['depth=0', 'depth=4', 'depth=abc'])('?%s → 400', async (query) => {
    const api = await examples();
    error(await api.get(`/api/graph/neighbors/${idOf(api.db, 'api.example.com')}?${query}`), 400, 'depth');
  });

  test('unknown node → 404', async () => {
    const api = await examples();
    error(await api.get('/api/graph/neighbors/0000000000000000'), 404, 'not found');
  });
});
