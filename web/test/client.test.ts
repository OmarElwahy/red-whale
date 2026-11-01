import { graphResponseSchema, layoutResponseSchema } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { ApiError, getJson, ResponseShapeError, sendJson, type Fetch } from '../src/api/client';
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

const graph = {
  nodes: [node('a')],
  edges: [],
  truncated: false,
  totals: { nodes: 1, edges: 0 },
  state: { expand: [], neighbors: [] },
  overBudget: [],
  autoOpened: [],
  autoFolded: [],
  expandAll: [],
};

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
    expect(queryKeys.view({ q: 'x', types: ['ip'] }, [], [], [])).toEqual(queryKeys.view({ types: ['ip'], q: 'x' }, [], [], []));
  });
});

describe('sendJson', () => {
  function recordingFetch(status: number, body: unknown): { fetch: Fetch; requests: { url: string; init: RequestInit | undefined }[] } {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    return {
      requests,
      fetch: (url, init) => {
        requests.push({ url, init });
        return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
      },
    };
  }

  test('sends the method, a JSON body and content type, and parses the answer', async () => {
    const { fetch, requests } = recordingFetch(200, { updated: 1 });
    const positions = [{ id: 'a', x: 1, y: 2 }];
    await expect(sendJson('PUT', '/api/layout', { positions }, layoutResponseSchema, { fetch })).resolves.toEqual({ updated: 1 });
    expect(requests).toHaveLength(1);
    const init = requests[0]?.init;
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({ positions });
  });

  test('keepalive is passed through, so a save can outlive the page', async () => {
    const { fetch, requests } = recordingFetch(200, { updated: 0 });
    await sendJson('PUT', '/api/layout', { positions: [] }, layoutResponseSchema, { fetch, keepalive: true });
    expect(requests[0]?.init?.keepalive).toBe(true);
  });

  test('an API error becomes an ApiError with its issues', async () => {
    const { fetch } = recordingFetch(400, { error: 'unknown node IDs; nothing was saved', issues: ["unknown node 'x'"] });
    const err: unknown = await sendJson('PUT', '/api/layout', { positions: [] }, layoutResponseSchema, { fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, issues: ["unknown node 'x'"] });
  });

  test('a 200 that breaks the schema is a ResponseShapeError', async () => {
    const { fetch } = recordingFetch(200, { updated: 'all' });
    await expect(sendJson('PATCH', '/api/nodes/a', { tag: null }, layoutResponseSchema, { fetch })).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
  });
});
