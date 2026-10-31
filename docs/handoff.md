# RED WHALE — Context Handoff

Paste this file into a new chat to continue where we left off. It holds the context that isn't in the
other docs. Source of truth for design details is still `docs/architecture.md` (incl. the decisions log),
`docs/contract.md` and `CLAUDE.md` — attach `docs/architecture.md` too if the question is technical.

_Last updated: 2026-10-31_

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
Dropped: `cytoscape-expand-collapse` (aggregation is server-side). Docker/Dockerode comes in Phase 6B. Added in 6A: `tldts` (bundled Public Suffix List, for the scope guard).

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
| 6A | Scope guard: rules + `checkScope`, `authorize()` → `ScopedTarget`, dockerode/child_process lint guard, scope API + log, `inScope` on nodes, Scope panel, banner, out-of-scope hatch, mocks seed a scope | ✅ code + tests done; manual check pending |
| 6B+ | Docker orchestrator (runner behind `authorize()`), presets, auto-chaining (redirects re-check scope per hop), diffing, reports, CVE monitor, local LLM scoring, JS agent | later |

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
- For 6C: redirect-following tools must re-check scope on every hop.

## Open items to remember

- Tree layout near the 2,000 cap takes ~4.4 s (ELK in a worker, UI stays smooth, header shows progress).
  dagre would be ~0.85 s but freezes the UI and can't keep sibling order. Decide whether that's acceptable.
- Re-check the canvas feel in **Firefox** (my browser) with `await redwhale.bench()` on `pnpm mock:large` data, now
  also with the out-of-scope hatch (6A A/B: shipped hatch ≈ free, every node hatched ≈ +60 % p95; baseline was noisy).
- Test teammates' **real** JSON files: validator → `pnpm ingest` → check the graph.
- Technology names must be exactly `name/version` across all scripts, or corroboration silently fails.
  Maybe add an alias table later (`microsoft-iis` = `iis`).
- Edges have no provenance yet — add edge observations before scan diffing (Phase 6).
- 6B runner: call `authorize()` right before each run and `assertScoped()` the target; dockerode only in
  `server/src/runner/docker.ts` (lint + test already enforce it).
- After Phase 5: plan the DEPI demo. Best moment = running `pnpm ingest` live and watching the map grow.
  Take screenshots of each milestone for slides.
