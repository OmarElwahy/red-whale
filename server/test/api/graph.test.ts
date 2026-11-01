import {
  SEVERITIES,
  expandResponseSchema,
  graphPathResponseSchema,
  graphResponseSchema,
  neighborsResponseSchema,
  nodeId,
  type GraphResponse,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { body, error, idOf, ingestExamples, ingestMock, isAggregate, isReal, openAll, testApi, view } from './helpers';

const rank = (s: string | null) => (s === null ? -1 : SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]));
const DOMAIN = nodeId('domain', 'northwind.example');
const SUB_AGG = `agg:${DOMAIN}:has_subdomain:subdomain`;

/** The real parent → child links a view draws, through groups or directly. */
function links(g: GraphResponse): string[] {
  const parentOf = new Map(g.nodes.filter(isAggregate).map((a) => [a.id, a.parentId]));
  const out = g.edges.flatMap((e) => {
    if (e.kind === 'relation' || e.kind === 'neighbor') return [`${e.source}>${e.target}`];
    const parent = e.kind === 'member' ? parentOf.get(e.source) : null;
    return parent ? [`${parent}>${e.target}`] : [];
  });
  return [...new Set(out)];
}

const EMPTY_VIEW = { state: { expand: [], neighbors: [] }, overBudget: [], autoOpened: [], autoFolded: [], expandAll: [] };

