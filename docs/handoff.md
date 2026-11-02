# RED WHALE — Context Handoff

Paste this file into a new chat to continue where we left off. It holds the context that isn't in the
other docs. Source of truth for design details is still `docs/architecture.md` (incl. the decisions log),
`docs/contract.md` and `CLAUDE.md` — attach `docs/architecture.md` too if the question is technical.

_Last updated: 2026-11-03_

## Who / what

- **Project:** RED WHALE — local, free, open-source recon framework. Tool findings → correlation graph
  (domain → subdomain → IP → port → URL → tech → vuln). DEPI graduation project.
- **Me:** team leader. I build the **graph map, the API, and the database** myself, using Claude Code.
- **Team:** teammates each study one tool and write a Python script that outputs JSON per
  `docs/contract.md`. They follow `docs/team-guide.md` and check output with
  `python3 tools/validate_output.py file.json`. Their real outputs haven't been tested end to end yet.
- **My machine:** Windows laptop (16 GB RAM), PowerShell (no `&&`; run commands one by one or use `;`).
  Repo at `D:\DEPI\Technical\Red Whale`. Logos/flowchart kept in `assets/`.

## Stack (locked)

TypeScript (pinned 6.0.x) · pnpm monorepo `shared/` `server/` `web/` · Zod · Fastify + WebSocket on
127.0.0.1:4100 · SQLite via better-sqlite3 + Drizzle · Vite + React on 127.0.0.1:5173 · Cytoscape.js + fcose ·
Zustand · TanStack Query + Table · Tailwind + shadcn/ui · react-markdown · Vitest · elkjs (Tree layout, in a Web Worker).
Dropped: `cytoscape-expand-collapse` (aggregation is server-side). Added in 6C-1: `dockerode` 5.0.1 + `tar-stream` 3.2.2 (Docker runner, only in `server/src/runner/docker.ts`), Docker Desktop (WSL2), Python tool scripts in containers. Added in 6A: `tldts` (bundled Public Suffix List, for the scope guard). Added in 5D: `lucide-static` 1.59.0 (ISC, node-type icons, bundled per icon).

## Status

