// Zod schemas for the HTTP API (docs/architecture.md §6–7): query strings, request bodies and responses.
// The server parses every input with these; tests parse every response with them.
import { z } from 'zod';
import {
  CONFIDENCE_LEVELS,
  DELETION_KINDS,
  DELETION_MODES,
  EDGE_CONFIDENCE_LEVELS,
  NODE_TYPES,
  OBSERVATION_ROLES,
  RELATIONS,
  RELATION_TYPES,
  SCAN_STATUSES,
  SEVERITIES,
  TAGS,
} from './enums';
import type { NodeType, Relation } from './enums';
import { SCOPE_ACTIONS, SCOPE_DECISIONS, SCOPE_KINDS, SCOPE_MODES, SCOPE_SOURCES, TARGETABLE_TYPES } from './scope';
import { JOB_STATUSES, TOOL_MODES } from './tools';

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
  /** Scope decision in passive mode (`inScope` on every node). */
  scope: list(z.enum(SCOPE_DECISIONS)).optional(),
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

/** GET /highlights takes no params: it lists every `interesting` node whatever the graph filters are. */
export const highlightsQuerySchema = z.strictObject({});

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
  /** The scope decision for this node in passive mode, computed when the graph is read (never stored). */
  inScope: z.enum(SCOPE_DECISIONS),
  posX: z.number().nullable(),
  posY: z.number().nullable(),
  firstSeen: timestamp,
  lastSeen: timestamp,
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

/** Members shown per page when a group is expanded (and per "load more"). */
export const GROUP_PAGE_SIZE = 100;
/** Parentless nodes of one type are shown as they are up to this many, and grouped above it. */
export const ROOT_GROUP_THRESHOLD = 25;

/**
 * A group (docs/architecture.md §7): the children of one parent with the same relation and type, when there are
 * two or more (or, for parentless nodes, more than ROOT_GROUP_THRESHOLD of one type). It stays on the canvas as
 * the members' parent whether it is collapsed or expanded.
 */
export const aggregateNodeSchema = z.strictObject({
  id: z.string().startsWith('agg:'),
  type: z.literal('aggregate'),
  /** `12 subdomains`. */
  label: z.string(),
  /** All members of the group under the current filters. */
  count: z.number().int().min(1),
  childType: z.enum(NODE_TYPES),
  relation: z.enum(RELATION_TYPES).nullable(),
  parentId: z.string().nullable(),
  /** Highest effective severity among the members. */
  maxSeverity: severity,
  /**
   * Distinct nodes with their own severity high or critical at or below the members (each counted once, however
   * many paths reach it), so a collapsed group never hides a serious finding without a signal.
   */
  risk: z.strictObject({ critical: z.number().int().min(0), high: z.number().int().min(0) }),
  /** Open: its members (the loaded pages, plus pinned ones) hang under it. */
  expanded: z.boolean(),
  /** Members drawn under this group. */
  shown: z.number().int().min(0),
  /** Members not drawn under it (`count - shown`). */
  remaining: z.number().int().min(0),
  /** The next page (the first one, while collapsed) fits in the element budget. */
  canLoadMore: z.boolean(),
});
export type AggregateNode = z.infer<typeof aggregateNodeSchema>;

/** "+300 more": hangs under an expanded group that has members not loaded yet; double-click loads a page. */
export const moreNodeSchema = z.strictObject({
  id: z.string().startsWith('more:'),
  type: z.literal('more'),
  groupId: z.string(),
  label: z.string(),
  remaining: z.number().int().min(1),
});
export type MoreNode = z.infer<typeof moreNodeSchema>;

/** Computed from the edge's observations: distinct tools that reported the relation (1 → discovered, 2+ → corroborated). */
const edgeSourceCount = z.number().int().min(0);
const edgeConfidence = z.enum(EDGE_CONFIDENCE_LEVELS);

