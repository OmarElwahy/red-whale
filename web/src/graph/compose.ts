// What the canvas shows (docs/architecture.md §7–8): the aggregated GET /api/graph result, plus the pages the
// analyst loaded from expanded aggregates (GET /api/graph/expand) and the neighborhoods they expanded
// (GET /api/graph/neighbors), and single nodes they asked to "show on graph" (from GET /api/nodes/:id). Pure, so
// the merge rules are unit-tested without a browser.
import type { AggregateNode, GraphEdge, GraphNode, NodeDetail, Relation } from '@redwhale/shared';

type AnyNode = GraphNode | AggregateNode;

/** The browser never holds more than ~2,000 elements (CLAUDE.md rule 7). */
export const ELEMENT_BUDGET = 2000;
/** Members fetched per "load more". Small enough to fit several pages inside the budget. */
export const EXPAND_PAGE_SIZE = 100;
/** Head room kept free before allowing a neighborhood expansion, whose size isn't known in advance. */
export const NEIGHBORS_RESERVE = 200;

export interface ExpandPage {
  aggregate: { id: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  page: number;
  total: number;
}

/** The loaded pages of one expanded aggregate, in page order (1, 2, …, with no gaps). */
export interface Expansion {
  aggregateId: string;
  pages: ExpandPage[];
}

export interface Neighborhood {
  center: string;
  nodes: AnyNode[];
  edges: GraphEdge[];
}

/** A node hidden from the graph (e.g. inside an aggregate) that the analyst asked to show, with all its edges. */
export interface Reveal {
  node: GraphNode;
  edges: GraphEdge[];
}

export interface ComposeInput {
  base: { nodes: AnyNode[]; edges: GraphEdge[] };
  /** In the order the analyst expanded them. */
  expansions: readonly Expansion[];
  neighborhoods: readonly Neighborhood[];
  /** In the order they were asked for. */
  reveals?: readonly Reveal[];
  budget?: number;
}

/** How far an expanded aggregate has been loaded. */
export interface GroupState {
  aggregateId: string;
  pages: number;
  /** Members on the canvas because of this expansion (including ones that were already visible). */
  members: string[];
  /** All members of the group. */
  total: number;
  /** Members not loaded yet. 0 = fully expanded, and the aggregate node is gone. */
  remaining: number;
}

export interface ComposedGraph {
  nodes: AnyNode[];
  edges: GraphEdge[];
  /** Expanded aggregates that are on the canvas, by aggregate ID. */
  groups: Map<string, GroupState>;
  /** Member ID → the aggregate it was expanded from (the first one, if several). */
  groupOf: Map<string, string>;
  /** Expansions and neighborhoods that were skipped because they would go over the budget. */
  overBudget: string[];
  /** Elements on the canvas (nodes + edges). */
  size: number;
}

/** "412 subdomains" → "subdomains". */
const plural = (a: AggregateNode): string => a.label.replace(/^\d+ /, '');

export function composeGraph({
  base,
  expansions,
  neighborhoods,
  reveals = [],
  budget = ELEMENT_BUDGET,
}: ComposeInput): ComposedGraph {
  const nodes = new Map<string, AnyNode>();
  const edges = new Map<string, GraphEdge>();
  const removed = new Set<string>();
  const groups = new Map<string, GroupState>();
  const groupOf = new Map<string, string>();
  const overBudget: string[] = [];

  const put = (ns: readonly AnyNode[], es: readonly GraphEdge[]) => {
    for (const n of ns) if (!nodes.has(n.id) && !removed.has(n.id)) nodes.set(n.id, n);
    for (const e of es) if (!edges.has(e.id)) edges.set(e.id, e);
  };
  /** Adds the elements if they fit in the budget; first one wins on duplicate IDs. */
  const tryPut = (key: string, ns: readonly AnyNode[], es: readonly GraphEdge[]): boolean => {
    const extra = ns.filter((n) => !nodes.has(n.id) && !removed.has(n.id)).length + es.filter((e) => !edges.has(e.id)).length;
    if (nodes.size + edges.size + extra > budget) {
      overBudget.push(key);
      return false;
    }
    put(ns, es);
    return true;
  };

  put(base.nodes, base.edges);

  // An expansion needs its aggregate on the canvas and a neighborhood needs its center, which may come from
  // another expansion or neighborhood. Apply whatever is ready until nothing changes.
  const pendingExpansions = [...expansions];
  const pendingNeighborhoods = [...neighborhoods];
  const pendingReveals = [...reveals];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < pendingExpansions.length; i++) {
      const x = pendingExpansions[i];
      const agg = x === undefined ? undefined : nodes.get(x.aggregateId);
      if (x === undefined || agg?.type !== 'aggregate') continue;
      pendingExpansions.splice(i--, 1);
      changed = true;

      const members: string[] = [];
      let total = 0;
      let pages = 0;
      for (const page of x.pages) {
        if (!tryPut(`${x.aggregateId}#${String(page.page)}`, page.nodes, page.edges)) break;
        pages++;
        total = page.total;
        for (const n of page.nodes) {
          members.push(n.id);
          if (!groupOf.has(n.id)) groupOf.set(n.id, x.aggregateId);
        }
      }
      if (pages === 0) continue;
      const remaining = Math.max(0, total - members.length);
      groups.set(x.aggregateId, { aggregateId: x.aggregateId, pages, members, total, remaining });
      if (remaining === 0) {
        nodes.delete(x.aggregateId);
        removed.add(x.aggregateId);
      } else {
        nodes.set(x.aggregateId, { ...agg, count: remaining, label: `${String(remaining)} more ${plural(agg)}` });
      }
    }
    for (let i = 0; i < pendingNeighborhoods.length; i++) {
      const nb = pendingNeighborhoods[i];
      if (nb === undefined || !nodes.has(nb.center)) continue;
      pendingNeighborhoods.splice(i--, 1);
      changed = true;
      tryPut(`neighbors:${nb.center}`, nb.nodes, nb.edges);
    }
    // A revealed node joins next to whatever neighbor is shown, with only the edges to shown nodes.
    for (let i = 0; i < pendingReveals.length; i++) {
      const r = pendingReveals[i];
      if (r === undefined) continue;
      if (nodes.has(r.node.id)) {
        pendingReveals.splice(i--, 1);
        continue;
      }
      const shown = edgesToShown(r, nodes);
      if (shown.length === 0) continue;
      pendingReveals.splice(i--, 1);
      changed = true;
      tryPut(`reveal:${r.node.id}`, [r.node], shown);
    }
  }

  // Cytoscape refuses edges whose ends aren't on the canvas.
  const kept = [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target));
  return { nodes: [...nodes.values()], edges: kept, groups, groupOf, overBudget, size: nodes.size + kept.length };
}

