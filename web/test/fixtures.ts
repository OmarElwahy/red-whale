// Small builders for API graph objects, validated with the shared schemas so tests can't drift from the API.
import {
  aggregateNodeSchema,
  graphEdgeSchema,
  graphNodeSchema,
  type AggregateNode,
  type GraphEdge,
  type GraphNode,
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
    total: 420,
    childType: 'subdomain',
    relation: 'has_subdomain',
    parentId: '0123456789abcdef',
    maxSeverity: 'high',
    ...over,
  });
}

export function edge(source: string, target: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return graphEdgeSchema.parse({ id: `${source}->${target}`, source, target, relation: 'has_subdomain', ...over });
}

/** A canvas-less Cytoscape with our stylesheet applied, so computed styles can be read back. */
export function headless(): Core {
  return cytoscape({ headless: true, styleEnabled: true, style: graphStylesheet() });
}
