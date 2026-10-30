// TanStack Query hooks over the API client.
import {
  expandResponseSchema,
  graphResponseSchema,
  layoutResponseSchema,
  neighborsResponseSchema,
  nodeDetailResponseSchema,
  statsResponseSchema,
  type GraphFilters,
  type GraphResponse,
  type NodePatch,
  type StatsResponse,
} from '@redwhale/shared';
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { z } from 'zod';
import { EXPAND_PAGE_SIZE, type Expansion, type Neighborhood } from '@/graph/compose';
import { getJson, sendJson } from './client';
import { graphSearchParams, queryKeys, withParams } from './query';

export type NodeDetailResponse = z.infer<typeof nodeDetailResponseSchema>;
type ExpandResponse = z.infer<typeof expandResponseSchema>;
type NeighborsResponse = z.infer<typeof neighborsResponseSchema>;

const path = (prefix: string, id: string) => `${prefix}/${encodeURIComponent(id)}`;

/**
 * The filtered graph. While a new filter loads, the previous graph stays on the canvas (`isPlaceholderData`),
 * so typing in search doesn't blank the graph and re-run the full layout on every keystroke.
 */
export function useGraph(filters: GraphFilters = {}): UseQueryResult<GraphResponse> {
  return useQuery({
    queryKey: queryKeys.graph(filters),
    queryFn: ({ signal }) => getJson(withParams('/api/graph', graphSearchParams(filters)), graphResponseSchema, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** Workspace totals for the filter badges. Not filtered: the counts don't change with the filters. */
export function useStats(): UseQueryResult<StatsResponse> {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: ({ signal }) => getJson('/api/stats', statsResponseSchema, { signal }),
  });
}

interface Overlays<T> {
  data: T[];
  isFetching: boolean;
  error: Error | null;
}

/** Groups loaded pages by aggregate, keeping only pages 1..n with no gap (a later page may load first). */
function combineExpansions(results: UseQueryResult<ExpandResponse>[]): Overlays<Expansion> {
  const byId = new Map<string, ExpandResponse[]>();
  for (const r of results) {
    if (!r.data) continue;
    const pages = byId.get(r.data.aggregate.id);
    if (pages) pages.push(r.data);
    else byId.set(r.data.aggregate.id, [r.data]);
  }
  const data = [...byId].map(([aggregateId, pages]) => {
    pages.sort((a, b) => a.page - b.page);
    const contiguous = pages.filter((p, i) => p.page === i + 1);
    return { aggregateId, pages: contiguous };
  });
  return { data, isFetching: results.some((r) => r.isFetching), error: results.find((r) => r.error)?.error ?? null };
}

/** Every loaded page of every expanded aggregate, under the same filters as the graph. */
export function useExpansions(
  expanded: readonly { id: string; pages: number }[],
  filters: GraphFilters = {},
): Overlays<Expansion> {
  return useQueries({
    queries: expanded.flatMap(({ id, pages }) =>
      Array.from({ length: pages }, (_, i) => {
        const page = i + 1;
        const params = graphSearchParams(filters);
        params.set('page', String(page));
        params.set('pageSize', String(EXPAND_PAGE_SIZE));
        return {
          queryKey: queryKeys.expand(id, page, filters),
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            getJson(withParams(path('/api/graph/expand', id), params), expandResponseSchema, { signal }),
        };
      }),
    ),
    combine: combineExpansions,
  });
}

function combineNeighborhoods(results: UseQueryResult<NeighborsResponse>[]): Overlays<Neighborhood> {
  return {
    data: results.flatMap((r) => (r.data ? [r.data] : [])),
    isFetching: results.some((r) => r.isFetching),
    error: results.find((r) => r.error)?.error ?? null,
  };
}

/** The 1-hop neighborhood of each node the analyst expanded. */
export function useNeighborhoods(ids: readonly string[]): Overlays<Neighborhood> {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.neighbors(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getJson(withParams(path('/api/graph/neighbors', id), new URLSearchParams({ depth: '1' })), neighborsResponseSchema, {
          signal,
        }),
    })),
    combine: combineNeighborhoods,
  });
}

/** Node detail + provenance. Aggregates have no detail; pass null for them. */
export function useNodeDetail(id: string | null): UseQueryResult<NodeDetailResponse> {
  return useQuery({
    queryKey: queryKeys.node(id ?? ''),
    queryFn: ({ signal }) => getJson(path('/api/nodes', id ?? ''), nodeDetailResponseSchema, { signal }),
    enabled: id !== null,
  });
}

/**
 * PATCH a node (tag, notes). The answer is the new detail, so it goes straight into the cache; the graph views
 * are refetched because a tag changes the node's look and can change aggregation (`interesting` stays visible).
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
