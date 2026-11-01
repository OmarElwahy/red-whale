import {
  aggregateNodeSchema,
  edgeId,
  graphNodeSchema,
  moreNodeSchema,
  nodeId,
  viewEdgeSchema,
  type AggregateNode,
  type GraphEdge,
  type GraphNode,
  type GroupOpen,
  type NodeType,
  type Relation,
  type Severity,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { groupPath, groupedView, type ViewOptions, type ViewResult } from '../src/graph/aggregate';
import { effectiveSeverities, type Graph } from '../src/graph/store';

const T = '2026-10-29T10:00:00.000Z';

function node(type: NodeType, value: string, extra: { severity?: Severity } = {}): GraphNode {
  return {
    id: nodeId(type, value),
    type,
    value,
    label: value,
    severity: extra.severity ?? null,
    effectiveSeverity: extra.severity ?? null,
    confidence: 'discovered',
    sourceCount: 1,
    tag: null,
    inScope: 'out',
    posX: null,
    posY: null,
    firstSeen: T,
    lastSeen: T,
  };
}

function edge(source: GraphNode, relation: Relation, target: GraphNode): GraphEdge {
  return { id: edgeId(source.id, relation, target.id), source: source.id, target: target.id, relation };
}

/** Builds a graph and fills in effective severity, as loadGraph does. */
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const eff = effectiveSeverities(nodes, edges);
  return { nodes: nodes.map((n) => ({ ...n, effectiveSeverity: eff.get(n.id) ?? null })), edges };
}

function view(g: Graph, options: Partial<ViewOptions> = {}): ViewResult {
  const maxElements = options.maxElements ?? 2000;
  const r = groupedView(g, { ...options, maxElements });
  // Invariants for every result: valid shapes, unique IDs, no dangling edges, within the cap.
  const ids = r.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const n of r.nodes) {
    (n.type === 'aggregate' ? aggregateNodeSchema : n.type === 'more' ? moreNodeSchema : graphNodeSchema).parse(n);
  }
  for (const e of r.edges) {
    viewEdgeSchema.parse(e);
    expect(ids).toContain(e.source);
    expect(ids).toContain(e.target);
  }
  expect(new Set(r.edges.map((e) => e.id)).size).toBe(r.edges.length);
  expect(r.nodes.length + r.edges.length).toBeLessThanOrEqual(maxElements);
  return r;
}

const open = (id: string, pages = 1, pins: string[] = []): GroupOpen => ({ id, pages, pins });
const groups = (r: ViewResult) => r.nodes.filter((n): n is AggregateNode => n.type === 'aggregate');
const group = (r: ViewResult, id: string) => groups(r).find((g) => g.id === id);
const shown = (r: ViewResult) => new Set(r.nodes.map((n) => n.id));
const edgeKinds = (r: ViewResult, kind: string) => r.edges.filter((e) => e.kind === kind);

const domain = node('domain', 'example.com');
const subs = (n: number, prefix = 'host') =>
  Array.from({ length: n }, (_, i) => node('subdomain', `${prefix}${String(i).padStart(4, '0')}.example.com`));
const fanOut = (children: GraphNode[], parent = domain, relation: Relation = 'has_subdomain') =>
  children.map((c) => edge(parent, relation, c));
const SUBS = `agg:${domain.id}:has_subdomain:subdomain`;
const ipsOf = (s: GraphNode) => `agg:${s.id}:resolves_to:ip`;
const portsOf = (ip: GraphNode) => `agg:${ip.id}:has_port:port`;

/** domain → 3 subdomains → 2 IPs each → 2 ports each: a group at three levels. */
function threeLevels() {
  const ss = subs(3);
  const ips = ss.map((s, i) => [node('ip', `198.18.${String(i)}.1`), node('ip', `198.18.${String(i)}.2`)] as const);
  const ports = ips.flat().map((ip) => [node('port', `${ip.value}:80/tcp`), node('port', `${ip.value}:443/tcp`)] as const);
  const g = graph(
    [domain, ...ss, ...ips.flat(), ...ports.flat()],
    [
      ...fanOut(ss),
      ...ss.flatMap((s, i) => (ips[i] ?? []).map((ip) => edge(s, 'resolves_to', ip))),
      ...ips.flat().flatMap((ip, i) => (ports[i] ?? []).map((p) => edge(ip, 'has_port', p))),
    ],
  );
  return { g, ss, ips, ports };
}

