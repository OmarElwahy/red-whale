import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { Broadcaster } from '../ws';

/** What every route module gets. */
export interface RouteContext {
  app: FastifyInstance;
  db: Db;
  broadcaster: Broadcaster;
  maxElements: number;
}
