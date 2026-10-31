// GET /api/stats, GET /api/scans, GET /api/highlights, POST /api/ingest, GET /api/export (docs/architecture.md §6).
import {
  CONFIDENCE_LEVELS,
  NODE_TYPES,
  SCOPE_DECISIONS,
  SEVERITIES,
  compileScope,
  TAGS,
  exportQuerySchema,
  highlightsQuerySchema,
  type StatsResponse,
} from '@redwhale/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { edges, nodes, observations, scans } from '../db/schema';
import { loadGraph, riskFirst } from '../graph/store';
import { ingestDocument } from '../ingest/ingest';
import { HttpError, parseInput } from '../http';
import { currentScope } from '../scope/store';
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
  // Scope decisions aren't stored (they follow the rules), so count them from the node values.
  const scope = compileScope(currentScope(db));
  const byScope = countBy(SCOPE_DECISIONS, []);
  for (const n of db.select({ type: nodes.type, value: nodes.value }).from(nodes).all()) {
    byScope[scope.check(n.type, n.value, 'passive').decision] += 1;
  }
  const toolRows = db.$client
    .prepare('SELECT tool AS key, COUNT(DISTINCT node_id) AS n FROM observations GROUP BY tool ORDER BY tool')
    .all() as { key: string; n: number }[];

  return {
    totals: { nodes: count('nodes'), edges: count('edges'), scans: count('scans'), observations: count('observations') },
    byType: countBy(NODE_TYPES, group('type')),
    bySeverity: countBy([...SEVERITIES, 'none'], group('severity'), 'none'),
    byConfidence: countBy(CONFIDENCE_LEVELS, group('confidence')),
    byTag: countBy([...TAGS, 'none'], group('tag'), 'none'),
    byScope,
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

  // Every node tagged `interesting`, with its notes. Not filtered: it's the analyst's list, whatever the view.
  app.get('/api/highlights', (req) => {
    parseInput(highlightsQuerySchema, req.query);
    const notes = new Map(
      db
        .select({ id: nodes.id, notes: nodes.notes })
        .from(nodes)
        .where(eq(nodes.tag, 'interesting'))
        .all()
        .map((r) => [r.id, r.notes]),
    );
    const items = loadGraph(db)
      .nodes.filter((n) => notes.has(n.id))
      .sort(riskFirst)
      .map((n) => ({ ...n, notes: notes.get(n.id) ?? '' }));
    return { items };
  });

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
    const exportedAt = new Date().toISOString();
    const body = {
      format,
      exportedAt,
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
          role: observations.role,
          severity: observations.severity,
          data: observations.data,
          observedAt: observations.observedAt,
        })
        .from(observations)
        .orderBy(asc(observations.id))
        .all(),
    };
    // 2026-10-30T12:34:56.789Z → redwhale-export-2026-10-30T12-34-56Z.json (no colons: Windows can't save them).
    const filename = `redwhale-export-${exportedAt.slice(0, 19).replaceAll(':', '-')}Z.json`;
    return reply.header('content-disposition', `attachment; filename="${filename}"`).send(body);
  });
}