describe('the rule', () => {
  test('one child is drawn directly, with its real edge', () => {
    const [only] = subs(1) as [GraphNode];
    const r = view(graph([domain, only], fanOut([only])));
    expect(groups(r)).toEqual([]);
    expect(r.edges).toEqual([{ ...edge(domain, 'has_subdomain', only), kind: 'relation' }]);
  });

  test('two or more children become one collapsed group, carrying the relation', () => {
    const ss = subs(12);
    const r = view(graph([domain, ...ss], fanOut(ss)));
    expect(r.nodes.map((n) => n.id)).toEqual([domain.id, SUBS]);
    expect(group(r, SUBS)).toMatchObject({
      label: '12 subdomains',
      count: 12,
      expanded: false,
      shown: 0,
      remaining: 12,
      parentId: domain.id,
      relation: 'has_subdomain',
      childType: 'subdomain',
      canLoadMore: true,
    });
    expect(r.edges).toEqual([
      { id: `edge:${SUBS}`, source: domain.id, target: SUBS, relation: 'has_subdomain', kind: 'group' },
    ]);
  });

  test('collapsed by default at every level; opening one level shows the next level collapsed', () => {
    const { g, ss } = threeLevels();
    const r = view(g, { expand: [open(SUBS)] });
    expect(group(r, SUBS)).toMatchObject({ expanded: true, shown: 3, remaining: 0 });
    for (const s of ss) {
      expect(shown(r).has(s.id)).toBe(true);
      expect(group(r, ipsOf(s))).toMatchObject({ expanded: false, count: 2 });
    }
    expect(r.nodes.filter((n) => n.type === 'ip')).toEqual([]);
  });

  test('an open group stays as the parent: parent → group → member, plain member edges, no real edges', () => {
    const { g, ss } = threeLevels();
    const r = view(g, { expand: [open(SUBS)] });
    expect(edgeKinds(r, 'member').map((e) => e.target).sort()).toEqual(ss.map((s) => s.id).sort());
    for (const e of edgeKinds(r, 'member')) expect(e).toMatchObject({ source: SUBS, relation: null });
    expect(edgeKinds(r, 'relation')).toEqual([]);
  });

  test('three levels open: domain → subdomains → IPs → ports', () => {
    const { g, ss, ips } = threeLevels();
    const [s0] = ss as [GraphNode];
    const [ip0] = ips[0] as readonly [GraphNode, GraphNode];
    const r = view(g, { expand: [open(SUBS), open(ipsOf(s0)), open(portsOf(ip0))] });
    expect(r.nodes.filter((n) => n.type === 'port')).toHaveLength(2);
    expect(r.state.expand.map((x) => x.id)).toEqual([SUBS, ipsOf(s0), portsOf(ip0)]);
  });

  test('closing a group drops everything opened below it from the state (recursive collapse)', () => {
    const { g, ss, ips } = threeLevels();
    const [s0] = ss as [GraphNode];
    const [ip0] = ips[0] as readonly [GraphNode, GraphNode];
    // The client removed SUBS but still had the groups below it.
    const r = view(g, { expand: [open(ipsOf(s0)), open(portsOf(ip0))] });
    expect(r.nodes.map((n) => n.id)).toEqual([domain.id, SUBS]);
    expect(r.state.expand).toEqual([]);
  });
});

describe('pages and pins', () => {
  const ss = subs(250);
  const g = graph([domain, ...ss], fanOut(ss));

  test('100 members per page, then a "more" node', () => {
    const r = view(g, { expand: [open(SUBS)] });
    expect(r.nodes.filter((n) => n.type === 'subdomain')).toHaveLength(100);
    expect(r.nodes.find((n) => n.type === 'more')).toEqual({
      id: `more:${SUBS}`,
      type: 'more',
      groupId: SUBS,
      label: '+150 more',
      remaining: 150,
    });
    expect(group(r, SUBS)).toMatchObject({ shown: 100, remaining: 150, canLoadMore: true });
    const r2 = view(g, { expand: [open(SUBS, 3)] });
    expect(r2.nodes.filter((n) => n.type === 'subdomain')).toHaveLength(250);
    expect(r2.nodes.some((n) => n.type === 'more')).toBe(false);
  });

  test('a pin shows one member beyond the loaded pages; pages 0 shows only the pins', () => {
    const deep = ss[240] as GraphNode;
    const r = view(g, { expand: [open(SUBS, 0, [deep.id])] });
    expect(r.nodes.filter((n) => n.type === 'subdomain').map((n) => n.id)).toEqual([deep.id]);
    expect(group(r, SUBS)).toMatchObject({ expanded: true, shown: 1, remaining: 249 });
    expect(r.state.expand).toEqual([open(SUBS, 0, [deep.id])]);
  });

  test('pins that are not members are dropped from the state', () => {
    const r = view(g, { expand: [open(SUBS, 0, [domain.id, 'nope'])] });
    expect(r.state.expand).toEqual([open(SUBS, 0, [])]);
  });
});

