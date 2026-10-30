import { errorResponseSchema } from '@redwhale/shared';
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
