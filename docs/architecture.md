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
| `shared/` | Zod schemas for the tool-output contract and API responses; `normalize.ts` (value normalization); `nodeId.ts` (deterministic IDs); `scope.ts` (scope rules and `checkScope`, §10); shared enums (node types, relations, severities, confidence, tags) |
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

**scope_rules** — what tools may be pointed at (§10). Never deleted: removing sets `removed_at`.
`id` (integer) · `kind` (`domain` | `wildcard` | `ip` | `cidr`) · `value` (normalized) · `action` (`include` | `exclude`) ·
`note` · `created_at` · `removed_at` (nullable). Partial unique index on (`kind`, `value`, `action`) where `removed_at IS NULL`.

**scope_log** — every scope decision asked for: the UI's test box (`check`) and every `authorize()` call (`run`)
`id` · `source` (`check` | `run`) · `target_type` · `target_value` (as asked) · `mode` (`passive` | `active`) ·
`decision` (`in` | `out` | `n/a`) · `rule_id` → scope_rules (nullable) · `reason` · `at`. Index on (`source`, `at`).

**scope_settings** — one row (`id = 1`, CHECK), created by the migration: `passive_only` (default on) · `updated_at`.

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
| `GET /graph?types=&minSeverity=&confidence=&tool=&tag=&excludeTag=&scope=&q=` | Filtered graph, **aggregated** (see §7) |
| `GET /graph/expand/:aggregateId?…filters&page=&pageSize=` | Members of an aggregate node (paged, riskiest first) |
| `GET /graph/neighbors/:nodeId?depth=1` | Neighborhood for focus mode / expanding a node |
| `GET /nodes/:id` | Node detail + edges + all observations (provenance) |
| `PATCH /nodes/:id` | Update `tag`, `notes`, `confidence: "verified"`, `pos_x/pos_y` |
| `PUT /layout` | Bulk-save node positions |
| `GET /nodes?…&page=&sort=&at=` | Paged flat list for the table view |
| `GET /highlights` | Every `interesting` node with its notes, riskiest first (not filtered, not paged) |
| `GET /stats` | Workspace counts by type, severity, confidence, tag, scope decision, tool (dashboard / filter badges); not filtered |
| `GET /scans` | Ingested scans |
| `POST /ingest` | Upload one tool-output JSON |
| `GET /export?format=json` | Full graph export (CSV/GraphML later) |
| `GET /scope/rules?removed=1` | Active scope rules, oldest first (`removed=1` adds removed ones) |
| `POST /scope/rules` | Add a rule `{ kind, value, action, note? }`: 201 normalized rule, 400 refused (says why), 409 an active twin |
| `PATCH /scope/rules/:id` | `{ note?, removed?: true }`; removing is one-way (add the rule again to restore) |
| `GET /scope/check?type=&value=&mode=` | The decision against the current scope; **not logged** (a GET must not write) |
| `POST /scope/check` | Same body/answer, **logged** as `check`: the UI's "test a target" box, on submit only |
| `GET /scope/log?source=&page=&pageSize=` | Decision log, newest first; `source` defaults to `run` (`run,check` adds the test box) |
| `GET /scope/settings`, `PATCH /scope/settings` | `{ passiveOnly }` |
| `WS /ws` (i.e. `/api/ws`) | Push events: `graph.updated`, `scan.ingested`, `scope.changed` |

Request and response shapes are the Zod schemas in `shared/src/api.ts`. Details:
- **Filters** (shared by `/graph`, `/graph/expand`, `/nodes`): `types`, `confidence`, `tool`, `tag`, `excludeTag`
  take comma-separated lists (or repeated params); `q` is a case-insensitive substring of value or label;
  `minSeverity` compares **effective severity** (§7), so the path from the root down to a finding stays in the result.
  Filters select nodes; edges are kept when both ends are kept. Unknown params are a 400.
