// GET /api/nodes/:id/delete-preview, DELETE /api/nodes/:id, GET /api/deletions (docs/architecture.md §6).
// The analyst's permanent delete of a node or a group, and its log.
import {
  deletePreviewQuerySchema,
  deleteQuerySchema,
  deletionsQuerySchema,
  type DeletePreview,
  type GraphFilters,
} from '@redwhale/shared';
import { count, desc } from 'drizzle-orm';
import type { Db } from '../db/client';
import { deletions } from '../db/schema';
import { executeDeletion, jobRows, previewDeletion, resolveTarget, type DeletionCounts } from '../graph/delete';
import { HttpError, parseInput } from '../http';
import type { RouteContext } from './context';
import { jobDto } from './jobs';

function countsDto(c: DeletionCounts): DeletePreview['node'] {
  return { ...c, runningJobs: c.runningJobs.map(jobDto) };
}

/** The preview for a node or group ID; throws 400/404 like the routes. */
export function deletePreview(db: Db, id: string, filters: GraphFilters): DeletePreview {
  const resolved = resolveTarget(db, id, filters);
  if (!resolved.ok) throw new HttpError(resolved.status, resolved.error);
  const { target, node, subtree } = previewDeletion(db, resolved.target);
  return {
    target: {
      kind: target.kind,
      id: target.id,
      type: target.type,
      label: target.label,
      members: target.roots.length,
      hiddenByFilters: target.hiddenByFilters,
    },
    node: countsDto(node),
    subtree: countsDto(subtree),
  };
}

export function deletionRoutes({ app, db, broadcaster, orchestrator }: RouteContext): void {
  app.get<{ Params: { id: string } }>('/api/nodes/:id/delete-preview', (req) => {
    const filters = parseInput(deletePreviewQuerySchema, req.query);
    return deletePreview(db, req.params.id, filters);
  });

  app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
    const { id } = req.params;
    const { mode, expect, cancelJobs, ...filters } = parseInput(deleteQuerySchema, req.query);

    if (cancelJobs === '1' && orchestrator) {
      const running = deletePreview(db, id, filters)[mode].runningJobs.map((j) => j.id);
      await orchestrator.cancelAndWait(running);
    }

    const outcome = executeDeletion(db, id, filters, mode, expect);
    if (!outcome.ok) {
      if (outcome.reason === 'target') throw new HttpError(outcome.status, outcome.error);
      return reply.code(409).send({ error: outcome.error, reason: outcome.reason, preview: deletePreview(db, id, filters) });
    }

    const { deletionId, nodeIds, edgeIds, cancelledJobs } = outcome;
    broadcaster.send({ type: 'graph.deleted', nodeIds, edgeIds });
    for (const job of jobRows(db, cancelledJobs)) broadcaster.send({ type: 'job.updated', job: jobDto(job) });
    return { deletionId, nodeIds, edgeIds, cancelledJobs };
  });

  app.get('/api/deletions', (req) => {
    const { page, pageSize } = parseInput(deletionsQuerySchema, req.query);
    const items = db
      .select()
      .from(deletions)
      .orderBy(desc(deletions.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    const total = db.select({ n: count() }).from(deletions).get()?.n ?? 0;
    return { items, page, pageSize, total };
  });
}
