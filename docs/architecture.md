# RED WHALE — Architecture & Build Plan

Scope of this document: the **data contract, database, API, graph UI**, and since 6C-1 the **tool runner** (§11).
AI layers and CVE monitoring come later (see Phase 7+).

## 1. Data flow

```
Python tool scripts ──JSON (docs/contract.md)──▶ Ingest ──▶ SQLite ──▶ Fastify API ──▶ React + Cytoscape
   (tools/*.py)                                  (server)              REST + WebSocket     (web)
```

Files enter through `pnpm ingest <file.json>`, `POST /api/ingest`, or a tool run (§11): the orchestrator runs a
tool's script in a container and puts its `result.json` through the same ingest. It is just another producer of
the same JSON.

## 2. Packages

| Package | Contains |
|---|---|
| `shared/` | Zod schemas for the tool-output contract and API responses; `normalize.ts` (value normalization); `nodeId.ts` (deterministic IDs); `scope.ts` (scope rules and `checkScope`, §10); shared enums (node types, relations, severities, confidence, tags) |
| `server/` | Fastify app bound to `127.0.0.1:4100`; Drizzle schema + migrations; ingest pipeline; graph query + aggregation; WebSocket broadcaster; the tool runner (`src/runner/`, §11); CLI entry for `ingest`, `mock`, `tools:build`, `tools:check` |
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
`id` (pk, deterministic) · `source_id` → nodes · `target_id` → nodes · `relation` ·
`confidence` (`discovered` | `corroborated`; edges are never `verified`) · `source_count` (distinct tools) · `first_seen` · `last_seen`
Unique: (`source_id`, `relation`, `target_id`). Indexes on `source_id`, `target_id`. Everything after `relation` is derived
from the edge's observations.

