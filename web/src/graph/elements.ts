// API graph → Cytoscape element definitions. The `data` fields here are what style.ts selects on.
import type {
  AggregateNode,
  Confidence,
  GraphEdge,
  GraphNode,
  GraphResponse,
  NodeType,
  Relation,
  Severity,
  Tag,
} from '@redwhale/shared';

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
}

export interface AggregateData {
  [key: string]: unknown;
  id: string;
  kind: 'aggregate';
  /** The members' type, so the aggregate gets their shape. */
  type: NodeType;
  /** `412\nsubdomains`: the count on top, centered in the node. */
  label: string;
  /** Highest effective severity among the members. */
  severity: SeverityKey;
  count: number;
  total: number;
  relation: Relation | null;
  parentId: string | null;
}

export interface EdgeData {
  [key: string]: unknown;
  id: string;
  source: string;
  target: string;
  relation: Relation;
}

export interface NodeElement {
  group: 'nodes';
  data: NodeData | AggregateData;
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
      // The server's label is "<count> <plural>"; put the count on its own line.
      label: a.label.replace(/^(\d+) /, '$1\n'),
      severity: severityKey(a.maxSeverity),
      count: a.count,
      total: a.total,
      relation: a.relation,
      parentId: a.parentId,
    },
  };
}

function edgeElement(e: GraphEdge): EdgeElement {
  return { group: 'edges', data: { id: e.id, source: e.source, target: e.target, relation: e.relation } };
}

export function toElements(graph: Pick<GraphResponse, 'nodes' | 'edges'>): Element[] {
  return [
    ...graph.nodes.map((n) => (n.type === 'aggregate' ? aggregateElement(n) : nodeElement(n))),
    ...graph.edges.map(edgeElement),
  ];
}
