// GET /api/nodes, GET/PATCH /api/nodes/:id, PUT /api/layout (docs/architecture.md §6).
import {
  layoutBodySchema,
  nodeListQuerySchema,
  nodePatchSchema,
  type Confidence,
  type NodeType,
  type ObservationRole,
  type Relation,
  type Severity,
} from '@redwhale/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { nodes } from '../db/schema';
import { maxSeverity } from '../ingest/derive';
import { filteredGraph, nodeComparator } from '../graph/store';
import { HttpError, jsonObject, notFound, parseInput } from '../http';
import type { RouteContext } from './context';

/** Highest severity of the node and everything reachable below it (the same rule as loadGraph). */
function effectiveSeverity(db: Db, id: string): Severity | null {
  const rows = db.all<{ severity: Severity }>(sql`
    WITH RECURSIVE below(id) AS (
      SELECT ${id}
      UNION
      SELECT e.target_id FROM edges e JOIN below b ON e.source_id = b.id
    )
    SELECT n.severity FROM nodes n JOIN below b ON b.id = n.id WHERE n.severity IS NOT NULL`);
  return rows.reduce<Severity | null>((s, r) => maxSeverity(s, r.severity), null);
}

interface EdgeRow {
  id: string;
  relation: Relation;
  direction: 'in' | 'out';
  first_seen: string;
  last_seen: string;
  other_id: string;
  other_type: NodeType;
  other_value: string;
  other_label: string;
  other_severity: Severity | null;
  other_confidence: Confidence;
}

interface ObservationRow {
  scan_id: string;
  tool: string;
  command: string;
  role: ObservationRole;
  severity: Severity | null;
  data: string;
  observed_at: string;
}

/** Node detail + edges + provenance, or null if there is no such node. */
export function nodeDetail(db: Db, id: string) {
  const row = db.select().from(nodes).where(eq(nodes.id, id)).get();
  if (!row) return null;

  const edgeRows = db.$client
    .prepare(
      `SELECT e.id, e.relation, e.first_seen, e.last_seen,
              CASE WHEN e.source_id = @id THEN 'out' ELSE 'in' END AS direction,
              o.id AS other_id, o.type AS other_type, o.value AS other_value, o.label AS other_label,
              o.severity AS other_severity, o.confidence AS other_confidence
       FROM edges e
       JOIN nodes o ON o.id = CASE WHEN e.source_id = @id THEN e.target_id ELSE e.source_id END
       WHERE e.source_id = @id OR e.target_id = @id
       ORDER BY direction, e.relation, o.value`,
    )
    .all({ id }) as EdgeRow[];

  const observationRows = db.$client
    .prepare(
      `SELECT o.scan_id, o.tool, s.command, o.role, o.severity, o.data, o.observed_at
       FROM observations o JOIN scans s ON s.id = o.scan_id
       WHERE o.node_id = ?
       ORDER BY o.observed_at, o.tool, o.scan_id`,
    )
    .all(id) as ObservationRow[];

  return {
    node: {
      id: row.id,
      type: row.type,
      value: row.value,
      label: row.label,
      severity: row.severity,
      effectiveSeverity: effectiveSeverity(db, id),
      confidence: row.confidence,
      sourceCount: row.sourceCount,
      tag: row.tag,
      posX: row.posX,
      posY: row.posY,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      data: row.data,
      notes: row.notes,
    },
    edges: edgeRows.map((e) => ({
      id: e.id,
      relation: e.relation,
      direction: e.direction,
      other: {
        id: e.other_id,
        type: e.other_type,
        value: e.other_value,
        label: e.other_label,
        severity: e.other_severity,
        confidence: e.other_confidence,
      },
      firstSeen: e.first_seen,
      lastSeen: e.last_seen,
    })),
    observations: observationRows.map((o) => ({
      scanId: o.scan_id,
      tool: o.tool,
      command: o.command,
      role: o.role,
      severity: o.severity,
      data: jsonObject(o.data),
      observedAt: o.observed_at,
    })),
  };
}

export function nodeRoutes({ app, db, broadcaster }: RouteContext): void {
  app.get('/api/nodes', (req) => {
    const { page: requested, pageSize, sort, at, ...filters } = parseInput(nodeListQuerySchema, req.query);
    const items = filteredGraph(db, filters).nodes.sort(nodeComparator(sort));
    const index = at === undefined ? -1 : items.findIndex((n) => n.id === at);
    const page = index === -1 ? requested : Math.floor(index / pageSize) + 1;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length };
  });

  app.get<{ Params: { id: string } }>('/api/nodes/:id', (req) => {
    const detail = nodeDetail(db, req.params.id);
    if (!detail) throw notFound(`node ${req.params.id}`);
    return detail;
  });

  app.patch<{ Params: { id: string } }>('/api/nodes/:id', (req) => {
    const { id } = req.params;
    const body = parseInput(nodePatchSchema, req.body);
    const set: Partial<typeof nodes.$inferInsert> = {};
    if (body.tag !== undefined) set.tag = body.tag;
    if (body.notes !== undefined) set.notes = body.notes;
    if (body.confidence !== undefined) set.confidence = body.confidence;
    if (body.posX !== undefined) set.posX = body.posX;
    if (body.posY !== undefined) set.posY = body.posY;

    const updated = db.update(nodes).set(set).where(eq(nodes.id, id)).returning({ id: nodes.id }).all();
    if (updated.length === 0) throw notFound(`node ${id}`);
    broadcaster.send({ type: 'graph.updated', nodeIds: [id], edgeIds: [] });
    return nodeDetail(db, id);
  });

  app.put('/api/layout', (req) => {
    const { positions } = parseInput(layoutBodySchema, req.body);
    return db.transaction((tx) => {
      const ids = positions.map((p) => p.id);
      const known = new Set(
        tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(sql`${nodes.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)
          .all()
          .map((r) => r.id),
      );
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new HttpError(400, 'unknown node IDs; nothing was saved', unknown.map((id) => `unknown node '${id}'`));
      }
      for (const p of positions) tx.update(nodes).set({ posX: p.x, posY: p.y }).where(eq(nodes.id, p.id)).run();
      return { updated: positions.length };
    });
  });
}
