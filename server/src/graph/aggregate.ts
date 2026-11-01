// Server-side grouping (docs/architecture.md §7). Pure: a filtered graph and the analyst's view state in, what the
// browser should draw out.
//
// The children of one parent with the same relation and type form a group when there are two or more of them (one
// child is drawn directly). Parentless nodes form a group per type above ROOT_GROUP_THRESHOLD. Every group starts
// collapsed; an open group stays on the canvas as its members' parent (parent → group → member). The walk goes
// down from the roots and stops at collapsed groups, so whatever sits below one stays hidden until it is opened.
// Nothing is dropped from the database; this only decides what one response contains.
import {
  GROUP_PAGE_SIZE,
  NODE_TYPES,
  RELATION_TYPES,
  ROOT_GROUP_THRESHOLD,
  aggregateId,
  type AggregateNode,
  type GraphEdge,
  type GraphNode,
  type GroupOpen,
  type MoreNode,
  type NodeType,
  type Relation,
  type Severity,
  type ViewEdge,
  type ViewNode,
  type ViewState,
} from '@redwhale/shared';
import { maxSeverity } from '../ingest/derive';
import { riskFirst, type Graph } from './store';

export const MAX_ELEMENTS = 2000;

export interface ViewOptions {
  maxElements: number;
  /** Open groups, oldest first: when the budget is short, the last ones are refused first. */
  expand?: readonly GroupOpen[];
  /** Nodes whose parents are all drawn, with the edges to them. */
  neighbors?: readonly string[];
  /** One-shot: open every group below these nodes, as far as the budget allows. */
  expandAll?: readonly string[];
  /** What the canvas showed directly (`relation` edge IDs, parentless node IDs); see `graphViewRequestSchema`. */
  keep?: { edges: readonly string[]; roots: readonly string[] };
  /** Always drawn and walked like roots (the centre of /graph/neighbors). */
  entries?: readonly string[];
}

export interface ViewResult {
  nodes: ViewNode[];
  edges: ViewEdge[];
  truncated: boolean;
  state: ViewState;
  overBudget: string[];
  autoOpened: string[];
  autoFolded: string[];
  expandAll: { nodeId: string; opened: number; hidden: number }[];
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

// --- the graph, indexed by child set ------------------------------------------------------------------

/** The children of one parent with one relation and type (or the parentless nodes of one type). */
interface ChildSet {
  /** The group ID, also for a set that is too small to be a group. */
  id: string;
  parentId: string | null;
  relation: Relation | null;
  type: NodeType;
  /** Riskiest first. */
  members: GraphNode[];
  /** Member → its edge from the parent. */
  edgeOf: Map<string, GraphEdge>;
  isGroup: boolean;
}

interface Index {
  byId: Map<string, GraphNode>;
  sets: Map<string, ChildSet>;
  /** Parent → its child sets, by relation then type. */
  childSets: Map<string, ChildSet[]>;
  rootSets: ChildSet[];
  /** Riskiest node of each part of the graph no root reaches (e.g. only cycles), in the order they're walked. */
  pseudoRoots: string[];
  parentEdges: Map<string, GraphEdge[]>;
  childEdges: Map<string, GraphEdge[]>;
}

const setOrder = (relation: Relation, type: NodeType) =>
  RELATION_TYPES.indexOf(relation) * NODE_TYPES.length + NODE_TYPES.indexOf(type);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildIndex(graph: Graph): Index {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sets = new Map<string, ChildSet>();
  const childSets = new Map<string, ChildSet[]>();
  const parentEdges = new Map<string, GraphEdge[]>();
  const childEdges = new Map<string, GraphEdge[]>();

  for (const e of graph.edges) {
    const child = byId.get(e.target);
    if (!child || !byId.has(e.source)) continue;
    push(parentEdges, e.target, e);
    push(childEdges, e.source, e);
    const id = aggregateId({ parentId: e.source, relation: e.relation, childType: child.type });
    let set = sets.get(id);
    if (!set) {
      set = { id, parentId: e.source, relation: e.relation, type: child.type, members: [], edgeOf: new Map(), isGroup: false };
      sets.set(id, set);
      push(childSets, e.source, set);
    }
    if (!set.edgeOf.has(child.id)) {
      set.members.push(child);
      set.edgeOf.set(child.id, e);
    }
  }
  for (const list of childSets.values()) {
    list.sort((a, b) => setOrder(a.relation as Relation, a.type) - setOrder(b.relation as Relation, b.type));
    for (const s of list) {
      s.members.sort(riskFirst);
      s.isGroup = s.members.length >= 2;
    }
  }

  const rootSets: ChildSet[] = [];
  for (const type of NODE_TYPES) {
    const members = graph.nodes.filter((n) => n.type === type && !parentEdges.has(n.id)).sort(riskFirst);
    if (members.length === 0) continue;
    const id = aggregateId({ parentId: null, relation: null, childType: type });
    const set: ChildSet = {
      id,
      parentId: null,
      relation: null,
      type,
      members,
      edgeOf: new Map(),
      isGroup: members.length > ROOT_GROUP_THRESHOLD,
    };
    sets.set(id, set);
    rootSets.push(set);
  }

  // Parts of the graph with no root at all (only cycles, e.g. url ⇄ url) are walked from their riskiest node.
  const reached = new Set<string>();
  const reach = (start: string) => {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() ?? '';
      if (reached.has(id)) continue;
      reached.add(id);
      for (const e of childEdges.get(id) ?? []) stack.push(e.target);
    }
  };
  for (const s of rootSets) for (const m of s.members) reach(m.id);
  const pseudoRoots: string[] = [];
  for (;;) {
    const unreached = graph.nodes.filter((n) => !reached.has(n.id));
    if (unreached.length === 0) break;
    const start = (unreached.sort(riskFirst)[0] as GraphNode).id;
    pseudoRoots.push(start);
    reach(start);
  }

