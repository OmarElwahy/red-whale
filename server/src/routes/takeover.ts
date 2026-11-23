// GET /api/takeover/watch (TW-2, docs/architecture.md §6, §11): every subdomain's takeover status, built on read.
import { takeoverWatchQuerySchema } from '@redwhale/shared';
import { parseInput } from '../http';
import { takeoverWatch } from '../takeover/watch';
import type { RouteContext } from './context';

export function takeoverRoutes({ app, db }: RouteContext): void {
  app.get('/api/takeover/watch', (req) => {
    const { page, pageSize } = parseInput(takeoverWatchQuerySchema, req.query);
    return takeoverWatch(db, { page, pageSize, now: new Date() });
  });
}
