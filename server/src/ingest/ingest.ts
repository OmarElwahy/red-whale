// Ingest pipeline (docs/architecture.md §5): validate → hash → plan → one transaction.
import { randomUUID } from 'node:crypto';
import { validateContract, type Confidence } from '@redwhale/shared';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/client';
import { edgeObservations, edges, nodes, observations, scans } from '../db/schema';
import { deriveEdgeState, deriveNodeState, type EdgeObservationInput, type ObservationInput } from './derive';
import { fileHash } from './hash';
import { planIngest } from './plan';

export type IngestResult =
  | {
      status: 'ingested';
      scanId: string;
      /** Every node and edge this file touched; Phase 3 broadcasts these as `graph.updated`. */
      nodeIds: string[];
      edgeIds: string[];
      created: { nodes: number; edges: number };
      observations: number;
      /** One per edge in the file. */
      edgeObservations: number;
      warnings: string[];
    }
  | { status: 'duplicate'; scanId: string; warnings: string[] }
  | { status: 'invalid'; errors: string[] };

/** Rows per multi-row INSERT, well under SQLite's bound-parameter limit. */
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** `column IN (ids)` with the whole list bound as one JSON parameter. */
function inIds(column: AnySQLiteColumn, ids: readonly string[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

/** Contract timestamps → the fixed-width form stored in the database. */
function toIso(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

/** Ingests the text of one tool-output file. */
export function ingestText(db: Db, text: string, now: Date = new Date()): IngestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { status: 'invalid', errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return ingestDocument(db, parsed, now);
}

/** Ingests one parsed tool-output file. Rejected files leave the database untouched. */
export function ingestDocument(db: Db, input: unknown, now: Date = new Date()): IngestResult {
  const validation = validateContract(input);
  if (!validation.ok) return { status: 'invalid', errors: validation.errors };
  const { data: file, warnings } = validation;

  const planned = planIngest(file);
  if (!planned.ok) return { status: 'invalid', errors: planned.errors };
  const { plan } = planned;

  const hash = fileHash(input);
  const observedAt = toIso(file.finished_at);
  const nodeIds = [...plan.nodes.keys()];
  const edgeIds = [...plan.edges.keys()];

  return db.transaction(
    (tx): IngestResult => {
      const existing = tx.select({ id: scans.id }).from(scans).where(eq(scans.fileHash, hash)).get();
      if (existing) return { status: 'duplicate', scanId: existing.id, warnings };

      const scanId = randomUUID();
      tx.insert(scans)
        .values({
          id: scanId,
          tool: file.tool,
          toolVersion: file.tool_version ?? null,
          target: file.target,
          command: file.command,
          status: file.status,
          errors: file.errors,
          startedAt: toIso(file.started_at),
          finishedAt: observedAt,
          ingestedAt: now.toISOString(),
          fileHash: hash,
          raw: input,
        })
        .run();

      // New nodes get placeholder derived fields; recomputeNodes() below fills in the real ones.
      let createdNodes = 0;
      for (const batch of chunks([...plan.nodes.values()])) {
        createdNodes += tx
          .insert(nodes)
          .values(batch.map((n) => ({ ...n, firstSeen: observedAt, lastSeen: observedAt })))
          .onConflictDoNothing()
          .returning({ id: nodes.id })
          .all().length;
      }

      const knownEdges =
        edgeIds.length === 0 ? 0 : tx.select({ id: edges.id }).from(edges).where(inIds(edges.id, edgeIds)).all().length;
      // As for nodes: placeholder derived fields, filled in by recomputeEdges() below.
      for (const batch of chunks([...plan.edges.values()])) {
        tx.insert(edges)
          .values(batch.map((e) => ({ ...e, firstSeen: observedAt, lastSeen: observedAt })))
          .onConflictDoNothing()
          .run();
      }

      for (const batch of chunks([...plan.observations.values()])) {
        tx.insert(observations)
          .values(batch.map((o) => ({ ...o, scanId, tool: file.tool, observedAt })))
          .run();
      }

      // Edge provenance: one row per edge per scan, like observations for nodes (plan.edges is already deduplicated).
      for (const batch of chunks(edgeIds)) {
        tx.insert(edgeObservations)
          .values(batch.map((edgeId) => ({ edgeId, scanId, tool: file.tool, data: {}, observedAt })))
          .run();
      }

      recomputeNodes(tx, nodeIds);
      recomputeEdges(tx, edgeIds);

      return {
        status: 'ingested',
        scanId,
        nodeIds,
        edgeIds,
        created: { nodes: createdNodes, edges: edgeIds.length - knownEdges },
        observations: plan.observations.size,
        edgeObservations: edgeIds.length,
        warnings,
      };
    },
    { behavior: 'immediate' },
  );
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Rebuilds every derived field of these nodes from all of their observations. */
export function recomputeNodes(tx: Tx | Db, ids: readonly string[]): void {
  if (ids.length === 0) return;

  const byNode = new Map<string, ObservationInput[]>();
  const rows = tx
    .select({
      nodeId: observations.nodeId,
      scanId: observations.scanId,
      tool: observations.tool,
      role: observations.role,
      severity: observations.severity,
      data: observations.data,
      observedAt: observations.observedAt,
    })
    .from(observations)
    .where(inIds(observations.nodeId, ids))
    .all();
  for (const { nodeId, ...o } of rows) {
    const list = byNode.get(nodeId);
    if (list) list.push(o);
    else byNode.set(nodeId, [o]);
  }

  const current = new Map<string, Confidence>(
    tx
      .select({ id: nodes.id, confidence: nodes.confidence })
      .from(nodes)
      .where(inIds(nodes.id, ids))
      .all()
      .map((n) => [n.id, n.confidence]),
  );

  for (const id of ids) {
    const obs = byNode.get(id);
    const confidence = current.get(id);
    if (!obs || !confidence) throw new Error(`node ${id} has no observations`);
    tx.update(nodes).set(deriveNodeState(obs, confidence)).where(eq(nodes.id, id)).run();
  }
}

/** Rebuilds every derived field of these edges from all of their edge observations. */
export function recomputeEdges(tx: Tx | Db, ids: readonly string[]): void {
  if (ids.length === 0) return;

  const byEdge = new Map<string, EdgeObservationInput[]>();
  const rows = tx
    .select({
      edgeId: edgeObservations.edgeId,
      scanId: edgeObservations.scanId,
      tool: edgeObservations.tool,
      observedAt: edgeObservations.observedAt,
    })
    .from(edgeObservations)
    .where(inIds(edgeObservations.edgeId, ids))
    .all();
  for (const { edgeId, ...o } of rows) {
    const list = byEdge.get(edgeId);
    if (list) list.push(o);
    else byEdge.set(edgeId, [o]);
  }

  for (const id of ids) {
    const obs = byEdge.get(id);
    if (!obs) throw new Error(`edge ${id} has no observations`);
    tx.update(edges).set(deriveEdgeState(obs)).where(eq(edges.id, id)).run();
  }
}
