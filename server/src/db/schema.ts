// Drizzle schema (docs/architecture.md §4). After editing, run `pnpm db:generate` and commit server/drizzle/.
import {
  CONFIDENCE_LEVELS,
  EDGE_CONFIDENCE_LEVELS,
  NODE_TYPES,
  OBSERVATION_ROLES,
  RELATION_TYPES,
  SCAN_STATUSES,
  SCOPE_ACTIONS,
  SCOPE_DECISIONS,
  SCOPE_KINDS,
  SCOPE_MODES,
  SCOPE_SOURCES,
  SEVERITIES,
  TAGS,
} from '@redwhale/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/** CHECK (column IN ('a', 'b', ...)). NULL passes, so it also works for nullable columns. */
function oneOf(column: AnySQLiteColumn, values: readonly string[]) {
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

// Timestamps are TEXT in Date#toISOString() form (YYYY-MM-DDTHH:MM:SS.sssZ), so they sort as text.

export const scans = sqliteTable(
  'scans',
  {
    id: text('id').primaryKey(),
    tool: text('tool').notNull(),
    toolVersion: text('tool_version'),
    target: text('target').notNull(),
    command: text('command').notNull(),
    status: text('status', { enum: SCAN_STATUSES }).notNull(),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    ingestedAt: text('ingested_at').notNull(),
    /** sha256 of the file's canonical JSON; re-ingesting the same file is a no-op. */
    fileHash: text('file_hash').notNull().unique(),
    /** The whole tool-output file as ingested (provenance). */
    raw: text('raw', { mode: 'json' }).$type<unknown>().notNull(),
  },
  (t) => [check('scans_status_ck', oneOf(t.status, SCAN_STATUSES))],
);

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: NODE_TYPES }).notNull(),
    /** Normalized value (shared/src/normalize.ts). */
    value: text('value').notNull(),
    /** Display text, as first reported. */
    label: text('label').notNull(),
    // Everything from here to lastSeen is derived from observations at ingest.
    severity: text('severity', { enum: SEVERITIES }),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull().default('discovered'),
    sourceCount: integer('source_count').notNull().default(0),
    data: text('data', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    tag: text('tag', { enum: TAGS }),
    notes: text('notes').notNull().default(''),
    posX: real('pos_x'),
    posY: real('pos_y'),
    firstSeen: text('first_seen').notNull(),
    lastSeen: text('last_seen').notNull(),
  },
  (t) => [
    index('nodes_type_idx').on(t.type),
    index('nodes_severity_idx').on(t.severity),
    index('nodes_confidence_idx').on(t.confidence),
    index('nodes_tag_idx').on(t.tag),
    check('nodes_type_ck', oneOf(t.type, NODE_TYPES)),
    check('nodes_severity_ck', oneOf(t.severity, SEVERITIES)),
    check('nodes_confidence_ck', oneOf(t.confidence, CONFIDENCE_LEVELS)),
    check('nodes_tag_ck', oneOf(t.tag, TAGS)),
  ],
);

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => nodes.id),
    targetId: text('target_id')
      .notNull()
      .references(() => nodes.id),
    relation: text('relation', { enum: RELATION_TYPES }).notNull(),
    // Everything from here on is derived from edge_observations at ingest.
    confidence: text('confidence', { enum: EDGE_CONFIDENCE_LEVELS }).notNull().default('discovered'),
    sourceCount: integer('source_count').notNull().default(0),
    firstSeen: text('first_seen').notNull(),
    lastSeen: text('last_seen').notNull(),
  },
  (t) => [
    uniqueIndex('edges_source_relation_target_uq').on(t.sourceId, t.relation, t.targetId),
    index('edges_source_idx').on(t.sourceId),
    index('edges_target_idx').on(t.targetId),
    check('edges_relation_ck', oneOf(t.relation, RELATION_TYPES)),
    check('edges_confidence_ck', oneOf(t.confidence, EDGE_CONFIDENCE_LEVELS)),
  ],
);

