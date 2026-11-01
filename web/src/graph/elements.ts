// API graph → Cytoscape element definitions. The `data` fields here are what style.ts selects on.
import type {
  AggregateNode,
  Confidence,
  GraphNode,
  GraphResponse,
  MoreNode,
  NodeType,
  Relation,
  ScopeDecision,
  Severity,
  Tag,
  ViewEdge,
  ViewEdgeKind,
} from '@redwhale/shared';
import { riskText } from './icons';

/** `null` severity becomes 'none' so every node matches exactly one fill-color selector. */
export type SeverityKey = Severity | 'none';

export interface NodeData {
  [key: string]: unknown;
  id: string;
  kind: 'node';
  type: NodeType;
  value: string;
  label: string;
  severity: SeverityKey;
  effectiveSeverity: SeverityKey;
  confidence: Confidence;
  sourceCount: number;
  tag: Tag | null;
  /** Passive-mode scope decision; `out` draws the hatch (style.ts). */
  inScope: ScopeDecision;
}

/** A group (docs/architecture.md §7), collapsed or open. */
export interface AggregateData {
  [key: string]: unknown;
  id: string;
  kind: 'aggregate';
  /** The members' type, so the group gets their icon. */
  type: NodeType;
  /** `12 subdomains`. */
  label: string;
  /** Highest effective severity among the members. */
  severity: SeverityKey;
  count: number;
  relation: Relation | null;
  parentId: string | null;
  expanded: boolean;
  shown: number;
  remaining: number;
  canLoadMore: boolean;
  /** High + critical nodes below (the badge), and the badge's color. */
  risk: number;
  riskWorst: 'critical' | 'high' | 'none';
  /** "2 critical, 1 high below", or ''. */
  riskTitle: string;
}

/** "+150 more" under an open group. */
export interface MoreData {
  [key: string]: unknown;
  id: string;
  kind: 'more';
  groupId: string;
  label: string;
  remaining: number;
}

export interface EdgeData {
  [key: string]: unknown;
  id: string;
  source: string;
  target: string;
  relation: Relation | null;
  kind: ViewEdgeKind;
  /** The relation on `relation`, `group` and `neighbor` edges; '' on group → member and "more" edges. */
  label: string;
}

export interface NodeElement {
  group: 'nodes';
  data: NodeData | AggregateData | MoreData;
  position?: { x: number; y: number };
}
export interface EdgeElement {
  group: 'edges';
  data: EdgeData;
}
export type Element = NodeElement | EdgeElement;

const severityKey = (s: Severity | null): SeverityKey => s ?? 'none';

function nodeElement(n: GraphNode): NodeElement {
  const el: NodeElement = {
    group: 'nodes',
    data: {
      id: n.id,
      kind: 'node',
      type: n.type,
      value: n.value,
      label: n.label,
      severity: severityKey(n.severity),
      effectiveSeverity: severityKey(n.effectiveSeverity),
      confidence: n.confidence,
      sourceCount: n.sourceCount,
      tag: n.tag,
      inScope: n.inScope,
    },
  };
  if (n.posX !== null && n.posY !== null) el.position = { x: n.posX, y: n.posY };
  return el;
}

function aggregateElement(a: AggregateNode): NodeElement {
  return {
    group: 'nodes',
    data: {
      id: a.id,
      kind: 'aggregate',
      type: a.childType,
      label: a.label,
      severity: severityKey(a.maxSeverity),
      count: a.count,
      relation: a.relation,
      parentId: a.parentId,
      expanded: a.expanded,
      shown: a.shown,
      remaining: a.remaining,
      canLoadMore: a.canLoadMore,
      risk: a.risk.critical + a.risk.high,
      riskWorst: a.risk.critical > 0 ? 'critical' : a.risk.high > 0 ? 'high' : 'none',
      riskTitle: riskText(a.risk),
    },
  };
}

function moreElement(m: MoreNode): NodeElement {
  return { group: 'nodes', data: { id: m.id, kind: 'more', groupId: m.groupId, label: m.label, remaining: m.remaining } };
}

function edgeElement(e: ViewEdge): EdgeElement {
  const labelled = e.kind === 'relation' || e.kind === 'group' || e.kind === 'neighbor';
  return {
    group: 'edges',
    data: {
      id: e.id,
      source: e.source,
      target: e.target,
      relation: e.relation,
      kind: e.kind,
      label: labelled ? (e.relation ?? '') : '',
    },
  };
}

export function toElements(graph: Pick<GraphResponse, 'nodes' | 'edges'>): Element[] {
  return [
    ...graph.nodes.map((n) =>
      n.type === 'aggregate' ? aggregateElement(n) : n.type === 'more' ? moreElement(n) : nodeElement(n),
    ),
    ...graph.edges.map(edgeElement),
  ];
}
