// Small builders for API graph objects, validated with the shared schemas so tests can't drift from the API.
import {
  aggregateNodeSchema,
  graphNodeSchema,
  moreNodeSchema,
  viewEdgeSchema,
  type AggregateNode,
  type GraphNode,
  type MoreNode,
  type ViewEdge,
} from '@redwhale/shared';
import cytoscape, { type Core } from 'cytoscape';
import { graphStylesheet } from '../src/graph/style';

const T = '2026-10-30T00:00:00.000Z';

export function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return graphNodeSchema.parse({
    id,
    type: 'subdomain',
    value: `${id}.example.com`,
    label: `${id}.example.com`,
    severity: null,
    effectiveSeverity: null,
    confidence: 'discovered',
    sourceCount: 1,
    tag: null,
    inScope: 'in',
    posX: null,
    posY: null,
    firstSeen: T,
    lastSeen: T,
    ...over,
  });
}

export function aggregate(over: Partial<AggregateNode> = {}): AggregateNode {
  return aggregateNodeSchema.parse({
    id: 'agg:0123456789abcdef:has_subdomain:subdomain',
    type: 'aggregate',
    label: '412 subdomains',
    count: 412,
    childType: 'subdomain',
    relation: 'has_subdomain',
    parentId: '0123456789abcdef',
    maxSeverity: 'high',
    risk: { critical: 0, high: 0 },
    expanded: false,
    shown: 0,
    remaining: 412,
    canLoadMore: true,
    ...over,
  });
}

export function more(groupId: string, remaining: number): MoreNode {
  return moreNodeSchema.parse({ id: `more:${groupId}`, type: 'more', groupId, label: `+${String(remaining)} more`, remaining });
}

/** A real edge by default (`kind: 'relation'`); pass `kind` for group, member, more and neighbor edges. */
export function edge(source: string, target: string, over: Partial<ViewEdge> = {}): ViewEdge {
  const kind = over.kind ?? 'relation';
  const real = kind === 'relation' || kind === 'neighbor';
  return viewEdgeSchema.parse({
    id: `${source}->${target}`,
    source,
    target,
    relation: 'has_subdomain',
    kind,
    // Provenance as the server sends it: a real edge has its own; a group edge the union of its members'.
    sourceCount: real ? 1 : null,
    confidence: real ? 'discovered' : null,
    tools: kind === 'group' ? ['subfinder'] : null,
    edgeCount: kind === 'group' ? 2 : null,
    ...over,
  });
}

/** A canvas-less Cytoscape with our stylesheet applied, so computed styles can be read back. */
export function headless(): Core {
  return cytoscape({ headless: true, styleEnabled: true, style: graphStylesheet() });
}