/** Edge provenance: one row per (edge, scan) that reported the relation, i.e. had a finding naming that parent. */
export const edgeObservations = sqliteTable(
  'edge_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    edgeId: text('edge_id')
      .notNull()
      .references(() => edges.id),
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id),
    /** Copied from scans.tool, as on observations. */
    tool: text('tool').notNull(),
    /** Reserved for per-tool edge details; `{}` for now. */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** The scan's finished_at. */
    observedAt: text('observed_at').notNull(),
  },
  (t) => [
    uniqueIndex('edge_observations_edge_scan_uq').on(t.edgeId, t.scanId),
    index('edge_observations_edge_idx').on(t.edgeId),
    index('edge_observations_scan_idx').on(t.scanId),
    index('edge_observations_observed_at_idx').on(t.observedAt),
  ],
);

/** Provenance: one row per (node, scan) that reported it, as a finding or as a parent. */
export const observations = sqliteTable(
  'observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    scanId: text('scan_id')
      .notNull()
      .references(() => scans.id),
    /** Copied from scans.tool so confidence is a COUNT(DISTINCT tool) over this table alone. */
    tool: text('tool').notNull(),
    /** `finding` if the scan reported the node; `parent` if it only named it as a parent. Only findings count toward confidence. */
    role: text('role', { enum: OBSERVATION_ROLES }).notNull(),
    severity: text('severity', { enum: SEVERITIES }),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** The scan's finished_at. */
    observedAt: text('observed_at').notNull(),
  },
  (t) => [
    uniqueIndex('observations_node_scan_uq').on(t.nodeId, t.scanId),
    index('observations_scan_idx').on(t.scanId),
    check('observations_severity_ck', oneOf(t.severity, SEVERITIES)),
    check('observations_role_ck', oneOf(t.role, OBSERVATION_ROLES)),
  ],
);

// --- scope guard (docs/architecture.md §10) ---------------------------------------------------------

/** What tools may be pointed at. Rules are never deleted: removing one sets `removed_at` (the log points at it). */
export const scopeRules = sqliteTable(
  'scope_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: SCOPE_KINDS }).notNull(),
    /** Normalized with normalizeScopeRule (shared/src/scope.ts). */
    value: text('value').notNull(),
    action: text('action', { enum: SCOPE_ACTIONS }).notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    removedAt: text('removed_at'),
  },
  (t) => [
    // One active rule per (kind, value, action); a removed one can be added again.
    uniqueIndex('scope_rules_active_uq')
      .on(t.kind, t.value, t.action)
      .where(sql`${t.removedAt} IS NULL`),
    check('scope_rules_kind_ck', oneOf(t.kind, SCOPE_KINDS)),
    check('scope_rules_action_ck', oneOf(t.action, SCOPE_ACTIONS)),
  ],
);

/** Every scope decision anyone asked for: the test box (`check`) and everything authorize() let run or refused (`run`). */
export const scopeLog = sqliteTable(
  'scope_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: SCOPE_SOURCES }).notNull(),
    targetType: text('target_type', { enum: NODE_TYPES }).notNull(),
    /** As it was asked, before normalization. */
    targetValue: text('target_value').notNull(),
    mode: text('mode', { enum: SCOPE_MODES }).notNull(),
    decision: text('decision', { enum: SCOPE_DECISIONS }).notNull(),
    ruleId: integer('rule_id').references(() => scopeRules.id),
    reason: text('reason').notNull(),
    at: text('at').notNull(),
  },
  (t) => [
    index('scope_log_source_at_idx').on(t.source, t.at),
    check('scope_log_source_ck', oneOf(t.source, SCOPE_SOURCES)),
    check('scope_log_target_type_ck', oneOf(t.targetType, NODE_TYPES)),
    check('scope_log_mode_ck', oneOf(t.mode, SCOPE_MODES)),
    check('scope_log_decision_ck', oneOf(t.decision, SCOPE_DECISIONS)),
  ],
);

/** One row (id = 1), created by the migration. */
export const scopeSettings = sqliteTable(
  'scope_settings',
  {
    id: integer('id').primaryKey(),
    passiveOnly: integer('passive_only', { mode: 'boolean' }).notNull().default(true),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [check('scope_settings_single_row_ck', sql`${t.id} = 1`)],
);