describe('a node with several parents', () => {
  const [a, b] = subs(2) as [GraphNode, GraphNode];
  const shared = node('ip', '198.18.0.20');
  const ipA = node('ip', '198.18.0.1');
  const ipB = node('ip', '198.18.0.2');
  const g = graph(
    [domain, a, b, shared, ipA, ipB],
    [...fanOut([a, b]), edge(a, 'resolves_to', ipA), edge(a, 'resolves_to', shared), edge(b, 'resolves_to', shared), edge(b, 'resolves_to', ipB)],
  );

  test('both groups open: drawn once, with an edge from each group', () => {
    const r = view(g, { expand: [open(SUBS), open(ipsOf(a)), open(ipsOf(b))] });
    expect(r.nodes.filter((n) => n.id === shared.id)).toHaveLength(1);
    expect(edgeKinds(r, 'member').filter((e) => e.target === shared.id).map((e) => e.source).sort()).toEqual(
      [ipsOf(a), ipsOf(b)].sort(),
    );
  });

  test('one group open: it hangs under that one; the collapsed group still counts it and draws no edge to it', () => {
    const r = view(g, { expand: [open(SUBS), open(ipsOf(a))] });
    expect(edgeKinds(r, 'member').filter((e) => e.target === shared.id).map((e) => e.source)).toEqual([ipsOf(a)]);
    expect(group(r, ipsOf(b))).toMatchObject({ expanded: false, count: 2, shown: 0 });
  });

  test('expand neighbors draws every parent with its edge, even one hidden in a collapsed group', () => {
    // Only `a` is shown (pinned), so `b` is hidden until the shared IP's neighbors are expanded.
    const r = view(g, { expand: [open(SUBS, 0, [a.id]), open(ipsOf(a))], neighbors: [shared.id] });
    expect(shown(r).has(b.id)).toBe(true);
    expect(edgeKinds(r, 'neighbor').map((e) => e.source).sort()).toEqual([a.id, b.id].sort());
    expect(r.state.neighbors).toEqual([shared.id]);
  });

  test('a neighbor expansion whose node is not drawn is dropped', () => {
    const r = view(g, { neighbors: [shared.id] });
    expect(r.state.neighbors).toEqual([]);
  });
});

describe('roots', () => {
  test('up to 25 parentless nodes of a type are drawn as they are', () => {
    const r = view(graph(subs(25), []));
    expect(groups(r)).toEqual([]);
    expect(r.nodes).toHaveLength(25);
  });

  test('a single target domain is never "1 domain"', () => {
    const r = view(graph([domain], []));
    expect(r.nodes).toEqual([domain]);
  });

  test('more than 25 fold into agg:root:<type>', () => {
    const r = view(graph(subs(26), []));
    expect(r.nodes.map((n) => n.id)).toEqual(['agg:root:subdomain']);
    expect(group(r, 'agg:root:subdomain')).toMatchObject({ count: 26, parentId: null, relation: null });
    expect(r.edges).toEqual([]);
  });

  test('a part of the graph with no root (a cycle) is walked from its riskiest node', () => {
    const [x, y] = [node('url', 'https://a.example.com/'), node('url', 'https://b.example.com/', { severity: 'low' })];
    const r = view(graph([x, y], [edge(x, 'has_url', y), edge(y, 'has_url', x)]));
    expect(shown(r)).toEqual(new Set([x.id, y.id]));
  });
});

