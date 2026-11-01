// GET /api/edges/:id (docs/architecture.md §6): an edge's relation, both ends, derived fields and provenance.
import type { EdgeConfidence, EdgeDetailResponse, NodeType, Relation } from '@redwhale/shared';
import type { Db } from '../db/client';
import { jsonObject, notFound } from '../http';
import type { RouteContext } from './context';

interface EdgeRow {
  id: string;
  relation: Relation;
  source_count: number;
  confidence: EdgeConfidence;
  first_seen: string;
  last_seen: string;
  source_id: string;
  source_type: NodeType;
  source_label: string;
  target_id: string;
  target_type: NodeType;
  target_label: string;
}

interface EdgeObservationRow {
  scan_id: string;
  tool: string;
  command: string;
  data: string;
  observed_at: string;
}

/** Edge detail + every scan that reported it, oldest first; null if there is no such edge. */
export function edgeDetail(db: Db, id: string): EdgeDetailResponse | null {
  const row = db.$client
    .prepare(
      `SELECT e.id, e.relation, e.source_count, e.confidence, e.first_seen, e.last_seen,
              s.id AS source_id, s.type AS source_type, s.label AS source_label,
              t.id AS target_id, t.type AS target_type, t.label AS target_label
       FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
       WHERE e.id = ?`,
    )
    .get(id) as EdgeRow | undefined;
  if (!row) return null;

  const observations = db.$client
    .prepare(
      `SELECT o.scan_id, o.tool, s.command, o.data, o.observed_at
       FROM edge_observations o JOIN scans s ON s.id = o.scan_id
       WHERE o.edge_id = ?
       ORDER BY o.observed_at, o.tool, o.scan_id`,
    )
    .all(id) as EdgeObservationRow[];

  return {
    edge: {
      id: row.id,
      relation: row.relation,
      source: { id: row.source_id, type: row.source_type, label: row.source_label },
      target: { id: row.target_id, type: row.target_type, label: row.target_label },
      sourceCount: row.source_count,
      confidence: row.confidence,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    },
    observations: observations.map((o) => ({
      scanId: o.scan_id,
      tool: o.tool,
      command: o.command,
      data: jsonObject(o.data),
      observedAt: o.observed_at,
    })),
  };
}

export function edgeRoutes({ app, db }: RouteContext): void {
  app.get<{ Params: { id: string } }>('/api/edges/:id', (req) => {
    const detail = edgeDetail(db, req.params.id);
    if (!detail) throw notFound(`edge ${req.params.id}`);
    return detail;
  });
}
