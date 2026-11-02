import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { Orchestrator } from '../runner/orchestrator';
import type { Broadcaster } from '../ws';

/** What every route module gets. */
export interface RouteContext {
  app: FastifyInstance;
  db: Db;
  broadcaster: Broadcaster;
  maxElements: number;
  /** The job queue, if the tool runner is on: scope changes must re-check its queued jobs. */
  orchestrator: Orchestrator | null;
}