- **Scope:** every node carries `inScope` (`in` | `out` | `n/a`), its passive-mode decision (§10), computed on every
  read from the current rules, never stored. `scope=in,out,n/a` filters on it like any other node filter (so with
  `scope=out` an out-of-scope subdomain whose apex is in scope is parentless, and lands in `agg:root:subdomain`).
  `GET /nodes/:id` adds `scope: { decision, reason, rule }`. Rule and setting changes broadcast `scope.changed`.
- **Search paths:** on `/graph` and `/graph/expand`, `q` keeps the matches **plus their ancestors** (walking up parent
  edges), so results show their path to the root. Only ancestors that pass the other filters are kept; a filtered-out
  parent ends the path. `/nodes` lists the matches only. The rule itself is `matchesQuery` in `shared/src/api.ts`, so the
  UI can tell a match from a path node without a response field.
- Hiding a node is done with the `ignored` tag (+ `excludeTag=ignored`). Nothing is ever deleted (rule 4).
- `GET /nodes` sorts with `sort=-effectiveSeverity,label` (the default); `-` means descending; nodes without a
  severity sort last in both directions. `pageSize` ≤ 500. `at=<nodeId>` returns the page that holds that node
  (under the same filters and sort) instead of `page`; if the node isn't listed, `page` is used.
- `GET /highlights` takes no params (a filter param is a 400): it is the analyst's list, whatever the view.
- `GET /export` downloads as `redwhale-export-<UTC time, no colons>.json`.
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
- **Layout modes** (header toggle **Force | Tree**; `web/src/graph/modes.ts`). Switching animates every node to its
  new place (400 ms, ease-out) and fits the view.
  - **Force:** `fcose`; nodes with saved positions are locked to them; new nodes are laid out around them, and
    nothing already on the canvas moves. Only dragged nodes are saved (debounced `PUT /layout`).
  - **Tree:** a top-down layered hierarchy over the parent edges (domain → subdomain → IP → port → URL →
    tech/vuln/…), computed by ELK `layered` (`elkjs`, in a Web Worker, loaded the first time Tree is used;
    `web/src/graph/tree.ts`). It handles DAGs: a shared IP sits below both parents. Roots = nodes with no parent
    on the canvas (a node only named as a parent is one), all on the top row. Siblings are ordered riskiest
    first (effective severity; aggregates by `maxSeverity`), then by label, and ELK keeps that order, so the
    tree is the same on every reload. Aggregates and expanded members are ordinary nodes in the tree.
  - In Tree mode, anything that changes the tree (live update, expand, "show on graph", filter change, a
    severity or label change) re-runs the layout and animates there; new nodes grow out of their parent. Only a
    switch, a filter change and **Re-layout** fit the view. Near the element cap ELK takes a few seconds; the
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
    Cytoscape skips them.
  - `prefers-reduced-motion`: no momentum, no wheel easing, no animated layouts or camera moves.
  - Dev only: `await redwhale.bench()` in the browser console pans and zooms for 5 s and reports frame times
    (`redwhale.bench({ zoom: false })` pans only). Measured at 1,887 elements (decisions log, 2026-10-31).
