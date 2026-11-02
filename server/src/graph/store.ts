// Loads the graph for the API and applies filters. Everything after loading is in memory and pure,
// so /graph, /graph/expand, /graph/neighbors and /nodes all filter and sort the same way.
import {
  CONFIDENCE_LEVELS,
  compileScope,
  NODE_TYPES,
  SEVERITIES,
  matchesQuery,
  type AggregateKey,
  type GraphEdge,
  type GraphFilters,
  type GraphNode,
  type NodeSort,
  type Severity,
} from '@redwhale/shared';
import { asc, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { edgeObservations, edges, nodes, observations } from '../db/schema';
import { currentScope } from '../scope/store';

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Edge ID → the distinct tools that reported it, sorted. Server-side only (group edges carry their union). */
  edgeTools: ReadonlyMap<string, readonly string[]>;
}

/** -1 for null, so "no severity" sorts below info. */
export function severityRank(s: Severity | null): number {
  return s === null ? -1 : SEVERITIES.indexOf(s);
}

/**
 * Effective severity: the highest severity of a node and everything reachable below it.
 * One reverse BFS per level, highest first, so a node's first assignment is its maximum. Cycle-safe.
 */
export function effectiveSeverities(
  nodeList: readonly { id: string; severity: Severity | null }[],
  edgeList: readonly { source: string; target: string }[],
): Map<string, Severity | null> {
  const parents = new Map<string, string[]>();
  for (const e of edgeList) {
    const list = parents.get(e.target);
    if (list) list.push(e.source);
    else parents.set(e.target, [e.source]);
  }

  const result = new Map<string, Severity | null>();
  for (const level of [...SEVERITIES].reverse()) {
    const queue = nodeList.filter((n) => n.severity === level && !result.has(n.id)).map((n) => n.id);
    for (const id of queue) result.set(id, level);
    for (let i = 0; i < queue.length; i++) {
      for (const parent of parents.get(queue[i] ?? '') ?? []) {
        if (result.has(parent)) continue;
        result.set(parent, level);
        queue.push(parent);
      }
    }
  }
  for (const n of nodeList) if (!result.has(n.id)) result.set(n.id, null);
  return result;
}

/** The whole graph, with effective severity and the passive-mode scope decision filled in. */
export function loadGraph(db: Db): Graph {
  const nodeRows = db
    .select({
      id: nodes.id,
      type: nodes.type,
      value: nodes.value,
      label: nodes.label,
      severity: nodes.severity,
      confidence: nodes.confidence,
      sourceCount: nodes.sourceCount,
      tag: nodes.tag,
      posX: nodes.posX,
      posY: nodes.posY,
      firstSeen: nodes.firstSeen,
      lastSeen: nodes.lastSeen,
    })
    .from(nodes)
    .orderBy(asc(nodes.id))
    .all();
  const edgeRows = db
    .select({
      id: edges.id,
      source: edges.sourceId,
      target: edges.targetId,
      relation: edges.relation,
      sourceCount: edges.sourceCount,
      confidence: edges.confidence,
    })
    .from(edges)
    .orderBy(asc(edges.id))
    .all();
  const edgeTools = new Map<string, string[]>();
  const toolRows = db
    .selectDistinct({ edgeId: edgeObservations.edgeId, tool: edgeObservations.tool })
    .from(edgeObservations)
    .orderBy(asc(edgeObservations.edgeId), asc(edgeObservations.tool))
    .all();
  for (const { edgeId, tool } of toolRows) {
    const list = edgeTools.get(edgeId);
    if (list) list.push(tool);
    else edgeTools.set(edgeId, [tool]);
  }
  const effective = effectiveSeverities(nodeRows, edgeRows);
  // Computed on every read, never stored: a rule change applies to the next request.
  const scope = compileScope(currentScope(db));
  return {
    nodes: nodeRows.map(({ firstSeen, lastSeen, ...n }) => ({
      ...n,
      effectiveSeverity: effective.get(n.id) ?? null,
      inScope: scope.check(n.type, n.value, 'passive').decision,
      firstSeen,
      lastSeen,
    })),
    edges: edgeRows,
    edgeTools,
  };
}

/** IDs of nodes that any of these tools reported. */
export function nodeIdsSeenBy(db: Db, tools: readonly string[]): Set<string> {
  const rows = db
    .selectDistinct({ id: observations.nodeId })
    .from(observations)
    .where(sql`${observations.tool} IN (SELECT value FROM json_each(${JSON.stringify(tools)}))`)
    .all();
  return new Set(rows.map((r) => r.id));
}

