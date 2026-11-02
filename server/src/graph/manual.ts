// Nodes the analyst adds by hand (POST /api/nodes). The node goes through the normal ingest as a one-finding scan by
// the reserved tool `manual`, so it gets the usual ID, normalization, observation, provenance and live update.
import {
  RELATIONS,
  describeManualValue,
  manualDocument,
  manualIssue,
  manualNodeSchema,
  relationsBetween,
  type ManualFinding,
  type NodeType,
} from '@redwhale/shared';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { edges, nodes } from '../db/schema';
import { ingestDocument } from '../ingest/ingest';
import { updateNode } from './update';

type Input = z.output<typeof manualNodeSchema>;

export type ManualOutcome =
  | {
      ok: true;
      status: 201 | 200;
      id: string;
      created: boolean;
      linked: boolean;
      warnings: string[];
      /** The scan the node or link was ingested as (null: nothing was written). */
      ingested: { scanId: string; nodeIds: string[]; edgeIds: string[] } | null;
    }
  | { ok: false; status: 422; error: string; issues: string[] };

function invalid(...issues: string[]): ManualOutcome {
  return { ok: false, status: 422, error: 'invalid node', issues };
}

export function addManualNode(db: Db, input: Input, now: Date = new Date()): ManualOutcome {
  const check = describeManualValue(input.type, input.value);
  if (!check.ok) return invalid(`value: ${check.error}`);

  // The parent: an existing node, and a relation the contract allows between the two types.
  let parent: { id: string; type: NodeType; value: string } | undefined;
  let relation = input.relation;
  if (input.parentId !== undefined) {
    parent = db.select({ id: nodes.id, type: nodes.type, value: nodes.value }).from(nodes).where(eq(nodes.id, input.parentId)).get();
    if (!parent) return invalid(`parentId: node '${input.parentId}' not found`);
    if (parent.id === check.id) return invalid('parentId: a node cannot be its own parent');
    const allowed = relationsBetween(parent.type, input.type);
    if (relation === undefined) {
      if (allowed.length === 0) {
        return invalid(`parentId: a ${input.type} can't hang under a ${parent.type} (no relation links ${parent.type} -> ${input.type})`);
      }
      if (allowed.length > 1) return invalid(`relation: pick one of ${allowed.join(', ')}`);
      relation = allowed[0];
    } else if (!allowed.includes(relation)) {
      const rule = RELATIONS[relation];
      return invalid(
        `relation: '${relation}' can't link ${parent.type} -> ${input.type} ` +
          `(allowed: ${rule.parents.join(', ')} -> ${rule.children.join(', ')})`,
      );
    }
  }

  const finding: ManualFinding = {
    type: input.type,
    value: input.value,
    ...(parent && relation ? { parent: { type: parent.type, value: parent.value }, relation } : {}),
  };
  const id = check.id;
  const exists = db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).get() !== undefined;

  if (exists) {
    // Never a duplicate, and never a change to the existing node; at most the link the analyst asked for.
    const base = { ok: true as const, status: 200 as const, id, created: false, warnings: [] };
    if (input.ifExists !== 'link' || !parent || !relation) return { ...base, linked: false, ingested: null };
    const linked = db
      .select({ id: edges.id })
      .from(edges)
      .where(and(eq(edges.sourceId, parent.id), eq(edges.relation, relation), eq(edges.targetId, id)))
      .get();
    if (linked) return { ...base, linked: false, ingested: null };
    const result = ingestDocument(db, manualDocument(finding, now), now, { allowManual: true });
    if (result.status !== 'ingested') return invalid(...(result.status === 'invalid' ? result.errors.map(manualIssue) : []));
    const { scanId, nodeIds, edgeIds } = result;
    return { ...base, linked: true, ingested: { scanId, nodeIds, edgeIds } };
  }

  const doc = manualDocument({ ...finding, ...(input.severity ? { severity: input.severity } : {}) }, now);
  const result = ingestDocument(db, doc, now, {
    allowManual: true,
    apply: () => {
      // Inside the ingest transaction: the analyst's fields land with the node, or not at all.
      if (input.label) db.update(nodes).set({ label: input.label }).where(eq(nodes.id, id)).run();
      const patch = {
        ...(input.tag ? { tag: input.tag } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.x !== undefined && input.y !== undefined ? { posX: input.x, posY: input.y } : {}),
      };
      if (Object.keys(patch).length > 0) updateNode(db, id, patch);
    },
  });
  if (result.status === 'invalid') return invalid(...result.errors.map(manualIssue));
  if (result.status === 'duplicate') throw new Error('a manual scan was a duplicate file');
  return {
    ok: true,
    status: 201,
    id,
    created: true,
    linked: parent !== undefined,
    warnings: result.warnings.map(manualIssue),
    ingested: { scanId: result.scanId, nodeIds: result.nodeIds, edgeIds: result.edgeIds },
  };
}
