// The Fastify app (docs/architecture.md §6). buildApp() doesn't listen, so tests drive it with inject().
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/client';
import { MAX_ELEMENTS } from './graph/aggregate';
import { HttpError } from './http';
import type { RouteContext } from './routes/context';
import { dataRoutes } from './routes/data';
import { edgeRoutes } from './routes/edges';
import { graphRoutes } from './routes/graph';
import { jobDto, jobRoutes, type RunnerContext } from './routes/jobs';
import { nodeRoutes } from './routes/nodes';
import { scopeRoutes } from './routes/scope';
import type { Catalog } from './runner/catalog';
import type { ToolDef } from './runner/defs';
import { ingestFinish } from './runner/finish';
import { Orchestrator } from './runner/orchestrator';
import type { ContainerRuntime } from './runner/runtime';
import { Broadcaster } from './ws';

declare module 'fastify' {
  interface FastifyInstance {
    /** The job queue (null when the server runs without the tool runner). */
    orchestrator: Orchestrator | null;
  }
}

export const DEFAULT_PORT = 4100;
export const WEB_PORT = 5173;
const BODY_LIMIT = 50 * 1024 * 1024;

export interface AppOptions {
  db: Db;
  /** The port the server listens on; only used to decide which Host headers are ours. */
  port?: number;
  maxElements?: number;
  logger?: boolean;
  /** The tool runner (docs/architecture.md §12). Without it, the /api/tools, /jobs and /runner routes answer 503. */
  runner?: RunnerOptions;
}

export interface RunnerOptions {
  runtime: ContainerRuntime;
  catalog: Catalog;
  /** Where each job's raw output is kept (<db dir>/jobs). */
  jobsDir: string;
  /** Jobs running at once (default 2). */
  maxJobs?: number;
  /** The hard kill per tool; tests shorten it. */
  timeoutMs?: (def: ToolDef) => number;
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
  const db = options.db;
  let runner: RunnerContext | null = null;
  if (options.runner) {
    const { runtime, catalog, jobsDir, maxJobs, timeoutMs } = options.runner;
    const orchestrator = new Orchestrator({
      db,
      runtime,
      catalog,
      ...(maxJobs === undefined ? {} : { maxConcurrent: maxJobs }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      finish: ingestFinish({
        db,
        jobsDir,
        onIngested: (result, tool) => {
          broadcaster.send({ type: 'scan.ingested', scanId: result.scanId, tool });
          broadcaster.send({ type: 'graph.updated', nodeIds: result.nodeIds, edgeIds: result.edgeIds });
        },
      }),
      onJob: (job) => {
        broadcaster.send({ type: 'job.updated', job: jobDto(job) });
      },
      onRunnerChange: (ping) => {
        broadcaster.send({ type: 'runner.status', reachable: ping.ok, error: ping.ok ? null : ping.error });
      },
    });
    runner = { orchestrator, catalog, jobsDir };
    app.addHook('onClose', (_instance, done) => {
      orchestrator.stop();
      done();
    });
  }
  app.decorate('orchestrator', runner?.orchestrator ?? null);

  const ctx: RouteContext = {
    app,
    db,
    broadcaster,
    maxElements: options.maxElements ?? MAX_ELEMENTS,
    orchestrator: runner?.orchestrator ?? null,
  };
  graphRoutes(ctx);
  nodeRoutes(ctx);
  edgeRoutes(ctx);
  dataRoutes(ctx);
  scopeRoutes(ctx);
  jobRoutes(ctx, runner);
  app.get('/api/ws', { websocket: true }, (socket) => {
    broadcaster.add(socket);
  });

  return app;
}
