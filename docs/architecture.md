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

Additional rules (see decisions log, 2026-10-29):
- IPv4-mapped IPv6 (`::ffff:1.2.3.4`) becomes plain IPv4 (`1.2.3.4`), so it merges with the IPv4 node.
- Ports on IPv6 are bracketed: `[2001:db8::1]:443/tcp`. Unbracketed input (`2001:db8::1:443/tcp`) is
  accepted by the validator and converted. Protocol is lowercased; leading zeros in the port number are dropped.
- URLs are serialized with WHATWG `URL` (so `https://a.com` → `https://a.com/`); path and query keep their case.
- `technology` is lowercased for the ID (`Nginx/1.18.0` = `nginx/1.18.0`); the node label keeps the original text.
- `vulnerability` CVE IDs are uppercased (`cve-2021-41773` → `CVE-2021-41773`); other IDs are left as-is.
- `certificate` fingerprints are lowercased and colons removed.
- Values that can't be canonicalized (e.g. an unparseable IP or URL) throw `NormalizeError`; they are never guessed.

## 4. Database schema (SQLite, Drizzle)

**scans** — one row per ingested tool-output file
`id` (uuid) · `tool` · `tool_version` · `target` · `command` · `status` · `errors` (json) ·
`started_at` · `finished_at` · `ingested_at` · `file_hash` (unique; sha256 of the file's canonical JSON —
keys sorted, no whitespace — so re-ingesting a file, even reformatted, is a no-op) · `raw` (json, the whole file)

**nodes**
`id` (pk, deterministic) · `type` · `value` (normalized) · `label` (display text) ·
`severity` (nullable; highest seen) · `confidence` (`discovered` | `corroborated` | `verified`) ·
`source_count` (distinct tools) · `data` (json, merged) · `tag` (`interesting` | `checked` | `ignored` | null) ·
`notes` (markdown) · `pos_x`, `pos_y` (nullable; saved layout) · `first_seen` · `last_seen`
Indexes: `type`, `severity`, `confidence`, `tag`.

**edges**
`id` (pk, deterministic) · `source_id` → nodes · `target_id` → nodes · `relation` · `first_seen` · `last_seen`
Unique: (`source_id`, `relation`, `target_id`). Indexes on `source_id`, `target_id`.

