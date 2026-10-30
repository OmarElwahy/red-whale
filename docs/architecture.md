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
- URL hosts must be ASCII (punycode, `xn--…`) with no `%`, and must parse with WHATWG `URL`; both validators
  enforce this (Python mirrors the WHATWG host rules in `url_host_parses()`), so normalization never sees a URL it can't parse.
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
`id` · `node_id` → nodes · `scan_id` → scans · `tool` · `role` (`finding` | `parent`) · `severity` (nullable) ·
`data` (json, this tool's details; `{}` for a parent-only reference) · `observed_at` (= the scan's `finished_at`)
Unique: (`node_id`, `scan_id`). A node reported several times in one file gets one row: `data` shallow-merged
in file order, highest `severity`. `role` is `finding` if the file reports the node as a finding anywhere,
`parent` if it only names it as some finding's parent.

All timestamps are stored as TEXT in `Date#toISOString()` form (`YYYY-MM-DDTHH:MM:SS.sssZ`) so they sort as text.
Enum columns have CHECK constraints.

Confidence rule: after each ingest, recompute `source_count = COUNT(DISTINCT tool)` over the node's **finding** rows
for touched nodes; `0 or 1 → discovered`, `≥2 → corroborated`; `verified` is only set by the analyst and never
downgraded automatically. Parent rows are kept as provenance and count as sightings (`first_seen`/`last_seen`,
the `tool` filter), but never toward `source_count`, so a node that tools only name as a parent stays `discovered`
with `source_count` 0.

