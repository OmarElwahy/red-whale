// Server-side aggregation (docs/architecture.md §7). Pure: a filtered graph in, what the browser should draw out.
//
// Walk down from the roots. When one node has more than `threshold` children of one type via one relation,
// those children fold into a single aggregate node, except "sticky" ones (effective severity ≥ medium,
// tagged interesting, or pinned). Anything reachable only through folded children stays hidden until the
// aggregate is expanded. Nothing is dropped from the database; this only decides what one response contains.
import {
  NODE_TYPES,
  RELATION_TYPES,
  aggregateId,
  type AggregateKey,
  type AggregateNode,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type Severity,
} from '@redwhale/shared';
import { maxSeverity } from '../ingest/derive';
import { riskFirst, severityRank, type Graph } from './store';

export const AGG_THRESHOLD = 25;
export const MAX_ELEMENTS = 2000;
/** Thresholds tried, in order, after the configured one when a response is too big. */
const FALLBACK_THRESHOLDS = [10, 5, 2];

export interface AggregateOptions {
  threshold: number;
  maxElements: number;
  /** Always visible and treated as roots (e.g. the centre of a neighbourhood). */
  pinned?: readonly string[];
}

export interface AggregateResult {
  nodes: (GraphNode | AggregateNode)[];
  edges: GraphEdge[];
  truncated: boolean;
  threshold: number;
}

const PLURAL: Record<NodeType, string> = {
  domain: 'domains',
  subdomain: 'subdomains',
  ip: 'IPs',
  port: 'ports',
  url: 'URLs',
  technology: 'technologies',
  vulnerability: 'vulnerabilities',
  email: 'emails',
  secret: 'secrets',
  certificate: 'certificates',
  leak: 'leaks',
};

const MEDIUM = severityRank('medium');

interface Group {
  key: AggregateKey;
  members: GraphNode[];
  folded: string[];
}

interface Layout {
  /** Node and aggregate IDs in the order they became visible. */
  order: string[];
  visible: Set<string>;
  groups: Map<string, Group>;
}

function groupKey(relation: string, type: NodeType): number {
  return RELATION_TYPES.indexOf(relation as (typeof RELATION_TYPES)[number]) * NODE_TYPES.length + NODE_TYPES.indexOf(type);
}

function layout(graph: Graph, threshold: number, keepSticky: boolean, pinned: ReadonlySet<string>): Layout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, GraphEdge[]>();
  const hasParent = new Set<string>();
  for (const e of graph.edges) {
    const list = children.get(e.source);
    if (list) list.push(e);
    else children.set(e.source, [e]);
    hasParent.add(e.target);
  }

  const order: string[] = [];
  const visible = new Set<string>();
  const groups = new Map<string, Group>();
  const queue: string[] = [];
  let head = 0;

  const show = (id: string) => {
    if (visible.has(id)) return;
    visible.add(id);
    order.push(id);
    queue.push(id);
  };
  const sticky = (n: GraphNode) =>
    pinned.has(n.id) || (keepSticky && (severityRank(n.effectiveSeverity) >= MEDIUM || n.tag === 'interesting'));

  const place = (key: AggregateKey, members: GraphNode[]) => {
    members.sort(riskFirst);
    if (members.length <= threshold) {
      for (const m of members) show(m.id);
      return;
    }
    const id = aggregateId(key);
    const group: Group = { key, members, folded: [] };
    groups.set(id, group);
    order.push(id);
    for (const m of members) {
      if (sticky(m)) show(m.id);
      else group.folded.push(m.id);
    }
  };

  const drain = () => {
    while (head < queue.length) {
      const id = queue[head++] ?? '';
      const byGroup = new Map<number, { relation: GraphEdge['relation']; type: NodeType; members: GraphNode[] }>();
      for (const e of children.get(id) ?? []) {
        const child = byId.get(e.target);
        if (!child) continue;
        const k = groupKey(e.relation, child.type);
        const g = byGroup.get(k);
        if (g) g.members.push(child);
        else byGroup.set(k, { relation: e.relation, type: child.type, members: [child] });
      }
      for (const k of [...byGroup.keys()].sort((a, b) => a - b)) {
        const g = byGroup.get(k);
        if (g) place({ parentId: id, relation: g.relation, childType: g.type }, g.members);
      }
    }
  };

  // Roots: nodes with no parent in this graph, plus pinned nodes. Too many of one type fold, too.
  const rootsByType = new Map<NodeType, GraphNode[]>();
  for (const n of graph.nodes) {
    if (hasParent.has(n.id) && !pinned.has(n.id)) continue;
    const list = rootsByType.get(n.type);
    if (list) list.push(n);
    else rootsByType.set(n.type, [n]);
  }
  for (const type of NODE_TYPES) {
    const roots = rootsByType.get(type);
    if (roots) place({ parentId: null, relation: null, childType: type }, roots);
  }
  drain();

  // Parts of the graph with no root at all (only cycles, e.g. url ⇄ url) are walked from their riskiest node.
  for (;;) {
    const hidden = new Set<string>();
    const stack = [...groups.values()].flatMap((g) => g.folded).filter((id) => !visible.has(id));
    while (stack.length > 0) {
      const id = stack.pop() ?? '';
      if (hidden.has(id) || visible.has(id)) continue;
      hidden.add(id);
      for (const e of children.get(id) ?? []) stack.push(e.target);
    }
    const unreached = graph.nodes.filter((n) => !visible.has(n.id) && !hidden.has(n.id));
    if (unreached.length === 0) break;
    show((unreached.sort(riskFirst)[0] as GraphNode).id);
    drain();
  }

  return { order, visible, groups };
}