**edge_observations** — edge provenance: every scan that reported a relation (a finding naming that parent)
`id` · `edge_id` → edges · `scan_id` → scans · `tool` · `data` (json, `{}` for now) · `observed_at` (= the scan's `finished_at`)
Unique: (`edge_id`, `scan_id`); indexes on `edge_id`, `scan_id`, `observed_at`. An edge reported several times in one
file gets one row. So for every edge we can answer "which scan first/last reported this relation?" (groundwork for
scan diffing, 6E).

**observations** — provenance: every time any tool reported a node, as a finding **or as a parent**
`id` · `node_id` → nodes · `scan_id` → scans · `tool` · `role` (`finding` | `parent`) · `severity` (nullable) ·
`data` (json, this tool's details; `{}` for a parent-only reference) · `observed_at` (= the scan's `finished_at`)
Unique: (`node_id`, `scan_id`). A node reported several times in one file gets one row: `data` shallow-merged
in file order, highest `severity`. `role` is `finding` if the file reports the node as a finding anywhere,
`parent` if it only names it as some finding's parent.

**scope_rules** — what tools may be pointed at (§10). Never deleted: removing sets `removed_at`.
`id` (integer) · `kind` (`domain` | `wildcard` | `ip` | `cidr`) · `value` (normalized) · `action` (`include` | `exclude`) ·
`note` · `created_at` · `removed_at` (nullable). Partial unique index on (`kind`, `value`, `action`) where `removed_at IS NULL`.

**scope_log** — every scope decision asked for: the UI's test box (`check`) and every `authorize()` call (`run`)
`id` · `source` (`check` | `run`) · `target_type` · `target_value` (as asked) · `mode` (`passive` | `active`) ·
`decision` (`in` | `out` | `n/a`) · `rule_id` → scope_rules (nullable) · `reason` · `at`. Index on (`source`, `at`).

**scope_settings** — one row (`id = 1`, CHECK), created by the migration: `passive_only` (default on) · `updated_at`.

**jobs** — one row per tool run (§11), from queueing to the ingested scan. Never deleted (the mock wipe aside).
`id` (integer) · `tool` · `tool_group` · `node_id` → nodes · `target_type` · `target_value` (the node's value when
queued) · `mode` (`passive` | `active` | `intrusive`) · `status` (`queued` | `running` | `succeeded` | `failed` |
`cancelled` | `refused`) · `queued_scope_log_id` → scope_log (the `authorize()` decision at queueing) ·
`scope_log_id` → scope_log (the decision right before the container started) · `argv` (json, the command as run) ·
`image` · `container_id` · `timeout_sec` · `exit_code` · `error` · `issues` (json, why `result.json` was rejected) ·
`created_at` · `started_at` · `finished_at` · `scan_id` → scans · `nodes_created` · `nodes_updated`.
Indexes on `status`, `created_at`, `scan_id`, `node_id`; CHECKs on the enums.

**runner_state** — one row (`id = 1`), created by migration `0004_jobs`: `workspace_id` (random, labels this
workspace's containers and volumes) · `created_at`. `0004_jobs` adds tables only: not breaking.

All timestamps are stored as TEXT in `Date#toISOString()` form (`YYYY-MM-DDTHH:MM:SS.sssZ`) so they sort as text.
Enum columns have CHECK constraints.

Confidence rule: after each ingest, recompute `source_count = COUNT(DISTINCT tool)` over the node's **finding** rows
for touched nodes; `0 or 1 → discovered`, `≥2 → corroborated`; `verified` is only set by the analyst and never
downgraded automatically. Parent rows are kept as provenance and count as sightings (`first_seen`/`last_seen`,
the `tool` filter), but never toward `source_count`, so a node that tools only name as a parent stays `discovered`
with `source_count` 0.

Edge confidence: `source_count = COUNT(DISTINCT tool)` over **all** of the edge's observations (every one is a report of
the relation; there is no parent-only role for edges); `1 → discovered`, `≥2 → corroborated`. No analyst `verified`.

Schema changes: until there is real engagement data, migrations don't backfill. A migration that can't carry old
rows forward is listed in `BREAKING_MIGRATIONS` (`server/src/db/client.ts`), and `openDb` refuses to run it on a
database that already holds observations ("Database is from an older schema. Delete data/redwhale.db and run
pnpm mock (or re-ingest your files)."). Breaking so far: `0001_observation_role`, `0003_edge_observations`.

## 5. Ingest pipeline

1. Parse file → validate with Zod (reject the whole file with a clear error list on failure).
2. Hash the file; if `scans.file_hash` exists, stop (idempotent).
3. In **one transaction**: insert scan → for each finding, upsert parent node (if any) and child node,
   upsert edge, insert observation; for every finding that names a parent, one edge observation per edge →
   recompute derived fields for touched nodes and edges.
4. After commit, broadcast `{ type: "graph.updated", nodeIds, edgeIds }` over WebSocket.

Merging `data`: keep per-tool details in `observations.data`; `nodes.data` holds a shallow merge where
newer values win. Severity = max severity across observations.

All derived node fields (`source_count`, `confidence`, `severity`, `data`, `first_seen`, `last_seen`) are recomputed
from the node's full observation set, ordered by (`observed_at`, `tool`, `scan_id`), so the result doesn't depend on
ingest order. "Newer" means a later `observed_at`, not a later ingest. Only `label` is set once, at first insert.

Derived edge fields (`source_count`, `confidence`, `first_seen`, `last_seen`) are recomputed the same way, from the
edge's full set of `edge_observations` in the same order (`recomputeEdges`, `deriveEdgeState`).

## 6. API (all under `/api`, JSON, validated with Zod)

| Method & path | Purpose |
|---|---|
| `GET /graph?types=&minSeverity=&confidence=&tool=&tag=&excludeTag=&scope=&q=` | Filtered graph, **grouped**, every group collapsed (see §7) |
| `POST /graph/view` | The same, with the analyst's view: open groups, neighbor expansions, expand-all, `keep` (§7). What the UI uses |
| `GET /graph/path/:nodeId?…filters` | The groups to open (as pins) so that a node deep inside collapsed groups is drawn |
| `GET /graph/expand/:aggregateId?…filters&page=&pageSize=` | Members of a group (paged, riskiest first). Not used by the UI since 5D; kept for scripts |
| `GET /graph/neighbors/:nodeId?depth=1` | Neighborhood of a node, grouped, the node always drawn. Not used by the UI since 5D |
| `GET /nodes/:id` | Node detail + edges (each with `sourceCount`, `confidence`, first/last seen) + all observations (provenance) |
| `GET /edges/:id` | Edge detail: relation, both ends (`id`, `type`, `label`), derived fields, every edge observation (provenance) |
| `PATCH /nodes/:id` | Update `tag`, `notes`, `confidence: "verified"`, `pos_x/pos_y` |
| `PUT /layout` | Bulk-save node positions |
| `GET /nodes?…&page=&sort=&at=` | Paged flat list for the table view |
| `GET /highlights` | Every `interesting` node with its notes, riskiest first (not filtered, not paged) |
| `GET /stats` | Workspace counts by type, severity, confidence, tag, scope decision, tool (dashboard / filter badges); not filtered |
| `GET /scans` | Ingested scans (each with `jobId`: the run that produced it, null for an upload) |
| `POST /ingest` | Upload one tool-output JSON |
| `GET /export?format=json` | Full graph export (CSV/GraphML later) |
| `GET /scope/rules?removed=1` | Active scope rules, oldest first (`removed=1` adds removed ones) |
| `POST /scope/rules` | Add a rule `{ kind, value, action, note? }`: 201 normalized rule, 400 refused (says why), 409 an active twin |
| `PATCH /scope/rules/:id` | `{ note?, removed?: true }`; removing is one-way (add the rule again to restore) |
| `GET /scope/check?type=&value=&mode=` | The decision against the current scope; **not logged** (a GET must not write) |
| `POST /scope/check` | Same body/answer, **logged** as `check`: the UI's "test a target" box, on submit only |
| `GET /scope/log?source=&page=&pageSize=` | Decision log, newest first; `source` defaults to `run` (`run,check` adds the test box) |
| `GET /scope/settings`, `PATCH /scope/settings` | `{ passiveOnly }` |
| `GET /tools` | Tool groups (label, image, `imageStatus` built/outdated/missing/unknown, tools) and tools (mode, accepted types, external services, timeout) |
| `POST /jobs` | `{ tool, nodeId }`: 201 `{ jobs }` queued · 403 `{ error, decision, jobs }` refused by scope (kept as `refused`) · 404 · 400 · 409 image not built · 503 Docker unreachable |
| `POST /jobs/group` | `{ group, nodeId }`: one job per tool of the group that takes the node's type, one `authorize()` each |
| `GET /jobs?page=&pageSize=&status=&nodeId=` | Jobs, newest first (`pageSize` ≤ 200) |
| `GET /jobs/:id` | `{ job, tails: { stdout, stderr, raw } }`: the last 4 KB of each kept output (null: none) |
| `GET /jobs/:id/output/:stream` | `stdout` \| `stderr` \| `raw` as `text/plain` (≤ 5 MB, as kept) |
| `POST /jobs/:id/cancel` | Queued → cancelled; running → killed, cancelled, nothing ingested; 409 if finished |
| `GET /runner/status` | `{ docker: { reachable, version, error }, images: [{ group, image, status }], running, queued, maxConcurrent }` |
| `WS /ws` (i.e. `/api/ws`) | Push events: `graph.updated`, `scan.ingested`, `scope.changed`, `job.updated { job }`, `runner.status { reachable, error }` |

Request and response shapes are the Zod schemas in `shared/src/api.ts`. Details:
- **Filters** (shared by `/graph`, `/graph/expand`, `/nodes`): `types`, `confidence`, `tool`, `tag`, `excludeTag`
  take comma-separated lists (or repeated params); `q` is a case-insensitive substring of value or label;
  `minSeverity` compares **effective severity** (§7), so the path from the root down to a finding stays in the result.
  Filters select nodes; edges are kept when both ends are kept. Unknown params are a 400.
  **Known limit (`tool`):** it keeps nodes that tool saw, so it also keeps an edge between two such nodes that the tool
  itself never reported (decisions log, 2026-11-01).
- **Tool runs** (§11): node- and edge-detail observations carry `jobId` (the job whose run produced the scan; null for
  an upload), so the provenance table can open the raw output. A run's 409/503 store no job and log no scope decision;
  a 403 stores the refused job and its decision. Without the runner (no Docker client, or invalid tool definitions)
  the tool, job and runner routes answer 503.
- **Edge provenance on graph edges:** graph edges (`/graph/expand`, export) carry `sourceCount` and `confidence`. View edges
  (`/graph`, `/graph/view`) carry `edgeId`, `sourceCount`, `confidence`, `tools` and `edgeCount`, always present, null where
  they don't apply: `relation`/`neighbor` edges are real (`edgeId` = their ID, their own `sourceCount`/`confidence`);
  a `member` edge (group → member) stands for the real parent → member edge (`edgeId` = that edge, its provenance); a
  `group` edge (parent → group) carries `tools` (the sorted union of every member edge's tools under the current filters,
  drawn or not) and `edgeCount` (how many member edges); `more` edges carry nothing.
- **`GET /edges/:id`**: `{ edge: { id, relation, source, target, sourceCount, confidence, firstSeen, lastSeen },
  observations: [{ scanId, tool, command, data, observedAt }] }`, oldest first; 404 for an unknown id. Takes a real edge
  ID (a view edge's `edgeId`), not a view ID like `edge:agg:…`.
- **Scope:** every node carries `inScope` (`in` | `out` | `n/a`), its passive-mode decision (§10), computed on every
  read from the current rules, never stored. `scope=in,out,n/a` filters on it like any other node filter (so with
  `scope=out` an out-of-scope subdomain whose apex is in scope is parentless: a root, grouped as `agg:root:subdomain` above 25).
  `GET /nodes/:id` adds `scope: { decision, reason, rule }`. Rule and setting changes broadcast `scope.changed`.
- **`POST /graph/view`** (a POST because the open groups don't fit in a query string; it only reads) takes
  `{ filters, expand: [{ id, pages, pins }], neighbors, expandAll, keep: { edges, roots } }` (`graphViewRequestSchema`:
  ≤ 2,000 open groups, `pages` ≤ 50, ≤ 100 pins each, ≤ 200 neighbor expansions, ≤ 10 expand-all). `filters` are the
  same values as the query string (`"types": "ip,port"` or a list). The answer is `GET /graph`'s shape plus
  `state` (the view as applied, which the UI adopts), `overBudget`, `autoOpened`, `autoFolded` and `expandAll`
  (`{ nodeId, opened, hidden }`); edges carry a `kind` (§7).
- **`GET /graph/path/:nodeId`**: `{ nodeId, inView, steps: [{ groupId, memberId }] }`, root first. `inView: false` when
  the filters leave the node out; 404 for an unknown node.
- **Search paths:** on `/graph` and `/graph/expand`, `q` keeps the matches **plus their ancestors** (walking up parent
  edges), so results show their path to the root. Only ancestors that pass the other filters are kept; a filtered-out
  parent ends the path. `/nodes` lists the matches only. The rule itself is `matchesQuery` in `shared/src/api.ts`, so the
  UI can tell a match from a path node without a response field.
- Hiding a node is done with the `ignored` tag (+ `excludeTag=ignored`). Nothing is ever deleted (rule 4).
- `GET /nodes` sorts with `sort=-effectiveSeverity,label` (the default); `-` means descending; nodes without a
  severity sort last in both directions. `pageSize` ≤ 500. `at=<nodeId>` returns the page that holds that node
  (under the same filters and sort) instead of `page`; if the node isn't listed, `page` is used.
- `GET /highlights` takes no params (a filter param is a 400): it is the analyst's list, whatever the view.
- `GET /export` downloads as `redwhale-export-<UTC time, no colons>.json`; it holds nodes, edges (with derived fields), scans,
  `observations` and `edgeObservations` (`edgeId, scanId, tool, data, observedAt`).
- `PUT /layout` takes `{ positions: [{ id, x, y }] }` (≤ 5,000); an unknown or duplicate ID rejects the whole batch.
- `POST /ingest`: 201 ingested, 200 duplicate, 422 `{ error, issues }` with the exact validation errors, 400 bad JSON,
  415 not `application/json`, 413 over 50 MB. Errors are always `{ error, issues? }`.
- Localhost only: requests whose `Host` isn't `127.0.0.1`/`localhost` on the API or Vite port, or whose `Origin`
  isn't our UI, get 403 (blocks DNS rebinding and other web pages calling the API).

## 7. Groups (aggregation)

Server-side, per request (`server/src/graph/aggregate.ts`, `groupedView`; pure). The browser keeps only which groups are
open; the server draws the view.

**Rule.** The children of one parent with the **same relation and the same child type** form a group when there are
**two or more** of them, at every level (subdomains under a domain, IPs under a subdomain, ports under an IP, URLs under a
port or a URL, techs, vulnerabilities, …). A single child is drawn directly, with its real edge, and the walk goes on
below it. Parentless nodes (roots, e.g. when a filter removes the domain) are drawn as they are up to
`ROOT_GROUP_THRESHOLD` (25) per type and grouped above it as `agg:root:<type>`, so a single target domain is never
"1 domain". Parts of the graph no root reaches (only cycles, e.g. url ⇄ url) are walked from their riskiest node.

```json
{ "id": "agg:<parentId>:has_subdomain:subdomain", "type": "aggregate", "label": "412 subdomains", "count": 412,
  "childType": "subdomain", "relation": "has_subdomain", "parentId": "<parentId>", "maxSeverity": "critical",
  "risk": { "critical": 2, "high": 1 }, "expanded": true, "shown": 100, "remaining": 312, "canLoadMore": true }
```

- **Collapsed by default.** The walk goes down from the roots and stops at collapsed groups: anything below one is
  hidden until it's opened. Groups have **no sticky members**: a risky member stays inside, and the group says so.
- **An open group stays on the canvas** as its members' parent: parent → group (a `group` edge carrying the relation) →
  each member (plain `member` edges). Real parent → child edges are unchanged in the database; on the canvas a real
  edge (`relation`) is drawn only for a parent's single child of that kind.
- **Effective severity** = the highest severity of a node and everything reachable below it; every graph node carries
  `effectiveSeverity` (used by `minSeverity`, muting and ordering).
- **Risk:** fill = `maxSeverity` (highest effective severity among the members); `risk` = the distinct nodes with their
  **own** severity high or critical at or below the members, each counted once however many paths reach it (a shared
  IP). Computed by walking up from each serious node once.
- **Pages:** an open entry is `{ id, pages, pins }`: `pages` × 100 members (`GROUP_PAGE_SIZE`), riskiest first (effective
  severity, then type, then value), plus `pins` (members opened on purpose, e.g. the path to a search result). Members
  not drawn hang behind a `more:<groupId>` node ("+312 more", a `more` edge); loading more is one more page.
- **A node with several parents** (an IP shared by two subdomains) is drawn once. Both groups open: an edge from each.
  One open: it hangs under that one; the collapsed group still counts it and draws no edge to it (collapsed means closed).
  A single-child parent links to it with the real edge.
- **Recursive collapse:** the answer's `state` lists only open groups that are **drawn**. Closing a group stops the walk
  above everything opened below it, so those entries drop out of `state`, and the UI adopts that: they come back collapsed.
  The same rule drops groups that no longer exist after a filter change (gone, or down to one member), so a filter
  change keeps every open group that still exists.
- **Neighbor expansions** (`neighbors`): once the node is drawn, every parent of it is drawn too, with `neighbor` edges
  (the only way to see a shared node's other parents). Applied after the main walk, until nothing changes.
- **Expand all below** (`expandAll`, one-shot): opens every group below the node at any depth, first pages nearest-first,
  then further pages, until the budget is full; answers `{ nodeId, opened, hidden }` (`hidden` = nodes below still not drawn).
- **Auto-open** (`keep`): each request carries what the canvas showed directly (`relation` edge IDs and parentless node
  IDs). A collapsed group holding one of them is new (a live update turned one child into two, or root number 26
  arrived) and is opened with its first page, so nothing the analyst was looking at disappears when a scan finishes
  (`autoOpened`). If it doesn't fit, it folds and the UI flashes it (`autoFolded`). A group the analyst collapsed never
  matches: its members were drawn through `member` edges, not `relation` ones.
- **Budget.** The browser never receives more than ~2,000 elements. The view state is a list of units, most important
  first: the analyst's open groups in request order (each extra page its own unit; the UI moves a group to the end when it
  loads more), neighbor expansions, expand-all, auto-opens. Granting a unit only adds elements, so the server binary-
  searches the longest prefix that fits (a few walks); the rest are refused and listed in `overBudget` (`truncated: true`).
  Each drawn group's `canLoadMore` says whether its next page would fit (estimated: each member, its edge, and what
  hangs below it collapsed). As a last resort (the collapsed view alone over the cap) the result is cut in visiting order.
- **Paths** (`GET /graph/path/:nodeId`): breadth-first from the roots in the walk's order, the first path to the node,
  with a step `{ groupId, memberId }` per group on it. Opened as pins, it draws exactly that path and nothing more at
  those levels.
- `GET /graph/expand/:aggregateId` still returns a group's members, riskiest first, paged (for scripts).

Measured on `mock:large` (965 nodes, 400 subdomains): a view takes 15–25 ms on the server, expand-all from the domain
included (1,945 elements, truncated).
## 8. Graph UI

- **Wrapper:** `web/src/graph/CytoscapeGraph.tsx` creates the `cy` instance once; diffs incoming elements
  (add/remove/update by id) instead of rebuilding.
- **The view** comes whole from `POST /graph/view` (§7); the client keeps only `{ expanded: [{ id, pages, pins }],
  neighbors, expandAll }` (Zustand, `web/src/state/ui.ts`) and adopts the answer's `state` when it differs (pruned,
  auto-opened, expand-all), seeding the cache under the new key so nothing is fetched twice. `keep` is read from the
  last view when a request goes out and is not part of the query key. Helpers in `web/src/graph/groups.ts`.
- **Layout modes** (header toggle **Force | Tree**; `web/src/graph/modes.ts`). Switching animates every node to its
  new place (400 ms, ease-out) and fits the view.
  - **Force:** `fcose`; nodes with saved positions are locked to them; new nodes are laid out around them, and
    nothing already on the canvas moves. New nodes start breadth-first from a placed neighbor (a group's members fan
    out on the far side of the group, a chain of new nodes unrolls outward), then fcose settles them with every placed
    node pinned (up to 800 nodes on the canvas; above that only their direct neighbors), so they don't land on what's
    there. Only dragged nodes are saved (debounced `PUT /layout`); groups and "more" nodes are never saved (no DB row),
    a dragged group stays where it was put for the session.
  - **Tree:** a top-down layered hierarchy over the parent edges (domain → subdomain → IP → port → URL →
    tech/vuln/…), computed by ELK `layered` (`elkjs`, in a Web Worker, loaded the first time Tree is used;
    `web/src/graph/tree.ts`). It handles DAGs: a shared IP sits below both parents. Roots = nodes with no parent
    on the canvas (a node only named as a parent is one), all on the top row. Siblings are ordered riskiest
    first (effective severity; groups by `maxSeverity`, "more" nodes last), then by label, and ELK keeps that order, so
    the tree is the same on every reload. Groups are ordinary tree levels (domain → "6 subdomains" → each subdomain →
    "2 IPs" → …); opening or closing one re-runs the tree and animates there.
  - In Tree mode, anything that changes the tree (live update, expand, "show on graph", filter change, a
    severity or label change) re-runs the layout and animates there; new nodes grow out of their parent. Only a
    switch, a filter change and **Re-layout** fit the view. Otherwise the camera stays put and so does what you're
    looking at: the new tree is shifted so the node you just expanded, collapsed or opened a path to keeps its exact place
    on screen (with no such node, e.g. a live update, the node nearest the middle of the view does). Near the element cap ELK takes a few seconds; the
    header says "laying out tree…" meanwhile, and only the latest run lands.
  - Dragging in Tree mode carries the node's whole subtree (descendants via parent edges; a shared node goes with
    whichever parent moves). Tree positions are **never saved** and never pin anything; entering Tree remembers
    each node's Force position and going back restores it. **Re-layout** snaps back to the clean tree (so does
    any re-run). The mode is view-only URL state, `layout=tree`, never sent to the API.