/** The reveal's edges whose other end is on the canvas. */
function edgesToShown(r: Reveal, shown: ReadonlyMap<string, unknown>): GraphEdge[] {
  return r.edges.filter((e) => shown.has(e.source === r.node.id ? e.target : e.source));
}

/** Node detail (GET /api/nodes/:id) → the node as the graph has it, plus its edges in graph form. */
export function revealFrom(detail: {
  node: NodeDetail;
  edges: readonly { id: string; relation: Relation; direction: 'in' | 'out'; other: { id: string } }[];
}): Reveal {
  const d = detail.node;
  const node: GraphNode = {
    id: d.id,
    type: d.type,
    value: d.value,
    label: d.label,
    severity: d.severity,
    effectiveSeverity: d.effectiveSeverity,
    confidence: d.confidence,
    sourceCount: d.sourceCount,
    tag: d.tag,
    posX: d.posX,
    posY: d.posY,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
  };
  return {
    node,
    edges: detail.edges.map((e) => ({
      id: e.id,
      source: e.direction === 'out' ? node.id : e.other.id,
      target: e.direction === 'out' ? e.other.id : node.id,
      relation: e.relation,
    })),
  };
}

/**
 * Can this node be shown on the graph? It needs a neighbor that's already shown (it is placed next to it), and
 * room for itself and those edges in the element budget. Returns the reason when it can't.
 */
export function revealCheck(
  composed: Pick<ComposedGraph, 'nodes' | 'size'>,
  reveal: Reveal,
  budget = ELEMENT_BUDGET,
): { ok: true } | { ok: false; reason: string } {
  const shown = new Map(composed.nodes.map((n) => [n.id, n]));
  const edges = edgesToShown(reveal, shown);
  if (edges.length === 0) {
    return { ok: false, reason: 'None of its neighbors is on the graph. Expand the group or node above it first.' };
  }
  if (composed.size + 1 + edges.length > budget) {
    return { ok: false, reason: 'The graph is at its ~2,000-element limit. Collapse a group to make room.' };
  }
  return { ok: true };
}

/** Can one more page of this aggregate be loaded without going over the budget? */
export function canLoadPage(composed: Pick<ComposedGraph, 'size'>, remaining: number, budget = ELEMENT_BUDGET): boolean {
  if (remaining <= 0) return false;
  // Each member brings one node and its edge to the parent.
  return composed.size + 2 * Math.min(remaining, EXPAND_PAGE_SIZE) <= budget;
}

export function canExpandNeighbors(composed: Pick<ComposedGraph, 'size'>, budget = ELEMENT_BUDGET): boolean {
  return composed.size + NEIGHBORS_RESERVE <= budget;
}