| Phase | What | Status |
|---|---|---|
| 1 | Monorepo, contract Zod schema, normalization, deterministic IDs | ✅ done |
| 2 | SQLite schema (scans, nodes, edges, observations), idempotent ingest, confidence | ✅ done |
| 3 | Mock data (`northwind.example`, seed 1337), Fastify API, server-side aggregation | ✅ done |
| 4 | Graph UI: styling, side panel + provenance, tags/notes, expand/collapse, saved positions | ✅ done |
| — | Review fixes: `observations.role` (parent refs don't corroborate), ASCII/punycode hosts, docs synced | ✅ done |
| 5A | Filters sidebar, search, URL state, N-hop focus, mute low-risk | ✅ done |
| 5B | Synced table, WebSocket live updates, Highlights view, JSON/PNG export | ✅ code + tests done; manual browser check pending |
| 5C | Graph feel (edges/labels always drawn, momentum, smooth zoom, edge labels), Force/Tree layouts, small showcase mock | ✅ code + tests done; manual check pending |
| 5D | Graph pass: an icon per node type in a circle, header legend; collapsible groups for every output (2+ siblings of one kind = a group, collapsed by default, stays as the members' parent, recursive collapse, risk badge, auto-open on live updates, paths opened as pins, expand all below), `POST /graph/view`, `GET /graph/path` | ✅ code + tests done; checked in headless Chrome; manual check pending |
| 6A | Scope guard: rules + `checkScope`, `authorize()` → `ScopedTarget`, dockerode/child_process lint guard, scope API + log, `inScope` on nodes, Scope panel, banner, out-of-scope hatch, mocks seed a scope | ✅ code + tests done; manual check pending |
| 6B | Edge provenance: `edge_observations` (one per edge per scan), derived edge first/last seen, source_count, confidence (discovered/corroborated); `GET /edges/:id`; provenance on node-detail and graph edges (group edges: union of members' tools); edge side panel; corroborated edges thicker | ✅ code + tests done on branch `phase-6b` (not merged); manual check pending |
| 6C-1 | Orchestrator core + subdomain enumeration group: hardened containers (non-root, read-only, cap-drop ALL, limits, per-job `/out` volume), jobs table + SQLite queue (cap 2), `authorize()` at queueing and right before each start, restart/orphan cleanup, tool.json/group.json, one image per group (`pnpm tools:build`), subfinder/assetfinder/findomain/crt.sh with anonymized real fixtures, `pnpm tools:check`, jobs API + WS, Run tool menu, Jobs tab, Docker status chip, team guide rewritten | ✅ code + tests done on branch `phase-6c1` (not merged); manual check pending |
| Edit | Graph editing (branch `graph-editing`): add nodes by hand (canvas "Add node…", node "Add child node…"; validator rules and wording live; ingested as tool `manual`, never counts toward corroboration; duplicates never created); permanent delete of a node / its subtree / a group's members (under the current filters), with a deletion log ("Deleted" tab); refused while a job runs on a node being deleted ("Cancel job and delete") | ✅ code + tests done; manual check pending |
| 6C+ | Other tool groups (teammates' scripts), 6D presets + auto-chaining (redirects re-check scope per hop), 6E scan diffing; then reports, CVE monitor, local LLM scoring, JS agent | later |

## How I work with Claude Code

- One phase (or half-phase) per **fresh session**; always "plan first", I review the plan, then it codes.
- After each: `pnpm typecheck`, `pnpm test`, manual check, then `git add -A` + `git commit`.
- When Claude Code asks me design questions, I bring them to the chat for a second opinion.
- Rule added: until real engagement data exists, schema changes get **no backfill** — the server refuses
  to open an old-schema DB; delete `data/redwhale.db` and run `pnpm mock`.

## Recent decisions I made (Phase 5)

- Filter counts show **workspace totals** (labelled "total"); filter-aware `/stats` is a later improvement.
- Severity counts = own severity, with a tooltip that the filter also keeps parent paths.
- "Mute low-risk" = none/info/low muted by `effectiveSeverity`.
- Search should show matches **plus their ancestor path** (reuse the minSeverity logic) if that's a small change;
  otherwise matches-only, logged.
- Focus mode = canvas only. "Hide ignored" off by default; on → `excludeTag=ignored` in the URL.
- Table row for a hidden node → open side panel; a **"Show on graph"** button reveals it (disabled at the
  2,000-element cap or with no visible neighbor).
- Table supports `?at=` to jump to the selected node's page.
- Highlights view ignores graph filters. `/api/nodes` items have no notes, so it got its own `GET /api/highlights`.

## Recent decisions (Phase 5C)

- `pnpm mock` = small showcase (`showcase.example`, ~80 nodes, every type/relation/severity/confidence/tag);
  the old generator is `pnpm mock:large`. Both wipe the DB first, but refuse if it holds a real scan
  (target not under `.example`) unless `--force`.
- Tree layout = ELK layered (keeps riskiest-first sibling order; dagre can't). Tree positions are never saved.
- Edge labels show the relation; labels fade (two steps) below 8 px on screen; two-finger scroll = zoom.
- Measured at ~1,900 elements: panning p95 7 ms, zooming p95 21 ms (headless Chrome, Intel iGPU). No edge hiding.

## Recent decisions (Phase 5D, icons and groups)

- Every node is a circle with its type's icon (Lucide, bundled, no CDN); icon ink is white on none/critical fills and
  near-black on info/low/medium/high (≥ 4.5:1). No type needs a text label today (the 11 contract types all have icons;
  JS files and endpoints are `url` nodes). Legend opens from the header.
- Group = same parent + same relation + same child type, **2 or more**, at every level; one child is drawn directly.
  Collapsed by default; double-click opens it and the group **stays** as the parent; double-click again closes it and
  everything opened below it. Roots group only above 25 per type.
- No sticky risky children: the group's fill is its riskiest member, and a badge counts the distinct high/critical nodes
  below it (each once), with a tooltip "2 critical, 1 high below".
- Live update that turns one shown child into two: the new group **opens automatically** if the old child was on the
  canvas (so nothing I'm looking at disappears); if there's no room, it folds and flashes.
- Search / table / highlights / "Show on graph" open **exactly the path** to the node (pinned members, "+N more" for the
  rest). Filters keep open groups that still exist.
- "Expand neighbors" kept (shows a shared node's other parents); "Expand all below" added (stops at the 2,000 budget and
  says how many nodes stay collapsed).
- Server draws the whole view (`POST /api/graph/view`); the browser only keeps which groups are open.

## Recent decisions (Phase 6A, scope guard)

- Default deny; exclude always wins; `*.example.com` ≠ `example.com`. A domain in scope **never** puts its IPs in scope
  (only ip/cidr rules cover IPs). Ports are judged by their IP; URLs by their host. Non-targetable types are `n/a`.
- Passive-only is on by default: every active check is out until I turn it off.
- Broad includes refused, no override: CIDR broader than /8 (IPv4) or /32 (IPv6); wildcards on a public suffix
  (`*.com`, `*.co.uk`, `*.com.eg`) via the bundled Public Suffix List (`tldts`). Excludes any size.
- Checks are logged too (`source` = check | run). The test box logs only on submit; the log panel shows runs by
  default with an "include checks" toggle. `GET /scope/check` isn't logged (a GET mustn't write).
- Out-of-scope marker = thin semi-transparent diagonal hatch over the fill (visible at any zoom).
- Both mocks wipe and seed a scope; the showcase has an in-scope domain + wildcard, an excluded subdomain (dev),
  in-scope IP/CIDR, and a CDN-style IP (198.18.0.20) that in-scope subdomains resolve to but is out.
- For 6D (was "6C" before the 2026-11-01 renumbering): redirect-following tools must re-check scope on every hop.

## Recent decisions (Phase 6B, edge provenance)

- Phases renumbered: 6B edge provenance, 6C orchestrator, 6D presets & auto-chaining, 6E scan diffing.
- Edge confidence = distinct tools over every edge observation; never `verified`. Migration 0003 is breaking (delete
  `data/redwhale.db`, run `pnpm mock`).
- Group → member edges stand for the real edge: clickable, thicker when corroborated (otherwise no corroborated edge
  would be visible, since they're all inside groups). Parent → group edges show the members' tools, never thicker.
- Known limit: the `tool` filter still selects nodes, so it can keep an edge that tool never reported.

## Recent decisions (Phase 6C-1, tool runner)

- One container per job from the group's image; `authorize()` at queueing and again right before the container starts;
  scope changes cancel queued jobs; a refused run is a 403 with the reason and is kept as a `refused` job.
- `/out` is a per-job named Docker volume (a tmpfs disappears when the container exits), removed right after the fetch
  and in the startup orphan cleanup. Size caps enforced while reading (raw/logs 5 MB, result.json ≤ 50 MB).
- One folder per tool (`tool.json`, `run.py`, `fixtures/`), one image per group tagged by the hash of its files;
  `.dockerignore` keeps fixtures/tests out. Scripts: stdlib Python on top of `tools/lib/redwhale_tool.py`.
- Fixtures are real outputs from an authorized bug-bounty target, anonymized to `northwind.example` (the target isn't
  named in the repo; it was once, in a pushed progress-doc commit, then removed).
- Jobs show "+N new, M updated"; "Show results" = the target node with that scan's provenance rows highlighted.

## Recent decisions (graph editing)

- **Deleting nodes is allowed now** (supersedes "No node deletion; the `ignored` tag hides nodes"). Only the analyst's
  explicit delete from the UI or API; no code path deletes nodes on its own (CLAUDE.md rule 4 amended). No undo; the
  "Deleted" tab is a record, not a restore. Scans and jobs stay; a job on a deleted node says "node deleted".
- Two modes: the node only (its children with no other parent become roots), or with everything below (shared nodes,
  e.g. an IP also under another subdomain, stay with what's under them).
- A group delete = every member the current filters keep (not only what's drawn); the dialog says how many the filters
  hide and keep.
- Refused while a job is running on any node being deleted; "Cancel job and delete" cancels and waits first. Queued jobs
  on deleted nodes are cancelled. A later scan that finds a deleted node brings it back as a new node.
- Nodes added by hand go through the normal ingest as tool `manual` ("added by analyst"): normal ID, provenance and live
  update; never counts toward corroboration (like parent rows); `manual` is reserved (the server refuses it on ingest).
- The Add node dialog uses the validator's exact rules and wording (no silent lowercasing) and shows the stored value; an
  existing value offers "Select existing node" / "Add the parent link" instead of a duplicate.

## Open items to remember

- Graph editing manual check: add a node on the empty canvas, add a child under a domain, try a duplicate, delete a node
  with its subtree, watch a second tab update, then run subfinder on the domain and see a deleted subdomain come back.


- 5D manual check: `pnpm mock`, open groups at three levels, search deep, live ingest into an open group (see the
  5D chat for the exact steps). Re-run `await redwhale.bench()` with icons on (icons are one more background image
  per node; the 6A hatch A/B on a busy machine said every-node images cost up to +60 % p95).

- Tree layout near the 2,000 cap takes ~4.4 s (ELK in a worker, UI stays smooth, header shows progress).
  dagre would be ~0.85 s but freezes the UI and can't keep sibling order. Decide whether that's acceptable.
- Re-check the canvas feel in **Firefox** (my browser) with `await redwhale.bench()` on `pnpm mock:large` data, now
  also with the out-of-scope hatch (6A A/B: shipped hatch ≈ free, every node hatched ≈ +60 % p95; baseline was noisy).
- Test teammates' **real** JSON files: validator → `pnpm ingest` → check the graph.
- Technology names must be exactly `name/version` across all scripts, or corroboration silently fails.
  Maybe add an alias table later (`microsoft-iis` = `iis`).
- ~~Edges have no provenance yet~~ — done in 6B (`edge_observations`); scan diffing is 6E.
- 6B manual check: `pnpm mock`, click a thick (corroborated) edge and a thin one, a group edge, a member edge; check
  the export has `edgeObservations`.
- 6C-1 manual check (see the end of the 6C-1 session / docs/phase-6c1-progress.md): `pnpm tools:build`, run the
  group on an authorized domain, corroborated subdomains, cancel a running job, stop Docker → header goes red.
- Every `pnpm tools:build` after a script change leaves the previous image tag behind (`docker image prune` cleans
  them); maybe make tools:build remove older images of the group.
- Teammates who copied the old `team-tool-template` branch's template must move to `docs/team-guide.md`.
- After Phase 5: plan the DEPI demo. Best moment = running `pnpm ingest` live and watching the map grow.
  Take screenshots of each milestone for slides.
