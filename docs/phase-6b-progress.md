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
| 2 | Derived edge fields (first/last seen, source_count, confidence) + order/idempotency tests | in progress |
| 3 | API: `GET /edges/:id`, edge fields on `/nodes/:id` and `/graph`, group-edge tool union, export | todo |
| 4 | UI: edge side panel, thicker corroborated edges | todo |
| 5 | Mock data + coverage test (edge confidence) | todo |
| 6 | Docs: architecture.md §4 §5 §6 §8 §9, decisions log, handoff.md | todo |

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

- drizzle-kit's generated 0003 copied the new columns out of the old  table (would fail); replaced by a hand-written
  DROP/CREATE. Re-running  reports no drift.
- The mock wipe ( wipeWorkspace) deletes  before .
- / gained  (count); the CLI prints it.
- Test helpers: , ;  includes edge observations,  unchanged.
  The old "0001 db upgrades through openDb" scope test now migrates to 0002 only (0003 is breaking).
- Edges still get first/last seen from the old min/max upsert; source_count/confidence stay at defaults until step 2.

## Next action

Step 2: add  in  (widen  to a Pick of
observedAt/tool/scanId),  in  (replace the min/max upsert with
onConflictDoNothing), tests in  and  (2 tools → corroborated, A/B vs B/A identical
edge rows, re-ingest unchanged).