**observations** — provenance: every time any tool reported a node, as a finding **or as a parent**
`id` · `node_id` → nodes · `scan_id` → scans · `tool` · `severity` (nullable) · `data` (json, this tool's details;
`{}` for a parent-only reference) · `observed_at` (= the scan's `finished_at`)
Unique: (`node_id`, `scan_id`). A node reported several times in one file gets one row: `data` shallow-merged
in file order, highest `severity`.

All timestamps are stored as TEXT in `Date#toISOString()` form (`YYYY-MM-DDTHH:MM:SS.sssZ`) so they sort as text.
Enum columns have CHECK constraints.

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

All derived node fields (`source_count`, `confidence`, `severity`, `data`, `first_seen`, `last_seen`) are recomputed
from the node's full observation set, ordered by (`observed_at`, `tool`, `scan_id`), so the result doesn't depend on
ingest order. "Newer" means a later `observed_at`, not a later ingest. Only `label` is set once, at first insert.

## 6. API (all under `/api`, JSON, validated with Zod)

| Method & path | Purpose |
|---|---|
| `GET /graph?types=&minSeverity=&confidence=&tool=&tag=&excludeTag=&q=` | Filtered graph, **aggregated** (see §7) |
| `GET /graph/expand/:aggregateId?…filters&page=&pageSize=` | Members of an aggregate node (paged, riskiest first) |
| `GET /graph/neighbors/:nodeId?depth=1` | Neighborhood for focus mode / expanding a node |
| `GET /nodes/:id` | Node detail + edges + all observations (provenance) |
| `PATCH /nodes/:id` | Update `tag`, `notes`, `confidence: "verified"`, `pos_x/pos_y` |
| `PUT /layout` | Bulk-save node positions |
| `GET /nodes?…&page=&sort=` | Paged flat list for the table view |
| `GET /stats` | Counts by type, severity, confidence (dashboard / filter badges) |
| `GET /scans` | Ingested scans |
| `POST /ingest` | Upload one tool-output JSON |
| `GET /export?format=json` | Full graph export (CSV/GraphML later) |
| `WS /ws` (i.e. `/api/ws`) | Push events: `graph.updated`, `scan.ingested` |

Request and response shapes are the Zod schemas in `shared/src/api.ts`. Details:
- **Filters** (shared by `/graph`, `/graph/expand`, `/nodes`): `types`, `confidence`, `tool`, `tag`, `excludeTag`
  take comma-separated lists (or repeated params); `q` is a case-insensitive substring of value or label;
  `minSeverity` compares **effective severity** (§7), so the path from the root down to a finding stays in the result.
  Filters select nodes; edges are kept when both ends are kept. Unknown params are a 400.
- Hiding a node is done with the `ignored` tag (+ `excludeTag=ignored`). Nothing is ever deleted (rule 4).
- `GET /nodes` sorts with `sort=-effectiveSeverity,label` (the default); `-` means descending; nodes without a
  severity sort last in both directions. `pageSize` ≤ 500.
- `PUT /layout` takes `{ positions: [{ id, x, y }] }` (≤ 5,000); an unknown or duplicate ID rejects the whole batch.
- `POST /ingest`: 201 ingested, 200 duplicate, 422 `{ error, issues }` with the exact validation errors, 400 bad JSON,
  415 not `application/json`, 413 over 50 MB. Errors are always `{ error, issues? }`.
- Localhost only: requests whose `Host` isn't `127.0.0.1`/`localhost` on the API or Vite port, or whose `Origin`
  isn't our UI, get 403 (blocks DNS rebinding and other web pages calling the API).

## 7. Aggregation

Server-side, per request. Rule: if a node has more than `AGG_THRESHOLD` (default 25) children of the same
type via the same relation, replace them with one aggregate node:

```json
{ "id": "agg:<parentId>:has_subdomain:subdomain", "type": "aggregate",
  "label": "412 subdomains", "count": 412, "total": 420, "childType": "subdomain",
  "relation": "has_subdomain", "maxSeverity": "high", "parentId": "<parentId>" }
```

Children with **effective severity** ≥ medium, or tagged `interesting`, are **not** collapsed (they stay visible).
Effective severity = the highest severity of the node and everything reachable below it, so a subdomain whose
URL has a critical finding stays visible. Every graph node carries `effectiveSeverity` (the UI can mute low-risk nodes).
- `count` = members hidden in the aggregate; `total` = all members; `maxSeverity` = highest effective severity
  among all members.
- Anything reachable only through collapsed children is hidden until the aggregate is expanded.
- Parentless nodes (e.g. when a filter removes the domain) aggregate the same way, as `agg:root:<childType>`.
- `GET /graph/expand/:aggregateId` returns every member, riskiest first, then by value; the client de-duplicates by ID.

The browser never receives more than ~2,000 elements; if a response would exceed that, the server
aggregates more aggressively and says so in the response (`truncated: true`): it lowers the threshold
(10, 5, 2), then collapses sticky children too, and as a last resort cuts the result.

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
| 2026-10-29 | Extra normalization rules in §3: IPv4-mapped → IPv4, bracketed IPv6 ports, lowercase technology, uppercase CVE IDs |
| 2026-10-29 | Zod errors use the validator's rules and wording, prefixed with a path (`findings[3].value: …`), not identical text |
| 2026-10-29 | TypeScript pinned to 6.0.x: typescript-eslint 8.72 does not support TS 7 yet |
| 2026-10-29 | Known validator gaps, accepted: (1) Python rejects `"contract_version": 1.0` but JS can't tell `1.0` from `1`; (2) Python's `fromisoformat` accepts more timestamp shapes than the documented `YYYY-MM-DDTHH:MM:SS[.frac]Z`, which is all Zod accepts; (3) a URL host the regex allows but WHATWG `URL` can't parse (e.g. containing a space) passes validation but fails normalization at ingest |
| 2026-10-29 | Phase 2 schema: added `observations.severity` (needed to compute max severity) and `scans.raw` (full provenance) |
| 2026-10-29 | A parent reference counts as an observation by that tool, so it can corroborate the node |
| 2026-10-29 | `file_hash` is over canonical JSON, not raw bytes, so CRLF/reindented copies are duplicates |
| 2026-10-29 | pnpm 12 native builds are allowed via `allowBuilds` in `pnpm-workspace.yaml` (better-sqlite3, esbuild) |
| 2026-10-30 | Aggregation keeps nodes visible by **effective severity** (worst finding below them), not only their own; `minSeverity` filters on it too |
| 2026-10-30 | Parentless nodes over the threshold aggregate as `agg:root:<type>`; aggregate `maxSeverity` covers all members |
| 2026-10-30 | Aggregate members and the node list are ordered riskiest first |
| 2026-10-30 | No node deletion: the `ignored` tag + `excludeTag` filter hides nodes (provenance is never dropped) |
| 2026-10-30 | API rejects foreign `Host`/`Origin` headers (403) in addition to binding 127.0.0.1 |
| 2026-10-30 | Mock data: `northwind.example`, IPs from 198.18.0.0/15, seed 1337, 7 fake tools; generator in `server/src/mock/` |
