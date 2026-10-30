// Query-string building and TanStack Query keys. Filters map 1:1 to GET /api/graph params (§6, §8).
import type { GraphFilters } from '@redwhale/shared';

/** `{ types: ['ip','port'], q: 'dev' }` → `types=ip%2Cport&q=dev`. Keys are sorted so equal filters give equal strings. */
export function graphSearchParams(filters: GraphFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(filters).sort() as (keyof GraphFilters)[]) {
    const value = filters[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, value);
    }
  }
  return params;
}

export function withParams(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

export const queryKeys = {
  all: ['api'] as const,
  graph: (filters: GraphFilters) => ['api', 'graph', graphSearchParams(filters).toString()] as const,
  /** Members depend on the filters too: /graph/expand applies them. */
  expand: (aggregateId: string, page: number, filters: GraphFilters) =>
    ['api', 'expand', aggregateId, page, graphSearchParams(filters).toString()] as const,
  neighbors: (nodeId: string) => ['api', 'neighbors', nodeId] as const,
  node: (id: string) => ['api', 'node', id] as const,
  stats: ['api', 'stats'] as const,
};