export const graphEdgeSchema = z.strictObject({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  relation: z.enum(RELATION_TYPES),
  sourceCount: edgeSourceCount,
  confidence: edgeConfidence,
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/**
 * What an edge on the canvas stands for. `relation`: a real edge (a parent's only child of that kind);
 * `group`: parent → group, carrying the relation; `member`: group → member (plain); `more`: group → its "more"
 * node; `neighbor`: a real edge drawn because the analyst expanded a node's neighbors.
 */
export const VIEW_EDGE_KINDS = ['relation', 'group', 'member', 'more', 'neighbor'] as const;
export type ViewEdgeKind = (typeof VIEW_EDGE_KINDS)[number];

export const viewEdgeSchema = z.strictObject({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /** Null on `member` and `more` edges. */
  relation: z.enum(RELATION_TYPES).nullable(),
  kind: z.enum(VIEW_EDGE_KINDS),
  /**
   * The real edge this one stands for: itself on `relation` and `neighbor` edges, parent → member on `member` edges
   * (GET /edges/:id takes it); null on `group` and `more` edges.
   */
  edgeId: z.string().nullable(),
  /** That real edge's provenance (same nulls as `edgeId`). */
  sourceCount: edgeSourceCount.nullable(),
  confidence: edgeConfidence.nullable(),
  /**
   * On `group` edges only (null elsewhere): every tool that reported any of the group's member edges (sorted), and
   * how many member edges that is (one per member, under the current filters).
   */
  tools: z.array(z.string()).nullable(),
  edgeCount: z.number().int().min(0).nullable(),
});
export type ViewEdge = z.infer<typeof viewEdgeSchema>;

export type ViewNode = GraphNode | AggregateNode | MoreNode;

const nodeIdText = z.string().min(1).max(200);

/** One open group: `pages` × GROUP_PAGE_SIZE members, riskiest first, plus `pins` (members opened on purpose). */
export const groupOpenSchema = z.strictObject({
  id: z.string().startsWith('agg:').max(200),
  pages: z.number().int().min(0).max(50),
  pins: z.array(nodeIdText).max(100),
});
export type GroupOpen = z.infer<typeof groupOpenSchema>;

/** The analyst's view of the graph: which groups are open, and whose neighbors are expanded. */
export const viewStateSchema = z.strictObject({
  expand: z.array(groupOpenSchema).max(2000),
  /** Nodes whose parents are all drawn, with their edges (the only way to see a shared node's other parents). */
  neighbors: z.array(nodeIdText).max(200),
});
export type ViewState = z.infer<typeof viewStateSchema>;

export const graphViewRequestSchema = z.strictObject({
  filters: graphFiltersSchema.prefault({}),
  expand: viewStateSchema.shape.expand.default([]),
  neighbors: viewStateSchema.shape.neighbors.default([]),
  /** One-shot: open every group below these nodes, as far as the element budget allows. */
  expandAll: z.array(nodeIdText).max(10).default([]),
  /**
   * What the canvas showed directly before this request: `relation` edges (a parent's only child of that kind) and
   * parentless nodes. A collapsed group that now holds one of them (a live update turned 1 child into 2) is opened,
   * so nothing the analyst is looking at disappears when a scan finishes.
   */
  keep: z
    .strictObject({
      edges: z.array(nodeIdText).max(5000).default([]),
      roots: z.array(nodeIdText).max(5000).default([]),
    })
    .prefault({}),
});
export type GraphViewRequest = z.input<typeof graphViewRequestSchema>;
export type GraphViewInput = z.output<typeof graphViewRequestSchema>;

export const graphResponseSchema = z.strictObject({
  nodes: z.array(z.union([graphNodeSchema, aggregateNodeSchema, moreNodeSchema])),
  edges: z.array(viewEdgeSchema),
  /** True when something asked for didn't fit in the element budget, or the result had to be cut. */
  truncated: z.boolean(),
  /** Size of the filtered graph before grouping. */
  totals: z.strictObject({ nodes: z.number().int(), edges: z.number().int() }),
  /**
   * The view as applied: open groups that are on the canvas (pins limited to real members), and neighbor
   * expansions whose node is shown. Anything asked for that isn't here was dropped (collapsed above, gone under
   * these filters, or over budget); the client adopts this as its state.
   */
  state: viewStateSchema,
  /** Groups (or `neighbors:<id>`) refused, or loaded with fewer pages, to stay within the element budget. */
  overBudget: z.array(z.string()),
  /** Groups opened because they hold something the canvas showed directly (see `keep`). */
  autoOpened: z.array(z.string()),
  /** Such groups that couldn't be opened within the budget: folded instead (the UI flashes them). */
  autoFolded: z.array(z.string()),
  /** Per `expandAll` node: groups it opened, and nodes below it still not on the canvas. */
  expandAll: z.array(
    z.strictObject({ nodeId: z.string(), opened: z.number().int().min(0), hidden: z.number().int().min(0) }),
  ),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;

export const neighborsResponseSchema = graphResponseSchema.extend({ center: z.string() });

/** The groups to open (as pins) so that a node deep inside collapsed groups is drawn: GET /graph/path/:nodeId. */
export const graphPathResponseSchema = z.strictObject({
  nodeId: z.string(),
  /** False when the current filters exclude the node: no path can show it. */
  inView: z.boolean(),
  /** From the root down; groups of one aren't groups, so they need no step. */
  steps: z.array(z.strictObject({ groupId: z.string(), memberId: z.string() })),
});
export type GraphPathResponse = z.infer<typeof graphPathResponseSchema>;

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

// --- scope (docs/architecture.md §10) --------------------------------------------------------------

export const scopeRuleSchema = z.strictObject({
  id: z.number().int().min(1),
  kind: z.enum(SCOPE_KINDS),
  /** Normalized: punycode, lowercase, canonical IP/CIDR text. */
  value: z.string(),
  action: z.enum(SCOPE_ACTIONS),
  note: z.string(),
  createdAt: timestamp,
  /** Set when the rule is removed. Removed rules are kept (the log still points at them) and never match. */
  removedAt: timestamp.nullable(),
});
export type ScopeRule = z.infer<typeof scopeRuleSchema>;

export const SCOPE_NOTE_MAX = 1000;

export const scopeRuleCreateSchema = z.strictObject({
  kind: z.enum(SCOPE_KINDS),
  /** Normalized and checked by the server (normalizeScopeRule); a refusal is a 400 saying why. */
  value: z.string().min(1).max(300),
  action: z.enum(SCOPE_ACTIONS),
  note: z.string().max(SCOPE_NOTE_MAX).default(''),
});

/** Kind, value and action never change: remove the rule and add another. Removing is one-way. */
export const scopeRulePatchSchema = z
  .strictObject({ note: z.string().max(SCOPE_NOTE_MAX).optional(), removed: z.literal(true).optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to update' });

export const scopeRulesQuerySchema = z.strictObject({
  /** `1` also lists removed rules. */
  removed: z.enum(['0', '1']).default('0'),
});

export const scopeRulesResponseSchema = z.strictObject({ rules: z.array(scopeRuleSchema) });

export const scopeCheckInputSchema = z.strictObject({
  type: z.enum(NODE_TYPES),
  value: z.string().trim().min(1).max(2000),
  mode: z.enum(SCOPE_MODES).default('passive'),
});

export const scopeResultSchema = z.strictObject({
  decision: z.enum(SCOPE_DECISIONS),
  reason: z.string(),
  /** The rule that decided it, if one did. */
  rule: scopeRuleSchema.nullable(),
});
export type ScopeResultResponse = z.infer<typeof scopeResultSchema>;

export const scopeCheckResponseSchema = scopeResultSchema.extend({
  type: z.enum(NODE_TYPES),
  value: z.string(),
  mode: z.enum(SCOPE_MODES),
  /** The log row, for POST /scope/check; null for GET (not logged). */
  logId: z.number().int().nullable(),
});
export type ScopeCheckResponse = z.infer<typeof scopeCheckResponseSchema>;

export const SCOPE_LOG_PAGE_SIZE = { default: 50, max: 200 } as const;

export const scopeLogQuerySchema = z.strictObject({
  page: positiveInt.default(1),
  pageSize: positiveInt.max(SCOPE_LOG_PAGE_SIZE.max).default(SCOPE_LOG_PAGE_SIZE.default),
  /** Which entries: `run` (the default) is what was authorized to run; add `check` for the test box. */
  source: list(z.enum(SCOPE_SOURCES)).prefault('run'),
});

export const scopeLogEntrySchema = z.strictObject({
  id: z.number().int(),
  source: z.enum(SCOPE_SOURCES),
  targetType: z.enum(NODE_TYPES),
  /** As it was asked, before normalization. */
  targetValue: z.string(),
  mode: z.enum(SCOPE_MODES),
  decision: z.enum(SCOPE_DECISIONS),
  /** The deciding rule as it is now (it may have been removed since). */
  rule: scopeRuleSchema.nullable(),
  reason: z.string(),
  at: timestamp,
});
export type ScopeLogEntry = z.infer<typeof scopeLogEntrySchema>;

export const scopeLogResponseSchema = z.strictObject({
  items: z.array(scopeLogEntrySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const scopeSettingsSchema = z.strictObject({
  /** On (the default): every active check is out of scope. */
  passiveOnly: z.boolean(),
  updatedAt: timestamp,
});
export type ScopeSettings = z.infer<typeof scopeSettingsSchema>;

export const scopeSettingsPatchSchema = z.strictObject({ passiveOnly: z.boolean() });

const nodeRef = graphNodeSchema.pick({ id: true, type: true, value: true, label: true, severity: true, confidence: true });

export const nodeDetailSchema = graphNodeSchema.extend({
  data: z.record(z.string(), z.unknown()),
  notes: z.string(),
});
export type NodeDetail = z.infer<typeof nodeDetailSchema>;

export const nodeDetailResponseSchema = z.strictObject({
  node: nodeDetailSchema,
  /** The passive-mode decision behind `node.inScope`, with the rule that made it. */
  scope: scopeResultSchema,
  edges: z.array(
    z.strictObject({
      id: z.string(),
      relation: z.enum(RELATION_TYPES),
      direction: z.enum(['in', 'out']),
      other: nodeRef,
      sourceCount: edgeSourceCount,
      confidence: edgeConfidence,
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
      /** The job whose run produced the scan (its raw output); null for an uploaded file. */
      jobId: z.number().int().nullable(),
    }),
  ),
});

const edgeEnd = graphNodeSchema.pick({ id: true, type: true, label: true });

/** GET /edges/:id: the relation, both ends, derived fields and every scan that reported it. */
export const edgeDetailResponseSchema = z.strictObject({
  edge: z.strictObject({
    id: z.string(),
    relation: z.enum(RELATION_TYPES),
    /** The parent. */
    source: edgeEnd,
    /** The child. */
    target: edgeEnd,
    sourceCount: edgeSourceCount,
    confidence: edgeConfidence,
    firstSeen: timestamp,
    lastSeen: timestamp,
  }),
  /** Provenance: every scan that reported this relation, oldest first. */
  observations: z.array(
    z.strictObject({
      scanId: z.string(),
      tool: z.string(),
      command: z.string(),
      data: z.record(z.string(), z.unknown()),
      observedAt: timestamp,
      jobId: z.number().int().nullable(),
    }),
  ),
});
export type EdgeDetailResponse = z.infer<typeof edgeDetailResponseSchema>;

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

/** `skipped`: IDs of nodes that no longer exist (deleted meanwhile, e.g. from another tab); the rest are saved. */
export const layoutResponseSchema = z.strictObject({ updated: z.number().int(), skipped: z.array(z.string()) });

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
  byScope: countsBy(SCOPE_DECISIONS),
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
  /** The job that produced it; null for an uploaded file. */
  jobId: z.number().int().nullable(),
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
    edgeObservations: z.number().int(),
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
  edgeObservations: z.array(
    z.strictObject({
      edgeId: z.string(),
      scanId: z.string(),
      tool: z.string(),
      data: z.record(z.string(), z.unknown()),
      observedAt: timestamp,
    }),
  ),
});

// --- tool runs (docs/architecture.md §11) ------------------------------------------------------------

export const IMAGE_STATUSES = ['built', 'outdated', 'missing', 'unknown'] as const;
export type ImageStatus = (typeof IMAGE_STATUSES)[number];

export const toolInfoSchema = z.strictObject({
  name: z.string(),
  group: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  mode: z.enum(TOOL_MODES),
  /** Node types it can be pointed at. */
  accepts: z.array(z.enum(TARGETABLE_TYPES)),
  /** Outside services it contacts. */
  external: z.array(z.string()),
  timeoutSec: z.number().int(),
});
export type ToolInfo = z.infer<typeof toolInfoSchema>;

export const toolGroupInfoSchema = z.strictObject({
  name: z.string(),
  label: z.string(),
  /** repo:tag of the image the current scripts make. */
  image: z.string(),
  /** built = that exact image exists; outdated = only an older build; unknown = Docker not reachable. */
  imageStatus: z.enum(IMAGE_STATUSES),
  /** Its tools, in run order. */
  tools: z.array(z.string()),
});
export type ToolGroupInfo = z.infer<typeof toolGroupInfoSchema>;

export const toolsResponseSchema = z.strictObject({ groups: z.array(toolGroupInfoSchema), tools: z.array(toolInfoSchema) });
export type ToolsResponse = z.infer<typeof toolsResponseSchema>;

export const jobSchema = z.strictObject({
  id: z.number().int(),
  tool: z.string(),
  group: z.string(),
  /** Null once the analyst deleted the target node ("node deleted"); targetType/targetValue still say what it was. */
  nodeId: z.string().nullable(),
  targetType: z.enum(NODE_TYPES),
  targetValue: z.string(),
  mode: z.enum(TOOL_MODES),
  status: z.enum(JOB_STATUSES),
  /** scope_log rows: the decision at queueing, and the one right before the container started. */
  queuedScopeLogId: z.number().int(),
  scopeLogId: z.number().int().nullable(),
  /** The command as run. */
  argv: z.array(z.string()).nullable(),
  image: z.string().nullable(),
  timeoutSec: z.number().int(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Why result.json was rejected (validation issues). */
  issues: z.array(z.string()).nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  scanId: z.string().nullable(),
  /** Nodes the scan created, and existing nodes it touched ("+14 new, 6 updated"). */
  nodesCreated: z.number().int().nullable(),
  nodesUpdated: z.number().int().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const JOB_PAGE_SIZE = { default: 50, max: 200 } as const;

export const jobsQuerySchema = z.strictObject({
  page: positiveInt.default(1),
  pageSize: positiveInt.max(JOB_PAGE_SIZE.max).default(JOB_PAGE_SIZE.default),
  status: list(z.enum(JOB_STATUSES)).optional(),
  nodeId: z.string().min(1).optional(),
});

export const jobsResponseSchema = z.strictObject({
  items: z.array(jobSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type JobsResponse = z.infer<typeof jobsResponseSchema>;

export const JOB_OUTPUT_STREAMS = ['stdout', 'stderr', 'raw'] as const;
export type JobOutputStream = (typeof JOB_OUTPUT_STREAMS)[number];

export const jobDetailResponseSchema = z.strictObject({
  job: jobSchema,
  /** The last few KB of each kept output (null: there is none). */
  tails: z.strictObject({ stdout: z.string().nullable(), stderr: z.string().nullable(), raw: z.string().nullable() }),
});
export type JobDetailResponse = z.infer<typeof jobDetailResponseSchema>;

export const jobCreateSchema = z.strictObject({ tool: z.string().min(1), nodeId: z.string().min(1) });
export const groupJobCreateSchema = z.strictObject({ group: z.string().min(1), nodeId: z.string().min(1) });
export const jobsCreatedResponseSchema = z.strictObject({ jobs: z.array(jobSchema) });

/** 403: the scope guard refused the run. The jobs are stored as `refused`. */
export const jobRefusedResponseSchema = z.strictObject({
  error: z.string(),
  decision: z.enum(SCOPE_DECISIONS),
  jobs: z.array(jobSchema),
});

export const runnerStatusSchema = z.strictObject({
  docker: z.strictObject({ reachable: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }),
  images: z.array(z.strictObject({ group: z.string(), image: z.string(), status: z.enum(IMAGE_STATUSES) })),
  running: z.number().int(),
  queued: z.number().int(),
  maxConcurrent: z.number().int(),
});
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

// --- graph editing: adding nodes by hand ------------------------------------------------------------

export const MANUAL_EXISTS_ACTIONS = ['return', 'link'] as const;

/**
 * POST /nodes: the value is checked by the contract validator's rules (a 422 in its wording), then goes through
 * ingest as a scan by tool `manual`. `x`/`y`: the saved position (both or neither).
 */
export const manualNodeSchema = z
  .strictObject({
    type: z.enum(NODE_TYPES),
    value: z.string().max(2000),
    label: z.string().trim().max(500).optional(),
    parentId: z.string().min(1).max(200).optional(),
    relation: z.enum(RELATION_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    tag: z.enum(TAGS).optional(),
    notes: z.string().max(100_000).optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
    /** The value already exists: `return` its ID (nothing written), or `link` it under `parentId`. */
    ifExists: z.enum(MANUAL_EXISTS_ACTIONS).default('return'),
  })
  .refine((b) => (b.x === undefined) === (b.y === undefined), { message: 'give both x and y, or neither', path: ['x'] })
  .refine((b) => b.relation === undefined || b.parentId !== undefined, { message: "has 'relation' but no 'parentId'", path: ['relation'] });
export type ManualNodeInput = z.input<typeof manualNodeSchema>;

export const manualNodeResponseSchema = z.strictObject({
  id: z.string(),
  /** False: the value was already in the graph (201 vs 200). */
  created: z.boolean(),
  /** With `ifExists: link`: the parent → node edge was added (false if it was already there). */
  linked: z.boolean(),
  /** The validator's warnings for this finding, e.g. "vulnerability has no severity". */
  warnings: z.array(z.string()),
});
export type ManualNodeResponse = z.infer<typeof manualNodeResponseSchema>;

// --- graph editing: deleting nodes ------------------------------------------------------------------

/**
 * GET /nodes/:id/delete-preview takes the graph filters: they only matter for a group, whose members are the ones
 * the filters keep (every one, not only the pages on the canvas).
 */
export const deletePreviewQuerySchema = graphFiltersSchema;

export const deleteQuerySchema = graphFiltersSchema.extend({
  mode: z.enum(DELETION_MODES),
  /** The node count the analyst confirmed; if the graph changed since the preview, a 409 instead. */
  expect: z.coerce.number().int().min(0).optional(),
  /** `1`: cancel the running jobs on the nodes being deleted, wait for them to stop, then delete. */
  cancelJobs: z.enum(['0', '1']).default('0'),
});

const deletionCountsSchema = z.strictObject({
  /** Nodes removed. */
  nodes: z.number().int().min(0),
  /** Edges removed (every edge touching a removed node). */
  edges: z.number().int().min(0),
  /** Nodes left with no parent, which become roots. */
  orphans: z.number().int().min(0),
  /** Nodes below that stay because they also hang under a node that isn't deleted (always 0 in `node` mode). */
  keptShared: z.number().int().min(0),
  /** Running jobs on removed nodes: the delete is refused while any is running. */
  runningJobs: z.array(jobSchema),
  /** Queued jobs on removed nodes, cancelled by the delete. */
  queuedJobs: z.number().int().min(0),
});

export const deletePreviewSchema = z.strictObject({
  target: z.strictObject({
    kind: z.enum(DELETION_KINDS),
    id: z.string(),
    /** The node's type; a group's member type. */
    type: z.enum(NODE_TYPES),
    label: z.string(),
    /** A group's members the filters keep: these are deleted (1 for a node). */
    members: z.number().int().min(0),
    /** A group's members the filters hide: kept (0 for a node). */
    hiddenByFilters: z.number().int().min(0),
  }),
  node: deletionCountsSchema,
  subtree: deletionCountsSchema,
});
export type DeletePreview = z.infer<typeof deletePreviewSchema>;

export const deleteResponseSchema = z.strictObject({
  deletionId: z.number().int(),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  /** Jobs that were queued on removed nodes, now cancelled. */
  cancelledJobs: z.array(z.number().int()),
});
export type DeleteResponse = z.infer<typeof deleteResponseSchema>;

/** 409: a job is running on a node being deleted, or the graph changed since the preview (`expect`). */
export const deleteConflictSchema = z.strictObject({
  error: z.string(),
  reason: z.enum(['jobs-running', 'changed']),
  preview: deletePreviewSchema,
});

export const deletionSchema = z.strictObject({
  id: z.number().int(),
  at: timestamp,
  kind: z.enum(DELETION_KINDS),
  mode: z.enum(DELETION_MODES),
  rootType: z.enum(NODE_TYPES),
  rootValue: z.string(),
  rootLabel: z.string(),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  removed: z.array(z.strictObject({ type: z.enum(NODE_TYPES), value: z.string() })),
});
export type Deletion = z.infer<typeof deletionSchema>;

export const DELETION_PAGE_SIZE = { default: 20, max: 100 } as const;
export const deletionsQuerySchema = z.strictObject({
  page: positiveInt.default(1),
  pageSize: positiveInt.max(DELETION_PAGE_SIZE.max).default(DELETION_PAGE_SIZE.default),
});
export const deletionsResponseSchema = z.strictObject({
  items: z.array(deletionSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type DeletionsResponse = z.infer<typeof deletionsResponseSchema>;

export const errorResponseSchema = z.strictObject({
  error: z.string(),
  issues: z.array(z.string()).optional(),
});

export const wsEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('graph.updated'), nodeIds: z.array(z.string()), edgeIds: z.array(z.string()) }),
  z.strictObject({ type: z.literal('scan.ingested'), scanId: z.string(), tool: z.string() }),
  /** The analyst deleted these nodes and edges (DELETE /nodes/:id). */
  z.strictObject({ type: z.literal('graph.deleted'), nodeIds: z.array(z.string()), edgeIds: z.array(z.string()) }),
  /** A scope rule or setting changed: every node's `inScope` may be different. */
  z.strictObject({ type: z.literal('scope.changed') }),
  /** A job was queued, started, finished, cancelled or refused. */
  z.strictObject({ type: z.literal('job.updated'), job: jobSchema }),
  /** Docker became reachable or unreachable. */
  z.strictObject({ type: z.literal('runner.status'), reachable: z.boolean(), error: z.string().nullable() }),
]);
export type WsEvent = z.infer<typeof wsEventSchema>;