  return { byId, sets, childSets, rootSets, pseudoRoots, parentEdges, childEdges };
}

// --- risk badge -----------------------------------------------------------------------------------------

type Risk = { critical: Set<string>; high: Set<string> };

/**
 * For every child set: the distinct high/critical nodes at or below its members. Walks up from each serious node
 * once, so a node reachable through several paths (a shared IP) is counted once per set.
 */
function riskBySet(ix: Index): Map<string, Risk> {
  const out = new Map<string, Risk>();
  for (const s of ix.byId.values()) {
    if (s.severity !== 'high' && s.severity !== 'critical') continue;
    const seen = new Set<string>([s.id]);
    const queue = [s.id];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i] ?? '';
      const node = ix.byId.get(id);
      if (!node) continue;
      const parents = ix.parentEdges.get(id);
      const keys = parents
        ? parents.map((e) => aggregateId({ parentId: e.source, relation: e.relation, childType: node.type }))
        : [aggregateId({ parentId: null, relation: null, childType: node.type })];
      for (const key of keys) {
        let r = out.get(key);
        if (!r) {
          r = { critical: new Set(), high: new Set() };
          out.set(key, r);
        }
        r[s.severity].add(s.id);
      }
      for (const e of parents ?? []) {
        if (seen.has(e.source)) continue;
        seen.add(e.source);
        queue.push(e.source);
      }
    }
  }
  return out;
}

// --- the walk ---------------------------------------------------------------------------------------------

interface OpenState {
  pages: number;
  pins: Set<string>;
}

interface DrawnGroup {
  set: ChildSet;
  open: OpenState | null;
  /** Members drawn under the group, in order. */
  members: string[];
}

interface Walk {
  /** Node and group IDs in the order they became visible. */
  order: string[];
  visible: Set<string>;
  groups: Map<string, DrawnGroup>;
  neighborEdges: GraphEdge[];
  appliedNeighbors: string[];
}