/** The matches plus every ancestor among `candidates`, walking up parent edges. Cycle-safe. */
function withAncestors(matches: readonly GraphNode[], candidates: readonly GraphNode[], edgeList: readonly GraphEdge[]) {
  const allowed = new Set(candidates.map((n) => n.id));
  const parents = new Map<string, string[]>();
  for (const e of edgeList) {
    if (!allowed.has(e.source)) continue;
    const list = parents.get(e.target);
    if (list) list.push(e.source);
    else parents.set(e.target, [e.source]);
  }
  const keep = new Set(matches.map((n) => n.id));
  const queue = [...keep];
  for (let i = 0; i < queue.length; i++) {
    for (const parent of parents.get(queue[i] ?? '') ?? []) {
      if (keep.has(parent)) continue;
      keep.add(parent);
      queue.push(parent);
    }
  }
  return candidates.filter((n) => keep.has(n.id));
}

export interface FilterOptions {
  /**
   * With `q`, also keep each match's ancestors (those that pass the other filters), so search results show
   * their path up to the root instead of floating alone. Used by the graph views, not by the /nodes list.
   */
  searchPaths?: boolean;
}

/** Keeps the nodes that match every filter, and the edges between them. */
export function applyFilters(
  graph: Graph,
  filters: GraphFilters,
  seenByTool: Set<string> | null,
  { searchPaths = false }: FilterOptions = {},
): Graph {
  const { types, minSeverity, confidence, tag, excludeTag, scope, q } = filters;
  const min = minSeverity ? severityRank(minSeverity) : null;

  const candidates = graph.nodes.filter(
    (n) =>
      (!types || types.includes(n.type)) &&
      (min === null || severityRank(n.effectiveSeverity) >= min) &&
      (!confidence || confidence.includes(n.confidence)) &&
      (!seenByTool || seenByTool.has(n.id)) &&
      (!tag || (n.tag !== null && tag.includes(n.tag))) &&
      (!excludeTag || n.tag === null || !excludeTag.includes(n.tag)) &&
      (!scope || scope.includes(n.inScope)),
  );
  let kept = candidates;
  if (q !== undefined) {
    const matches = candidates.filter((n) => matchesQuery(n, q));
    kept = searchPaths ? withAncestors(matches, candidates, graph.edges) : matches;
  }
  if (kept.length === graph.nodes.length) return graph;
  const ids = new Set(kept.map((n) => n.id));
  return {
    nodes: kept,
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    edgeTools: graph.edgeTools,
  };
}

/**
 * A group's members in this graph, riskiest first, with the parent → member edge of each (none for a group of roots).
 * The same rule as the view's groups: the parent's children by that relation and type, or the parentless nodes of the type.
 */
export function groupMembers(graph: Graph, key: AggregateKey): { members: GraphNode[]; edgeTo: Map<string, GraphEdge> } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeTo = new Map<string, GraphEdge>();
  let members: GraphNode[];
  if (key.parentId !== null) {
    for (const e of graph.edges) {
      if (e.source === key.parentId && e.relation === key.relation && byId.get(e.target)?.type === key.childType) {
        edgeTo.set(e.target, e);
      }
    }
    members = [...edgeTo.keys()].flatMap((m) => byId.get(m) ?? []);
  } else {
    const hasParent = new Set(graph.edges.map((e) => e.target));
    members = graph.nodes.filter((n) => n.type === key.childType && !hasParent.has(n.id));
  }
  members.sort(riskFirst);
  return { members, edgeTo };
}

/** Loads the graph and applies the filters. */
export function filteredGraph(db: Db, filters: GraphFilters, options: FilterOptions = {}): Graph {
  const seenByTool = filters.tool ? nodeIdsSeenBy(db, filters.tool) : null;
  return applyFilters(loadGraph(db), filters, seenByTool, options);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Riskiest first (effective severity), then node type, then value. Total and deterministic. */
export function riskFirst(a: GraphNode, b: GraphNode): number {
  return (
    severityRank(b.effectiveSeverity) - severityRank(a.effectiveSeverity) ||
    NODE_TYPES.indexOf(a.type) - NODE_TYPES.indexOf(b.type) ||
    compareText(a.value, b.value) ||
    compareText(a.id, b.id)
  );
}

/** Comparator for GET /nodes. Missing severities sort last in either direction; ties fall back to riskFirst. */
export function nodeComparator(sort: NodeSort): (a: GraphNode, b: GraphNode) => number {
  return (a, b) => {
    for (const { field, desc } of sort) {
      let c: number;
      switch (field) {
        case 'effectiveSeverity':
        case 'severity': {
          const ra = severityRank(a[field]);
          const rb = severityRank(b[field]);
          if (ra === rb) continue;
          if (ra === -1) return 1;
          if (rb === -1) return -1;
          c = ra - rb;
          break;
        }
        case 'type':
          c = NODE_TYPES.indexOf(a.type) - NODE_TYPES.indexOf(b.type);
          break;
        case 'confidence':
          c = CONFIDENCE_LEVELS.indexOf(a.confidence) - CONFIDENCE_LEVELS.indexOf(b.confidence);
          break;
        case 'sourceCount':
          c = a.sourceCount - b.sourceCount;
          break;
        default:
          c = compareText(a[field], b[field]);
      }
      if (c !== 0) return desc ? -c : c;
    }
    return riskFirst(a, b);
  };
}
