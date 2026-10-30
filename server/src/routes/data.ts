// GET /api/stats, GET /api/scans, POST /api/ingest, GET /api/export (docs/architecture.md §6).
import {
  CONFIDENCE_LEVELS,
  NODE_TYPES,
  SEVERITIES,
  TAGS,
  exportQuerySchema,
  type StatsResponse,
} from '@redwhale/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { edges, nodes, observations, scans } from '../db/schema';
import { loadGraph } from '../graph/store';
import { ingestDocument } from '../ingest/ingest';
import { HttpError, parseInput } from '../http';
import type { RouteContext } from './context';

function countBy<K extends string>(keys: readonly K[], rows: { key: string | null; n: number }[], nullKey?: K) {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const r of rows) {
    const key = (r.key ?? nullKey) as K | undefined;
    if (key !== undefined && key in counts) counts[key] = r.n;
  }
  return counts;
}

function stats(db: Db): StatsResponse {
  const group = (column: string) =>
    db.$client.prepare(`SELECT ${column} AS key, COUNT(*) AS n FROM nodes GROUP BY ${column}`).all() as {
      key: string | null;
      n: number;
    }[];
  const count = (table: string) =>
    (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const toolRows = db.$client
    .prepare('SELECT tool AS key, COUNT(DISTINCT node_id) AS n FROM observations GROUP BY tool ORDER BY tool')
    .all() as { key: string; n: number }[];

  return {
    totals: { nodes: count('nodes'), edges: count('edges'), scans: count('scans'), observations: count('observations') },
    byType: countBy(NODE_TYPES, group('type')),
    bySeverity: countBy([...SEVERITIES, 'none'], group('severity'), 'none'),
    byConfidence: countBy(CONFIDENCE_LEVELS, group('confidence')),
    byTag: countBy([...TAGS, 'none'], group('tag'), 'none'),
    byTool: Object.fromEntries(toolRows.map((r) => [r.key, r.n])),
  };
}

function scanSummaries(db: Db) {
  return db
    .select({
      id: scans.id,
      tool: scans.tool,
      toolVersion: scans.toolVersion,
      target: scans.target,
      command: scans.command,
      status: scans.status,
      errors: scans.errors,
      startedAt: scans.startedAt,
      finishedAt: scans.finishedAt,
      ingestedAt: scans.ingestedAt,
      findingCount: sql<number>`json_array_length(${scans.raw}, '$.findings')`,
      // Raw SQL: inside a subquery Drizzle leaves column names unqualified, and `id` would bind to observations.
      observationCount: sql<number>`(SELECT COUNT(*) FROM observations o WHERE o.scan_id = scans.id)`,
    })
    .from(scans)
    .orderBy(desc(scans.ingestedAt), sql`${scans}.rowid DESC`)
    .all();
}

export function dataRoutes({ app, db, broadcaster }: RouteContext): void {
  app.get('/api/stats', () => stats(db));

  app.get('/api/scans', () => ({ scans: scanSummaries(db) }));

  app.post('/api/ingest', (req, reply) => {
    const result = ingestDocument(db, req.body);
    switch (result.status) {
      case 'invalid':
        // Report exactly what failed; never "fix" a teammate's file here.
        throw new HttpError(422, 'invalid tool-output file', result.errors);
      case 'duplicate':
        return result;
      case 'ingested': {
        const scan = db.select({ tool: scans.tool }).from(scans).where(eq(scans.id, result.scanId)).get();
        broadcaster.send({ type: 'scan.ingested', scanId: result.scanId, tool: scan?.tool ?? '' });
        broadcaster.send({ type: 'graph.updated', nodeIds: result.nodeIds, edgeIds: result.edgeIds });
        return reply.code(201).send(result);
      }
    }
  });

  app.get('/api/export', (req, reply) => {
    const { format } = parseInput(exportQuerySchema, req.query);
    const notesAndData = new Map(
      db
        .select({ id: nodes.id, data: nodes.data, notes: nodes.notes })
        .from(nodes)
        .all()
        .map(({ id, ...rest }) => [id, rest]),
    );
    const body = {
      format,
      exportedAt: new Date().toISOString(),
      nodes: loadGraph(db).nodes.map((n) => ({ ...n, ...(notesAndData.get(n.id) ?? { data: {}, notes: '' }) })),
      edges: db
        .select({
          id: edges.id,
          source: edges.sourceId,
          target: edges.targetId,
          relation: edges.relation,
          firstSeen: edges.firstSeen,
          lastSeen: edges.lastSeen,
        })
        .from(edges)
        .orderBy(asc(edges.id))
        .all(),
      scans: scanSummaries(db),
      observations: db
        .select({
          nodeId: observations.nodeId,
          scanId: observations.scanId,
          tool: observations.tool,
          severity: observations.severity,
          data: observations.data,
          observedAt: observations.observedAt,
        })
        .from(observations)
        .orderBy(asc(observations.id))
        .all(),
    };
    return reply.header('content-disposition', 'attachment; filename="redwhale-export.json"').send(body);
  });
}
