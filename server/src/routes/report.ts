// GET /api/nodes/:id/report (docs/architecture.md §6): a bug-report draft for a vulnerability, secret or leak node.
import { REPORT_NODE_TYPES } from '@redwhale/shared';
import { HttpError, notFound } from '../http';
import { nodeReport } from '../report/build';
import type { RouteContext } from './context';

export function reportRoutes({ app, db }: RouteContext): void {
  app.get<{ Params: { id: string } }>('/api/nodes/:id/report', (req) => {
    const report = nodeReport(db, req.params.id);
    if (report === null) throw notFound(`node ${req.params.id}`);
    if (report === 'unsupported') throw new HttpError(400, `reports are for ${REPORT_NODE_TYPES.join(', ')} nodes`);
    return report;
  });
}
