// Graph editing (add nodes by hand, delete nodes): hooks over POST /api/nodes and the delete routes.
import {
  deleteConflictSchema,
  deletePreviewSchema,
  deleteResponseSchema,
  deletionsResponseSchema,
  errorResponseSchema,
  manualNodeResponseSchema,
  nodeDetailResponseSchema,
  nodeListResponseSchema,
  type DeletePreview,
  type DeleteResponse,
  type DeletionMode,
  type DeletionsResponse,
  type GraphFilters,
  type ManualNodeInput,
  type NodeType,
} from '@redwhale/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, getJson, sendJson } from './client';
import { graphSearchParams, queryKeys, withParams } from './query';

type NodeDetail = z.infer<typeof nodeDetailResponseSchema>;
type NodeList = z.infer<typeof nodeListResponseSchema>;

export const editKeys = {
  /** Does a node with this ID exist? (the Add node dialog's duplicate check) */
  exists: (id: string) => ['api', 'edit', 'exists', id] as const,
  parentSearch: (q: string, types: string) => ['api', 'edit', 'parents', q, types] as const,
  preview: (id: string, filters: string) => ['api', 'edit', 'delete-preview', id, filters] as const,
  deletions: (page: number) => ['api', 'deletions', page] as const,
};

/** Only a group's members depend on the filters; a node's delete ignores them, so none are sent. */
function deleteParams(id: string, filters: GraphFilters): URLSearchParams {
  return id.startsWith('agg:') ? graphSearchParams(filters) : new URLSearchParams();
}

/** What deleting this node or group would remove, in each mode (GET /nodes/:id/delete-preview). */
export function useDeletePreview(id: string, filters: GraphFilters): UseQueryResult<DeletePreview> {
  const params = deleteParams(id, filters);
  return useQuery({
    queryKey: editKeys.preview(id, params.toString()),
    queryFn: ({ signal }) =>
      getJson(withParams(`/api/nodes/${encodeURIComponent(id)}/delete-preview`, params), deletePreviewSchema, { signal }),
    retry: false,
  });
}

export type DeleteOutcome =
  | { ok: true; result: DeleteResponse }
  /** 409: a job is running on one of the nodes, or the graph changed since the preview (a fresh preview comes with it). */
  | { ok: false; reason: 'jobs-running' | 'changed'; error: string; preview: DeletePreview };

export interface DeleteRequest {
  id: string;
  mode: DeletionMode;
  filters: GraphFilters;
  /** The node count the analyst saw and confirmed. */
  expect: number;
  /** "Cancel job and delete". */
  cancelJobs: boolean;
}

/** DELETE /api/nodes/:id. A 409 is an answer (the dialog shows it), not an error. */
export async function deleteNode(req: DeleteRequest, fetchImpl: typeof fetch = fetch): Promise<DeleteOutcome> {
  const params = deleteParams(req.id, req.filters);
  params.set('mode', req.mode);
  params.set('expect', String(req.expect));
  if (req.cancelJobs) params.set('cancelJobs', '1');
  const path = withParams(`/api/nodes/${encodeURIComponent(req.id)}`, params);
  const res = await fetchImpl(path, { method: 'DELETE', headers: { accept: 'application/json' } });
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status === 409) {
    const conflict = deleteConflictSchema.parse(body);
    return { ok: false, reason: conflict.reason, error: conflict.error, preview: conflict.preview };
  }
  if (!res.ok) {
    const err = errorResponseSchema.safeParse(body);
    throw new ApiError(res.status, err.success ? err.data.error : `HTTP ${String(res.status)}`, err.success ? (err.data.issues ?? []) : []);
  }
  return { ok: true, result: deleteResponseSchema.parse(body) };
}

export function useDeleteNode() {
  return useMutation({ mutationFn: (req: DeleteRequest) => deleteNode(req) });
}

/** The deletion log, newest first (GET /deletions). */
export function useDeletions(page: number): UseQueryResult<DeletionsResponse> {
  return useQuery({
    queryKey: editKeys.deletions(page),
    queryFn: ({ signal }) => getJson(`/api/deletions?page=${String(page)}&pageSize=20`, deletionsResponseSchema, { signal }),
  });
}

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
