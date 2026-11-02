// Graph editing (add nodes by hand, delete nodes): hooks over POST /api/nodes and the delete routes.
import {
  manualNodeResponseSchema,
  nodeDetailResponseSchema,
  nodeListResponseSchema,
  type ManualNodeInput,
  type NodeType,
} from '@redwhale/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, getJson, sendJson } from './client';
import { queryKeys } from './query';

type NodeDetail = z.infer<typeof nodeDetailResponseSchema>;
type NodeList = z.infer<typeof nodeListResponseSchema>;

export const editKeys = {
  /** Does a node with this ID exist? (the Add node dialog's duplicate check) */
  exists: (id: string) => ['api', 'edit', 'exists', id] as const,
  parentSearch: (q: string, types: string) => ['api', 'edit', 'parents', q, types] as const,
};

/** The node with this ID, or null if there is none (404). Disabled for a null ID. */
export function useExistingNode(id: string | null): UseQueryResult<NodeDetail | null> {
  return useQuery({
    queryKey: editKeys.exists(id ?? ''),
    queryFn: async ({ signal }) => {
      try {
        return await getJson(`/api/nodes/${encodeURIComponent(id ?? '')}`, nodeDetailResponseSchema, { signal });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: id !== null,
    retry: false,
  });
}

/** Nodes whose value or label contains `q`, of the given types (the parent picker). */
export function useParentSearch(q: string, types: readonly NodeType[]): UseQueryResult<NodeList> {
  const params = new URLSearchParams({ q, types: types.join(','), pageSize: '8', sort: 'label' });
  return useQuery({
    queryKey: editKeys.parentSearch(q, types.join(',')),
    queryFn: ({ signal }) => getJson(`/api/nodes?${params.toString()}`, nodeListResponseSchema, { signal }),
    enabled: q.trim() !== '' && types.length > 0,
    retry: false,
  });
}

/** POST /api/nodes. Everything under `api` refetches afterwards (the live event would do it too, a moment later). */
export function useAddNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ManualNodeInput) => sendJson('POST', '/api/nodes', body, manualNodeResponseSchema),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.all });
    },
  });
}