Schema changes: until there is real engagement data, migrations don't backfill. A migration that can't carry old
rows forward is listed in `BREAKING_MIGRATIONS` (`server/src/db/client.ts`), and `openDb` refuses to run it on a
database that already holds observations ("Database is from an older schema. Delete data/redwhale.db and run
pnpm mock (or re-ingest your files).").

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
| `GET /stats` | Workspace counts by type, severity, confidence, tag, tool (dashboard / filter badges); not filtered |
| `GET /scans` | Ingested scans |
| `POST /ingest` | Upload one tool-output JSON |
| `GET /export?format=json` | Full graph export (CSV/GraphML later) |
| `WS /ws` (i.e. `/api/ws`) | Push events: `graph.updated`, `scan.ingested` |

Request and response shapes are the Zod schemas in `shared/src/api.ts`. Details:
- **Filters** (shared by `/graph`, `/graph/expand`, `/nodes`): `types`, `confidence`, `tool`, `tag`, `excludeTag`
  take comma-separated lists (or repeated params); `q` is a case-insensitive substring of value or label;
  `minSeverity` compares **effective severity** (§7), so the path from the root down to a finding stays in the result.
  Filters select nodes; edges are kept when both ends are kept. Unknown params are a 400.
- **Search paths:** on `/graph` and `/graph/expand`, `q` keeps the matches **plus their ancestors** (walking up parent
  edges), so results show their path to the root. Only ancestors that pass the other filters are kept; a filtered-out
  parent ends the path. `/nodes` lists the matches only. The rule itself is `matchesQuery` in `shared/src/api.ts`, so the
  UI can tell a match from a path node without a response field.
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
- **Focus mode:** the node + its N-hop neighborhood (1–3, either edge direction) stay bright, plus the edges among
  them; everything else is faded. Computed on the canvas (`web/src/graph/emphasis.ts`), nothing is fetched; a
  neighbor hidden in an aggregate counts as the aggregate. Esc or a background click clears it.
- **Filters & search:** left sidebar (`web/src/filters/`); state in Zustand (`web/src/state/view.ts`), where
  `filters` has the API's `GraphFilters` type and maps 1:1 to `GET /graph` (and `/graph/expand`) params. Counts
  next to each option are `/stats` workspace totals, labeled as such. Search is debounced (300 ms); Enter
  searches at once, then selects + centers the riskiest visible match. Path nodes (kept above matches) are drawn dimmer.
  Changing filters drops expanded pages, expanded neighborhoods and focus (they were loaded under the old filters).
- **URL:** the view lives in the query string (`web/src/state/url.ts`): the filter params exactly as the API takes
  them, plus view-only `mute=1` and `hops=N`, which never reach the API. Bad values are dropped one by one.
- **Mute low-risk:** fades nodes whose effective severity is below medium (aggregates by `maxSeverity`), and edges
  touching them; a quiet parent above a serious finding stays bright.
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

**Later improvements (logged, not scheduled)**
- Filter-aware `/stats` (counts that follow the active filters, i.e. faceted counts). Today the sidebar shows
  workspace totals.

## 10. Decisions log

| Date | Decision |
|---|---|
| 2026-10-29 | Stack: TS, React, Cytoscape.js, SQLite (Drizzle + better-sqlite3), Fastify, Zod |
| 2026-10-29 | Teammates' Python scripts output contract v1 JSON; server owns IDs and confidence |
| 2026-10-29 | Aggregation is server-side; browser cap ~2,000 elements |
| 2026-10-29 | Extra normalization rules in §3: IPv4-mapped → IPv4, bracketed IPv6 ports, lowercase technology, uppercase CVE IDs |
| 2026-10-29 | Zod errors use the validator's rules and wording, prefixed with a path (`findings[3].value: …`), not identical text |
| 2026-10-29 | TypeScript pinned to 6.0.x: typescript-eslint 8.72 does not support TS 7 yet |
| 2026-10-29 | Known validator gaps, accepted: (1) Python rejects `"contract_version": 1.0` but JS can't tell `1.0` from `1`; (2) Python's `fromisoformat` accepts more timestamp shapes than the documented `YYYY-MM-DDTHH:MM:SS[.frac]Z`, which is all Zod accepts; (3) a URL host the regex allows but WHATWG `URL` can't parse (e.g. containing a space) passes validation but fails normalization at ingest (closed 2026-10-30, see below) |
| 2026-10-29 | Phase 2 schema: added `observations.severity` (needed to compute max severity) and `scans.raw` (full provenance) |
| 2026-10-29 | A parent reference counts as an observation by that tool, so it can corroborate the node (superseded 2026-10-30: parent rows no longer corroborate) |
| 2026-10-29 | `file_hash` is over canonical JSON, not raw bytes, so CRLF/reindented copies are duplicates |
| 2026-10-29 | pnpm 12 native builds are allowed via `allowBuilds` in `pnpm-workspace.yaml` (better-sqlite3, esbuild) |
| 2026-10-30 | Aggregation keeps nodes visible by **effective severity** (worst finding below them), not only their own; `minSeverity` filters on it too |
| 2026-10-30 | Parentless nodes over the threshold aggregate as `agg:root:<type>`; aggregate `maxSeverity` covers all members |
| 2026-10-30 | Aggregate members and the node list are ordered riskiest first |
| 2026-10-30 | No node deletion: the `ignored` tag + `excludeTag` filter hides nodes (provenance is never dropped) |
| 2026-10-30 | API rejects foreign `Host`/`Origin` headers (403) in addition to binding 127.0.0.1 |
| 2026-10-30 | Mock data: `northwind.example`, IPs from 198.18.0.0/15, seed 1337, 7 fake tools; generator in `server/src/mock/` |
| 2026-10-30 | Graph fill color = the node's **own** severity (aggregates: `maxSeverity`); `effectiveSeverity` is kept for muting in Phase 5 |
| 2026-10-30 | Node types are shown by shape only for now (no icons); `interesting` = fuchsia outline, so it never clashes with a severity fill or the confidence border |
| 2026-10-30 | shadcn/ui files are written by hand from the upstream source (no `shadcn init`), with system fonts only: no remote font or CDN imports |
| 2026-10-30 | No `cytoscape-expand-collapse`: it collapses compound nodes client-side, but aggregates are built and paged by the server (§7). The UI merges expand pages into the canvas itself (`web/src/graph/compose.ts`) |
| 2026-10-30 | The UI loads aggregates 100 members per page and keeps the canvas under 2,000 elements: "load more" / "expand neighbors" are disabled at the limit, and anything that would cross it is skipped |
| 2026-10-30 | Collapsing a group also drops the neighborhoods expanded from its members; a fully loaded aggregate disappears, and its members' panel/menu offer "collapse group" |
| 2026-10-30 | Notes are saved explicitly (button / Ctrl+Enter), not on every keystroke, since each PATCH is broadcast. Markdown preview uses `react-markdown` with no raw HTML |
| 2026-10-30 | Phase 4 focus = 1 hop, faded elsewhere, Esc or a background click clears it; the N-hop focus mode is Phase 5 step 1 |
| 2026-10-30 | Only dragged nodes get saved positions (debounced `PUT /layout`, aggregates left out); positions from fcose runs are not saved |
| 2026-10-30 | React component tests run in a separate `web-dom` Vitest project (jsdom + Testing Library); the rest of `web/` tests stay in Node |
| 2026-10-30 | `observations.role` (`finding` \| `parent`): parent references stay as observations (provenance, first/last seen, `tool` filter, `byTool` stats) but only finding rows count toward `source_count`/confidence. A node tools only name as a parent stays `discovered` with `source_count` 0. **Supersedes** the 2026-10-29 "parent reference counts as an observation by that tool" entry |
| 2026-10-30 | No backfills for schema changes until there is real engagement data (only mock and example files exist, and both regenerate). Migration `0001_observation_role` adds the column without one; `openDb` refuses a database with observations from before a breaking migration: "Database is from an older schema. Delete data/redwhale.db and run pnpm mock (or re-ingest your files)." |
| 2026-10-30 | URL hosts must be ASCII with no `%`; non-ASCII names are sent as punycode (`xn--…`). Error: "non-ASCII host: convert it to punycode, e.g. host.encode('idna').decode()" (also for `domain`/`subdomain`). Both validators also reject URLs WHATWG `URL` can't parse (space or `<>[]^\|` in the host, port > 65535, a host ending in a number that isn't valid IPv4); Python mirrors the WHATWG host parser. Closes validator gap (3) from 2026-10-29 |
| 2026-10-30 | `POST /api/ingest` with no `Origin` header (a script, e.g. Python `requests`) is accepted; only a foreign `Origin` is refused. Covered by an explicit test |
| 2026-10-30 | Phase 5 step 1: filter counts are `/stats` **workspace totals**, labeled as totals in the sidebar; filter-aware `/stats` is logged as a later improvement |
| 2026-10-30 | Min-severity counts are each node's **own** severity, with a tooltip saying the filter (effective severity) also keeps the nodes above each finding |
| 2026-10-30 | "Mute low-risk" mutes effective severity `none`/`info`/`low`; medium and up stay bright, so a quiet parent above a critical finding is not muted |
| 2026-10-30 | `q` keeps matches plus their ancestors (that pass the other filters) on `/graph` and `/graph/expand`; `/nodes` stays matches-only. Path nodes are drawn dimmer than matches. No response field: the UI applies the shared `matchesQuery` |
| 2026-10-30 | N-hop focus (1–3) is computed on the canvas, not with `/graph/neighbors`; it also keeps edges between two bright nodes. Supersedes the 1-hop-only focus from Phase 4 |
| 2026-10-30 | "Hide ignored" is off by default; on, it is `excludeTag=ignored` in the API params and the URL. View state uses `replaceState` (no history entry per click) |
| 2026-10-30 | Changing filters clears expanded aggregates, expanded neighborhoods and focus; the selection stays (its panel shows again if the node comes back) |
