// Zod schemas for the HTTP API (docs/architecture.md §6–7): query strings, request bodies and responses.
// The server parses every input with these; tests parse every response with them.
import { z } from 'zod';
import {
  CONFIDENCE_LEVELS,
  NODE_TYPES,
  OBSERVATION_ROLES,
  RELATIONS,
  RELATION_TYPES,
  SCAN_STATUSES,
  SEVERITIES,
  TAGS,
} from './enums';
import type { NodeType, Relation } from './enums';

// --- aggregate IDs ---------------------------------------------------------------------------------

/** Children of one parent with the same relation and type: `agg:<parentId>:<relation>:<childType>`. */
export type AggregateKey =
  | { parentId: string; relation: Relation; childType: NodeType }
  | { parentId: null; relation: null; childType: NodeType };

/** `agg:<parentId>:<relation>:<childType>`, or `agg:root:<childType>` for parentless nodes. */
export function aggregateId(key: AggregateKey): string {
  return key.parentId === null
    ? `agg:root:${key.childType}`
    : `agg:${key.parentId}:${key.relation}:${key.childType}`;
}

const AGG_RE = /^agg:([0-9a-f]{16}):([a-z_]+):([a-z]+)$/;
const ROOT_AGG_RE = /^agg:root:([a-z]+)$/;

function isNodeType(v: string | undefined): v is NodeType {
  return (NODE_TYPES as readonly string[]).includes(v ?? '');
}
function isRelation(v: string | undefined): v is Relation {
  return (RELATION_TYPES as readonly string[]).includes(v ?? '');
}

/** Parses an aggregate ID. Doesn't check that the parent exists or that its type fits the relation. */
export function parseAggregateId(id: string): AggregateKey | { error: string } {
  const root = ROOT_AGG_RE.exec(id);
  if (root) {
    return isNodeType(root[1]) ? { parentId: null, relation: null, childType: root[1] } : { error: `unknown node type in '${id}'` };
  }
  const m = AGG_RE.exec(id);
  if (!m) return { error: `'${id}' is not an aggregate ID (agg:<parentId>:<relation>:<childType>)` };
  const [, parentId = '', relation, childType] = m;
  if (!isRelation(relation)) return { error: `unknown relation in '${id}'` };
  if (!isNodeType(childType)) return { error: `unknown node type in '${id}'` };
  if (!RELATIONS[relation].children.includes(childType)) {
    return { error: `'${relation}' never links to ${childType}` };
  }
  return { parentId, relation, childType };
}

// --- query strings ---------------------------------------------------------------------------------

/** `a,b` or repeated `?x=a&x=b`, as a de-duplicated non-empty list. */
function list<T extends z.ZodType<string, string>>(item: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) => [...new Set((Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).map((s) => s.trim()))])
    .pipe(z.array(item).min(1));
}

const positiveInt = z.coerce.number().int().min(1);

export const graphFiltersSchema = z.strictObject({
  types: list(z.enum(NODE_TYPES)).optional(),
  /** Compared with effective severity, so the path down to a finding stays in the result. */
  minSeverity: z.enum(SEVERITIES).optional(),
  confidence: list(z.enum(CONFIDENCE_LEVELS)).optional(),
  tool: list(z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, 'tool names are lowercase')).optional(),
  tag: list(z.enum(TAGS)).optional(),
  excludeTag: list(z.enum(TAGS)).optional(),
  /** Case-insensitive substring of value or label. */
  q: z.string().trim().min(1).max(200).optional(),
});
export type GraphFilters = z.infer<typeof graphFiltersSchema>;

/** The `q` rule, shared so the UI can tell search matches from the path nodes kept above them. */
export function matchesQuery(node: { value: string; label: string }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return node.value.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle);
}

export const EXPAND_PAGE_SIZE = { default: 200, max: 500 } as const;
export const expandQuerySchema = graphFiltersSchema.extend({
  page: positiveInt.default(1),
  pageSize: positiveInt.max(EXPAND_PAGE_SIZE.max).default(EXPAND_PAGE_SIZE.default),
});

export const neighborsQuerySchema = z.strictObject({
  depth: z.coerce.number().int().min(1).max(3).default(1),
});

export const NODE_SORT_FIELDS = [
  'effectiveSeverity',
  'severity',
  'label',
  'value',
  'type',
  'confidence',
  'sourceCount',
  'firstSeen',
  'lastSeen',
] as const;
export type NodeSortField = (typeof NODE_SORT_FIELDS)[number];
export type NodeSort = { field: NodeSortField; desc: boolean }[];

