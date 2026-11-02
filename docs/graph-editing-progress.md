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
| 2 | Manual node API (`POST /nodes`) through ingest as tool `manual` + duplicate handling (`ifExists: return\|link`) + validation (422 in validator wording) + `manual` reserved on `POST /ingest` and CLI ingest + manual rows don't count toward `source_count` (nodes and edges), tests | next |
| 3 | UI: add-node dialog (canvas "Add node…" and node "Add child node…") | |
| 4 | UI: delete dialog, Deleted tab, live-update cleanup on `graph.deleted` | |
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

## Step 2 plan (POST /nodes)

`POST /api/nodes {type, value, label?, parentId?, relation?, severity?, tag?, notes?, x?, y?, ifExists?: 'return'|'link'}`
- Build a contract v1 doc: tool `manual`, command `added by analyst`, target = the value, started/finished = now,
  one finding (+ parent from `parentId`'s type/value, relation as given or the single allowed one).
- `ingestDocument(db, doc, now, { allowManual: true, apply(tx, result) })`: the hook sets label/tag/notes/posX/posY on a
  new node inside the ingest transaction (`updateNode` made to accept a tx).
- 201 `{ id, created: true }`; 200 existing `{ id, created: false }` with nothing written; with `ifExists: 'link'` and a
  parent: ingest just the link (manual finding on the existing node naming the parent) → `linked: true` (or false if
  the edge exists). 422 `{ error, issues }` in validator wording without `findings[0].` (`value: domain value 'X' must be lowercase`).
- `shared`: `describeManualNode(type, value)` → `{ error, normalized, id, warnings }`, and `relationsBetween(parentType, childType)`.
- `deriveNodeState` / `deriveEdgeState`: skip `MANUAL_TOOL` in `sourceCount`.
- Ingest entry points (`ingestText` via POST /ingest and CLI, and job results) refuse `tool: manual`:
  "tool 'manual' is reserved for nodes added by the analyst".

## Next action

Step 2: implement the plan above, tests (duplicate → existing, invalid → 422 wording, manual node discovered with
source_count 0, manual-only edge source_count 0, POST /ingest with tool manual → 422), then commit "Graph editing
step 2: manual node API".
