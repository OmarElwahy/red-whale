import {
  aggregateNodeSchema,
  edgeId,
  graphNodeSchema,
  nodeId,
  type AggregateNode,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type Relation,
  type Severity,
  type Tag,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { AGG_THRESHOLD, aggregateGraph, type AggregateResult } from '../src/graph/aggregate';
import { effectiveSeverities, type Graph } from '../src/graph/store';

const T = '2026-10-29T10:00:00.000Z';

function node(type: NodeType, value: string, extra: { severity?: Severity; tag?: Tag } = {}): GraphNode {
  return {
    id: nodeId(type, value),
    type,
    value,
    label: value,
    severity: extra.severity ?? null,
    effectiveSeverity: extra.severity ?? null,
    confidence: 'discovered',
    sourceCount: 1,
    tag: extra.tag ?? null,
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

const domain = node('domain', 'example.com');
const subs = (n: number, prefix = 'host') =>
  Array.from({ length: n }, (_, i) => node('subdomain', `${prefix}${String(i).padStart(4, '0')}.example.com`));
const fanOut = (children: GraphNode[], parent = domain, relation: Relation = 'has_subdomain') =>
  children.map((c) => edge(parent, relation, c));

function run(g: Graph, options: Partial<Parameters<typeof aggregateGraph>[1]> = {}): AggregateResult {
  const r = aggregateGraph(g, { threshold: AGG_THRESHOLD, maxElements: 2000, ...options });
  // Invariants for every result: valid shapes, unique IDs, no dangling edges, within the cap.
  const ids = r.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const n of r.nodes) (n.type === 'aggregate' ? aggregateNodeSchema : graphNodeSchema).parse(n);
  for (const e of r.edges) {
    expect(ids).toContain(e.source);
    expect(ids).toContain(e.target);
  }
  expect(new Set(r.edges.map((e) => e.id)).size).toBe(r.edges.length);
  expect(r.nodes.length + r.edges.length).toBeLessThanOrEqual(options.maxElements ?? 2000);
  return r;
}

const aggregates = (r: AggregateResult) => r.nodes.filter((n): n is AggregateNode => n.type === 'aggregate');
const visibleIds = (r: AggregateResult) => new Set(r.nodes.map((n) => n.id));

describe('threshold', () => {
  test('25 children stay as they are', () => {
    const children = subs(25);
    const r = run(graph([domain, ...children], fanOut(children)));
    expect(aggregates(r)).toEqual([]);
    expect(r.nodes).toHaveLength(26);
    expect(r.edges).toHaveLength(25);
    expect(r).toMatchObject({ truncated: false, threshold: 25 });
  });

  test('26 children fold into one aggregate', () => {
    const children = subs(26);
    const r = run(graph([domain, ...children], fanOut(children)));
    expect(r.nodes.map((n) => n.id)).toEqual([domain.id, `agg:${domain.id}:has_subdomain:subdomain`]);
    expect(aggregates(r)[0]).toEqual({
      id: `agg:${domain.id}:has_subdomain:subdomain`,
      type: 'aggregate',
      label: '26 subdomains',
      count: 26,
      total: 26,
      childType: 'subdomain',
      relation: 'has_subdomain',
      parentId: domain.id,
      maxSeverity: null,
    });
    expect(r.edges).toEqual([
      {
        id: `edge:agg:${domain.id}:has_subdomain:subdomain`,
        source: domain.id,
        target: `agg:${domain.id}:has_subdomain:subdomain`,
        relation: 'has_subdomain',
      },
    ]);
  });

  test('the threshold is configurable', () => {
    const children = subs(6);
    expect(aggregates(run(graph([domain, ...children], fanOut(children)), { threshold: 5 }))).toHaveLength(1);
  });
});

describe('sticky children stay visible', () => {
  test('severity medium or worse, or tagged interesting; maxSeverity covers every member', () => {
    const children = subs(30);
    const [high, interesting, low] = [
      node('subdomain', 'high.example.com', { severity: 'high' }),
      node('subdomain', 'tagged.example.com', { tag: 'interesting' }),
      node('subdomain', 'low.example.com', { severity: 'low' }),
    ];
    const all = [...children, high, interesting, low];
    const r = run(graph([domain, ...all], fanOut(all)));
    const ids = visibleIds(r);
    expect(ids.has(high.id) && ids.has(interesting.id)).toBe(true);
    expect(ids.has(low.id)).toBe(false);
    expect(aggregates(r)[0]).toMatchObject({ count: 31, total: 33, maxSeverity: 'high', label: '31 subdomains' });
  });

  test('a subdomain whose URL has a high vulnerability stays visible (effective severity)', () => {
    const children = subs(30);
    const [risky] = children;
    if (!risky) throw new Error('no children');
    const url = node('url', `https://${risky.value}/`);
    const vuln = node('vulnerability', 'CVE-2021-41773', { severity: 'high' });
    const g = graph(
      [domain, ...children, url, vuln],
      [...fanOut(children), edge(risky, 'serves', url), edge(url, 'has_vulnerability', vuln)],
    );
    const r = run(g);
    expect([...visibleIds(r)]).toEqual(expect.arrayContaining([risky.id, url.id, vuln.id]));
    expect(aggregates(r)[0]).toMatchObject({ count: 29, total: 30, maxSeverity: 'high' });
  });

  test('pinned nodes always stay visible', () => {
    const children = subs(30);
    const pin = children[7];
    if (!pin) throw new Error('no child');
    const r = run(graph([domain, ...children], fanOut(children)), { pinned: [pin.id] });
    expect(visibleIds(r).has(pin.id)).toBe(true);
  });
});

describe('what folding hides', () => {
  test('a node reachable only through folded children is hidden; one with a visible parent is shown', () => {
    const children = subs(30);
    const visibleSub = node('subdomain', 'tagged.example.com', { tag: 'interesting' });
    const [hiddenSub] = children;
    if (!hiddenSub) throw new Error('no child');
    const privateIp = node('ip', '198.18.0.1');
    const sharedIp = node('ip', '198.18.0.2');
    const g = graph(
      [domain, ...children, visibleSub, privateIp, sharedIp],
      [
        ...fanOut([...children, visibleSub]),
        edge(hiddenSub, 'resolves_to', privateIp),
        edge(hiddenSub, 'resolves_to', sharedIp),
        edge(visibleSub, 'resolves_to', sharedIp),
      ],
    );
    const ids = visibleIds(run(g));
    expect(ids.has(privateIp.id)).toBe(false);
    expect(ids.has(sharedIp.id)).toBe(true);
  });

  test('different relations and child types under one parent are separate aggregates', () => {
    const children = subs(30);
    const ips = Array.from({ length: 30 }, (_, i) => node('ip', `198.18.1.${String(i + 1)}`));
    const r = run(graph([domain, ...children, ...ips], [...fanOut(children), ...fanOut(ips, domain, 'resolves_to')]));
    expect(aggregates(r).map((a) => a.id)).toEqual([
      `agg:${domain.id}:has_subdomain:subdomain`,
      `agg:${domain.id}:resolves_to:ip`,
    ]);
    expect(aggregates(r).map((a) => a.label)).toEqual(['30 subdomains', '30 IPs']);
  });

  test('a folded member that another visible parent links to is drawn and not counted', () => {
    const children = subs(30);
    const [shared] = children;
    if (!shared) throw new Error('no child');
    const otherDomain = node('domain', 'example.org');
    const r = run(graph([domain, otherDomain, ...children], [...fanOut(children), edge(otherDomain, 'has_subdomain', shared)]));
    expect(visibleIds(r).has(shared.id)).toBe(true);
    expect(aggregates(r)[0]).toMatchObject({ count: 29, total: 30 });
    expect(r.edges.map((e) => [e.source, e.target])).toContainEqual([domain.id, shared.id]);
  });
});

describe('roots', () => {
  test('more than the threshold parentless nodes of one type fold into agg:root:<type>', () => {
    const children = subs(40);
    const r = run(graph(children, []));
    expect(aggregates(r)).toEqual([
      expect.objectContaining({ id: 'agg:root:subdomain', parentId: null, relation: null, count: 40, label: '40 subdomains' }),
    ]);
    expect(r.edges).toEqual([]);
  });

  test('a graph made only of a cycle is still returned, without looping forever', () => {
    const a = node('url', 'https://a.example.com/');
    const b = node('url', 'https://a.example.com/b');
    const r = run(graph([a, b], [edge(a, 'has_url', b), edge(b, 'has_url', a)]));
    expect(visibleIds(r)).toEqual(new Set([a.id, b.id]));
    expect(r.edges).toHaveLength(2);
  });
});

describe('order', () => {
  test('riskiest first, then by value', () => {
    const plain = node('subdomain', 'a.example.com');
    const crit = node('subdomain', 'z.example.com', { severity: 'critical' });
    const med = node('subdomain', 'm.example.com', { severity: 'medium' });
    const r = run(graph([domain, plain, crit, med], fanOut([plain, crit, med])));
    expect(r.nodes.map((n) => n.id)).toEqual([domain.id, crit.id, med.id, plain.id]);
  });

  test('the same input always gives the same output', () => {
    const children = subs(100);
    const g = graph([domain, ...children], fanOut(children));
    expect(run(g)).toEqual(run({ nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }));
  });
});

describe('the element cap', () => {
  // 30 domains × 20 subdomains each: under the threshold, but 30 + 600 + 600 = 1230 elements.
  const domains = Array.from({ length: 30 }, (_, i) => node('domain', `d${String(i)}.example`));
  const children = domains.flatMap((d) =>
    Array.from({ length: 20 }, (_, i) => node('subdomain', `h${String(i)}.${d.value}`)),
  );
  const edges = domains.flatMap((d, i) => fanOut(children.slice(i * 20, i * 20 + 20), d));
  const g = graph([...domains, ...children], edges);

  // 30 parentless domains would fold into agg:root:domain, so the tests pin them.
  test('under the cap: nothing changes', () => {
    const r = run(g, { maxElements: 2000, pinned: domains.map((d) => d.id) });
    expect(r).toMatchObject({ truncated: false, threshold: 25 });
    expect(r.nodes).toHaveLength(630);
  });

  test('over the cap: the threshold is lowered and the response says so', () => {
    const r = run(g, { maxElements: 1000, pinned: domains.map((d) => d.id) });
    expect(r).toMatchObject({ truncated: true, threshold: 10 });
    expect(aggregates(r)).toHaveLength(30);
  });

  test('sticky children fold too when lowering the threshold is not enough', () => {
    const stickyChildren = children.map((c) => ({ ...c, effectiveSeverity: 'high' as const, severity: 'high' as const }));
    const r = run({ nodes: [...domains, ...stickyChildren], edges }, { maxElements: 100, pinned: domains.map((d) => d.id) });
    expect(r).toMatchObject({ truncated: true, threshold: 2 });
    expect(aggregates(r)).toHaveLength(30);
  });

  test('as a last resort the result is cut to the cap', () => {
    const r = run(g, { maxElements: 20, pinned: domains.map((d) => d.id) });
    expect(r.truncated).toBe(true);
    expect(r.nodes.length + r.edges.length).toBeLessThanOrEqual(20);
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
