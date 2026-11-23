// The Takeover watch (TW-2, docs/architecture.md §11): every subdomain's takeover status, built by the server on read.
// Its query key sits under the runner's, so job.updated (a check finished) refetches it as well as graph.updated and
// scope.changed (which refetch everything).
import { takeoverWatchResponseSchema, type TakeoverWatchResponse } from '@redwhale/shared';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getJson } from './client';
import { queryKeys } from './query';

export const TAKEOVER_PANEL_SIZE = 100;

export function useTakeoverWatch(page: number): UseQueryResult<TakeoverWatchResponse> {
  return useQuery({
    queryKey: queryKeys.takeoverWatch(page),
    queryFn: ({ signal }) =>
      getJson(
        `/api/takeover/watch?${new URLSearchParams({ page: String(page), pageSize: String(TAKEOVER_PANEL_SIZE) }).toString()}`,
        takeoverWatchResponseSchema,
        { signal },
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
}
