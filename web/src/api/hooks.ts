// TanStack Query hooks over the API client.
import {
  edgeDetailResponseSchema,
  graphPathResponseSchema,
  graphResponseSchema,
  highlightsResponseSchema,
  layoutResponseSchema,
  nodeDetailResponseSchema,
  nodeListResponseSchema,
  statsResponseSchema,
  type EdgeDetailResponse,
  type GraphFilters,
  type GraphNode,
  type GraphPathResponse,
  type GraphResponse,
  type GroupOpen,
  type Highlight,
  type NodePatch,
  type StatsResponse,
} from '@redwhale/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';
import { getJson, sendJson } from './client';
import { graphSearchParams, queryKeys, withParams } from './query';

export type NodeDetailResponse = z.infer<typeof nodeDetailResponseSchema>;
export type NodeListResponse = z.infer<typeof nodeListResponseSchema>;

const path = (prefix: string, id: string) => `${prefix}/${encodeURIComponent(id)}`;

export interface ViewRequest {
  filters: GraphFilters;
  expand: readonly GroupOpen[];
  neighbors: readonly string[];
  expandAll: readonly string[];
}

/** What the canvas shows directly, read when the request is sent (see groups.ts `keepFrom`). */
export type KeepSource = () => { edges: string[]; roots: string[] };

/**
 * The grouped graph (POST /api/graph/view): the filters and the open groups. While the next view loads, the
 * previous one stays on the canvas (`isPlaceholderData`), so typing in search or opening a group never blanks it.
 * `keep` isn't part of the key: it only matters to a refetch (a live update), and is read when the request goes out.
 * Never stale on its own: live updates invalidate it.
 */
export function useGraphView(req: ViewRequest, keep: KeepSource): UseQueryResult<GraphResponse> {
  return useQuery({
    queryKey: queryKeys.view(req.filters, req.expand, req.neighbors, req.expandAll),
    queryFn: ({ signal }) =>
      sendJson(
        'POST',
        '/api/graph/view',
        { filters: req.filters, expand: req.expand, neighbors: req.neighbors, expandAll: req.expandAll, keep: keep() },
        graphResponseSchema,
        { signal },
      ),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
}

/** The groups to open so that a node is drawn (GET /api/graph/path/:id), under the graph's filters. */
export function fetchPath(id: string, filters: GraphFilters): Promise<GraphPathResponse> {
  return getJson(withParams(path('/api/graph/path', id), graphSearchParams(filters)), graphPathResponseSchema);
}

/** Path status for a node that isn't drawn: is it in view at all under these filters? */
export function useGraphPath(id: string | null, filters: GraphFilters): UseQueryResult<GraphPathResponse> {
  return useQuery({
    queryKey: queryKeys.path(id ?? '', filters),
    queryFn: () => fetchPath(id ?? '', filters),
    enabled: id !== null,
  });
}

/** The riskiest node matching the search (GET /api/nodes lists matches only, riskiest first), or null. */
export async function fetchFirstMatch(filters: GraphFilters): Promise<GraphNode | null> {
  const params = graphSearchParams(filters);
  params.set('pageSize', '1');
  const list = await getJson(withParams('/api/nodes', params), nodeListResponseSchema);
  return list.items[0] ?? null;
}

/** Workspace totals for the filter badges. Not filtered: the counts don't change with the filters. */
export function useStats(): UseQueryResult<StatsResponse> {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: ({ signal }) => getJson('/api/stats', statsResponseSchema, { signal }),
  });
}

/** Every node tagged `interesting`, with its notes, riskiest first. Ignores the graph filters. */
export function useHighlights(): UseQueryResult<Highlight[]> {
  return useQuery({
    queryKey: queryKeys.highlights,
    queryFn: async ({ signal }) => (await getJson('/api/highlights', highlightsResponseSchema, { signal })).items,
  });
}

/** `/api/nodes?…`: the table's filters (the graph's own), page, sort and, optionally, `at`. */
export function nodeListPath(filters: GraphFilters, page: number, sort: string, at?: string): string {
  const params = graphSearchParams(filters);
  params.set('page', String(page));
  params.set('sort', sort);
  if (at !== undefined) params.set('at', at);
  return withParams('/api/nodes', params);
}

/** One page of the table, under the graph's filters. The previous page stays shown while the next one loads. */
export function useNodeList(filters: GraphFilters, page: number, sort: string): UseQueryResult<NodeListResponse> {
  return useQuery({
    queryKey: queryKeys.nodes(filters, page, sort),
    queryFn: ({ signal }) => getJson(nodeListPath(filters, page, sort), nodeListResponseSchema, { signal }),
    placeholderData: keepPreviousData,
  });
}

/**
 * The table page that holds this node (`?at=`), put in the cache under its own page key. Null if the node isn't
 * in the list (an aggregate, a search path node, …).
 */
export function useLocateNode() {
  const client = useQueryClient();
  return useCallback(
    async (filters: GraphFilters, sort: string, id: string, fallbackPage: number): Promise<number | null> => {
      const list = await getJson(nodeListPath(filters, fallbackPage, sort, id), nodeListResponseSchema);
      if (!list.items.some((n) => n.id === id)) return null;
      client.setQueryData(queryKeys.nodes(filters, list.page, sort), list);
      return list.page;
    },
    [client],
  );
}

/** Node detail + provenance. Aggregates have no detail; pass null for them. */
export function useNodeDetail(id: string | null): UseQueryResult<NodeDetailResponse> {
  return useQuery({
    queryKey: queryKeys.node(id ?? ''),
    queryFn: ({ signal }) => getJson(path('/api/nodes', id ?? ''), nodeDetailResponseSchema, { signal }),
    enabled: id !== null,
  });
}

/** Edge detail + provenance (GET /api/edges/:id). Only real edges have one; pass null otherwise. */
export function useEdgeDetail(id: string | null): UseQueryResult<EdgeDetailResponse> {
  return useQuery({
    queryKey: queryKeys.edge(id ?? ''),
    queryFn: ({ signal }) => getJson(path('/api/edges', id ?? ''), edgeDetailResponseSchema, { signal }),
    enabled: id !== null,
  });
}

/**
 * PATCH a node (tag, notes). The answer is the new detail, so it goes straight into the cache; the graph views
 * are refetched because a tag changes the node's look.
 */
export function usePatchNode(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: NodePatch) => sendJson('PATCH', path('/api/nodes', id), patch, nodeDetailResponseSchema),
    onSuccess: async (detail) => {
      client.setQueryData(queryKeys.node(id), detail);
      await client.invalidateQueries({ queryKey: queryKeys.all, predicate: (q) => q.queryKey[1] !== 'node' });
    },
  });
}

export interface Position {
  id: string;
  x: number;
  y: number;
}

export function saveLayout(positions: readonly Position[], options: { keepalive?: boolean } = {}) {
  return sendJson('PUT', '/api/layout', { positions }, layoutResponseSchema, options);
}