function render(graph: Graph, l: Layout): Omit<AggregateResult, 'truncated' | 'threshold'> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const aggregates = new Map<string, AggregateNode>();
  const aggEdges: GraphEdge[] = [];

  for (const [id, g] of l.groups) {
    // A folded member that another path made visible is drawn, not counted.
    const count = g.folded.filter((m) => !l.visible.has(m)).length;
    if (count === 0) continue;
    aggregates.set(id, {
      id,
      type: 'aggregate',
      label: `${String(count)} ${PLURAL[g.key.childType]}`,
      count,
      total: g.members.length,
      childType: g.key.childType,
      relation: g.key.relation,
      parentId: g.key.parentId,
      maxSeverity: g.members.reduce<Severity | null>((s, m) => maxSeverity(s, m.effectiveSeverity), null),
    });
    if (g.key.parentId !== null) {
      aggEdges.push({ id: `edge:${id}`, source: g.key.parentId, target: id, relation: g.key.relation });
    }
  }

  const nodes: (GraphNode | AggregateNode)[] = [];
  for (const id of l.order) {
    const n = byId.get(id) ?? aggregates.get(id);
    if (n) nodes.push(n);
  }
  const edges = graph.edges.filter((e) => l.visible.has(e.source) && l.visible.has(e.target));
  return { nodes, edges: [...edges, ...aggEdges] };
}

const size = (r: { nodes: unknown[]; edges: unknown[] }) => r.nodes.length + r.edges.length;

/** Keeps nodes in visiting order while the node + edge count fits; edges only between kept nodes. */
function cut(r: Omit<AggregateResult, 'truncated' | 'threshold'>, maxElements: number) {
  const incident = new Map<string, GraphEdge[]>();
  for (const e of r.edges) {
    for (const end of [e.source, e.target]) {
      const list = incident.get(end);
      if (list) list.push(e);
      else incident.set(end, [e]);
    }
  }
  const kept = new Set<string>();
  const nodes: (GraphNode | AggregateNode)[] = [];
  let used = 0;
  for (const n of r.nodes) {
    const added = (incident.get(n.id) ?? []).filter((e) => kept.has(e.source === n.id ? e.target : e.source));
    const selfLoops = (incident.get(n.id) ?? []).filter((e) => e.source === n.id && e.target === n.id).length / 2;
    if (used + 1 + added.length + selfLoops > maxElements) break;
    kept.add(n.id);
    nodes.push(n);
    used += 1 + added.length + selfLoops;
  }
  return { nodes, edges: r.edges.filter((e) => kept.has(e.source) && kept.has(e.target)) };
}

export function aggregateGraph(graph: Graph, options: AggregateOptions): AggregateResult {
  const pinned = new Set(options.pinned ?? []);
  const ladder = [options.threshold, ...FALLBACK_THRESHOLDS.filter((t) => t < options.threshold)];

  for (const threshold of ladder) {
    const r = render(graph, layout(graph, threshold, true, pinned));
    if (size(r) <= options.maxElements) return { ...r, truncated: threshold !== options.threshold, threshold };
  }
  // Still too big: fold sticky children too, and as a last resort cut the result.
  const threshold = ladder.at(-1) ?? options.threshold;
  const r = render(graph, layout(graph, threshold, false, pinned));
  if (size(r) <= options.maxElements) return { ...r, truncated: true, threshold };
  return { ...cut(r, options.maxElements), truncated: true, threshold };
}
