// Fetch helpers for the API (docs/architecture.md §6). Every response is parsed with the Zod schema from
// @redwhale/shared, so a server that drifts from the contract fails loudly instead of rendering garbage.
import { errorResponseSchema, formatIssues } from '@redwhale/shared';
import type { z } from 'zod';

/** A non-2xx answer from the API: `{ error, issues? }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A 2xx answer that doesn't match the response schema: a server/contract bug, not a user error. */
export class ResponseShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string[],
  ) {
    super(`unexpected response from ${path}`);
    this.name = 'ResponseShapeError';
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** GET `path` and parse the body with `schema`. Throws ApiError for HTTP errors. */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { signal?: AbortSignal; fetch?: Fetch } = {},
): Promise<z.output<S>> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(path, { headers: { accept: 'application/json' }, signal: options.signal });
  return parseResponse(res, path, schema);
}

/** PATCH or PUT a JSON body and parse the answer with `schema`. `keepalive` lets the request outlive the page. */
export async function sendJson<S extends z.ZodType>(
  method: 'PATCH' | 'PUT',
  path: string,
  payload: unknown,
  schema: S,
  options: { fetch?: Fetch; keepalive?: boolean } = {},
): Promise<z.output<S>> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: options.keepalive,
  });
  return parseResponse(res, path, schema);
}

/** A parsed body, or ApiError for an HTTP error, or ResponseShapeError for a 2xx that breaks the schema. */
async function parseResponse<S extends z.ZodType>(res: Response, path: string, schema: S): Promise<z.output<S>> {
  const body = await readJson(res);
  if (!res.ok) {
    const err = errorResponseSchema.safeParse(body);
    throw err.success
      ? new ApiError(res.status, err.data.error, err.data.issues)
      : new ApiError(res.status, `${String(res.status)} ${res.statusText}`.trim());
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ResponseShapeError(path, formatIssues(parsed.error));
  return parsed.data;
}