export const DEFAULT_NODE_SORT = '-effectiveSeverity,label';
export const NODE_PAGE_SIZE = { default: 50, max: 500 } as const;

const sortSchema = z
  .string()
  .transform((s) => s.split(',').map((part) => part.trim()))
  .pipe(
    z.array(
      z
        .string()
        .transform((part) => ({ field: part.replace(/^-/, ''), desc: part.startsWith('-') }))
        .pipe(z.object({ field: z.enum(NODE_SORT_FIELDS), desc: z.boolean() })),
    ),
  );

export const nodeListQuerySchema = graphFiltersSchema.extend({
  page: positiveInt.default(1),
  pageSize: positiveInt.max(NODE_PAGE_SIZE.max).default(NODE_PAGE_SIZE.default),
  sort: sortSchema.prefault(DEFAULT_NODE_SORT),
  /** Return the page that holds this node instead of `page` (table ↔ graph sync). Ignored if it isn't listed. */
  at: z.string().min(1).max(200).optional(),
});

export const exportQuerySchema = z.strictObject({ format: z.literal('json').default('json') });

// --- request bodies --------------------------------------------------------------------------------

// z.number() rejects Infinity and NaN in Zod 4.
const coordinate = z.number();

export const nodePatchSchema = z
  .strictObject({
    tag: z.enum(TAGS).nullable().optional(),
    notes: z.string().max(100_000).optional(),
    /** Only the analyst sets `verified`; it is never set back automatically. */
    confidence: z.literal('verified').optional(),
    posX: coordinate.nullable().optional(),
    posY: coordinate.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to update' });
export type NodePatch = z.infer<typeof nodePatchSchema>;

export const MAX_LAYOUT_POSITIONS = 5000;
export const layoutBodySchema = z
  .strictObject({
    positions: z
      .array(z.strictObject({ id: z.string().min(1), x: coordinate, y: coordinate }))
      .max(MAX_LAYOUT_POSITIONS),
  })
  .superRefine(({ positions }, ctx) => {
    const seen = new Set<string>();
    positions.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: 'custom', path: ['positions', i, 'id'], message: `duplicate id '${p.id}'` });
      seen.add(p.id);
    });
  });

// --- responses -------------------------------------------------------------------------------------

const severity = z.enum(SEVERITIES).nullable();
const timestamp = z.iso.datetime();