function walk(ix: Index, open: ReadonlyMap<string, OpenState>, neighbors: readonly string[], entries: readonly string[]): Walk {
  const order: string[] = [];
  const visible = new Set<string>();
  const groups = new Map<string, DrawnGroup>();
  const queue: string[] = [];
  let head = 0;

  const show = (id: string) => {
    if (visible.has(id) || !ix.byId.has(id)) return;
    visible.add(id);
    order.push(id);
    queue.push(id);
  };
  const place = (set: ChildSet) => {
    if (!set.isGroup) {
      for (const m of set.members) show(m.id);
      return;
    }
    const o = open.get(set.id) ?? null;
    const drawn: DrawnGroup = { set, open: o, members: [] };
    groups.set(set.id, drawn);
    order.push(set.id);
    if (!o) return;
    const limit = o.pages * GROUP_PAGE_SIZE;
    set.members.forEach((m, i) => {
      if (i >= limit && !o.pins.has(m.id)) return;
      drawn.members.push(m.id);
      show(m.id);
    });
  };
  const drain = () => {
    while (head < queue.length) {
      const id = queue[head++] ?? '';
      for (const set of ix.childSets.get(id) ?? []) place(set);
    }
  };

  for (const id of entries) show(id);
  drain();
  for (const set of ix.rootSets) place(set);
  drain();
  for (const id of ix.pseudoRoots) show(id);
  drain();

  // A neighbor expansion draws every parent of its node, once the node itself is drawn (which may take another
  // expansion's parents first).
  const neighborEdges: GraphEdge[] = [];
  const appliedNeighbors: string[] = [];
  const pending = [...new Set(neighbors)];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < pending.length; i++) {
      const center = pending[i] ?? '';
      if (!visible.has(center)) continue;
      pending.splice(i--, 1);
      changed = true;
      appliedNeighbors.push(center);
      for (const e of ix.parentEdges.get(center) ?? []) {
        show(e.source);
        neighborEdges.push(e);
      }
      drain();
    }
  }

  return { order, visible, groups, neighborEdges, appliedNeighbors };
}

function groupLabel(set: ChildSet): string {
  return `${String(set.members.length)} ${PLURAL[set.type]}`;
}

/** Elements a page of these members would add: each one's node and member edge, and what hangs below it collapsed. */
function pageCost(ix: Index, w: Walk, members: readonly GraphNode[]): number {
  const memo = new Map<string, number>();
  const below = (id: string, path: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return 0;
    path.add(id);
    let cost = 0;
    for (const set of ix.childSets.get(id) ?? []) {
      if (set.isGroup) {
        cost += 2;
        continue;
      }
      const child = set.members[0];
      if (!child) continue;
      cost += w.visible.has(child.id) ? 1 : 2 + below(child.id, path);
    }
    path.delete(id);
    memo.set(id, cost);
    return cost;
  };
  let cost = 0;
  for (const m of members) cost += w.visible.has(m.id) ? 1 : 2 + below(m.id, new Set());
  return cost;
}

interface Rendered {
  nodes: ViewNode[];
  edges: ViewEdge[];
}

/** The provenance fields of a view edge that stands for no single real edge. */
const NO_PROVENANCE = { sourceCount: null, confidence: null, tools: null, edgeCount: null } as const;

/** A real edge drawn on the canvas: its own provenance, no group fields. */
function realEdge(e: GraphEdge, kind: 'relation' | 'neighbor'): ViewEdge {
  return { ...e, kind, tools: null, edgeCount: null };
}

/** Every tool that reported any of these edges, sorted. */
function toolUnion(edgeTools: Graph['edgeTools'], list: Iterable<GraphEdge>): string[] {
  const tools = new Set<string>();
  for (const e of list) for (const t of edgeTools.get(e.id) ?? []) tools.add(t);
  return [...tools].sort();
}

