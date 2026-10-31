# RED WHALE — instructions for Claude Code

RED WHALE is a local, open-source recon framework. Security tools produce findings,
findings become nodes and edges in a SQLite database, and an interactive graph
(React + Cytoscape.js) lets an analyst explore the attack surface.

**This repo is currently scoped to: the data contract, the database, the API, and the graph UI.**
Running tools in containers (the orchestrator) is out of scope until Phase 6. Until then,
data enters the system only as JSON files that follow `docs/contract.md`.

Read these before starting any task:
- `docs/architecture.md` — system design, DB schema, API, and the phase plan
- `docs/contract.md` — the JSON format every tool script outputs (the most important file)
- `docs/features.md` — full product vision (for context; most of it is out of current scope)

## Stack (do not change without asking)

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere, `strict: true`, pinned to 6.0.x (typescript-eslint 8.72 doesn't support TS 7 yet). Python only for teammates' tool scripts in `tools/` |
| Monorepo | pnpm workspaces: `shared/`, `server/`, `web/` |
| Validation | Zod, in `shared/`. Validate at every boundary (ingest, API input, API output in tests) |
| Server | Fastify + `@fastify/websocket` |
| Database | SQLite via better-sqlite3 + Drizzle ORM. One `.db` file per workspace, default `./data/redwhale.db` |
| Frontend | Vite + React + Cytoscape.js (+ `cytoscape-fcose` for Force, `elkjs` layered in a Web Worker for Tree; aggregates expand through the API, not `cytoscape-expand-collapse`) |
| UI state | Zustand. Server data via TanStack Query. Table view via TanStack Table |
| Styling | Tailwind + shadcn/ui (hand-written from upstream source, system fonts only). Notes preview: `react-markdown`, no raw HTML |
| Tests | Vitest everywhere; React components with jsdom + Testing Library (`web/test/*.test.tsx`) |

## Repo layout

```
shared/     Zod schemas + TS types + node ID / normalization functions (used by server and web)
server/     Fastify API, Drizzle schema + migrations, ingest, graph queries, WebSocket
web/        React app, Cytoscape graph, side panel, filters, table view
contract/   examples/*.json — real and sample tool outputs; used as test fixtures
tools/      validate_output.py (team validator) and teammates' Python tool scripts
docs/       architecture, contract, features
scripts/    mock data generator and dev utilities
```

## Commands

Once scaffolded, these must work from the repo root:
- `pnpm dev` — server + web together
- `pnpm test` — all Vitest suites
- `pnpm typecheck` — `tsc --noEmit` across all packages
- `pnpm lint`
- `pnpm ingest <file.json>` — load one tool-output file into the DB
- `pnpm mock` — small showcase graph (~80 nodes, every node type/relation/severity/confidence/tag; files in `data/mock/showcase/`)
- `pnpm mock:large -- --subdomains 400` — large fake graph for aggregation/performance (files in `data/mock/large/`; `--seed`, `--domain x.example`)
- Both **wipe the workspace DB first** and refuse if it holds a scan not from a mock (target not under `.example`) unless `--force`; both take `--db`, `--out`, `--no-ingest`, `--skip-python`
- `pnpm dev:server` — API only, on `127.0.0.1:4100` (`REDWHALE_DB` picks the database)

Run `pnpm typecheck` and `pnpm test` after every change, and before saying a task is done.

## Hard rules

1. **The contract is law.** `shared/` Zod schemas must match `docs/contract.md` exactly. Every file in
   `contract/examples/` must pass the Zod schema AND `python3 tools/validate_output.py`. If you change
   the contract, update the doc, the Zod schema, the Python validator, and the examples together.
2. **Node IDs are deterministic.** `id = sha256(type + ":" + normalizedValue)`, truncated to 16 hex chars.
   Normalization lives in one place (`shared/src/normalize.ts`) and is fully unit-tested.
   Tool scripts never create IDs.
3. **Ingest is idempotent.** Ingesting the same file twice must not create duplicate nodes, edges,
   or observations. Merging = upsert by node ID, then add an observation row.
4. **Never drop provenance.** Every node keeps every observation: which tool, command, scan, timestamp, raw data.
5. **Confidence is computed, not stored by tools.** 1 distinct tool = `discovered`,
   2+ distinct tools = `corroborated`, analyst-confirmed = `verified`.
6. **Cytoscape owns the canvas; React owns everything around it.** Create the Cytoscape instance once
   in a `useRef`/`useEffect` wrapper and update it imperatively. Do not re-render the graph through React state.
7. **Aggregate on the server.** The browser should never receive more than ~2,000 elements at once.
   Large sibling sets (e.g. 400 subdomains of one domain) come back as one aggregate node until expanded.
8. **Localhost only.** The server binds to `127.0.0.1`. No telemetry, no external network calls
   from server or web.
9. **No `any`.** Use `unknown` and narrow with Zod.
10. Keep changes small and focused. One phase step at a time. Don't start the next phase unasked.
11. **No backfills for schema changes** until we have real engagement data (today there's only mock and example
    data, which regenerates). A migration that can't carry old rows forward goes in `BREAKING_MIGRATIONS`
    (`server/src/db/client.ts`); the server then refuses an old database with "Database is from an older schema.
    Delete data/redwhale.db and run pnpm mock (or re-ingest your files)."

## How to work in this repo

- Start each task by stating which phase/step from `docs/architecture.md` it belongs to.
- For anything bigger than a small fix: propose a plan first, wait for approval, then implement.
- Write tests alongside code, not after. Parsers/ingest use files in `contract/examples/` as fixtures.
- When a teammate's script output fails validation, report exactly which rule failed;
  don't silently "fix" their data inside ingest.
- If something in the docs is ambiguous or contradictory, ask instead of guessing.
