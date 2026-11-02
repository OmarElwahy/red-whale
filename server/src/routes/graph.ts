// The graph views (docs/architecture.md §6–7): GET /api/graph (everything collapsed), POST /api/graph/view (with
// the analyst's open groups), GET /api/graph/path/:nodeId, GET /api/graph/expand/:aggregateId and
// GET /api/graph/neighbors/:nodeId.
import {
  RELATIONS,
  expandQuerySchema,
  graphFiltersSchema,
  graphViewRequestSchema,
  neighborsQuerySchema,
  parseAggregateId,
} from '@redwhale/shared';
import { eq } from 'drizzle-orm';
import { nodes } from '../db/schema';
import { groupPath, groupedView } from '../graph/aggregate';
import { filteredGraph, groupMembers, loadGraph, type Graph } from '../graph/store';
import { HttpError, notFound, parseInput } from '../http';
import type { RouteContext } from './context';

export function graphRoutes({ app, db, maxElements }: RouteContext): void {
  app.get('/api/graph', (req) => {
    const filters = parseInput(graphFiltersSchema, req.query);
    const graph = filteredGraph(db, filters, { searchPaths: true });
    const result = groupedView(graph, { maxElements });
    return { ...result, totals: { nodes: graph.nodes.length, edges: graph.edges.length } };
  });

  // A POST because the open groups don't fit in a query string; it reads only.
  app.post('/api/graph/view', (req) => {
    const { filters, ...view } = parseInput(graphViewRequestSchema, req.body);
    const graph = filteredGraph(db, filters, { searchPaths: true });
    const result = groupedView(graph, { maxElements, ...view });
    return { ...result, totals: { nodes: graph.nodes.length, edges: graph.edges.length } };
  });

  app.get<{ Params: { nodeId: string } }>('/api/graph/path/:nodeId', (req) => {
    const id = req.params.nodeId;
    const filters = parseInput(graphFiltersSchema, req.query);
    if (!db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).get()) throw notFound(`node ${id}`);
    const steps = groupPath(filteredGraph(db, filters, { searchPaths: true }), id);
    return { nodeId: id, inView: steps !== null, steps: steps ?? [] };
  });

  app.get<{ Params: { aggregateId: string } }>('/api/graph/expand/:aggregateId', (req) => {
    const id = req.params.aggregateId;
    const key = parseAggregateId(id);
    if ('error' in key) throw new HttpError(400, key.error);
    const { page, pageSize, ...filters } = parseInput(expandQuerySchema, req.query);

    if (key.parentId !== null) {
      const parent = db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, key.parentId)).get();
      if (!parent) throw notFound(`node ${key.parentId}`);
      if (!RELATIONS[key.relation].parents.includes(parent.type)) {
        throw new HttpError(400, `'${key.relation}' never starts at a ${parent.type}`);
      }
    }

    const { members, edgeTo } = groupMembers(filteredGraph(db, filters, { searchPaths: true }), key);

    const pageNodes = members.slice((page - 1) * pageSize, page * pageSize);
    return {
      aggregate: { id, parentId: key.parentId, relation: key.relation, childType: key.childType },
      nodes: pageNodes,
      edges: pageNodes.flatMap((n) => edgeTo.get(n.id) ?? []),
      page,
      pageSize,
      total: members.length,
    };
  });

  app.get<{ Params: { nodeId: string } }>('/api/graph/neighbors/:nodeId', (req) => {
    const center = req.params.nodeId;
    const { depth } = parseInput(neighborsQuerySchema, req.query);
    const full = loadGraph(db);
    if (!full.nodes.some((n) => n.id === center)) throw notFound(`node ${center}`);

    // Undirected: parents and children both count as neighbours.
    const adjacent = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = adjacent.get(a);
      if (list) list.push(b);
      else adjacent.set(a, [b]);
    };
    for (const e of full.edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    const reached = new Set([center]);
    let frontier = [center];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of adjacent.get(id) ?? []) {
          if (reached.has(other)) continue;
          reached.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }

    const sub: Graph = {
      nodes: full.nodes.filter((n) => reached.has(n.id)),
      edges: full.edges.filter((e) => reached.has(e.source) && reached.has(e.target)),
      edgeTools: full.edgeTools,
    };
    const result = groupedView(sub, { maxElements, entries: [center] });
    return { ...result, totals: { nodes: sub.nodes.length, edges: sub.edges.length }, center };
  });
}
