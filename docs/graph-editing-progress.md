# Graph editing (add nodes by hand, delete nodes): progress

Branch `graph-editing`, cut from `phase-6c1` (59701e4; main doesn't have 6B/6C-1, and this needs the jobs table).
**Don't merge into main**: the user merges after their manual check. After each step: `pnpm typecheck` + `pnpm test`
green → commit "Graph editing step N: <what>" (with this file) → `git push` (first time `git push -u origin graph-editing`).
If a session is cut off: read this file, check `git log`, continue at "Next action". Don't ask the user.

Spec: the user's graph-editing request (add node dialog through ingest as tool `manual`; permanent delete of a node,
its subtree or a group, with a deletion log). Approved plan and the user's answers are under "Decisions".

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Delete API: node and subtree modes, groups (under filters), cascade, deletion log, jobs (`node_id` nullable, queued cancelled, running refuses / `cancelJobs=1`), `graph.deleted`, `PUT /layout` skips unknown IDs, tests | done |
| 2 | Manual node API (`POST /nodes`) through ingest as tool `manual` + duplicate handling (`ifExists: return\|link`) + validation (422 in validator wording) + `manual` reserved on `POST /ingest` and CLI ingest + manual rows don't count toward `source_count` (nodes and edges), tests | done |
| 3 | UI: add-node dialog (canvas "Add node…" and node "Add child node…") | done |
| 4 | UI: delete dialog, Deleted tab, live-update cleanup on `graph.deleted` | next |
| 5 | Docs: architecture.md (§4, §5, §6, §8, decisions log), contract.md note on `manual`, handoff.md | |

## Decisions (approved plan + user's answers, 2026-11-02)

- **Group delete** = every member the request's filters keep (server-side, all pages, not only what's loaded). The
  preview gives `target.members` and `target.hiddenByFilters`; the dialog says "Delete 37 subdomains. 5 more are
  hidden by your filters and will be kept." DELETE takes the same filter params as the view.
