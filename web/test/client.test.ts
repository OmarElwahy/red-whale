import { graphResponseSchema } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { ApiError, getJson, ResponseShapeError, type Fetch } from '../src/api/client';
import { graphSearchParams, queryKeys, withParams } from '../src/api/query';
import { node } from './fixtures';

function stub(status: number, body: unknown): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (input) => {
      calls.push(input);
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return Promise.resolve(new Response(text, { status, headers: { 'content-type': 'application/json' } }));
    },
  };
}

const graph = { nodes: [node('a')], edges: [], truncated: false, threshold: 25, totals: { nodes: 1, edges: 0 } };

describe('getJson', () => {
  test('parses a valid response with the shared schema', async () => {
    const { fetch, calls } = stub(200, graph);
    await expect(getJson('/api/graph', graphResponseSchema, { fetch })).resolves.toEqual(graph);
    expect(calls).toEqual(['/api/graph']);
  });

  test('an API error body becomes an ApiError with its issues', async () => {
    const { fetch } = stub(400, { error: 'invalid request', issues: ['minSeverity: Invalid option'] });
    const err: unknown = await getJson('/api/graph', graphResponseSchema, { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, message: 'invalid request', issues: ['minSeverity: Invalid option'] });
  });

  test('a non-JSON error still becomes an ApiError', async () => {
    const { fetch } = stub(502, 'Bad Gateway');
    await expect(getJson('/api/graph', graphResponseSchema, { fetch })).rejects.toMatchObject({ status: 502, issues: [] });
  });

  test('a 200 that breaks the schema is a ResponseShapeError, not data', async () => {
    const { fetch } = stub(200, { ...graph, truncated: 'no' });
    const err: unknown = await getJson('/api/graph', graphResponseSchema, { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as ResponseShapeError).issues.join('\n')).toMatch(/truncated/);
  });
});

describe('query params', () => {
  test('lists are comma-joined, keys sorted, undefined and empty lists dropped', () => {
    const params = graphSearchParams({ types: ['ip', 'port'], q: 'dev', minSeverity: 'high', tag: [], tool: undefined });
    expect(params.toString()).toBe('minSeverity=high&q=dev&types=ip%2Cport');
  });

  test('the round trip through the server schema gives the same filters', async () => {
    const { graphFiltersSchema } = await import('@redwhale/shared');
    const filters = { types: ['ip' as const, 'port' as const], excludeTag: ['ignored' as const], q: 'a b' };
    const back = graphFiltersSchema.parse(Object.fromEntries(graphSearchParams(filters)));
    expect(back).toEqual(filters);
  });

  test('withParams leaves the path alone when there are no params', () => {
    expect(withParams('/api/graph', graphSearchParams({}))).toBe('/api/graph');
  });

  test('equal filters give equal query keys regardless of key order', () => {
    expect(queryKeys.graph({ q: 'x', types: ['ip'] })).toEqual(queryKeys.graph({ types: ['ip'], q: 'x' }));
  });
});
