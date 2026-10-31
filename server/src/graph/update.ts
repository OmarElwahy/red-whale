// The analyst's edits to a node (PATCH /api/nodes/:id): tag, notes, `verified`, saved position. Shared by the
// route and the showcase mock, so mock annotations take exactly the path a real PATCH does.
import { nodePatchSchema, type NodePatch } from '@redwhale/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { nodes } from '../db/schema';

/** Validates the patch with the API's schema and applies it. Returns false if there is no such node. */
export function updateNode(db: Db, id: string, patch: NodePatch): boolean {
  const body = nodePatchSchema.parse(patch);
  const set: Partial<typeof nodes.$inferInsert> = {};
  if (body.tag !== undefined) set.tag = body.tag;
  if (body.notes !== undefined) set.notes = body.notes;
  if (body.confidence !== undefined) set.confidence = body.confidence;
  if (body.posX !== undefined) set.posX = body.posX;
  if (body.posY !== undefined) set.posY = body.posY;
  return db.update(nodes).set(set).where(eq(nodes.id, id)).returning({ id: nodes.id }).all().length > 0;
}
