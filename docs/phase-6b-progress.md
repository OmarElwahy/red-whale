# Phase 6B — Edge provenance: progress

Branch `phase-6b`, cut from `phase-5d-icons-groups` (45d6e1f; main doesn't have 5D yet). Don't merge into main:
the user merges after their manual check. After each step: `pnpm typecheck` + `pnpm test` green →
commit "6B step N: <what>" (with this file) → `git push`.

Spec: the user's 6B request (edge_observations, derived edge fields, GET /edges/:id, edge panel, thicker
corroborated edges). The approved plan is summarized under "Decisions" below.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | `edge_observations` table + migration `0003_edge_observations` + ingest writing it, tests | done |
| 2 | Derived edge fields (first/last seen, source_count, confidence) + order/idempotency tests | done |
| 3 | API: `GET /edges/:id`, edge fields on `/nodes/:id` and `/graph`, group-edge tool union, export | done |
| 4 | UI: edge side panel, thicker corroborated edges | done |
| 5 | Mock data + coverage test (edge confidence) | done |
| 6 | Docs: architecture.md §4 §5 §6 §8 §9, decisions log, handoff.md | done |

## Decisions (made along the way; user may overrule)

- The user didn't answer the plan's two questions before saying go; the recommended defaults are used:
  - **Phase renumbering** in architecture.md §9 (step 6): 6B edge provenance, 6C orchestrator, 6D presets &
    auto-chaining, 6E scan diffing. Fix "runner (6B)"/"For 6C" references in §10, decisions log, handoff.md.
  - **Group edge click** → a small panel from the view edge (parent → group, relation, "N edges, reported by:
    tools…"), no fetch. **Member and "more" edges stay unclickable.**
- One migration (`0003_edge_observations`) does the whole schema in step 1: the new table **and** the new
  `edges.source_count`/`edges.confidence` columns, so step 2 adds no second breaking migration. It drops and
  recreates `edges` (as 0001 did for observations) and is in `BREAKING_MIGRATIONS`.
- `EDGE_CONFIDENCE_LEVELS = ['discovered', 'corroborated']` in `shared/src/enums.ts` (no `verified` for edges).
- View edges: `relation`/`neighbor` carry `sourceCount` + `confidence`; `group` edges carry `tools` (sorted union
  over all the group's member edges under the current filters) + `edgeCount`, with `sourceCount`/`confidence`
  null; `member`/`more` edges: all null. Per-edge tools stay server-internal otherwise.
- Group edges are **not** drawn thicker (a union of 2 tools across members doesn't corroborate any one relation).
- Tool filter unchanged (selects nodes; an edge is kept when both ends are) — log as a known limit.
- The "edges have no provenance" open item lives in `docs/handoff.md` (line ~118); close it there.

## Notes from step 1

- drizzle-kit's generated 0003 copied the new columns out of the old `edges` table (would fail); replaced by a
  hand-written DROP/CREATE. Re-running `pnpm --filter @redwhale/server db:generate` reports no drift.
- The mock wipe (`server/src/mock/cli.ts` wipeWorkspace) deletes `edge_observations` before `edges`.
- `IngestResult` / `ingestResponseSchema` gained `edgeObservations` (a count); the CLI prints it.
- Test helpers: `schema0002Db(withData)`, `migrateTo(path, n)`; `snapshot()` includes edge observations, `counts()`
  unchanged. The old "0001 db upgrades through openDb" scope test now migrates to 0002 only (0003 is breaking).
- Edges still get first/last seen from the old min/max upsert; source_count/confidence stay at defaults until step 2.
- Shell gotcha: don't write this file through bash heredocs/`node -e` with backticks (bash expands them). Use Edit.

## Notes from step 2

- `deriveEdgeState` (derive.ts) + `recomputeEdges` (ingest.ts) after `recomputeNodes`, inside the one transaction.
  Every edge observation counts toward source_count (there's no parent-only role for edges).
- Tests: derive.test.ts `deriveEdgeState`; ingest.test.ts `describe('edge provenance')`.
- The 4 contract examples have no corroborated edge (each edge comes from one tool); asserted in a test.

## Notes from step 3

- `Graph` (server/src/graph/store.ts) has a required `edgeTools` map (edge ID → sorted distinct tools), passed through
  `applyFilters` and the neighbors route; `render()` in aggregate.ts builds view edges via `realEdge()` /
  `NO_PROVENANCE` and fills group edges with `toolUnion()` over `set.edgeOf` (all members under the filters).
- `ViewEdge` fields `sourceCount`, `confidence`, `tools`, `edgeCount` are **required and nullable** (same style as
  `relation`). web/test/fixtures.ts `edge()` fills them per kind.
- New `server/src/routes/edges.ts` (`edgeDetail`, `edgeRoutes`), registered in app.ts. Tests:
  server/test/api/edges.test.ts (detail, 404, 403, node-detail fields, group union incl. a filter, export).

## Notes from step 4

- **Changed from the plan: group → member edges ARE clickable and DO show provenance.** In both mocks the
  corroborated `has_subdomain` edges are inside groups (drawn group → member), so with member edges unclickable no
  corroborated edge could be seen in the UI. A member edge stands for exactly one real edge, so `ViewEdge` gained
  `edgeId` (the real edge: itself on relation/neighbor, parent → member on member; null on group/more) and member
  edges carry that edge's `sourceCount`/`confidence`. Only "more" edges are unclickable (`selectable: false`).
- Widths (`web/src/graph/style.ts`): `EDGE_WIDTH` 1.5, `CORROBORATED_EDGE` 2.5 (sourceCount ≥ 2, data selector);
  member edges `MEMBER_EDGE` 1 → 2 when corroborated. Parent → group edges never thicker. Selected edge style
  unchanged (`edge:selected`, already existed). Legend: new "Edges" section.
- State: `selectedEdgeId` + `selectEdge` in ui.ts (exclusive with `selectedId`; background tap clears both). The
  store holds the **real** edge ID (or the `edge:agg:…` view ID for a group edge); App resolves the canvas element
  (`canvasEdgeId`) for highlighting and renders `SelectedEdgePanel` → `EdgePanel` (fetches `/api/edges/:id`, stays
  when the edge leaves the canvas) or `GroupEdgePanel` (from the view; gone with its group).
- Ends in the panel: a node is picked like a table row (`pick`: select + open path); a group end is selected + centered.
- Not run in a browser in this session (manual check for the user).

## Notes from step 5

- No generator change needed: subfinder + amass (and others) already report the same edges in both mocks.
- showcase.test.ts: "covers every edge confidence" (reads `EDGE_CONFIDENCE_LEVELS`; every edge has observations;
  source_count = distinct tools). mock.test.ts: "edges reported by two tools and by one" for --subdomains 1 and 400.

## Notes from step 6

- architecture.md §4, §5, §6, §8, §9 (renumbered) and 6 decisions-log rows; older rows naming 6B/6C as runner/presets
  are annotated "renumbered", not rewritten. handoff.md: status, 6B decisions, open item closed, manual check added.
  Code comments / the Scope panel's empty-log text now say the runner is Phase 6C.
- Smoke: `pnpm mock --db <scratch>` → 80 nodes, 83 edges (8 corroborated, 75 discovered), 91 edge observations.

## Next action

**6B is complete on `phase-6b`.** Waiting for the user's manual check and merge (don't merge into main).
If anything else is asked, it's a new task. (Original step-6 instructions, done:)

Step 6 (docs). architecture.md: §4 (edges columns, `edge_observations` table, edge confidence rule, 0003 breaking),
§5 (ingest step 3 + edge recompute), §6 (`GET /edges/:id`, edge fields on /nodes/:id and graph/view edges incl.
`edgeId`/`tools`/`edgeCount`, export `edgeObservations`, tool-filter limit), §8 (edge click/panel, widths, legend),
§9 renumber (6B edge provenance, 6C orchestrator, 6D presets & auto-chaining, 6E scan diffing; fix "runner (6B)" and
"For 6C" references in §10 and the decisions log text where they name phases), decisions log rows (2026-11-01).
handoff.md: Status row for 6B, close the "Edges have no provenance" open item (~line 118), renumbered phases.
Then: final typecheck/test/lint, commit "6B step 6: docs", push, and give the user the manual checks.
