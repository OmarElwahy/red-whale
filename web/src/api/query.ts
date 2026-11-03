// Query-string building and TanStack Query keys. Filters map 1:1 to GET /api/graph params (§6, §8).
import type { GraphFilters, GroupOpen } from '@redwhale/shared';

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
  /** The grouped view: the filters, then the open groups, neighbor expansions and expand-all requests. */
  view: (filters: GraphFilters, expand: readonly GroupOpen[], neighbors: readonly string[], expandAll: readonly string[]) =>
    ['api', 'graph', graphSearchParams(filters).toString(), JSON.stringify({ expand, neighbors, expandAll })] as const,
  path: (nodeId: string, filters: GraphFilters) => ['api', 'path', nodeId, graphSearchParams(filters).toString()] as const,
  node: (id: string) => ['api', 'node', id] as const,
  edge: (id: string) => ['api', 'edge', id] as const,
  /** One page of the table (GET /api/nodes). */
  nodes: (filters: GraphFilters, page: number, sort: string) =>
    ['api', 'nodes', graphSearchParams(filters).toString(), page, sort] as const,
  stats: ['api', 'stats'] as const,
  /** Not filtered: every `interesting` node. */
  highlights: ['api', 'highlights'] as const,
  /** Under 'api' like everything else, so a `scope.changed` event (or any other) refetches them. */
  scopeRules: (includeRemoved: boolean) => ['api', 'scope', 'rules', includeRemoved] as const,
  scopeSettings: ['api', 'scope', 'settings'] as const,
  scopeLog: (sources: string, page: number) => ['api', 'scope', 'log', sources, page] as const,
  scopeLogAll: ['api', 'scope', 'log'] as const,
  /** GET /scope/check (not logged): refetched with the rest of the scope on scope.changed. */
  scopeCheck: (type: string, value: string, mode: string) => ['api', 'scope', 'check', type, value, mode] as const,
  /** Tool runs (§11): job.updated / runner.status refetch only these (and the scope log), never the graph. */
  runner: ['api', 'runner'] as const,
  tools: ['api', 'runner', 'tools'] as const,
  runnerStatus: ['api', 'runner', 'status'] as const,
  jobs: (page: number) => ['api', 'runner', 'jobs', page] as const,
  job: (id: number) => ['api', 'runner', 'job', id] as const,
};