- **Visual language** (single file `web/src/graph/style.ts`):
  - shape/icon by node type
  - fill color by severity (none, info, low, medium, high, critical)
  - border by confidence: dashed = discovered, solid = corroborated, thick = verified
  - aggregate nodes: larger, with count badge
  - tag `ignored` → faded; `interesting` → highlight ring
  - out of scope (`inScope = out`) → thin, semi-transparent diagonal stripes over the fill (`OUT_OF_SCOPE_HATCH`, an SVG
    `background-image`): the severity color reads between them, and it uses none of the other channels (fill,
    confidence border, `interesting` outline, selection/fresh underlay). The stripes scale with the node, so the marker
    shows at every zoom (a corner badge would vanish zoomed out). `in` and `n/a` are drawn as before
  - edges: arrow toward the child; the relation (`has_subdomain`, `resolves_to`, …) as a label along the edge, on
    a small canvas-colored background so it reads over other edges
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
- **Bottom panel:** toggled from the header, under the canvas: **Table**, **Highlights** or **Scope**.
- **Scope** (`web/src/scope/ScopePanel.tsx`, §10): the header chip shows the active rule count and "passive" while
  passive-only is on (amber dot when there is no include rule). The panel has the rules (add with the server's
  normalized value or its refusal; edit a note; remove with a second confirming click; "show removed" lists the
  history), the passive-only switch, a "test a target" box (type, mode, value; `POST /scope/check` on Enter or the
  button only, never per keystroke) and the log (runs by default, "include checks" adds the test box's entries, paged).
  With no include rule a banner under the header says nothing is in scope and opens the panel. The filter sidebar
  has a Scope group (in scope / out of scope / not targetable, workspace totals), and the side panel a Scope section
  (decision, reason, deciding rule and its note).
- **Table view** (`web/src/table/`): TanStack Table (v9) over `GET /nodes` with the graph's filters, 50 per page,
  sorted on the server (click a header; shift-click adds a column). Clicking a row selects the node and centers on it
  if it's on the canvas. When the selection changes (e.g. a graph click), the table turns to the page that holds it
  (`at=`) and highlights the row; once. Paging away afterwards doesn't jump back. Rows of nodes not on the canvas
  are dimmer.
- **Hidden nodes:** selecting a node that isn't on the canvas (from the table or highlights, or after a filter
  change) opens its side panel from `GET /nodes/:id` and leaves the canvas alone. The panel offers **Show on graph**,
  which adds the node next to a neighbor that's on the canvas (with its edges to shown nodes only) and centers on it.
  It is disabled, with the reason written out, when no neighbor is shown or the element budget is full. Shown nodes
  are an overlay like expansions (`compose.ts` `reveals`), dropped on a filter change.
- **Live updates** (`web/src/api/live.ts`): one WebSocket to `/api/ws`, reconnecting with backoff (0.5 s doubling
  to 10 s, reset after a good connection); the header shows live / reconnecting. Each event invalidates every `api`
  query, coalesced over 200 ms; a reconnect refetches at once (events may have been missed). The wrapper diffs the
  result in: only new nodes are laid out, nothing on the canvas moves. New nodes named by an event in the last 15 s,
  and aggregates that grew, flash a cyan halo for 2.5 s.
- **Highlights:** cards for every `interesting` node with its notes (markdown, no raw HTML); click = same as a row.
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
     a parent, and exactly one aggregate (a JS file with `AGG_THRESHOLD + 3` endpoints). Files in `data/mock/showcase/`.
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

**Phase 6 — Running tools**
1. (6A) **Scope guard** (§10): `checkScope` in `shared/`, `scope_rules`/`scope_log`/`scope_settings`, `authorize()` as
   the only producer of `ScopedTarget`, the dockerode/child_process lint guard, the scope API, `inScope` on every node
   and the `scope` filter, the Scope panel, banner and out-of-scope hatch. Both mocks seed a scope. No tool runs yet.
2. (6B) Orchestrator: Dockerode in `server/src/runner/docker.ts` (the one file allowed to import it), containerized
   tool groups; every run takes a `ScopedTarget` from `authorize()` called right before it, and `assertScoped()`s it.
3. (6C) Presets & auto-chaining; redirect-following tools re-check scope on every hop (decisions log, 2026-10-31).

**Phase 7+ — Later (not now)**
Diffing between scans · reports · CVE monitoring · local LLM scoring · JS analysis agent.

**Later improvements (logged, not scheduled)**
- Filter-aware `/stats` (counts that follow the active filters, i.e. faceted counts). Today the sidebar shows
  workspace totals.