describe('GET /api/graph', () => {
  test('empty database', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/graph'), 200, graphResponseSchema)).toEqual({
      nodes: [],
      edges: [],
      truncated: false,
      totals: { nodes: 0, edges: 0 },
      ...EMPTY_VIEW,
    });
  });

  test('the four examples start collapsed: the domain and one group per kind of child', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const domain = idOf(api.db, 'example.com');
    expect(g.nodes.filter(isReal).map((n) => n.label)).toEqual(['example.com']);
    for (const a of g.nodes.filter(isAggregate)) expect(a).toMatchObject({ parentId: domain, expanded: false });
    expect(g.totals).toEqual({ nodes: 11, edges: 11 });
  });

  test('opened all the way, the examples come back whole', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const g = await openAll(api);
    expect(g.nodes.filter(isReal)).toHaveLength(11);
    expect(links(g)).toHaveLength(11);
  });

  test('effective severity reaches the domain through the path to the medium finding', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const g = await openAll(api);
    const eff = Object.fromEntries(g.nodes.filter(isReal).map((n) => [n.label, n.effectiveSeverity]));
    expect(eff).toMatchObject({
      'example.com': 'medium',
      'dev.example.com': 'medium',
      'git-config-exposure': 'medium',
      'api.example.com': null,
    });
  });

  test('mock with 60 subdomains: the domain and one collapsed subdomain group, with its risk', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const agg = g.nodes.filter(isAggregate).find((n) => n.id === SUB_AGG);
    expect(agg).toMatchObject({ count: 60, remaining: 60, expanded: false, parentId: DOMAIN, relation: 'has_subdomain' });
    expect((agg?.risk.critical ?? 0) + (agg?.risk.high ?? 0)).toBeGreaterThan(0);
    expect(g.nodes.filter((n) => n.type === 'subdomain')).toEqual([]);
    expect(g.edges).toContainEqual(
      expect.objectContaining({ id: `edge:${SUB_AGG}`, source: DOMAIN, target: SUB_AGG, relation: 'has_subdomain', kind: 'group' }),
    );
  });

  describe('filters', () => {
    async function examples() {
      const api = await testApi();
      ingestExamples(api.db);
      return api;
    }
    const labels = (g: GraphResponse) => g.nodes.filter(isReal).map((n) => n.label).sort();

    test('types', async () => {
      const api = await examples();
      const g = await openAll(api, 'types=subdomain,ip');
      expect(new Set(g.nodes.filter(isReal).map((n) => n.type))).toEqual(new Set(['subdomain', 'ip']));
      expect(g.nodes.filter(isReal)).toHaveLength(4);
    });

    test('types given twice (?types=a&types=b)', async () => {
      const api = await examples();
      const twice = body(await api.get('/api/graph?types=subdomain&types=ip'), 200, graphResponseSchema);
      const once = body(await api.get('/api/graph?types=subdomain,ip'), 200, graphResponseSchema);
      expect(twice).toEqual(once);
      expect(twice.totals.nodes).toBe(4);
    });

    test('minSeverity keeps the path down to the finding', async () => {
      const api = await examples();
      const g = await openAll(api, 'minSeverity=medium');
      expect(labels(g)).toEqual(['dev.example.com', 'example.com', 'git-config-exposure', 'https://dev.example.com/.git/config']);
      expect(links(g)).toHaveLength(3);
    });

    test('confidence', async () => {
      const api = await examples();
      const g = await openAll(api, 'confidence=corroborated');
      expect(labels(g)).toEqual(['nginx/1.18.0']);
      for (const n of g.nodes.filter(isReal)) expect(n).toMatchObject({ confidence: 'corroborated' });
    });

    test('tool: nodes nuclei reported, including as a parent', async () => {
      const api = await examples();
      const g = await openAll(api, 'tool=nuclei');
      expect(labels(g)).toEqual(['dev.example.com', 'git-config-exposure', 'https://dev.example.com/.git/config']);
    });

    test('tag and excludeTag', async () => {
      const api = await examples();
      const api1 = idOf(api.db, 'api.example.com');
      await api.send('PATCH', `/api/nodes/${api1}`, { tag: 'interesting' });
      await api.send('PATCH', `/api/nodes/${idOf(api.db, 'mail.example.com')}`, { tag: 'ignored' });
      const tagged = await openAll(api, 'tag=interesting');
      expect(labels(tagged)).toEqual(['api.example.com']);
      const rest = await openAll(api, 'excludeTag=ignored');
      expect(labels(rest)).not.toContain('mail.example.com');
      expect(rest.nodes.filter(isReal)).toHaveLength(10);
    });

    test('q: case-insensitive matches, plus their path up to the root', async () => {
      const api = await examples();
      const g = await openAll(api, 'q=API');
      expect(labels(g)).toEqual(['api.example.com', 'example.com', 'https://api.example.com/']);
      expect(links(g)).toHaveLength(2);
    });

    test('q: the path only goes through nodes that pass the other filters', async () => {
      const api = await examples();
      const g = await openAll(api, 'q=git-config&types=vulnerability,url');
      expect(labels(g)).toEqual(['git-config-exposure', 'https://dev.example.com/.git/config']);
      const cut = await openAll(api, 'q=git-config&types=vulnerability,subdomain,domain');
      expect(labels(cut)).toEqual(['git-config-exposure']);
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

  test('over maxElements an open group is refused and the server says so', async () => {
    const api = await testApi({ maxElements: 50 });
    ingestMock(api.db, 60);
    const g = await view(api, { expand: [{ id: SUB_AGG, pages: 1, pins: [] }] });
    expect(g).toMatchObject({ truncated: true, overBudget: [SUB_AGG], state: { expand: [] } });
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

describe('POST /api/graph/view', () => {
  test('an open group: its members hang under it, with their own groups collapsed', async () => {
    const api = await testApi();
    ingestMock(api.db, 60);
    const g = await view(api, { expand: [{ id: SUB_AGG, pages: 1, pins: [] }] });
    const subs = g.nodes.filter((n) => n.type === 'subdomain');
    expect(subs).toHaveLength(60);
    const ranks = subs.map((n) => rank(isReal(n) ? n.effectiveSeverity : null));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(g.state.expand).toEqual([{ id: SUB_AGG, pages: 1, pins: [] }]);
    expect(g.nodes.find((n) => n.id === SUB_AGG)).toMatchObject({ expanded: true, shown: 60, remaining: 0 });
  });

  test('filters go in the body, as the query string takes them', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const g = await view(api, { filters: { types: 'subdomain,ip' } });
    expect(g.totals.nodes).toBe(4);
  });

  test('expandAll opens everything below a node and reports what it opened', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const domain = idOf(api.db, 'example.com');
    const g = await view(api, { expandAll: [domain] });
    expect(g.nodes.filter(isReal)).toHaveLength(11);
    expect(g.expandAll).toEqual([{ nodeId: domain, opened: g.state.expand.length, hidden: 0 }]);
  });

  test.each([
    [{ expand: [{ id: 'nope', pages: 1, pins: [] }] }, 'expand[0].id'],
    [{ expand: [{ id: SUB_AGG, pages: 51, pins: [] }] }, 'expand[0].pages'],
    [{ filters: { types: 'bogus' } }, 'filters.types[0]'],
    [{ foo: 1 }, 'Unrecognized key: "foo"'],
  ])('%j → 400', async (request, issue) => {
    const api = await testApi();
    error(await api.send('POST', '/api/graph/view', request), 400, issue);
  });
});

describe('GET /api/graph/path/:nodeId', () => {
  test('the groups to open, root first, to draw a node three groups deep', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const port = idOf(api.db, '93.184.216.34:443/tcp');
    const path = body(await api.get(`/api/graph/path/${port}`), 200, graphPathResponseSchema);
    expect(path.inView).toBe(true);
    expect(path.steps.length).toBeGreaterThanOrEqual(2);
    expect(path.steps.at(-1)).toMatchObject({ memberId: port });
    // Opening exactly those groups as pins draws the port.
    const g = await view(api, { expand: path.steps.map((s) => ({ id: s.groupId, pages: 0, pins: [s.memberId] })) });
    expect(g.nodes.some((n) => n.id === port)).toBe(true);
  });

  test('a node the filters exclude is not in view', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const port = idOf(api.db, '93.184.216.34:443/tcp');
    const path = body(await api.get(`/api/graph/path/${port}?types=domain`), 200, graphPathResponseSchema);
    expect(path).toEqual({ nodeId: port, inView: false, steps: [] });
  });

  test('unknown node → 404, bad filter → 400', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    error(await api.get('/api/graph/path/0000000000000000'), 404, 'not found');
    error(await api.get(`/api/graph/path/${idOf(api.db, 'example.com')}?minSeverity=urgent`), 400, 'minSeverity');
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
  const labelsOf = (g: GraphResponse) => g.nodes.map((n) => n.label).sort();

  test('depth 1 (the default) of a subdomain: its domain, IP and URL', async () => {
    const api = await examples();
    const center = idOf(api.db, 'api.example.com');
    const g = body(await api.get(`/api/graph/neighbors/${center}`), 200, neighborsResponseSchema);
    expect(g.center).toBe(center);
    expect(labelsOf(g)).toEqual(['93.184.216.34', 'api.example.com', 'example.com', 'https://api.example.com/']);
    expect(g.edges).toHaveLength(3);
  });

  test('depth 2 reaches the ports, the technology and the sibling subdomains, grouped', async () => {
    const api = await examples();
    const g = body(
      await api.get(`/api/graph/neighbors/${idOf(api.db, 'api.example.com')}?depth=2`),
      200,
      neighborsResponseSchema,
    );
    expect(labelsOf(g)).toEqual(expect.arrayContaining(['2 ports', '3 subdomains', 'nginx/1.18.0']));
    expect(g.totals.nodes).toBeGreaterThanOrEqual(8);
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
