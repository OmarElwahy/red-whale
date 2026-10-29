# RED WHALE — Architecture & Build Plan

Scope of this document: the **data contract, database, API, and graph UI**.
Container orchestration, AI layers, and CVE monitoring come later (see Phase 6+).

## 1. Data flow

```
Python tool scripts ──JSON (docs/contract.md)──▶ Ingest ──▶ SQLite ──▶ Fastify API ──▶ React + Cytoscape
   (tools/*.py)                                  (server)              REST + WebSocket     (web)
```

Until the orchestrator exists, files enter through `pnpm ingest <file.json>` or `POST /api/ingest`.
Later the orchestrator just becomes another producer of the same JSON.

## 2. Packages

| Package | Contains |
|---|---|
| `shared/` | Zod schemas for the tool-output contract and API responses; `normalize.ts` (value normalization); `nodeId.ts` (deterministic IDs); shared enums (node types, relations, severities, confidence, tags) |
| `server/` | Fastify app bound to `127.0.0.1:4100`; Drizzle schema + migrations; ingest pipeline; graph query + aggregation; WebSocket broadcaster; CLI entry for `ingest` and `mock` |
| `web/` | Vite + React app on `127.0.0.1:5173`, proxying `/api` to the server |

## 3. Node identity

```
normalizedValue = normalize(type, value)      // shared/src/normalize.ts
id              = sha256(`${type}:${normalizedValue}`).slice(0, 16)
edgeId          = sha256(`${sourceId}|${relation}|${targetId}`).slice(0, 16)
```

Normalization (must be unit-tested): trim; lowercase domains, subdomains, emails, URL hosts;
strip trailing dots; canonicalize IPs (compress IPv6); drop default ports from URLs (`:443` for https,
`:80` for http); remove URL fragments. The validator rejects most bad values; normalization is the
second safety net.

## 4. Database schema (SQLite, Drizzle)

**scans** — one row per ingested tool-output file
`id` (uuid) · `tool` · `tool_version` · `target` · `command` · `status` · `errors` (json) ·
`started_at` · `finished_at` · `ingested_at` · `file_hash` (unique; makes re-ingesting a file a no-op)

**nodes**
`id` (pk, deterministic) · `type` · `value` (normalized) · `label` (display text) ·
`severity` (nullable; highest seen) · `confidence` (`discovered` | `corroborated` | `verified`) ·
`source_count` (distinct tools) · `data` (json, merged) · `tag` (`interesting` | `checked` | `ignored` | null) ·
`notes` (markdown) · `pos_x`, `pos_y` (nullable; saved layout) · `first_seen` · `last_seen`
Indexes: `type`, `severity`, `confidence`, `tag`.

**edges**
`id` (pk, deterministic) · `source_id` → nodes · `target_id` → nodes · `relation` · `first_seen` · `last_seen`
Unique: (`source_id`, `relation`, `target_id`). Indexes on `source_id`, `target_id`.

