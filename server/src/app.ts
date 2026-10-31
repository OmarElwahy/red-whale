// The Fastify app (docs/architecture.md §6). buildApp() doesn't listen, so tests drive it with inject().
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/client';
import { AGG_THRESHOLD, MAX_ELEMENTS } from './graph/aggregate';
import { HttpError } from './http';
import type { RouteContext } from './routes/context';
import { dataRoutes } from './routes/data';
import { graphRoutes } from './routes/graph';
import { nodeRoutes } from './routes/nodes';
import { scopeRoutes } from './routes/scope';
import { Broadcaster } from './ws';

export const DEFAULT_PORT = 4100;
export const WEB_PORT = 5173;
const BODY_LIMIT = 50 * 1024 * 1024;

export interface AppOptions {
  db: Db;
  /** The port the server listens on; only used to decide which Host headers are ours. */
  port?: number;
  threshold?: number;
  maxElements?: number;
  logger?: boolean;
}

/**
 * Requests must name this machine in Host (blocks DNS rebinding) and, if a browser sent an Origin,
 * come from our own UI (blocks other web pages posting to the API or opening the WebSocket).
 */
function localOnly(port: number) {
  const hosts = new Set(['127.0.0.1', 'localhost'].flatMap((h) => [port, WEB_PORT].map((p) => `${h}:${String(p)}`)));
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return (host: string | undefined, origin: string | undefined): string | null => {
    if (host === undefined || !hosts.has(host.toLowerCase())) return `host '${host ?? ''}' is not allowed`;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) return `origin '${origin}' is not allowed`;
    return null;
  };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: BODY_LIMIT });
  await app.register(websocket);
  // JSON only: without this, Fastify's built-in text/plain parser would hand ingest a string.
  app.removeContentTypeParser('text/plain');

  const check = localOnly(options.port ?? DEFAULT_PORT);
  app.addHook('onRequest', (req, reply, done) => {
    const problem = check(req.headers.host, req.headers.origin);
    if (problem) {
      void reply.code(403).send({ error: problem });
      return;
    }
    done();
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...(err.issues ? { issues: err.issues } : {}) });
    }
    // Fastify's own client errors: malformed JSON (400), body too large (413), wrong content type (415).
    const status =
      err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500 && err instanceof Error) return reply.code(status).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal server error' });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `no route ${req.method} ${req.url}` }));

  const broadcaster = new Broadcaster();
  const ctx: RouteContext = {
    app,
    db: options.db,
    broadcaster,
    threshold: options.threshold ?? AGG_THRESHOLD,
    maxElements: options.maxElements ?? MAX_ELEMENTS,
  };
  graphRoutes(ctx);
  nodeRoutes(ctx);
  dataRoutes(ctx);
  scopeRoutes(ctx);
  app.get('/api/ws', { websocket: true }, (socket) => {
    broadcaster.add(socket);
  });

  return app;
}