describe('the risk badge', () => {
  test('distinct high/critical nodes anywhere below the group, each counted once', () => {
    const [a, b] = subs(2) as [GraphNode, GraphNode];
    const shared = node('ip', '198.18.0.20');
    const other = node('ip', '198.18.0.21');
    const port = node('port', '198.18.0.20:443/tcp');
    const crit = node('vulnerability', 'CVE-2021-41773', { severity: 'critical' });
    const high = node('vulnerability', 'redis-no-auth', { severity: 'high' });
    const medium = node('vulnerability', 'headers', { severity: 'medium' });
    const g = graph(
      [domain, a, b, shared, other, port, crit, high, medium],
      [
        ...fanOut([a, b]),
        edge(a, 'resolves_to', shared),
        edge(b, 'resolves_to', shared),
        edge(b, 'resolves_to', other),
        edge(shared, 'has_port', port),
        edge(port, 'has_vulnerability', crit),
        edge(other, 'has_vulnerability', high),
        edge(a, 'has_vulnerability', medium),
      ],
    );
    const r = view(g, { expand: [open(SUBS)] });
    // The critical one is reachable through both subdomains: counted once.
    expect(group(r, SUBS)).toMatchObject({ risk: { critical: 1, high: 1 }, maxSeverity: 'critical' });
    expect(group(r, ipsOf(b))).toMatchObject({ risk: { critical: 1, high: 1 } });
  });

  test('a group with nothing serious below has a zero badge', () => {
    const ss = subs(3);
    expect(group(view(graph([domain, ...ss], fanOut(ss))), SUBS)?.risk).toEqual({ critical: 0, high: 0 });
  });
});

describe('the element budget', () => {
  const ss = subs(60);
  const g = graph([domain, ...ss], fanOut(ss));

  test('an open group that does not fit is refused, said so, and left out of the state', () => {
    const r = view(g, { maxElements: 50, expand: [open(SUBS)] });
    expect(r).toMatchObject({ truncated: true, overBudget: [SUBS] });
    expect(group(r, SUBS)).toMatchObject({ expanded: false, canLoadMore: false });
    expect(r.state.expand).toEqual([]);
  });

  test('the newest asks are refused first; a "load more" loses its extra page only', () => {
    const [a, b] = subs(2, 'x') as [GraphNode, GraphNode];
    const kids = (s: GraphNode) =>
      Array.from({ length: 150 }, (_, i) => node('ip', `198.${s === a ? '18' : '19'}.${String(i >> 8)}.${String(i & 255)}`));
    const ka = kids(a);
    const kb = kids(b);
    const big = graph(
      [domain, a, b, ...ka, ...kb],
      [...fanOut([a, b]), ...ka.map((k) => edge(a, 'resolves_to', k)), ...kb.map((k) => edge(b, 'resolves_to', k))],
    );
    const r = view(big, { maxElements: 420, expand: [open(SUBS), open(ipsOf(a)), open(ipsOf(b), 2)] });
    expect(r.state.expand).toEqual([open(SUBS), open(ipsOf(a)), open(ipsOf(b), 1)]);
    expect(r.overBudget).toEqual([ipsOf(b)]);
  });
});

describe('auto-open (live updates)', () => {
  const [x, y] = subs(2) as [GraphNode, GraphNode];
  const before = edge(domain, 'has_subdomain', x);
  const after = graph([domain, x, y], fanOut([x, y]));

  test('a group that now holds what the canvas showed directly opens, so nothing on screen disappears', () => {
    const r = view(after, { keep: { edges: [before.id], roots: [] } });
    expect(r.autoOpened).toEqual([SUBS]);
    expect(shown(r).has(x.id) && shown(r).has(y.id)).toBe(true);
    expect(r.state.expand).toEqual([open(SUBS)]);
  });

  test('without it on the canvas, the group folds as usual', () => {
    const r = view(after, { keep: { edges: [], roots: [] } });
    expect(r.autoOpened).toEqual([]);
    expect(group(r, SUBS)?.expanded).toBe(false);
  });

  test('over the budget it folds, and says so (the UI flashes it)', () => {
    const r = view(after, { maxElements: 4, keep: { edges: [before.id], roots: [] } });
    expect(r.autoFolded).toEqual([SUBS]);
    expect(group(r, SUBS)?.expanded).toBe(false);
  });

  test('parentless nodes on the canvas open their new root group', () => {
    const roots = subs(26);
    const r = view(graph(roots, []), { keep: { edges: [], roots: [(roots[0] as GraphNode).id] } });
    expect(r.autoOpened).toEqual(['agg:root:subdomain']);
  });
});