function render(
  ix: Index,
  w: Walk,
  risk: ReadonlyMap<string, Risk>,
  maxElements: number,
  edgeTools: Graph['edgeTools'],
): Rendered {
  const groupNodes = new Map<string, AggregateNode>();
  const extraNodes: MoreNode[] = [];
  const edges: ViewEdge[] = [];
  const edgeIds = new Set<string>();
  const addEdge = (e: ViewEdge) => {
    if (edgeIds.has(e.id)) return;
    edgeIds.add(e.id);
    edges.push(e);
  };

  // Real edges: a parent's only child of that kind, whichever way both ends got onto the canvas.
  for (const id of w.order) {
    if (!w.visible.has(id)) continue;
    for (const set of ix.childSets.get(id) ?? []) {
      const child = set.members[0];
      if (set.isGroup || !child || !w.visible.has(child.id)) continue;
      const e = set.edgeOf.get(child.id);
      if (e) addEdge(realEdge(e, 'relation'));
    }
  }

  for (const [id, g] of w.groups) {
    const shown = g.members.length;
    const remaining = g.set.members.length - shown;
    if (g.set.parentId !== null) {
      addEdge({
        ...NO_PROVENANCE,
        id: `edge:${id}`,
        source: g.set.parentId,
        target: id,
        relation: g.set.relation,
        kind: 'group',
        tools: toolUnion(edgeTools, g.set.edgeOf.values()),
        edgeCount: g.set.edgeOf.size,
      });
    }
    for (const m of g.members) {
      addEdge({ ...NO_PROVENANCE, id: `member:${id}:${m}`, source: id, target: m, relation: null, kind: 'member' });
    }
    if (g.open && remaining > 0) {
      const moreId = `more:${id}`;
      extraNodes.push({ id: moreId, type: 'more', groupId: id, label: `+${String(remaining)} more`, remaining });
      addEdge({ ...NO_PROVENANCE, id: `edge:${moreId}`, source: id, target: moreId, relation: null, kind: 'more' });
    }
    const r = risk.get(id);
    groupNodes.set(id, {
      id,
      type: 'aggregate',
      label: groupLabel(g.set),
      count: g.set.members.length,
      childType: g.set.type,
      relation: g.set.relation,
      parentId: g.set.parentId,
      maxSeverity: g.set.members.reduce<Severity | null>((s, m) => maxSeverity(s, m.effectiveSeverity), null),
      risk: { critical: r?.critical.size ?? 0, high: r?.high.size ?? 0 },
      expanded: g.open !== null,
      shown,
      remaining,
      canLoadMore: false,
    });
  }
  for (const e of w.neighborEdges) addEdge(realEdge(e, 'neighbor'));

  const nodes: ViewNode[] = [];
  for (const id of w.order) {
    const n = ix.byId.get(id) ?? groupNodes.get(id);
    if (n) nodes.push(n);
  }
  nodes.push(...extraNodes);

  // Can the next page of each group (the first, while collapsed) still fit?
  const size = nodes.length + edges.length;
  for (const [id, g] of w.groups) {
    const node = groupNodes.get(id);
    if (!node || node.remaining === 0) continue;
    const from = g.open ? g.open.pages * GROUP_PAGE_SIZE : 0;
    const next = g.set.members.slice(from, from + GROUP_PAGE_SIZE).filter((m) => !g.members.includes(m.id));
    const more = node.remaining - next.length > 0 && !g.open ? 2 : 0;
    node.canLoadMore = next.length > 0 && size + pageCost(ix, w, next) + more <= maxElements;
  }
  return { nodes, edges };
}

/** Keeps nodes in visiting order while the node + edge count fits; edges only between kept nodes. */
function cut(r: Rendered, maxElements: number): Rendered {
  const incident = new Map<string, ViewEdge[]>();
  for (const e of r.edges) {
    push(incident, e.source, e);
    if (e.target !== e.source) push(incident, e.target, e);
  }
  const kept = new Set<string>();
  const nodes: ViewNode[] = [];
  let used = 0;
  for (const n of r.nodes) {
    const added = (incident.get(n.id) ?? []).filter((e) => {
      const other = e.source === n.id ? e.target : e.source;
      return other === n.id || kept.has(other);
    }).length;
    if (used + 1 + added > maxElements) break;
    kept.add(n.id);
    nodes.push(n);
    used += 1 + added;
  }
  return { nodes, edges: r.edges.filter((e) => kept.has(e.source) && kept.has(e.target)) };
}

// --- what the analyst asked for, granted in order until the budget is full -------------------------------

/** One step of the view state. Units are granted in order; when the budget is short, the tail is refused. */
type Unit =
  | { kind: 'open'; id: string; pages: number; pins: readonly string[]; origin: 'user' | 'expandAll' | 'auto'; from?: string }
  | { kind: 'neighbors'; center: string };