- Scope rules and settings in `GET /export` (today the export has each node's `inScope`, not the rules behind it).
- A `scope.logged` WS event, so other tabs' log panels refresh when a run is authorized (6B).

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
imported (statically, `import()` or `require`) only by `server/src/runner/docker.ts`, which doesn't exist until 6B;
`node:child_process` only under `server/src/runner/`, by `server/src/mock/python.ts` (the team validator) and in tests.
The test also scans every source file for `dockerode`, so `pnpm test` catches it even without `pnpm lint`.

**Storage and API:** tables in §4, routes in §6. Rules are never deleted (the log still points at removed ones);
the only exception is the mock wipe (a disposable mock workspace, behind the same `--force` guard as its scans).
Ingest never rejects out-of-scope findings: tools may report anything; scope decides what they may be pointed at.

**Mocks:** `pnpm mock` seeds `showcase.example` + `*.showcase.example`, excludes `dev.showcase.example`, includes
`198.18.0.0/28`, `198.18.0.30` and `2001:db8::25`; `api` and `app` resolve to `198.18.0.20`, which stays out (the CDN
case). `pnpm mock:large` includes the domain + wildcard and `198.18.0.0/27`, excludes `admin.<domain>`. Passive-only
stays on.

## 11. Decisions log

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
| 2026-10-30 | Changing filters clears expanded aggregates, expanded neighborhoods and focus; the selection stays (its panel shows again if the node comes back; superseded 2026-10-30: the panel stays, see "hidden nodes") |
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
| 2026-10-31 | `authorize()` is the only producer of the branded `ScopedTarget` (type brand on an unexported `unique symbol` + lint ban on casts + a runtime `WeakSet` checked by `assertScoped()`). It logs every call as `run`. The runner (6B) must call it **immediately before** each run, never reuse an earlier target |
| 2026-10-31 | Only `server/src/runner/docker.ts` may import `dockerode`/`docker-modem` (static, `import()`, `require`); `node:child_process` only under `server/src/runner/`, in `server/src/mock/python.ts` and tests. Enforced by ESLint and proven by `server/test/guard.test.ts`, which also scans the sources for `dockerode` |
| 2026-10-31 | Checks are logged too, with `scope_log.source` = `check` \| `run`: a record of every target anyone tested, and the log can be demoed before the runner exists. `POST /scope/check` logs (the UI's test box, on Enter/button only, never per keystroke); `GET /scope/check` doesn't, because a GET must not write (an `<img>` on any page can send one with no `Origin`). The log panel shows `run` by default with an "include checks" toggle |
| 2026-10-31 | Scope rules are soft-deleted (`removed_at`), removing is one-way (add again to restore) and kind/value/action never change, so the log's `rule_id` always points at what decided. The mock wipe is the one place scope rows are deleted (log, rules; passive-only back on) |
| 2026-10-31 | `inScope` is computed on every read (passive mode), never stored; `scope=` is one more node filter on `/graph`, `/graph/expand`, `/nodes`; `/stats` has `byScope`. Ingest never rejects out-of-scope findings. Migration `0002_scope` adds tables only (plus the settings row), so it is not breaking and needs no backfill |
| 2026-10-31 | Out-of-scope marker: a diagonal hatch over the fill (stripes 1.6/24 of the node wide, every 5/24, canvas color at 0.55 opacity). Chosen over a corner badge because it stays visible at any zoom; checked by screenshot at every severity and at zoom 2.4, 0.7 and 0.35 (at 0.35 it reads as a darker tint on the dark none/info fills). Cost, A/B in one headless-Chrome session at 1,887 elements (`mock:large --subdomains 260`, aggregation off, 76 of 647 nodes out of scope): hatch as shipped ≈ no hatch after warm-up (pan+zoom p95 136 vs 136 ms), every node hatched ≈ +60 % p95. **Open:** that session's baseline was ~50 ms p50, far off the 7 ms measured earlier the same day (the machine was busy), so re-run `await redwhale.bench()` in Firefox before relying on it |
| 2026-10-31 | **For 6C:** tools that follow redirects (httpx `-follow-redirects`, crawlers, nuclei with redirects) must re-check scope on **every hop**, not just the first URL. A hop that leaves scope ends that chain and is logged; the tool must not fetch it. Same for any host a tool discovers and then contacts on its own |