- **Feel** (nothing changes how the canvas draws mid-gesture):
  - Cytoscape runs with `textureOnViewport`, `hideEdgesOnViewport`, `hideLabelsOnViewport` and `motionBlur` off:
    edges and labels stay drawn while panning, zooming and dragging.
  - **Momentum** (`momentum.ts`, physics in `motion.ts`): a fast pan keeps gliding after release; a node thrown by
    a fast drag slides on. Release velocity comes from the last 80 ms of pointer movement only (a drag that ends
    in a pause doesn't fly), is capped at 3,000 px/s, and must be at least 150 px/s to glide; friction is
    exponential (τ = 325 ms), integrated per frame so the distance doesn't depend on the frame rate; it stops
    below 20 px/s. Any press on the canvas, any wheel, and any programmatic camera move end a glide at once. A
    thrown node's position is saved once, where it comes to rest.
  - **Wheel zoom** (`wheel.ts`): we take the wheel over from Cytoscape (capture listener on the wrapper). Every
    wheel event moves a target zoom by `exp(-px × 0.0015)` (a ctrl+wheel touchpad pinch by `exp(-px × 0.01)`),
    so a mouse notch and the same distance of two-finger scroll zoom the same; the view eases to the target
    (τ = 60 ms) toward the cursor. Touch-screen pinch stays with Cytoscape.
  - **Labels at low zoom** (`labels.ts`): node and edge labels show only while they'd be at least 8 px on screen
    (with a little hysteresis). Crossing the threshold fades them through half opacity in 150 ms; at 0 opacity
    Cytoscape skips them. Node icons hide the same way below 7 px on screen (class `icon-hidden`, one swap, no fade);
    the hatch and a group's badge stay.
  - **Collapsing** slides the members that disappear into their group (220 ms, fading) before they go; edges go at once.
  - **Expanding** is the reverse: every new node starts at its nearest ancestor that was already on the canvas (so a
    group's members, and the groups under them, all come out of the group that was opened) and glides to its place
    (Force: 400 ms ease-out after fcose places it; Tree: the tree animation carries it). Live updates grow the same way.
    Centering on a node mid-glide (search, table, Show on graph) aims at where it stops.
  - `prefers-reduced-motion`: no momentum, no wheel easing, no animated layouts or camera moves.
  - Dev only: `await redwhale.bench()` in the browser console pans and zooms for 5 s and reports frame times
    (`redwhale.bench({ zoom: false })` pans only). Measured at 1,887 elements (decisions log, 2026-10-31).
- **Visual language** (`web/src/graph/style.ts`, icons in `web/src/graph/icons.ts`):
  - every node is a **circle with its type's icon** (Lucide, from `lucide-static` 1.59.0, ISC; one `?raw` import per
    icon, inlined as SVG data URIs, so only the icons we use are bundled and nothing is fetched):

    | Type | Icon | | Type | Icon |
    |---|---|---|---|---|
    | domain | globe | | vulnerability | bug |
    | subdomain | network | | email | at-sign |
    | ip | server | | secret | key-round |
    | port | plug | | certificate | lock |
    | url | link | | leak | database-zap |
    | technology | layers | | | |

    A type with no fitting icon gets short text instead (`{ text: 'JS' }`, drawn in the system font); none needs it
    today. The map is a `Record<NodeType, …>`, so a new node type doesn't compile until it picks one.
  - the icon is inked for the fill: white on none and critical, slate-950 on info, low, medium and high (WCAG ≥ 4.5:1 on
    every fill, tested). Hatch, icon and badge are one background-image stack (bottom to top), built per node by
    `imageLayers` through Cytoscape function mappers (memoized by data + class)
  - fill color by severity (none, info, low, medium, high, critical)
  - border by confidence: dashed = discovered, solid = corroborated, thick = verified
  - groups: larger (44 px), double border, the members' icon, label below ("12 subdomains"), fill = `maxSeverity`; an open
    group is fainter (border 0.5, fill 0.7). A **badge** over the top-right corner counts the high/critical nodes below
    (red with a critical among them, orange for high only, "99+" past 99); hovering the group shows "12 subdomains: 2
    critical, 1 high below"
  - "+N more": a dashed slate pill under an open group
  - tag `ignored` → faded; `interesting` → highlight ring
  - out of scope (`inScope = out`) → thin, semi-transparent diagonal stripes over the fill (`OUT_OF_SCOPE_HATCH`, an SVG
    `background-image`): the severity color reads between them, and it uses none of the other channels (fill,
    confidence border, `interesting` outline, selection/fresh underlay). The stripes scale with the node, so the marker
    shows at every zoom (a corner badge would vanish zoomed out). `in` and `n/a` are drawn as before
  - edges: arrow toward the child; the relation (`has_subdomain`, `resolves_to`, …) as a label along the edge, on
    a small canvas-colored background so it reads over other edges. Group → member edges are plain and quieter;
    group → "more" edges dashed
  - edge width by provenance (`EDGE_WIDTH`, `CORROBORATED_EDGE`, `MEMBER_EDGE`): an edge whose real edge 2+ tools
    reported is slightly thicker (1.5 → 2.5 px; group → member 1 → 2 px). Parent → group edges are never thicker: a union
    of tools across members corroborates no single relation. Nothing else about edges changes
- **Legend:** the header's **Legend** button opens it (type → icon, severity, confidence, markers incl. group, badge, "more",
  edge widths).