export const graphNodeSchema = z.strictObject({
  id: z.string(),
  type: z.enum(NODE_TYPES),
  value: z.string(),
  label: z.string(),
  severity,
  /** Highest severity of this node and everything below it. */
  effectiveSeverity: severity,
  confidence: z.enum(CONFIDENCE_LEVELS),
  sourceCount: z.number().int().min(0),
  tag: z.enum(TAGS).nullable(),
  posX: z.number().nullable(),
  posY: z.number().nullable(),
  firstSeen: timestamp,
  lastSeen: timestamp,
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const aggregateNodeSchema = z.strictObject({
  id: z.string().startsWith('agg:'),
  type: z.literal('aggregate'),
  label: z.string(),
  /** Members hidden inside the aggregate. */
  count: z.number().int().min(1),
  /** All members of the group, including the ones that stay visible. */
  total: z.number().int().min(1),
  childType: z.enum(NODE_TYPES),
  relation: z.enum(RELATION_TYPES).nullable(),
  parentId: z.string().nullable(),
  /** Highest effective severity among all members. */
  maxSeverity: severity,
});
export type AggregateNode = z.infer<typeof aggregateNodeSchema>;

export const graphEdgeSchema = z.strictObject({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  relation: z.enum(RELATION_TYPES),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphResponseSchema = z.strictObject({
  nodes: z.array(z.union([graphNodeSchema, aggregateNodeSchema])),
  edges: z.array(graphEdgeSchema),
  /** True when the server had to aggregate harder than the normal threshold, or cut the result. */
  truncated: z.boolean(),
  /** The aggregation threshold that was used. */
  threshold: z.number().int(),
  /** Size of the filtered graph before aggregation. */
  totals: z.strictObject({ nodes: z.number().int(), edges: z.number().int() }),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;

export const neighborsResponseSchema = graphResponseSchema.extend({ center: z.string() });

export const expandResponseSchema = z.strictObject({
  aggregate: z.strictObject({
    id: z.string(),
    parentId: z.string().nullable(),
    relation: z.enum(RELATION_TYPES).nullable(),
    childType: z.enum(NODE_TYPES),
  }),
  /** Riskiest first (effective severity), then by value. */
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

const nodeRef = graphNodeSchema.pick({ id: true, type: true, value: true, label: true, severity: true, confidence: true });

export const nodeDetailSchema = graphNodeSchema.extend({
  data: z.record(z.string(), z.unknown()),
  notes: z.string(),
});
export type NodeDetail = z.infer<typeof nodeDetailSchema>;

export const nodeDetailResponseSchema = z.strictObject({
  node: nodeDetailSchema,
  edges: z.array(
    z.strictObject({
      id: z.string(),
      relation: z.enum(RELATION_TYPES),
      direction: z.enum(['in', 'out']),
      other: nodeRef,
      firstSeen: timestamp,
      lastSeen: timestamp,
    }),
  ),
  /** Provenance: every scan that reported this node, oldest first. */
  observations: z.array(
    z.strictObject({
      scanId: z.string(),
      tool: z.string(),
      command: z.string(),
      role: z.enum(OBSERVATION_ROLES),
      severity,
      data: z.record(z.string(), z.unknown()),
      observedAt: timestamp,
    }),
  ),
});

export const nodeListResponseSchema = z.strictObject({
  items: z.array(graphNodeSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/** A node the analyst tagged `interesting`, with its notes (GET /highlights). */
export const highlightSchema = graphNodeSchema.extend({ notes: z.string() });
export type Highlight = z.infer<typeof highlightSchema>;

/** Every `interesting` node in the workspace, riskiest first. Not filtered, not paged. */
export const highlightsResponseSchema = z.strictObject({ items: z.array(highlightSchema) });

export const layoutResponseSchema = z.strictObject({ updated: z.number().int() });

const countsBy = <const T extends readonly [string, ...string[]]>(keys: T) =>
  z.record(z.enum(keys), z.number().int().min(0));

export const statsResponseSchema = z.strictObject({
  totals: z.strictObject({
    nodes: z.number().int(),
    edges: z.number().int(),
    scans: z.number().int(),
    observations: z.number().int(),
  }),
  byType: countsBy(NODE_TYPES),
  bySeverity: countsBy([...SEVERITIES, 'none']),
  byConfidence: countsBy(CONFIDENCE_LEVELS),
  byTag: countsBy([...TAGS, 'none']),
  byTool: z.record(z.string(), z.number().int().min(0)),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

export const scanSummarySchema = z.strictObject({
  id: z.string(),
  tool: z.string(),
  toolVersion: z.string().nullable(),
  target: z.string(),
  command: z.string(),
  status: z.enum(SCAN_STATUSES),
  errors: z.array(z.string()),
  startedAt: timestamp,
  finishedAt: timestamp,
  ingestedAt: timestamp,
  findingCount: z.number().int(),
  observationCount: z.number().int(),
});
export type ScanSummary = z.infer<typeof scanSummarySchema>;

export const scansResponseSchema = z.strictObject({ scans: z.array(scanSummarySchema) });

export const ingestResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ingested'),
    scanId: z.string(),
    nodeIds: z.array(z.string()),
    edgeIds: z.array(z.string()),
    created: z.strictObject({ nodes: z.number().int(), edges: z.number().int() }),
    observations: z.number().int(),
    warnings: z.array(z.string()),
  }),
  z.strictObject({ status: z.literal('duplicate'), scanId: z.string(), warnings: z.array(z.string()) }),
]);

export const exportResponseSchema = z.strictObject({
  format: z.literal('json'),
  exportedAt: timestamp,
  nodes: z.array(nodeDetailSchema),
  edges: z.array(graphEdgeSchema.extend({ firstSeen: timestamp, lastSeen: timestamp })),
  scans: z.array(scanSummarySchema),
  observations: z.array(
    z.strictObject({
      nodeId: z.string(),
      scanId: z.string(),
      tool: z.string(),
      role: z.enum(OBSERVATION_ROLES),
      severity,
      data: z.record(z.string(), z.unknown()),
      observedAt: timestamp,
    }),
  ),
});

export const errorResponseSchema = z.strictObject({
  error: z.string(),
  issues: z.array(z.string()).optional(),
});

export const wsEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('graph.updated'), nodeIds: z.array(z.string()), edgeIds: z.array(z.string()) }),
  z.strictObject({ type: z.literal('scan.ingested'), scanId: z.string(), tool: z.string() }),
]);
export type WsEvent = z.infer<typeof wsEventSchema>;
