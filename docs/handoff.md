# RED WHALE — Context Handoff

Paste this file into a new chat to continue where we left off. It holds the context that isn't in the
other docs. Source of truth for design details is still `docs/architecture.md` (incl. the decisions log, §13),
`docs/contract.md` and `CLAUDE.md` — attach `docs/architecture.md` too if the question is technical.

_Last updated: 2026-11-03_

## Who / what

- **Project:** RED WHALE — local, free, open-source recon framework. Tool findings → correlation graph
  (domain → subdomain → IP → port → URL → tech → vuln). DEPI graduation project.
- **Me:** team leader. **Claude Code builds the core** (contract, database, API, graph UI) **and the orchestrator**;
  I plan, review and check by hand.
- **Team:** teammates write the scripts for the other tool groups by **copying the subdomain group template**
  (`tools/subdomain/`, one folder per tool: `tool.json`, `run.py`, `fixtures/`) and following `docs/team-guide.md`.
  Before handing in, each script must pass `pnpm tools:check <tool>` (no network). Their real scripts haven't been
  tested end to end yet.
- **My machine:** Windows laptop (16 GB RAM), PowerShell (no `&&`; run commands one by one or use `;`), Docker Desktop
  (WSL2). Repo at `D:\DEPI\Technical\Red Whale`, on GitHub at **github.com/OmarElwahy/red-whale**. Logos/flowchart in `assets/`.

## Stack (locked)

TypeScript (pinned 6.0.x) · pnpm monorepo `shared/` `server/` `web/` · Zod · Fastify + WebSocket on
127.0.0.1:4100 · SQLite via better-sqlite3 + Drizzle · Vite + React on 127.0.0.1:5173 · Cytoscape.js + fcose ·
elkjs (Tree layout, Web Worker) · Zustand · TanStack Query + Table · Tailwind + shadcn/ui · react-markdown · Vitest ·
`lucide-static` (node icons) · `tldts` (Public Suffix List, scope guard) · `dockerode` + `tar-stream` (Docker runner,
only in `server/src/runner/docker.ts`) · Python stdlib tool scripts in containers.
Dropped: `cytoscape-expand-collapse` (groups are server-side).

## Status

Main has everything through 6A. 5D, 6B, 6C-1, graph editing and 6C-2 are stacked branches
(`phase-5d-icons-groups` → `phase-6b` → `phase-6c1` → `graph-editing` → `phase-6c2`; each contains the ones before it,
and all but the 5D branch are on GitHub), **not merged** until my manual check. Merging `phase-6c2` brings in all five.

| Phase | What | Status |
|---|---|---|
| 1–4 | Monorepo + contract + IDs; SQLite + idempotent ingest + confidence; mock data + API + server-side aggregation; graph UI, side panel, provenance, tags/notes | ✅ done |
| 5A | Filters, search, URL state, N-hop focus, mute low-risk | ✅ done |
| 5B | Synced table, WebSocket live updates, Highlights, JSON/PNG export | ✅ done · manual check pending |
| 5C | Graph polish: edges/labels, momentum, smooth zoom, Force/Tree layouts, showcase mock (`pnpm mock`) | ✅ done (on main) · manual check pending |
| 6A | Scope guard: rules, `authorize()`, scope API + log, Scope panel, out-of-scope hatch | ✅ done (on main) · manual check pending |
| 5D | Icons per node type + collapsible groups (`POST /graph/view`, `GET /graph/path`) | ✅ done · manual check pending |
| 6B | Edge provenance: `edge_observations`, edge confidence, edge side panel, thicker corroborated edges | ✅ done · manual check pending |
| 6C-1 | Orchestrator (hardened containers, SQLite job queue, scope re-check before each start, Jobs tab, Docker chip) + subdomain enumeration group: subfinder, assetfinder, findomain, crt.sh; `pnpm tools:build`, `pnpm tools:check` | ✅ done · manual check pending |
| Edit | Graph editing: add nodes by hand (tool `manual`), permanent delete (node / subtree / group) with a "Deleted" log | ✅ done · manual check pending |
| 6C-2 | First active tool: tools network `redwhale-tools`, local lab `lab.redwhale.test` (`pnpm lab:up/down/status`), 428 + confirmation dialog for active runs, `http` group with httpx (never follows redirects); `{targetType}`, `contacts`, `tech_value` | ✅ done · manual check pending (checklist in `docs/phase-6c2-progress.md`) |

## How I work with Claude Code

