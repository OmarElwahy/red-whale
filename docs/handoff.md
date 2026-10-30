# RED WHALE — Context Handoff

Paste this file into a new chat to continue where we left off. It holds the context that isn't in the
other docs. Source of truth for design details is still `docs/architecture.md` (incl. the decisions log),
`docs/contract.md` and `CLAUDE.md` — attach `docs/architecture.md` too if the question is technical.

_Last updated: 2026-10-30_

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
Zustand · TanStack Query + Table · Tailwind + shadcn/ui · react-markdown · Vitest.
Dropped: `cytoscape-expand-collapse` (aggregation is server-side). Docker/Dockerode comes in Phase 6.

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
| 6+ | **Scope guard first**, then Docker orchestrator, presets, auto-chaining, diffing, reports, CVE monitor, local LLM scoring, JS agent | later |

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

## Open items to remember

- Test teammates' **real** JSON files: validator → `pnpm ingest` → check the graph.
- Technology names must be exactly `name/version` across all scripts, or corroboration silently fails.
  Maybe add an alias table later (`microsoft-iis` = `iis`).
- Edges have no provenance yet — add edge observations before scan diffing (Phase 6).
- Phase 6 must start with the **scope guard** so no code path runs a tool without it.
- After Phase 5: plan the DEPI demo. Best moment = running `pnpm ingest` live and watching the map grow.
  Take screenshots of each milestone for slides.