describe('expand all below', () => {
  test('opens every group below the node, at every level', () => {
    const { g } = threeLevels();
    const r = view(g, { expandAll: [domain.id] });
    expect(r.nodes.filter((n) => n.type === 'port')).toHaveLength(12);
    expect(groups(r).every((x) => x.expanded)).toBe(true);
    expect(r.expandAll).toEqual([{ nodeId: domain.id, opened: 10, hidden: 0 }]);
    expect(r.state.expand).toHaveLength(10);
  });

  test('loads further pages of big groups too, after every first page, until the budget is full', () => {
    const ss = subs(250);
    const g = graph([domain, ...ss], fanOut(ss));
    const all = view(g, { expandAll: [domain.id] });
    expect(all.nodes.filter((n) => n.type === 'subdomain')).toHaveLength(250);
    expect(all.expandAll).toEqual([{ nodeId: domain.id, opened: 1, hidden: 0 }]);
    expect(all.state.expand).toEqual([open(SUBS, 3)]);
    const some = view(g, { maxElements: 420, expandAll: [domain.id] });
    expect(some.state.expand).toEqual([open(SUBS, 2)]);
    expect(some.expandAll).toEqual([{ nodeId: domain.id, opened: 1, hidden: 50 }]);
    expect(some.truncated).toBe(true);
  });

  test('stops at the budget and says how many nodes below are still not shown', () => {
    const { g } = threeLevels();
    const r = view(g, { maxElements: 30, expandAll: [domain.id] });
    const [result] = r.expandAll;
    expect(result?.hidden).toBeGreaterThan(0);
    expect(result?.opened).toBeLessThan(10);
    expect(r.truncated).toBe(true);
  });
});

describe('groupPath', () => {
  test('a step for each group on the way down, from the root', () => {
    const { g, ss, ips, ports } = threeLevels();
    const [s1] = [ss[1] as GraphNode];
    const ip = (ips[1] as readonly [GraphNode, GraphNode])[1];
    const port = (ports[3] as readonly [GraphNode, GraphNode])[0];
    expect(groupPath(g, port.id)).toEqual([
      { groupId: SUBS, memberId: s1.id },
      { groupId: ipsOf(s1), memberId: ip.id },
      { groupId: portsOf(ip), memberId: port.id },
    ]);
    // Opening exactly those as pins draws the port and nothing else at those levels.
    const steps = groupPath(g, port.id) ?? [];
    const r = view(g, { expand: steps.map((s) => open(s.groupId, 0, [s.memberId])) });
    expect(shown(r).has(port.id)).toBe(true);
    expect(r.nodes.filter((n) => n.type === 'port')).toHaveLength(1);
  });

  test('groups of one are not groups: no step', () => {
    const [only] = subs(1) as [GraphNode];
    expect(groupPath(graph([domain, only], fanOut([only])), only.id)).toEqual([]);
  });

  test('a root group is a step', () => {
    const roots = subs(30);
    expect(groupPath(graph(roots, []), (roots[7] as GraphNode).id)).toEqual([
      { groupId: 'agg:root:subdomain', memberId: (roots[7] as GraphNode).id },
    ]);
  });

  test('null when the node is not in the graph', () => {
    expect(groupPath(graph([domain], []), 'nope')).toBeNull();
  });
});

describe('effectiveSeverities', () => {
  test('the highest severity anywhere below a node, through cycles', () => {
    const [a, b, c, d] = [node('url', 'https://a.x.com/'), node('url', 'https://b.x.com/'), node('url', 'https://c.x.com/'), node('url', 'https://d.x.com/')];
    const low = node('vulnerability', 'low-thing', { severity: 'low' });
    const crit = node('vulnerability', 'crit-thing', { severity: 'critical' });
    // a → b → c → a (cycle), c → crit; d → low
    const eff = effectiveSeverities(
      [a, b, c, d, low, crit],
      [edge(a, 'has_url', b), edge(b, 'has_url', c), edge(c, 'has_url', a), edge(c, 'has_vulnerability', crit), edge(d, 'has_vulnerability', low)],
    );
    expect([a, b, c, d, low, crit].map((n) => eff.get(n.id))).toEqual(['critical', 'critical', 'critical', 'low', 'low', 'critical']);
  });

  test('a node with nothing below it keeps its own severity, or null', () => {
    const lone = node('ip', '198.18.0.9');
    expect(effectiveSeverities([lone], []).get(lone.id)).toBeNull();
  });
});