- **Plan first**: Claude Code proposes a plan, I review it (design questions go to a chat like this one), then it codes.
- Each phase on its **own branch**; after every green step (`pnpm typecheck` + `pnpm test`) a **checkpoint commit**
  ("<phase> step N: …") and a push to GitHub.
- A `docs/<phase>-progress.md` file (steps, decisions, exact next action) is committed with each step, so a session
  that gets cut off can continue from it without asking.
- **Merge to main only after my manual check.** I do the merge.
- Until real engagement data exists, schema changes get **no backfill**: the server refuses an old-schema DB; delete
  `data/redwhale.db` and run `pnpm mock`.

## Next up

1. Tool batches, in order: dnsx → naabu + nmap → katana + gau → nuclei → wafw00f + testssl → the rest (active ones
   use `contacts`, the confirmation and the lab; scripts that name the target as a parent use `{targetType}`).
2. Redirect following stays out until 6D (httpx keeps the `Location` as data).
3. **6D** presets + auto-chaining (redirect-following tools re-check scope on every hop) → **6E** scan diffing →
   **6F** reports.

## Key decisions (short; full list in architecture.md §13)

- **Graph (5B–5D):** filter counts are workspace totals; search shows matches plus their ancestor path; Tree = ELK
  layered (keeps sibling order, positions never saved). Group = 2+ siblings with the same parent, relation and type,
  collapsed by default; the group's fill is its riskiest member, badge counts high/critical below. Search/table/
  highlights open exactly the path to a node. The server draws the whole view; the browser only keeps open groups.
- **Mocks:** `pnpm mock` = showcase (`showcase.example`, ~80 nodes), `pnpm mock:large` = big graph; both wipe the DB,
  seed a scope, and refuse a DB holding a real scan unless `--force`.
- **Scope (6A):** default deny, exclude wins, `*.example.com` ≠ `example.com`; a domain never puts its IPs in scope;
  passive-only on by default; broad includes refused (CIDR wider than /8 or /32, wildcards on a public suffix).
- **Edges (6B):** edge confidence = distinct tools over edge observations, never `verified`. Known limit: the `tool`
  filter selects nodes, so it can keep an edge that tool never reported.
- **Runner (6C-1):** one container per job, one image per group (tagged by a hash of its files); `authorize()` at
  queueing and right before start; scope changes cancel queued jobs; refused runs are kept as `refused` jobs.
  Fixtures are real outputs from an authorized target, anonymized to `northwind.example` (target never named in the repo).
- **Editing:** delete is allowed but only by the analyst (CLAUDE.md rule 4 amended), no undo; subtree delete keeps
  shared nodes that something else still reaches; group delete = members the current filters keep; refused while a job
  runs on a node ("Cancel job and delete"). Hand-added nodes go through ingest as tool `manual` and never corroborate.
- **Active tools (6C-2):** jobs run on the `redwhale-tools` network (not internal; `172.29.250.0/24`,
  `REDWHALE_NET_SUBNET`); the lab `lab.redwhale.test` (`172.29.250.10`, no host ports) is the only place to try active
  tools, and `lab:up` never touches the scope. Active runs need `confirmActive` (428 otherwise, before `authorize()`);
  the UI asks every time. Tool definitions: `{targetType}` (the server passes the node type; scripts never guess it)
  and `contacts` (required for active tools). httpx never follows redirects; technologies via `tech_value()`.

## Open items

- **Manual checks** for 5B–6C-2 (steps in each `docs/phase-*-progress.md` / `docs/graph-editing-progress.md`), then merge.
- **Teammates' real scripts** not yet tested end to end (`pnpm tools:check` → run in the group → check the graph).
- **Technology spelling:** `tech_value()` fixes case/spaces, but different tools still name things differently
  (`iis` vs `microsoft-iis`), so corroboration can silently fail: maybe an alias table later.
- **Intrusive tools** (sqlmap, SSRFmap, dalfox) vs the "no destructive payloads" promise in features.md: undecided.
- **Local authentication for the UI** is promised but not built.
- **DEPI demo plan:** live `pnpm ingest` (map grows), a group run showing corroboration, the scope guard refusing a
  target. Take screenshots of each milestone for slides.
- Smaller: Tree layout near the 2,000 cap takes ~4.4 s (acceptable?); re-check canvas feel in Firefox with
  `await redwhale.bench()`; `pnpm tools:build` leaves old image tags behind (`docker image prune`).
