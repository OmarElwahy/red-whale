# Graph fixes progress: node position after a scan, mid-glide grab

Branch `phase-graphfix`, cut from `main` (`37a13fb`). Started 2026-11-28. Small fixes, not a phase.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Bug 1: reproduce "a moved node snaps back after a tool runs" (Force and Tree) | done: Tree only, documented; no change |
| 2 | Bug 2: mid-glide grab moves only the node (Tree); test, fix, docs | done |

## Findings

**Bug 1** was reproduced on a scratch copy of the app (scratch API + Vite, mock DB), with scans ingested through
`POST /api/ingest`. A tool run broadcasts the same `graph.updated` (`server/src/app.ts`).

- Force: a dragged node stays put after the refetch. This was checked for a plain node, a member of an opened
  group, and a Tree → Force round trip. `applyDiff` never moves nodes already on the canvas, and `layoutAdded` pins
  them all.
- Tree: the drag snaps back, because the tree re-runs. This is the documented design (§8, decisions 2026-10-31).
  It is a mismatch with what was expected, not a code bug, so nothing changed.
- If it is seen in Force again, note what was different: over 800 nodes on the canvas, a group that folded or
  opened after the scan, or filters or focus on.

**Bug 2** cause: momentum and the subtree drag both listen to `grab`, and the subtree drag was bound first. On a
press mid-glide, the subtree drag set itself up for the pressed node. Then momentum ended the old glide, and its
rest callback (`subtree.end()`) tore that new subtree drag down.

**Fix:** `web/src/graph/drags.ts` binds momentum first, then the subtree drag, and the wrapper uses it.
`web/test/drags.test.ts` shows the bug: two of its four tests failed before the fix. It covers grabbing another
node, grabbing the same node, a canvas glide, and Force.

The fix was re-checked in the scratch app: the subtree followed by +150 in all three cases (it was 0 before).

## Next action

None. The branch is ready for review and merge by the user.