function applyUnits(units: readonly Unit[]): { open: Map<string, OpenState>; neighbors: string[] } {
  const open = new Map<string, OpenState>();
  const neighbors: string[] = [];
  for (const u of units) {
    if (u.kind === 'neighbors') {
      neighbors.push(u.center);
      continue;
    }
    const o = open.get(u.id);
    if (o) {
      o.pages = Math.max(o.pages, u.pages);
      for (const p of u.pins) o.pins.add(p);
    } else {
      open.set(u.id, { pages: u.pages, pins: new Set(u.pins) });
    }
  }
  return { open, neighbors };
}

/** Every group below `start` (any depth, through every member), nearest first. */
function groupsBelow(ix: Index, start: string): { groups: string[]; nodes: Set<string> } {
  const groups: string[] = [];
  const nodes = new Set<string>();
  const queue = [start];
  const seen = new Set([start]);
  for (let i = 0; i < queue.length; i++) {
    for (const set of ix.childSets.get(queue[i] ?? '') ?? []) {
      if (set.isGroup) groups.push(set.id);
      for (const m of set.members) {
        nodes.add(m.id);
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        queue.push(m.id);
      }
    }
  }
  return { groups, nodes };
}

export function groupedView(graph: Graph, options: ViewOptions): ViewResult {
  const ix = buildIndex(graph);
  const entries = (options.entries ?? []).filter((id) => ix.byId.has(id));

  // Units, most important first: the analyst's own opens (oldest first; the client moves an entry to the end when
  // it loads more), then neighbor expansions, then expand-all, then auto-opens.
  const units: Unit[] = [];
  for (const x of options.expand ?? []) {
    const set = ix.sets.get(x.id);
    if (!set?.isGroup) continue;
    const pins = x.pins.filter((p) => set.members.some((m) => m.id === p));
    units.push({ kind: 'open', id: x.id, pages: Math.min(x.pages, 1), pins, origin: 'user' });
    for (let p = 2; p <= x.pages; p++) units.push({ kind: 'open', id: x.id, pages: p, pins: [], origin: 'user' });
  }
  for (const center of options.neighbors ?? []) if (ix.byId.has(center)) units.push({ kind: 'neighbors', center });

  const userOpen = applyUnits(units).open;
  const expandAllTargets = [...new Set(options.expandAll ?? [])].filter((id) => ix.byId.has(id));
  const below = new Map(expandAllTargets.map((id) => [id, groupsBelow(ix, id)]));
  // First pages of every group below, nearest first; then the further pages, so the budget goes to breadth first.
  const morePages: Unit[] = [];
  for (const [from, b] of below) {
    for (const id of b.groups) {
      const pages = Math.ceil((ix.sets.get(id)?.members.length ?? 0) / GROUP_PAGE_SIZE);
      const have = userOpen.get(id)?.pages ?? 0;
      if (have < 1) units.push({ kind: 'open', id, pages: 1, pins: [], origin: 'expandAll', from });
      for (let p = Math.max(have, 1) + 1; p <= pages; p++) morePages.push({ kind: 'open', id, pages: p, pins: [], origin: 'expandAll', from });
    }
  }
  units.push(...morePages);

  // Auto-open: a collapsed group holding something the canvas showed directly (a parent's only child, or a
  // parentless node) before this request. Only the analyst's open groups count as open here.
  const keepEdges = new Set(options.keep?.edges ?? []);
  const keepRoots = new Set(options.keep?.roots ?? []);
  if (keepEdges.size > 0 || keepRoots.size > 0) {
    for (const set of ix.sets.values()) {
      if (!set.isGroup || userOpen.has(set.id)) continue;
      const kept = set.members.filter((m) =>
        set.parentId === null ? keepRoots.has(m.id) : keepEdges.has(set.edgeOf.get(m.id)?.id ?? ''),
      );
      if (kept.length === 0) continue;
      const firstPage = new Set(set.members.slice(0, GROUP_PAGE_SIZE).map((m) => m.id));
      const pins = kept.filter((m) => !firstPage.has(m.id)).map((m) => m.id);
      units.push({ kind: 'open', id: set.id, pages: 1, pins, origin: 'auto' });
    }
  }

  const risk = riskBySet(ix);
  const attempt = (n: number) => {
    const { open, neighbors } = applyUnits(units.slice(0, n));
    const w = walk(ix, open, neighbors, entries);
    const r = render(ix, w, risk, options.maxElements, graph.edgeTools);
    return { w, r, open, size: r.nodes.length + r.edges.length };
  };

  // The longest prefix of units that fits. Granting a unit only ever adds elements, so the size grows with the
  // prefix and a binary search finds it in a few walks.
  let best = attempt(units.length);
  let granted = units.length;
  if (best.size > options.maxElements) {
    let lo = 0;
    let hi = units.length - 1;
    let fit: ReturnType<typeof attempt> | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = attempt(mid);
      if (a.size <= options.maxElements) {
        fit = a;
        granted = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    best = fit ?? attempt(0);
    if (!fit) granted = 0;
  }

  const { w } = best;
  let rendered = best.r;
  let truncated = granted < units.length;
  if (best.size > options.maxElements) {
    rendered = cut(rendered, options.maxElements);
    truncated = true;
  }

  const refused = units.slice(granted);
  const overBudget = [
    ...new Set(refused.map((u) => (u.kind === 'neighbors' ? `neighbors:${u.center}` : u.id))),
  ].filter((id) => !id.startsWith('agg:') || w.groups.has(id));
  const autoIds = new Set(units.flatMap((u) => (u.kind === 'open' && u.origin === 'auto' ? [u.id] : [])));
  const opened = (id: string) => (w.groups.get(id)?.open ?? null) !== null;
  const autoOpened = [...autoIds].filter(opened);
  const autoFolded = [...autoIds].filter((id) => w.groups.has(id) && !opened(id));

  // The state as applied: open groups that are drawn, in the order they were asked for (auto-opens last).
  const expand: GroupOpen[] = [];
  const seenOpen = new Set<string>();
  for (const u of units.slice(0, granted)) {
    if (u.kind !== 'open' || seenOpen.has(u.id) || !opened(u.id)) continue;
    seenOpen.add(u.id);
    const o = best.open.get(u.id);
    if (o) expand.push({ id: u.id, pages: o.pages, pins: [...o.pins] });
  }

  const expandAll = expandAllTargets.map((nodeId) => {
    const b = below.get(nodeId);
    const count = new Set(
      units
        .slice(0, granted)
        .flatMap((u) => (u.kind === 'open' && u.origin === 'expandAll' && u.from === nodeId && opened(u.id) ? [u.id] : [])),
    ).size;
    const hidden = b ? [...b.nodes].filter((id) => !w.visible.has(id)).length : 0;
    return { nodeId, opened: count, hidden };
  });

  return {
    nodes: rendered.nodes,
    edges: rendered.edges,
    truncated,
    state: { expand, neighbors: w.appliedNeighbors },
    overBudget,
    autoOpened,
    autoFolded,
    expandAll,
  };
}

/**
 * The groups to open, as pins, so that `nodeId` is drawn: the first path down from a root (breadth-first, in the
 * walk's own order), with a step for each group on it. Null when the node isn't in this graph.
 */
export function groupPath(graph: Graph, nodeId: string): { groupId: string; memberId: string }[] | null {
  const ix = buildIndex(graph);
  if (!ix.byId.has(nodeId)) return null;
  const via = new Map<string, ChildSet | null>();
  const queue: string[] = [];
  const visit = (id: string, set: ChildSet | null) => {
    if (via.has(id)) return;
    via.set(id, set);
    queue.push(id);
  };
  for (const set of ix.rootSets) for (const m of set.members) visit(m.id, set);
  for (const id of ix.pseudoRoots) visit(id, null);
  // Pseudo-roots are queued up front with the roots, so a node in a rootless cycle is found too.
  for (let i = 0; i < queue.length && !via.has(nodeId); i++) {
    for (const set of ix.childSets.get(queue[i] ?? '') ?? []) for (const m of set.members) visit(m.id, set);
  }

  const steps: { groupId: string; memberId: string }[] = [];
  for (let id: string | null = nodeId; id !== null; ) {
    const set: ChildSet | null = via.get(id) ?? null;
    if (set?.isGroup) steps.push({ groupId: set.id, memberId: id });
    id = set?.parentId ?? null;
  }
  return steps.reverse();
}