- **Subtree rule** (`planDeletion`, `server/src/graph/delete.ts`): S = roots + everything below; a node of S (not a
  root) stays if a walk down from any node outside S reaches it without passing through a root; the rest goes.
  Handles shared nodes and cycles. Node mode = the roots only; children left without a parent become roots.
  The subtree walk uses the whole graph (filters only pick a group's members).
- **Cascade**, one `immediate` transaction: edge_observations of affected edges → edges → observations → nodes;
  `jobs.node_id` → NULL; `deletions` row. Scans and raw files stay.
- **Jobs**: delete refused (409 `jobs-running`) while a job is **running** on any node being deleted; the dialog names
  the job and offers "Cancel job and delete" = `DELETE …&cancelJobs=1` (server cancels, waits ≤ 30 s for each to stop
  via `orchestrator.cancelAndWait`, then deletes). **Queued** jobs on deleted nodes are cancelled with error
  "target node deleted". Jobs on other nodes that later rediscover a deleted node are fine (intended).
- `expect=<node count>` on DELETE: 409 `changed` with a fresh preview if the graph changed since the preview.
- `jobs.node_id` nullable (migration `0005_graph_editing`, table rebuild, rows copied: **not breaking**). A job whose
  node was deleted stays "node deleted" even if the node comes back later.
- `PUT /layout`: unknown IDs are skipped and returned as `skipped` (was: reject the whole batch), so a pending drag
  save in another tab doesn't lose everything when a node was deleted.
- **`manual`** is a reserved tool name: the Python/Zod validators accept it (contract unchanged, contract.md gets a
  note); the server refuses it on `POST /ingest` and CLI ingest; only `POST /nodes` produces it. Manual observations
  (node and edge) don't count toward `source_count`; analyst can still mark `verified`.
- CLAUDE.md rule 4 amended (done in step 1): "...except an analyst's explicit delete from the UI or API, which removes
  the nodes with their provenance and records it in the deletion log. No code path deletes nodes automatically."
- Accepted: a hand-added node outside `.example` on a mock workspace makes the next `pnpm mock` need `--force`.
- Export: deleted nodes are simply absent; the deletion log is not exported.

## Step 2 as built (POST /nodes)

- `shared/src/manual.ts`: `describeManualValue(type, value)` → `{ ok, normalized, id }` or `{ ok: false, error }` in the
  validator's wording; `relationsBetween`, `parentTypesOf`, `childTypesOf`; `manualDocument` (the synthetic v1 file:
  tool `manual`, command `added by analyst`, target = value, both timestamps = now); `manualIssue` (drops `findings[0].`);
  `manualWarnings` (the validator's lint for that one finding). Schemas `manualNodeSchema` / `manualNodeResponseSchema` in api.ts.
- `server/src/graph/manual.ts` `addManualNode`: value check → parent (exists, not itself, relation from the two types or
  the given one, contract wording) → exists? 200 (`ifExists: link` + parent: ingest only the link, unless the edge exists)
  : ingest with `{ allowManual, apply }`; `apply` runs inside the ingest transaction (label, tag, notes, position).
  Severity is only sent for a new node. Route broadcasts `scan.ingested` (tool manual) + `graph.updated`.
- `ingestDocument(db, input, now, { allowManual?, apply? })`; without `allowManual` a `manual` file is `invalid` with
  "tool: 'manual' is reserved for nodes added by the analyst" (POST /ingest, CLI, job results all go through it).
- `deriveNodeState` / `deriveEdgeState` skip `manual` rows in `sourceCount`.

## Step 3 as built (UI: add-node dialog)

- `events.ts`: `cxttap` on the core → `onCanvasContextMenu({ x, y, modelX, modelY })`; `MenuState.id` is null for the canvas
  and carries `model` (the graph position). `items.ts`: `canvasMenuItems()` ("Add node…"), node menu ends with
  "Add child node…" (disabled with a reason when `childTypesOf` is empty; not on groups).
- `web/src/edit/AddNodeDialog.tsx` (+ `TypeIcon.tsx`), hooks in `web/src/api/edit.ts` (`useExistingNode` = GET /nodes/:id,
  404 → null; `useParentSearch` = GET /nodes?q&types=parentTypesOf; `useAddNode` invalidates everything under `api`).
- App.tsx: `adding` state. Canvas "Add node…" sends x/y only in Force mode (Tree places it); "Add child node…" never
  sends a position (laid out next to its parent). The empty-workspace message has an "add a node" button. On success
  (or "Select existing node") → `pick(id)` (select + open its path, as a table row).
- `NEEDS_SEVERITY` exported from shared/src/lint.ts (the dialog asks severity only for those types).

## Step 4 plan (UI: delete dialog, Deleted tab, live cleanup)

- Menu: node → "Delete…", group → "Delete group…" (actions `delete`); not on "more" nodes.
- `web/src/edit/DeleteDialog.tsx`: `GET /nodes/:id/delete-preview?<filters>` (group: current filters); two choices with
  counts ("Delete this node only" N nodes, M edges, K become roots / "Delete with everything below" N nodes, S shared kept;
  group: "Delete 37 subdomains. 5 more are hidden by your filters and will be kept."); red "can't be undone; tools may
  find these again". Running jobs in the chosen mode: list them, the Delete button becomes "Cancel job and delete"
  (`cancelJobs=1`). DELETE with `expect` = the shown count; 409 `changed` → show the new preview and ask again.
- `useDeleteNode` in web/src/api/edit.ts; on success apply the cleanup at once (don't wait for the WS event).
- Cleanup (`ui.ts` `forgetDeleted(nodeIds, edgeIds)`): selection/edge selection/focus/menu/anchor/centerWhenShown,
  expanded groups whose parent was deleted (`agg:<id>:…`) and pins/members that were deleted, neighbors, expandAll;
  live flash entries (`state/live.ts`); PositionSaver queue drops those IDs; the table clamps its page when past the end.
  `useLiveUpdates`: on `graph.deleted` call it and invalidate everything (incl. the runner queries: jobs show "node deleted").
- Bottom panel tab "Deleted" (`web/src/edit/DeletionsPanel.tsx`): GET /deletions paged, newest first; row = when, mode,
  what (rootLabel, type), count; expands to the removed `type value` list. Read-only.
- Tests: delete dialog (counts, hidden-by-filters text, running job → Cancel job and delete, 409 changed), ui cleanup,
  deletions panel, menu items, live event handling.

## Next action

Step 4: implement the plan above, then commit "Graph editing step 4: delete dialog, deletion list, live cleanup".