**observations** — provenance: every time any tool reported a node
`id` · `node_id` → nodes · `scan_id` → scans · `tool` · `data` (json, this tool's details) · `observed_at`
Unique: (`node_id`, `scan_id`).

Confidence rule: after each ingest, recompute `source_count = COUNT(DISTINCT tool)` for touched nodes;
`1 → discovered`, `≥2 → corroborated`; `verified` is only set by the analyst and never downgraded automatically.

## 5. Ingest pipeline

1. Parse file → validate with Zod (reject the whole file with a clear error list on failure).
2. Hash the file; if `scans.file_hash` exists, stop (idempotent).
3. In **one transaction**: insert scan → for each finding, upsert parent node (if any) and child node,
   upsert edge, insert observation → recompute confidence/severity for touched nodes.
4. After commit, broadcast `{ type: "graph.updated", nodeIds, edgeIds }` over WebSocket.

Merging `data`: keep per-tool details in `observations.data`; `nodes.data` holds a shallow merge where
newer values win. Severity = max severity across observations.

## 6. API (all under `/api`, JSON, validated with Zod)

| Method & path | Purpose |
|---|---|
| `GET /graph?types=&minSeverity=&confidence=&tool=&tag=&q=` | Filtered graph, **aggregated** (see §7) |
| `GET /graph/expand/:aggregateId` | Members of an aggregate node (paged) |
| `GET /graph/neighbors/:nodeId?depth=1` | Neighborhood for focus mode / expanding a node |
| `GET /nodes/:id` | Node detail + edges + all observations (provenance) |
| `PATCH /nodes/:id` | Update `tag`, `notes`, `confidence: "verified"`, `pos_x/pos_y` |
| `PUT /layout` | Bulk-save node positions |
| `GET /nodes?…&page=&sort=` | Paged flat list for the table view |
| `GET /stats` | Counts by type, severity, confidence (dashboard / filter badges) |
| `GET /scans` | Ingested scans |
| `POST /ingest` | Upload one tool-output JSON |
| `GET /export?format=json` | Full graph export (CSV/GraphML later) |
| `WS /ws` | Push events: `graph.updated`, `scan.ingested` |

## 7. Aggregation

Server-side, per request. Rule: if a node has more than `AGG_THRESHOLD` (default 25) children of the same
type via the same relation, replace them with one aggregate node:

```json
{ "id": "agg:<parentId>:has_subdomain:subdomain", "type": "aggregate",
  "label": "412 subdomains", "count": 412, "childType": "subdomain",
  "maxSeverity": "high", "parentId": "<parentId>" }
```

Children with severity ≥ medium, or tagged `interesting`, are **not** collapsed (they stay visible).
The browser never receives more than ~2,000 elements; if a response would exceed that, the server
aggregates more aggressively and says so in the response (`truncated: true`).

## 8. Graph UI

- **Wrapper:** `web/src/graph/CytoscapeGraph.tsx` creates the `cy` instance once; diffs incoming elements
  (add/remove/update by id) instead of rebuilding.
- **Layout:** `fcose`; nodes with saved positions are locked to them; new nodes are laid out around them.
- **Visual language** (single file `web/src/graph/style.ts`):
  - shape/icon by node type
  - fill color by severity (none, info, low, medium, high, critical)
  - border by confidence: dashed = discovered, solid = corroborated, thick = verified
  - aggregate nodes: larger, with count badge
  - tag `ignored` → faded; `interesting` → highlight ring
- **Interactions:** click → side panel (details, provenance table, tag, notes); double-click aggregate →
  expand; right-click → context menu (focus, expand neighbors, copy value, open URL; "run tool" disabled
  until orchestrator exists).
- **Focus mode:** selected node + N-hop neighborhood stay bright; everything else dimmed.
- **Filters & search:** left sidebar; state in Zustand; filters map 1:1 to `GET /graph` query params.
- **Table view:** TanStack Table beside/below the graph; selecting a row selects + centers the node, and vice versa.
- **Live updates:** WebSocket event → TanStack Query invalidation → wrapper diffs new elements in.

## 9. Build phases

Each phase ends with passing `pnpm typecheck` and `pnpm test`, and a short demo.

**Phase 1 — Foundation & contract**
1. Scaffold pnpm monorepo (`shared`, `server`, `web`), TS strict, Vitest, ESLint, root scripts.
2. `shared`: enums + Zod schema for contract v1. Test: all `contract/examples/*.json` pass; a set of
   bad inputs (mirroring `tools/validate_output.py` cases) fail.
3. `shared`: `normalize.ts` and `nodeId.ts` with thorough unit tests.

**Phase 2 — Database & ingest**
1. Drizzle schema + migrations (§4).
2. Ingest pipeline (§5) + `pnpm ingest` CLI.
3. Tests: ingest examples → expected node/edge counts; ingest twice → no duplicates;
   same node from two tools → `corroborated`; invalid file → rejected, DB untouched.

**Phase 3 — Mock data & API**
1. `scripts/mock.ts`: generates contract-valid files for a realistic target (1 domain, N subdomains,
   IPs, ports, URLs, tech, a few vulns) from multiple fake tools, so corroboration shows up.
2. Fastify server + endpoints in §6, with aggregation (§7). Tests with Fastify `inject`.

**Phase 4 — Graph UI core**
1. Vite + React + Tailwind + shadcn setup; API client with TanStack Query.
2. Cytoscape wrapper, fcose layout, style system (§8).
3. Side panel with details, provenance, tag, notes.
4. Aggregate expand/collapse; save positions.

**Phase 5 — Exploration**
1. Filters, search, focus mode.
2. Synced table view.
3. WebSocket live updates.
4. Highlights view (all `interesting` nodes), JSON export, PNG export (`cy.png()`).

**Phase 6+ — Later (not now)**
Orchestrator (Dockerode, containerized tool groups) · scope guard · presets & auto-chaining ·
diffing between scans · reports · CVE monitoring · local LLM scoring · JS analysis agent.

## 10. Decisions log

| Date | Decision |
|---|---|
| 2026-10-29 | Stack: TS, React, Cytoscape.js, SQLite (Drizzle + better-sqlite3), Fastify, Zod |
| 2026-10-29 | Teammates' Python scripts output contract v1 JSON; server owns IDs and confidence |
| 2026-10-29 | Aggregation is server-side; browser cap ~2,000 elements |
