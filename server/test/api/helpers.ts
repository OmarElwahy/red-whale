import {
  errorResponseSchema,
  graphResponseSchema,
  type AggregateNode,
  type GraphNode,
  type GraphResponse,
  type GroupOpen,
} from '@redwhale/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, expect } from 'vitest';
import type { z } from 'zod';
import { buildApp, type AppOptions } from '../../src/app';
import type { Db } from '../../src/db/client';
import { ingestText } from '../../src/ingest/ingest';
import { MOCK_DEFAULTS, generateMock, mockFileText } from '../../src/mock/generate';
import { EXAMPLES, exampleText, freshDb } from '../helpers';

export const HOST = '127.0.0.1:4100';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

export interface TestApi {
  app: FastifyInstance;
  db: Db;
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
  get(url: string): Promise<LightMyRequestResponse>;
  send(method: 'POST' | 'PATCH' | 'PUT', url: string, body: unknown): Promise<LightMyRequestResponse>;
}

/** A fresh app on a fresh in-memory database. Requests carry our own Host header by default. */
export async function testApi(options: Partial<AppOptions> = {}): Promise<TestApi> {
  const db = options.db ?? freshDb();
  const app = await buildApp({ ...options, db });
  apps.push(app);
  await app.ready();
  const request = (o: InjectOptions) => app.inject({ ...o, headers: { host: HOST, ...o.headers } });
  return {
    app,
    db,
    request,
    get: (url) => request({ method: 'GET', url }),
    send: (method, url, body) => request({ method, url, payload: body as InjectOptions['payload'] }),
  };
}

/** Asserts the status code, then parses the body with the response schema. */
export function body<S extends z.ZodType>(res: LightMyRequestResponse, status: number, schema: S): z.output<S> {
  expect(res.statusCode, res.body).toBe(status);
  return schema.parse(res.json());
}

/** Asserts an error response: status, schema, and that some issue mentions `match`. */
export function error(res: LightMyRequestResponse, status: number, match?: string | RegExp) {
  const parsed = body(res, status, errorResponseSchema);
  if (match !== undefined) {
    const text = [parsed.error, ...(parsed.issues ?? [])].join('\n');
    if (typeof match === 'string') expect(text).toContain(match);
    else expect(text).toMatch(match);
  }
  return parsed;
}

export function ingestExamples(db: Db): void {
  for (const name of EXAMPLES) {
    const r = ingestText(db, exampleText(name));
    if (r.status !== 'ingested') throw new Error(`could not ingest ${name}`);
  }
}

export function ingestMock(db: Db, subdomains: number): void {
  for (const f of generateMock({ ...MOCK_DEFAULTS, subdomains })) {
    const r = ingestText(db, mockFileText(f));
    if (r.status !== 'ingested') throw new Error(`could not ingest mock ${f.tool}`);
  }
}

export function idOf(db: Db, label: string): string {
  const row = db.$client.prepare('SELECT id FROM nodes WHERE label = ? OR value = ?').get(label, label) as
    | { id: string }
    | undefined;
  if (!row) throw new Error(`no node ${label}`);
  return row.id;
}

type ViewNode = GraphResponse['nodes'][number];
export const isAggregate = (n: ViewNode): n is AggregateNode => n.type === 'aggregate';
export const isReal = (n: ViewNode): n is GraphNode => n.type !== 'aggregate' && n.type !== 'more';

export async function view(api: TestApi, request: Record<string, unknown>): Promise<GraphResponse> {
  return body(await api.send('POST', '/api/graph/view', request), 200, graphResponseSchema);
}

/** Opens every group, all pages, until nothing is collapsed: the whole filtered graph, drawn through its groups. */
export async function openAll(api: TestApi, query = ''): Promise<GraphResponse> {
  const filters = Object.fromEntries(new URLSearchParams(query));
  let expand: GroupOpen[] = [];
  for (let i = 0; i < 12; i++) {
    const g = await view(api, { filters, expand });
    const closed = g.nodes.filter(isAggregate).filter((n) => !n.expanded || n.remaining > 0);
    if (closed.length === 0) return g;
    const ids = new Set(closed.map((c) => c.id));
    expand = [...g.state.expand.filter((x) => !ids.has(x.id)), ...closed.map((c) => ({ id: c.id, pages: 50, pins: [] }))];
  }
  throw new Error('groups still collapsed');
}