- **Edge panel** (`web/src/panel/EdgePanel.tsx`): clicking an edge selects it (one selection: a node or an edge, never
  both; `selectedEdgeId` in `web/src/state/ui.ts`) and opens its panel, same style as a node's. A real edge
  (`relation`, `neighbor`, or a group → member edge, which stands for it) shows relation, from → to (each end clickable:
  a node is picked like a table row, a group selected and centered), confidence (N tools), first/last seen and a
  provenance table (tool, command, time; a row opens the raw data), from `GET /edges/:id`; it stays open when the edge
  leaves the canvas. A parent → group edge shows its relation, both ends, "N edges, one per member" and the tools
  behind them, from the view (no fetch); it closes with its group. Group → "more" edges aren't clickable.
- **Interactions:** click → side panel (details, provenance table, tag, notes; a group: members, relation, parent, max
  severity, what's below, shown/total, and its controls). Double-click a group → expand / collapse; double-click "+N
  more" → next page. Right-click → context menu: on a node focus, expand neighbors, **expand all below** (stops at the
  budget; the header says how many groups it opened and how many nodes stay collapsed), copy value, open URL, collapse
  its group; on a group focus, expand / collapse, collapse all below (closes the open groups under it, keeps it open),
  load more. On a node, **Run tool ▸** (§11) opens a submenu in place: "Run group: subdomain enumeration" first, then
  each tool that takes the node's type, with a mode badge and an "external" badge; disabled items say why (Docker not
  running, image not built or out of date, passive-only mode, not a target, out of scope). Groups have no Run tool
  (6D). Expand, load more and expand-all are disabled at the element budget (the group's `canLoadMore`).
- **Focus mode:** the node + its N-hop neighborhood (1–3, either edge direction) stay bright, plus the edges among
  them; everything else is faded. Computed on the canvas (`web/src/graph/emphasis.ts`), nothing is fetched. A group is
  **no hop of its own**: from a parent a step goes on through its groups to their members, from a member up through its
  group to the parent (not to its siblings). Esc or a background click clears it.
- **Filters & search:** left sidebar (`web/src/filters/`); state in Zustand (`web/src/state/view.ts`), where
  `filters` has the API's `GraphFilters` type and maps 1:1 to `GET /graph` (and `/graph/expand`) params. Counts
  next to each option are `/stats` workspace totals, labeled as such. Search is debounced (300 ms); Enter
  searches at once, then selects the riskiest match anywhere (`GET /nodes?q=…&pageSize=1`) and, if it's inside
  collapsed groups, opens exactly the groups on its path (`GET /graph/path`, as pins) and centers on it. Path nodes
  (kept above matches) are drawn dimmer. Changing filters keeps open groups and neighbor expansions (the server drops
  those that no longer exist, §7), drops focus, and sends the table to page 1.
- **URL:** the view lives in the query string (`web/src/state/url.ts`): the filter params exactly as the API takes
  them, plus view-only `mute=1` and `hops=N`, which never reach the API. Bad values are dropped one by one.
- **Mute low-risk:** fades nodes whose effective severity is below medium (aggregates by `maxSeverity`), and edges
  touching them; a quiet parent above a serious finding stays bright.
- **Bottom panel:** toggled from the header, under the canvas: **Table**, **Highlights**, **Scope** or **Jobs**.
- **Jobs** (`web/src/jobs/JobsPanel.tsx`, §11): every run, newest first, live (`job.updated` refetches only the runner's
  queries and the scope log, never the graph): status, tool, target (click = pick the node), started, duration
  (ticking while running), what it found ("+14 new, 6 updated" / "nothing new"), the error; **Cancel** (queued or
  running), **Raw output** (command, validation issues, the tail of raw/stderr/stdout, links to the full text) and
  **Show results** (picks the target node and highlights that scan's rows in its provenance table). Queuing a run
  opens the tab and says what happened in the header ("… refused: <scope reason>" on a 403). Provenance rows from a run
  link to its raw output. The header shows the runner: green Docker, amber (images not built), red Docker off, grey
  runner off, with running(+queued) counts.
- **Scope** (`web/src/scope/ScopePanel.tsx`, §10): the header chip shows the active rule count and "passive" while
  passive-only is on (amber dot when there is no include rule). The panel has the rules (add with the server's
  normalized value or its refusal; edit a note; remove with a second confirming click; "show removed" lists the
  history), the passive-only switch, a "test a target" box (type, mode, value; `POST /scope/check` on Enter or the
  button only, never per keystroke) and the log (runs by default, "include checks" adds the test box's entries, paged).
  With no include rule a banner under the header says nothing is in scope and opens the panel. The filter sidebar
  has a Scope group (in scope / out of scope / not targetable, workspace totals), and the side panel a Scope section
  (decision, reason, deciding rule and its note).
- **Table view** (`web/src/table/`): TanStack Table (v9) over `GET /nodes` with the graph's filters, 50 per page,
  sorted on the server (click a header; shift-click adds a column). Clicking a row selects the node, opens exactly the
  groups on its path if it's inside collapsed ones (as pins: "+N more" stands for the rest), and centers on it. When the selection changes (e.g. a graph click), the table turns to the page that holds it
  (`at=`) and highlights the row; once. Paging away afterwards doesn't jump back. Rows of nodes not on the canvas
  are dimmer.
- **Hidden nodes:** a selected node that isn't on the canvas (its group was collapsed, or a filter change) keeps its side
  panel, built from `GET /nodes/:id`. The panel offers **Show on graph**, which opens the groups on its path (as a
  table click does). It is disabled, with the reason written out, when the filters leave the node out
  (`GET /graph/path` → `inView: false`) or the element budget is full.
- **Live updates** (`web/src/api/live.ts`): one WebSocket to `/api/ws`, reconnecting with backoff (0.5 s doubling
  to 10 s, reset after a good connection); the header shows live / reconnecting. Each event invalidates every `api`
  query, coalesced over 200 ms; a reconnect refetches at once (events may have been missed). The wrapper diffs the
  result in: only new nodes are laid out, nothing on the canvas moves. New members of an open group appear inside it;
  a collapsed group's count goes up. New nodes named by an event in the last 15 s, groups that grew, and groups the
  server folded instead of auto-opening (no room) flash a cyan halo for 2.5 s. Nothing on screen disappears because a
  scan finished: a group that now holds a node the canvas showed directly opens (§7, `keep`).
- **Highlights:** cards for every `interesting` node with its notes (markdown, no raw HTML); click = same as a row
  (opens the path to it).
- **Export:** JSON = a plain download of `GET /export` (the whole workspace). PNG = `cy.png({ full: true })` on the
  canvas color: everything loaded on the canvas, not just the viewport, as it looks (fading included), at 2× and at
  most 8,192 px a side.

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
   Since Phase 5C there are two (`server/src/mock/`); both validate every file with Zod and
   `tools/validate_output.py`, wipe the workspace, then go through the normal ingest path:
   - `pnpm mock`: the small **showcase**, `showcase.example` (`showcase.ts`): ~80 nodes from 12 fake tools with every
     node type, relation, severity (none → critical), confidence (`verified` and the tags/notes are applied with the
     PATCH route's own `updateNode`) and tag; an IP shared by two subdomains, an IPv6 address, a node only named as
     a parent, and groups nested three deep (subdomains → the app's URLs → the 27 endpoints `app.js` links to, one of
     them medium). Files in `data/mock/showcase/`.
   - `pnpm mock:large -- [--subdomains N] [--seed N] [--domain name.example]`: the seeded generator
     (`generate.ts`, `northwind.example`, seed 1337, 400 subdomains by default) for aggregation and performance
     testing. Files in `data/mock/large/`.
   - The wipe refuses a database holding any scan whose target isn't under `.example` (a real file), naming them,
     unless `--force`. `--db`, `--out`, `--no-ingest`, `--skip-python` work on both.
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
5. (5C) Graph feel (edges and labels always drawn, momentum, smooth wheel zoom, edge labels), Force | Tree layout
   modes, small showcase mock (`pnpm mock`) next to the large one (`pnpm mock:large`).
6. (5D) Graph pass before 6B: an icon per node type inside a circle (Lucide, bundled), a header legend; collapsible
   groups for every output (§7: same parent + relation + type, 2 or more, collapsed by default, the group stays as the
   members' parent, recursive collapse, risk badge, auto-open on live updates, paths opened as pins, expand all
   below), `POST /graph/view` and `GET /graph/path`.

**Phase 6 — Running tools**
1. (6A) **Scope guard** (§10): `checkScope` in `shared/`, `scope_rules`/`scope_log`/`scope_settings`, `authorize()` as
   the only producer of `ScopedTarget`, the dockerode/child_process lint guard, the scope API, `inScope` on every node
   and the `scope` filter, the Scope panel, banner and out-of-scope hatch. Both mocks seed a scope. No tool runs yet.
2. (6B) **Edge provenance** (§4–6, §8): `edge_observations` (one row per edge per scan), derived edge fields
   (`first_seen`, `last_seen`, `source_count`, `confidence`), `GET /edges/:id`, provenance on node-detail and view edges
   (group edges: the members' tools), the edge panel, thicker corroborated edges. Groundwork for 6E.
3. (6C) Orchestrator (§11): Dockerode in `server/src/runner/docker.ts` (the one file allowed to import it),
   containerized tool groups; every run takes a `ScopedTarget` from `authorize()` called right before it, and
   `assertScoped()`s it. **6C-1** (done): runner, hardening, jobs + queue, tool definitions, the subdomain enumeration
   group (subfinder, assetfinder, findomain, crt.sh) as the reference for teammates, `pnpm tools:build`,
   `pnpm tools:check`, API, Jobs tab. Later 6C steps: the other groups.
4. (6D) Presets & auto-chaining; redirect-following tools re-check scope on every hop (decisions log, 2026-10-31).
5. (6E) Diffing between scans: what a scan added, lost or changed, for nodes and edges (both have per-scan provenance).

**Phase 7+ — Later (not now)**
Reports · CVE monitoring · local LLM scoring · JS analysis agent.

**Later improvements (logged, not scheduled)**
- Filter-aware `/stats` (counts that follow the active filters, i.e. faceted counts). Today the sidebar shows
  workspace totals.
- Scope rules and settings in `GET /export` (today the export has each node's `inScope`, not the rules behind it).
- A `scope.logged` WS event, so other tabs' log panels refresh when a run is authorized (6C).

## 10. Scope guard

Goal: **no code path can run a tool against a target without passing the guard.** Phase 6A builds only the guard,
its storage, API and UI; nothing runs tools yet.

**Rules** (`shared/src/scope.ts`). Kinds: `domain` (exact), `wildcard` (`*.example.com`), `ip`, `cidr`; each an `include` or
an `exclude`. `normalizeScopeRule(kind, action, value)` validates and canonicalizes, and a refusal says why:
- Hostnames: IDNA → punycode via WHATWG `URL` (`normalizeHostname` in `normalize.ts`; `Bücher.example` →
  `xn--bcher-kva.example`), lowercase, no trailing dot; a port, path, scheme or `@` is refused, not dropped.
- Wildcards: exactly one leading `*.`. An **include** whose base is a public suffix is refused (Public Suffix List,
  ICANN and private sections, bundled with `tldts`, no network): `*.com`, `*.co.uk`, `*.com.eg`, `*.github.io`.
  Excludes may cover a whole TLD (`*.gov`).
- IPs: strict dotted-quad or IPv6, no zone ID; IPv6 compressed (RFC 5952); IPv4-mapped (`::ffff:a.b.c.d`) → IPv4.
- CIDRs: host bits must be zero (`10.0.0.5/8` → "did you mean 10.0.0.0/8?"); `::ffff:a.b.c.d/≥96` becomes the IPv4
  range, a shorter mapped prefix is refused. An **include** may be at most /8 (IPv4) or /32 (IPv6); `0.0.0.0/0` and
  `::/0` included are refused outright, with no override. Excludes can be any size.

**`checkScope(type, value, mode, { rules, passiveOnly })` → `{ decision, rule?, reason }`.** Pure; `compileScope`
prepares the rules once for checking a whole graph. In order:
1. Not targetable (technology, vulnerability, email, secret, certificate, leak) → `n/a`.
2. Resolve: domain/subdomain → the hostname; ip → the IP; port → its IP; url → its host (an IP literal, incl.
   `[v6]` and WHATWG-canonicalized forms like `0xcb.0.113.7`, goes to IP rules). A value that doesn't parse → `out`
   ("can't check an invalid …"): it fails closed.
3. A matching **exclude** → `out`, with that rule. Exclude always wins.
4. `active` while passive-only is on → `out`.
5. A matching **include** → `in`, with that rule.
6. Otherwise `out` (default deny). An empty scope, or one with only excludes, allows nothing.

Matching: domain rules exactly; wildcards on whole labels at any depth (`*.example.com` matches `a.b.example.com`,
never `example.com`, `evilexample.com` or `a.example.com.evil.com`). Hostnames only meet domain/wildcard rules and
IPs only ip/cidr rules, of the same family: **a domain in scope never puts its IPs in scope** (a CDN address is
someone else's machine), and the reason says so. A port is judged by its IP in both modes; the modes differ only by
passive-only.

**`authorize(db, target, mode)`** (`server/src/scope/authorize.ts`) is the only producer of `ScopedTarget`. It reads the
current rules and setting, logs the decision as `run` (allowed or not), and returns `{ ok: true, target }` only for
`in` (`n/a` is refused). The target's `value` is the canonical text that was judged (`canonicalTarget`), so it is
exactly what a tool may run against. Three locks against forging one:
- Type: the brand is keyed by a `unique symbol` that isn't exported; an object literal can't produce it
  (`@ts-expect-error` test, checked by `pnpm typecheck`).
- Lint: `as ScopedTarget` / `<ScopedTarget>` are errors outside `authorize.ts`.
- Runtime: issued targets live in a module-private `WeakSet`; `assertScoped()` (which the runner must call) rejects
  casts, copies and spreads.
`recordCheck()` is the test box's path: the same decision, logged as `check`, no `ScopedTarget`.

**Who may run things** (`eslint.config.js`, proven by `server/test/guard.test.ts`): `dockerode`/`docker-modem` may be
imported (statically, `import()` or `require`) only by `server/src/runner/docker.ts` (6C-1);
`node:child_process` only under `server/src/runner/`, by `server/src/mock/python.ts` (the team validator) and in tests.
The test also scans every source file for `dockerode`, so `pnpm test` catches it even without `pnpm lint`.

**Storage and API:** tables in §4, routes in §6. Rules are never deleted (the log still points at removed ones);
the only exception is the mock wipe (a disposable mock workspace, behind the same `--force` guard as its scans).
Ingest never rejects out-of-scope findings: tools may report anything; scope decides what they may be pointed at.

**Mocks:** `pnpm mock` seeds `showcase.example` + `*.showcase.example`, excludes `dev.showcase.example`, includes
`198.18.0.0/28`, `198.18.0.30` and `2001:db8::25`; `api` and `app` resolve to `198.18.0.20`, which stays out (the CDN
case). `pnpm mock:large` includes the domain + wildcard and `198.18.0.0/27`, excludes `admin.<domain>`. Passive-only
stays on.

## 11. Tool runs (orchestrator)

Phase 6C-1. A tool runs as a job: one container from its group's image, against one node, after `authorize()`.
Nothing else starts a container.

**Tool definitions** (`tools/`, loaded and checked by `server/src/runner/catalog.ts`, schema in `defs.ts`): one folder per
group, `tools/<group>/{group.json, Dockerfile, README.md}`, one folder per tool, `tools/<group>/<tool>/{tool.json,
run.py, fixtures/, test_*.py}`. `group.json`: `name`, `label`, `image` (repository), `tools` (run order). `tool.json`:
`name` (= folder = the contract's `tool`), `group`, `label`, `description`, `mode` (`passive` | `active` | `intrusive`;
scope checks `passive` as passive, the others as active), `accepts` (targetable node types), `argv` (an array; the
target is the item `{target}`, exactly once, whole), `timeoutSec`, `external` (services it contacts), `outputDir`
(`/out`). Every inconsistency (name ≠ folder, unlisted or missing tool, bad field) is reported at once; the server then
runs with the runner off (the graph still works) and `pnpm tools:check` prints the same list.

**Images:** one per group, built by `pnpm tools:build [group]` through dockerode (classic builder) from exactly the
group's build context: `tools/.dockerignore`, `validate_output.py`, `lib/`, `<group>/` minus fixtures, tests, docs
and caches (`inBuildContext`, mirrored by `.dockerignore`). The tag is the sha256 of those files
(`redwhale-tools/subdomain:<12 hex>`), labelled `redwhale.group`/`redwhale.context`, so the server can tell **built**
(this exact build), **outdated** (an older build of the group) and **missing**. Dockerfiles pin the base image by
digest and every tool to a release whose sha256 is checked (`lib/fetch_release.py`), and create user 10001 owning
`/out`. Building is the only step that downloads anything; the server never does.

**Runner** (`server/src/runner/`): `runtime.ts` is the interface (create/start/wait/kill/logs/fetch output/remove
container and volume/list by label/images); `docker.ts` implements it (named pipe or `DOCKER_HOST`); tests use a fake
(`server/test/fakeRuntime.ts`) and a real-Docker suite that runs only when Docker and the image are there. Every
container is built by `spec.ts` as plain Engine API JSON:
- user `10001:10001`, read-only root filesystem, `cap-drop ALL`, `no-new-privileges`, 1 GB memory (no swap), 1 CPU,
  256 pids, `init`, bridge network (the tools need the internet), no bind mounts, no Docker socket, json-file logs
  capped at 10 MB;
- `/tmp` a tmpfs (`noexec`, 256 MB), `HOME=/tmp`; **`/out` a per-job named volume** `redwhale-<ws>-job-<id>` (a tmpfs
  is gone once the container exits, so it couldn't be fetched); labels `redwhale.job`, `redwhale.workspace`,
  `redwhale.tool` on both;
- entrypoint + cmd = the argv exactly (no shell); the target value is one argv item and is refused if it starts with
  `-` or holds whitespace/control characters (argument injection; `authorize()` already refuses such hostnames);
- `REDWHALE_TOOL_TIMEOUT` = the tool's timeout − 30 s, so the script stops its tool and writes a partial result before
  the hard kill.

**Queue** (`orchestrator.ts`): jobs live in SQLite, oldest first, at most `REDWHALE_MAX_JOBS` (default 2) running.
1. Queueing (`POST /jobs`, `/jobs/group`): tool, node, type, Docker and image are checked first (no row, nothing
   logged on failure); then `authorize()` decides and logs (`run`); refused → a `refused` job and a 403.
2. Starting: **`authorize()` again, right before the container**; refused → `refused` ("out of scope at start"), no
   container. Then create volume + container, start, wait; past the timeout → SIGKILL, `failed` ("timed out after
   N s").
3. Always: fetch, then remove the container and its volume.
- Scope changes (any rule or setting change) re-check queued jobs without logging and cancel those now out of scope.
- Cancel: queued → cancelled; running → killed, cancelled, nothing ingested.
- Server start (`recover()`): `running` jobs → `failed` ("server restarted"), this workspace's labelled containers and
  volumes are killed and removed, queued jobs resume (re-authorized when they start). Docker is pinged every 5 s:
  while it's unreachable jobs stay queued; when it comes back the orphans are cleaned and the queue resumes. Changes are
  broadcast (`runner.status`), every job change too (`job.updated`).

**Results** (`finish.ts`): after exit, stdout/stderr (demuxed) and `/out` (`getArchive`, read as a tar) are fetched
with the caps enforced **while reading** (tar headers give real sizes): `raw.txt`, stdout, stderr ≤ 5 MB each (kept
truncated, with a note), `result.json` ≤ 50 MB (over → failed, never truncated), at most ~56 MB read in all; other
files are not kept but named with their sizes in the job's `error`. They are kept under `<db dir>/jobs/<id>/`
(`data/jobs/`). `result.json` must name the job's tool (else failed: no borrowed corroboration), then goes through
**the normal ingest**: invalid → `failed` with the exact `issues`, nothing ingested; valid → the scan is linked
(`scan_id`, `nodes_created`, `nodes_updated`) and `scan.ingested`/`graph.updated` are broadcast, so subdomains several
tools report become `corroborated`. A result whose `status` is `failed` fails the job but its scan is kept
(provenance); `partial` succeeds with a note; a timed-out job that still wrote a result is `failed` with its scan.

**Scripts** (Python, stdlib only; `tools/lib/redwhale_tool.py`): every `run.py` takes `--target`, `--out`
(`/out` in the container) and `--replay <saved output>`, and is only a command (or, for an HTTP API like crt.sh, a
`fetch`) plus a parser; `main()` does the rest (refuses option-like targets, runs the tool with a timeout, keeps
`raw.txt` capped, cleans values, skips wildcards/the apex/other domains, merges duplicates, fills in relations,
survives parser crashes, validates with `validate_output.py`, writes `result.json`). Each tool keeps a saved real
output, anonymized to `northwind.example`, with `expected.json` and a `NOTE.md`; `pnpm tools:check` (and `pnpm test`)
replays it. How to add a tool: `docs/team-guide.md`.

## 12. Decisions log

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
| 2026-10-30 | Aggregation keeps nodes visible by **effective severity** (worst finding below them), not only their own; `minSeverity` filters on it too (**superseded 2026-11-01**: there is no threshold of 25 and no sticky children any more: every set of 2+ children is a group, collapsed by default, and shows its risk instead (fill = `maxSeverity`, badge = high/critical below); `minSeverity` still filters on effective severity) |
| 2026-10-30 | Parentless nodes over the threshold aggregate as `agg:root:<type>`; aggregate `maxSeverity` covers all members |
| 2026-10-30 | Aggregate members and the node list are ordered riskiest first |
| 2026-10-30 | No node deletion: the `ignored` tag + `excludeTag` filter hides nodes (provenance is never dropped) |
| 2026-10-30 | API rejects foreign `Host`/`Origin` headers (403) in addition to binding 127.0.0.1 |
| 2026-10-30 | Mock data: `northwind.example`, IPs from 198.18.0.0/15, seed 1337, 7 fake tools; generator in `server/src/mock/` |
| 2026-10-30 | Graph fill color = the node's **own** severity (aggregates: `maxSeverity`); `effectiveSeverity` is kept for muting in Phase 5 |
| 2026-10-30 | Node types are shown by shape only for now (no icons); `interesting` = fuchsia outline, so it never clashes with a severity fill or the confidence border (**superseded 2026-11-01**: every node is a circle with its type's icon; the `interesting` outline is unchanged) |
| 2026-10-30 | shadcn/ui files are written by hand from the upstream source (no `shadcn init`), with system fonts only: no remote font or CDN imports |
| 2026-10-30 | No `cytoscape-expand-collapse`: it collapses compound nodes client-side, but aggregates are built and paged by the server (§7). The UI merges expand pages into the canvas itself (`web/src/graph/compose.ts`) (**superseded 2026-11-01**: still true; the server now draws the whole view (`POST /graph/view`) and `compose.ts` is gone) |
| 2026-10-30 | The UI loads aggregates 100 members per page and keeps the canvas under 2,000 elements: "load more" / "expand neighbors" are disabled at the limit, and anything that would cross it is skipped (**superseded 2026-11-01**: still 100 per page and ~2,000 elements, now enforced by the server, which refuses the newest asks first and reports them) |
| 2026-10-30 | Collapsing a group also drops the neighborhoods expanded from its members; a fully loaded aggregate disappears, and its members' panel/menu offer "collapse group" (**superseded 2026-11-01**: a group stays on the canvas as its members' parent, open or not; collapsing is recursive and drops neighbor expansions whose node is no longer drawn) |
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
| 2026-10-30 | Changing filters clears expanded aggregates, expanded neighborhoods and focus; the selection stays (its panel shows again if the node comes back; superseded 2026-10-30: the panel stays, see "hidden nodes") (**superseded 2026-11-01**: open groups and neighbor expansions survive a filter change; the server drops those that no longer exist. Focus is still cleared) |
| 2026-10-30 | Phase 5 step 2: a table row for a node hidden from the canvas opens its side panel without touching the canvas. The panel's **Show on graph** adds it next to a shown neighbor; disabled with the reason when no neighbor is shown or the 2,000-element budget is full. The panel is built from `GET /nodes/:id`, so it also stays open for a selected node a filter change hid |
| 2026-10-30 | `GET /nodes?at=<id>` returns the page holding that node; the table follows the selection once per change, never on later paging |
| 2026-10-30 | Table: TanStack Table v9 (`@tanstack/react-table` 9.3.1, the current major); its bundled agent skills are not installed |
| 2026-10-30 | Highlights get their own endpoint, `GET /highlights`: `GET /nodes?tag=interesting` was the first choice, but list items have no `notes` and adding them would make every table page carry up to 100 KB of notes per row. Ignores the graph filters by design; a filter param is a 400, not silently ignored |
| 2026-10-30 | Live updates refetch every active `api` query on any event (coalesced 200 ms) instead of picking queries by node ID: simpler, and only on-screen queries refetch. A node's own PATCH refetches twice (mutation + event); accepted |
| 2026-10-30 | Live flash: new nodes the event named (15 s window) and aggregates whose hidden count grew; nodes that only re-render, and expand/neighbor loads, never flash |
| 2026-10-30 | PNG export = the whole canvas as drawn (fading included), `bg` = canvas color, scale 2 capped at 8,192 px; JSON export = the whole workspace, file names `redwhale-<kind>-<UTC, no colons>` |
| 2026-10-31 | Phase 5C feel: `textureOnViewport`/`hideEdgesOnViewport`/`hideLabelsOnViewport`/`motionBlur` off, so edges and labels stay drawn mid-gesture. Measured at 1,887 elements (`mock:large --subdomains 260`, aggregation off; headless Chrome, Intel UHD iGPU, 1440×900): pan p50 6.9 ms / p95 7.4 ms; continuous zoom + pan across the label thresholds p50 13.8 ms / p95 20.9 ms. The old hide-while-moving settings measured the same for panning (p95 7.4 ms), so no fallback was needed |
| 2026-10-31 | Momentum: velocity from the last 80 ms only, capped at 3,000 px/s, glides from 150 px/s, exponential friction τ = 325 ms, stops below 20 px/s; any press, wheel or camera animation stops it. A thrown node is saved once, at rest (`onMoved` moved from `events.ts` to `momentum.ts`) |
| 2026-10-31 | Wheel zoom is ours, not Cytoscape's (`wheelSensitivity` untouched): zoom proportional to scrolled pixels (mouse = touchpad two-finger scroll; ctrl+wheel pinch faster per pixel), eased toward the cursor. Two-finger scroll stays zoom, as before |
| 2026-10-31 | Edge labels = the relation as stored (`has_subdomain`), autorotated, on a canvas-colored plate; same readability rule as node labels (≥ 8 px on screen). `min-zoomed-font-size` replaced by a class-stepped fade (half opacity, then hidden, 150 ms). A Cytoscape `transition` fade was measured first and pushed zoom p95 from ~21 ms to ~35 ms at the cap (it restyles every label every frame); the two-step fade costs the same as a hard cut |
| 2026-10-31 | Tree layout: ELK `layered` via `elkjs` 0.12.0 (0.12.1 was 3 days old), used directly in a Web Worker; not `cytoscape-elk` (pins elkjs 0.9, adds nothing we use) and not dagre (its crossing minimisation reorders siblings; no way to keep riskiest-first). Model order forced (`considerModelOrder` + `forceNodeModelOrder`), default greedy cycle breaking (`MODEL_ORDER` cycle breaking reversed the second parent edge of a shared IP), one layering for all components so every root is on the top row |
| 2026-10-31 | Tree layout time, measured on the 1,887-element graph: ELK ≈ 4.4 s in the worker (UI stays responsive; header shows "laying out tree…"); dagre 0.85 s on the same graph, but synchronous. The showcase (54 shown nodes) lays out in ~0.3 s. **Open:** whether that's acceptable near the cap |
| 2026-10-31 | Tree positions are never saved and never pin Force nodes; entering Tree snapshots Force positions, leaving restores them (new nodes get fcose around them). Dragging in Tree carries the subtree; any re-run (live update, expand, Re-layout) snaps manual tree drags back. Layout mode is view-only URL state (`layout=tree`) |
| 2026-10-31 | `pnpm mock` = small showcase (`showcase.example`, ~80 nodes, every enum value covered; a test reads the shared enums so it can't fall behind); the old generator unchanged as `pnpm mock:large`. Both wipe the workspace first (rows deleted in one transaction, so it works while the dev server holds the file) and refuse if any scan's target isn't under the reserved `.example` TLD, unless `--force`. `--domain` for `mock:large` must therefore end in `.example`. Output in `data/mock/showcase/` and `data/mock/large/` |
| 2026-10-31 | The PATCH handler's update logic moved to `server/src/graph/update.ts` (`updateNode`), shared by the route and the showcase's `verified`/tag/note annotations |
| 2026-10-31 | Phase 6A scope guard (§10): default deny; rule kinds domain / wildcard / ip / cidr, include or exclude; **exclude always wins**; `*.example.com` never matches `example.com`. Hostnames meet only domain/wildcard rules and IPs only ip/cidr rules, so a domain in scope never puts its IPs in scope. Non-targetable types (technology, vulnerability, email, secret, certificate, leak) are `n/a`. An unparseable value is `out` (fails closed) |
| 2026-10-31 | A port is judged by its IP in **both** modes (so the graph can mark it); passive and active differ only by the passive-only setting (default on: every active check is `out`) |
| 2026-10-31 | Broad includes are refused with no override: include CIDRs at most /8 (IPv4) or /32 (IPv6), so `0.0.0.0/0`/`::/0` too; wildcard includes on a Public Suffix List entry (`*.com`, `*.co.uk`, `*.com.eg`, `*.github.io`). The PSL comes from `tldts` 7.4.18 (bundled, no network; 7.4.19 was 11 days old). Excludes can be any size. CIDRs with host bits set are refused with the network suggested, not silently masked |
| 2026-10-31 | `authorize()` is the only producer of the branded `ScopedTarget` (type brand on an unexported `unique symbol` + lint ban on casts + a runtime `WeakSet` checked by `assertScoped()`). It logs every call as `run`. The runner (6B; **renumbered 2026-11-01: now 6C**) must call it **immediately before** each run, never reuse an earlier target |
| 2026-10-31 | Only `server/src/runner/docker.ts` may import `dockerode`/`docker-modem` (static, `import()`, `require`); `node:child_process` only under `server/src/runner/`, in `server/src/mock/python.ts` and tests. Enforced by ESLint and proven by `server/test/guard.test.ts`, which also scans the sources for `dockerode` |
| 2026-10-31 | Checks are logged too, with `scope_log.source` = `check` \| `run`: a record of every target anyone tested, and the log can be demoed before the runner exists. `POST /scope/check` logs (the UI's test box, on Enter/button only, never per keystroke); `GET /scope/check` doesn't, because a GET must not write (an `<img>` on any page can send one with no `Origin`). The log panel shows `run` by default with an "include checks" toggle |
| 2026-10-31 | Scope rules are soft-deleted (`removed_at`), removing is one-way (add again to restore) and kind/value/action never change, so the log's `rule_id` always points at what decided. The mock wipe is the one place scope rows are deleted (log, rules; passive-only back on) |
| 2026-10-31 | `inScope` is computed on every read (passive mode), never stored; `scope=` is one more node filter on `/graph`, `/graph/expand`, `/nodes`; `/stats` has `byScope`. Ingest never rejects out-of-scope findings. Migration `0002_scope` adds tables only (plus the settings row), so it is not breaking and needs no backfill |
| 2026-10-31 | Out-of-scope marker: a diagonal hatch over the fill (stripes 1.6/24 of the node wide, every 5/24, canvas color at 0.55 opacity). Chosen over a corner badge because it stays visible at any zoom; checked by screenshot at every severity and at zoom 2.4, 0.7 and 0.35 (at 0.35 it reads as a darker tint on the dark none/info fills). Cost, A/B in one headless-Chrome session at 1,887 elements (`mock:large --subdomains 260`, aggregation off, 76 of 647 nodes out of scope): hatch as shipped ≈ no hatch after warm-up (pan+zoom p95 136 vs 136 ms), every node hatched ≈ +60 % p95. **Open:** that session's baseline was ~50 ms p50, far off the 7 ms measured earlier the same day (the machine was busy), so re-run `await redwhale.bench()` in Firefox before relying on it |
| 2026-10-31 | **For 6C** (**renumbered 2026-11-01: now 6D**)**:** tools that follow redirects (httpx `-follow-redirects`, crawlers, nuclei with redirects) must re-check scope on **every hop**, not just the first URL. A hop that leaves scope ends that chain and is logged; the tool must not fetch it. Same for any host a tool discovers and then contacts on its own |
| 2026-11-01 | Phase 5D: node types are an **icon inside a circle**, not shapes. Icons from `lucide-static` **1.59.0** (ISC; 1.66.0 was the newest, 1.59.0 the newest at least two weeks old), one `?raw` import per icon in `web/src/graph/icons.ts` (the one type → icon map), inlined as SVG data URIs: only the 11 used icons are bundled, nothing is fetched. A type with no fitting icon gets short text (none today). Chosen: domain globe, subdomain network, ip server, port plug, url link, technology layers, vulnerability bug, email at-sign, secret key-round, certificate lock, leak database-zap |
| 2026-11-01 | Icon ink per fill: white on none and critical, slate-950 on info, low, medium, high (≥ 4.5:1 on every fill, unit-tested). Hatch, icon and badge are one Cytoscape background-image stack built by function mappers (hatch under the icon). Icons hide below 7 px on screen; the hatch and the badge stay. Legend opened from the header (closed by default) |
| 2026-11-01 | Phase 5D groups (§7): a group = same parent + same relation + same child type with **2 or more** members, at every level; one child is drawn directly. **Collapsed by default**; an open group **stays** as its members' parent (parent → group carries the relation, group → member plain). Roots group only above **25** per type (`ROOT_GROUP_THRESHOLD`), so one target domain is never "1 domain". Supersedes AGG_THRESHOLD 25, sticky children and "a fully loaded aggregate disappears" |
| 2026-11-01 | The server draws the whole view: `POST /api/graph/view` with `{ filters, expand: [{ id, pages, pins }], neighbors, expandAll, keep }` (a POST: ~2,000 open group IDs don't fit in a URL), answering with the view and the `state` it applied, which the client adopts (seeded into the cache under the new key). Smallest change that keeps one implementation of the grouping rule and the budget: the client-side merge of `/graph/expand` pages would have needed a second copy of both. `GET /graph` = the same with nothing open; `/graph/expand` and `/graph/neighbors` stay for scripts |
| 2026-11-01 | Group risk badge = distinct nodes with their **own** severity high or critical at or below the members, each counted once however many paths reach it; red if a critical is among them, orange for high only; tooltip "2 critical, 1 high below". Fill = `maxSeverity` (highest effective severity among members) |
| 2026-11-01 | Recursive collapse needs no client walk: the answer's `state` only lists open groups that are drawn, so groups opened below a closed one drop out and come back collapsed. The same rule keeps open groups across a filter change when they still exist (a group down to one member no longer exists) |
| 2026-11-01 | Live updates never hide what's on screen: each view request carries `keep` (the canvas's `relation` edges and parentless nodes). A collapsed group holding one of them (1 child became 2, or root #26 arrived) opens with its first page; if it doesn't fit it folds and flashes. A group the analyst collapsed never matches (its members were drawn through `member` edges). A selected or focused node is on the canvas, so it is covered by the same rule |
| 2026-11-01 | Search Enter, table rows, highlights and "Show on graph" open **exactly the path**: `GET /graph/path/:id` (first breadth-first path from a root, a step per group on it) opened as **pins** (`pages: 0`), so a node that is member #250 of a 400-member group opens with its siblings behind "+399 more", not 300 of them. The search jump asks the server for the riskiest match (`/nodes?q=&pageSize=1`) since it may be inside a collapsed group |
| 2026-11-01 | Budget: units in priority order (analyst opens in request order, one unit per page; neighbor expansions; expand-all, first pages then further pages; auto-opens last); the server binary-searches the longest prefix within ~2,000 elements and reports the rest in `overBudget`. Each group's `canLoadMore` is an estimate of its next page (members, their edges, what hangs below them collapsed). Measured on `mock:large` (965 nodes): 15–25 ms per view, expand-all from the domain included |
| 2026-11-01 | "Expand neighbors" kept (the only way to see a shared node's other parents): draws every parent of the node with `neighbor` edges, and opens the groups directly under it. "Expand all below" added next to it: every group below at any depth, until the budget, with a header line "opened N groups; M nodes below are still collapsed (element limit)". Groups' menu: expand / collapse / collapse all below / load more |
| 2026-11-01 | Focus mode steps through groups: parent → group → member is one hop (from a member: up to the parent, not to its siblings) |
| 2026-11-01 | Force layout of new nodes: seeded breadth-first from placed neighbors (a group's members fan out on its far side; chains of new nodes unroll outward), then fcose with every placed node pinned (≤ 800 nodes on the canvas, else only the direct neighbors). Before, a chain of new nodes started at the origin and fcose didn't see the rest of the canvas, which piled groups' members on top of existing nodes. Collapsing slides the members into their group (220 ms) before removing them. The removal never waits on the animation: layouts stop node animations without completing them (a Tree re-run right after a collapse), which first left members on the canvas without edges or clicks; a timer removes them regardless, the next diff sweeps any left, and layouts leave sliding nodes alone |
| 2026-11-01 | Showcase mock: one more link on the app's page (`/login`), one fewer quiet endpoint (27 in all), so it nests groups three deep (subdomains → app's URLs → app.js endpoints) and stays at 80 nodes |
| 2026-11-01 | Icon cost, A/B in headless Chrome (software rendering; same noisy machine as the 6A hatch A/B) at 1,945 elements (`mock:large`, expand all below the domain): with icons p50 ~55 ms / p95 ~350–360 ms; no background images p50 ~49–55 / p95 ~215 ms. Icons pre-rasterized to PNG gave p50 14–35 / p95 140–505 ms: too noisy to choose. **Open:** re-run `await redwhale.bench()` in Firefox on real graphics before changing anything; the lever if it's too slow is `ICON_MIN_PX` (hide icons sooner when zooming out) |
| 2026-11-01 | Expanding grows out of the opened node (the counterpart of the collapse slide): new nodes start at their nearest ancestor already on the canvas, walking up through other new nodes (`growOrigins`), and glide to their place (Force: 400 ms ease-out; Tree: via the tree animation). Before, Tree started only direct children at their parent (deeper new nodes flew in from the origin) and Force had no animation. Applies to live updates too; none with reduced motion |
| 2026-11-01 | Tree re-runs no longer shift what the analyst is looking at: a layered tree re-centers parents over their children, so the expanded group jumped ~210 px sideways on every expand (the camera never moved, but it read as if it did). The new tree is translated so the anchor (the node the last expand/collapse/path acted on, used once) keeps its place; otherwise the node nearest the view's middle. Fit only on switch, filter change and Re-layout, as before. Force mode never moved anything (measured 0 px) |
| 2026-11-01 | Phases renumbered: **6B edge provenance**, 6C orchestrator (was 6B), 6D presets & auto-chaining (was 6C), **6E scan diffing** (was in Phase 7+). Older entries that name 6B/6C as the runner/presets are annotated |
| 2026-11-01 | Phase 6B: edge provenance like node observations. `edge_observations` (edge, scan, tool, `data` `{}` for now, `observed_at` = the scan's `finished_at`), unique (edge, scan), so an edge reported several times in one file is one row. Every finding that names a parent records one for its scan's tool. Edges get `source_count` (distinct tools over **all** edge observations: there is no parent-only role for edges) and `confidence` `discovered` \| `corroborated` (never `verified`), and `first_seen`/`last_seen` become derived; all four are recomputed from the full set ordered (`observed_at`, `tool`, `scan_id`), like nodes, so ingest order never matters. Closes the "edges have no provenance" open item |
| 2026-11-01 | Migration `0003_edge_observations` is **breaking** (in `BREAKING_MIGRATIONS`): old edges have no provenance and there are no backfills, so `openDb` refuses a database with observations from before it (same message). drizzle-kit's generated SQL copied the new columns out of the old table (would fail); it is a hand-written DROP/CREATE of `edges`, as `0001` did |
| 2026-11-01 | View edges always carry `edgeId`, `sourceCount`, `confidence`, `tools`, `edgeCount` (nullable, like `relation`). A **group → member edge stands for the real parent → member edge**: it carries that edge's ID and provenance, is clickable and drawn thicker when corroborated. Changed from the 6B plan (member edges unclickable) because the mocks' corroborated `has_subdomain` edges are all inside groups, so otherwise no corroborated edge could be seen. Parent → group edges carry the sorted union of every member edge's tools under the current filters (drawn or not) and the member-edge count; they are **never drawn thicker**: tools across members corroborate no single relation. Per-edge tool lists otherwise stay on the server (`Graph.edgeTools`) |
| 2026-11-01 | **Known limit:** the `tool` filter still selects nodes (an edge is kept when both ends are), so it can keep an edge between two nodes that tool saw even if that tool never reported the edge. Kept as is for 6B; edge-level filtering can come with diffing (6E) if needed |
| 2026-11-01 | Edge widths: 1.5 px, 2.5 px when 2+ tools reported the real edge (group → member 1 → 2 px); the selected-edge style is unchanged. One selection at a time (node or edge). The edge panel is fetched (`GET /edges/:id`) and survives the edge leaving the canvas; a parent → group edge's panel is built from the view and closes with its group. Group → "more" edges are not selectable |
| 2026-11-02 | Phase 6C-1 (tool runner): one container per job from the group's image; `authorize()` at queueing **and** right before each container starts (both logged; `jobs.queued_scope_log_id`, `jobs.scope_log_id`); scope changes cancel queued jobs now out of scope; refused runs are kept as `refused` jobs and answered with 403 + the reason |
| 2026-11-02 | `/out` is a **per-job named Docker volume**, not a tmpfs: a tmpfs is gone once the container exits, so `getArchive` couldn't read it. Labelled with the job, removed right after the fetch, included in the startup orphan cleanup. Not a bind mount; `/tmp` stays tmpfs, the root filesystem read-only |
| 2026-11-02 | Output size caps enforced while reading the archive (tar header sizes): raw/stdout/stderr 5 MB each (truncated with a note), result.json ≤ 50 MB (else the job fails), ~56 MB read in all; unkept files reported with their sizes. Docker's own log file capped at 10 MB |
| 2026-11-02 | Container and volume names and labels carry a per-database `workspace_id` (`runner_state`), so one workspace's orphan cleanup never touches another's containers (two servers on one Docker) |
| 2026-11-02 | Jobs have integer IDs; raw output under `<db dir>/jobs/<id>/`; `pnpm mock` wipes jobs and that folder with the rest |
| 2026-11-02 | A `result.json` naming another tool fails the job (tool names drive corroboration). A tool-reported `failed` status fails the job but keeps the scan; `partial` succeeds with a note; the job shows "+N new, M updated" (`nodes_created`, `nodes_updated` = touched − created) |
| 2026-11-02 | 409 (image not built/outdated) and 503 (Docker unreachable) are answered before `authorize()`, so they log no scope decision and store no job |
| 2026-11-02 | Invalid tool definitions don't stop the server: the graph works, the runner is off (routes 503), and `pnpm tools:check` prints the same issues the server found |
| 2026-11-02 | Tool definitions are one folder per tool (`tool.json`, `run.py`, `fixtures/`, tests) under one folder per group (`group.json`, `Dockerfile`, README), so "copy a folder" is the whole template. `tools/.dockerignore` keeps fixtures and tests out of images; the image tag is the hash of the files that go in, so a script change makes the image "outdated" |
| 2026-11-02 | Subdomain group pins: base `python:3.13-slim-trixie@sha256:ae14d4ce…`, subfinder v2.17.0 (checksums.txt), assetfinder v0.1.1 (no published checksum: sha256 computed when pinned), findomain 10.0.1 (11.0 is beta); linux/amd64. dockerode 5.0.1, tar-stream 3.2.2, @types/dockerode 4.0.2 |
| 2026-11-02 | Commands: subfinder `-oJ -cs -silent -duc -max-time 8` (JSON lines with every source, no update check); assetfinder `--subs-only` (text: it has no JSON mode); findomain `-t <d> -q` (text, no resolving); crt.sh queried from Python (`?q=%25.<d>&output=json`, 3 tries, backoff 5/15 s, inside the script's time). None resolves names: the group stays passive. amass, sublist3r, chaos, shosubgo, github-subdomains and ffuf later |
| 2026-11-02 | Fixtures are real outputs (captured in the image against an authorized bug-bounty target) anonymized to `northwind.example` with one mapping shared by all tools; certificate IDs and serials replaced; edge cases the real output lacked are edited copies, marked in each `NOTE.md`. The real target is not named in the repo |
| 2026-11-02 | UI: Run tool is a submenu in place (disabled items show why); groups get no Run tool until 6D. `job.updated`/`runner.status` refetch only runner queries and the scope log, not the graph. "Show results" = pick the target node and highlight that scan's provenance rows |
