// TanStack Query hooks over the API client.
import { graphResponseSchema, type GraphFilters, type GraphResponse } from '@redwhale/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getJson } from './client';
import { graphSearchParams, queryKeys, withParams } from './query';

export function useGraph(filters: GraphFilters = {}): UseQueryResult<GraphResponse> {
  return useQuery({
    queryKey: queryKeys.graph(filters),
    queryFn: ({ signal }) => getJson(withParams('/api/graph', graphSearchParams(filters)), graphResponseSchema, { signal }),
  });
}
