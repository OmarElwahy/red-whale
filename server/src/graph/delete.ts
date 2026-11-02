// Analyst deletes (DELETE /api/nodes/:id, docs/architecture.md §6): which nodes and edges go, and removing them.
// The one code path that deletes nodes; nothing calls it automatically (CLAUDE.md rule 4).
import {
  NODE_TYPES,
  parseAggregateId,
  type DeletionKind,
  type DeletionMode,
  type GraphFilters,
  type NodeType,
} from '@redwhale/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/client';
import { deletions, edgeObservations, edges, jobs, nodes, observations } from '../db/schema';
import type { JobRow } from '../runner/orchestrator';
import { PLURAL } from './aggregate';
import { filteredGraph, groupMembers, loadGraph } from './store';

export interface EdgeLink {
  id: string;
  source: string;
  target: string;
}

export interface DeletionPlan {
  nodeIds: string[];
  edgeIds: string[];
  /** Surviving nodes whose every parent is removed: they become roots. */
  orphans: number;
  /** Nodes below the roots that stay, because a node that isn't removed reaches them too. */
  keptShared: number;
}

function multiMap(pairs: Iterable<[string, string]>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [k, v] of pairs) {
    const list = map.get(k);
    if (list) list.push(v);
    else map.set(k, [v]);
  }
  return map;
}

/**
 * Pure. `node`: the roots only. `subtree`: the roots and everything below them, except what a node outside that set
 * still reaches without passing through a root (a shared IP under another subdomain stays, and so does everything
 * below it). Reachability rather than "every parent removed", so a cycle below the roots (url ⇄ url) still goes.
 * Every edge touching a removed node goes with it.
 */
export function planDeletion(links: readonly EdgeLink[], roots: readonly string[], mode: DeletionMode): DeletionPlan {
  const rootSet = new Set(roots);
  const children = multiMap(links.map((e) => [e.source, e.target]));
  let removed = rootSet;
  let keptShared = 0;

  if (mode === 'subtree') {
    const below = new Set(rootSet);
    const queue = [...rootSet];
    for (let i = 0; i < queue.length; i++) {
      for (const c of children.get(queue[i] ?? '') ?? []) {
        if (below.has(c)) continue;
        below.add(c);
        queue.push(c);
      }
    }
    // Walk down from every node outside the set; whatever it reaches inside (roots excepted) stays.
    const kept = new Set<string>();
    const stays: string[] = [];
    const keep = (id: string) => {
      if (!below.has(id) || rootSet.has(id) || kept.has(id)) return;
      kept.add(id);
      stays.push(id);
    };
    for (const e of links) if (!below.has(e.source)) keep(e.target);
    for (let i = 0; i < stays.length; i++) for (const c of children.get(stays[i] ?? '') ?? []) keep(c);
    removed = new Set([...below].filter((id) => !kept.has(id)));
    keptShared = kept.size;
  }

  const parents = multiMap(links.map((e) => [e.target, e.source]));
  let orphans = 0;
  for (const [child, ps] of parents) {
    if (!removed.has(child) && ps.every((p) => removed.has(p))) orphans += 1;
  }
  return {
    nodeIds: [...removed],
    edgeIds: links.filter((e) => removed.has(e.source) || removed.has(e.target)).map((e) => e.id),
    orphans,
    keptShared,
  };
}

/** What a delete names: a node, or a group's members under the filters. */
export interface DeleteTarget {
  kind: DeletionKind;
  id: string;
  type: NodeType;
  /** The node's value; for a group, its parent's value ('' for a group of roots). */
  value: string;
  label: string;
  roots: string[];
  /** A group's members the filters hide (kept). */
  hiddenByFilters: number;
}

export type TargetResult = { ok: true; target: DeleteTarget } | { ok: false; status: 400 | 404; error: string };

/** A node ID, or a group ID (`agg:…`) whose members are the ones the filters keep, every page of them. */
export function resolveTarget(db: Db, id: string, filters: GraphFilters): TargetResult {
  if (!id.startsWith('agg:')) {
    const node = db.select().from(nodes).where(eq(nodes.id, id)).get();
    if (!node) return { ok: false, status: 404, error: `node ${id} not found` };
    return {
      ok: true,
      target: { kind: 'node', id, type: node.type, value: node.value, label: node.label, roots: [id], hiddenByFilters: 0 },
    };
  }

  const key = parseAggregateId(id);
  if ('error' in key) return { ok: false, status: 400, error: key.error };
  const parent = key.parentId === null ? null : db.select().from(nodes).where(eq(nodes.id, key.parentId)).get();
  if (parent === undefined) return { ok: false, status: 404, error: `node ${key.parentId ?? ''} not found` };
  const shown = groupMembers(filteredGraph(db, filters, { searchPaths: true }), key).members.map((n) => n.id);
  if (shown.length === 0) return { ok: false, status: 404, error: `group ${id} has no members under these filters` };
  const shownSet = new Set(shown);
  const hidden = groupMembers(loadGraph(db), key).members.filter((n) => !shownSet.has(n.id)).length;
  const what = `${String(shown.length)} ${PLURAL[key.childType]}`;
  return {
    ok: true,
    target: {
      kind: 'group',
      id,
      type: key.childType,
      value: parent?.value ?? '',
      label: parent ? `${what} under ${parent.label}` : `${what} without a parent`,
      roots: shown,
      hiddenByFilters: hidden,
    },
  };
}

/** `column IN (ids)` with the whole list bound as one JSON parameter. */
function inIds(column: AnySQLiteColumn, ids: readonly string[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

function loadLinks(db: Db): EdgeLink[] {
  return db.select({ id: edges.id, source: edges.sourceId, target: edges.targetId }).from(edges).all();
}

function jobsOn(db: Db, nodeIds: readonly string[], status: 'running' | 'queued'): JobRow[] {
  if (nodeIds.length === 0) return [];
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, status), inIds(jobs.nodeId, nodeIds)))
    .orderBy(jobs.id)
    .all();
}

export interface DeletionCounts {
  nodes: number;
  edges: number;
  orphans: number;
  keptShared: number;
  runningJobs: JobRow[];
  queuedJobs: number;
}

export interface Preview {
  target: DeleteTarget;
  node: DeletionCounts;
  subtree: DeletionCounts;
}

/** What each mode would remove. Read only. */
export function previewDeletion(db: Db, target: DeleteTarget): Preview {
  const links = loadLinks(db);
  const counts = (mode: DeletionMode): DeletionCounts => {
    const plan = planDeletion(links, target.roots, mode);
    return {
      nodes: plan.nodeIds.length,
      edges: plan.edgeIds.length,
      orphans: plan.orphans,
      keptShared: plan.keptShared,
      runningJobs: jobsOn(db, plan.nodeIds, 'running'),
      queuedJobs: jobsOn(db, plan.nodeIds, 'queued').length,
    };
  };
  return { target, node: counts('node'), subtree: counts('subtree') };
}

export type DeleteOutcome =
  | { ok: true; deletionId: number; nodeIds: string[]; edgeIds: string[]; cancelledJobs: number[] }
  | { ok: false; reason: 'jobs-running' | 'changed'; error: string }
  | { ok: false; reason: 'target'; status: 400 | 404; error: string };

export const DELETED_TARGET_ERROR = 'target node deleted';

/**
 * Removes the nodes, their observations, every edge touching them and those edges' observations, in one transaction,
 * and records it in `deletions`. Scans stay (provenance for other nodes). Queued jobs on removed nodes are cancelled;
 * every job on them keeps its row with `node_id` NULL. Refused while a job is running on any removed node, and, with
 * `expect`, when the node count differs from what the analyst confirmed.
 */
export function executeDeletion(
  db: Db,
  id: string,
  filters: GraphFilters,
  mode: DeletionMode,
  expect: number | undefined,
  now: Date = new Date(),
): DeleteOutcome {
  return db.transaction(
    (): DeleteOutcome => {
      const resolved = resolveTarget(db, id, filters);
      if (!resolved.ok) return { ok: false, reason: 'target', status: resolved.status, error: resolved.error };
      const { target } = resolved;
      const plan = planDeletion(loadLinks(db), target.roots, mode);
      if (expect !== undefined && plan.nodeIds.length !== expect) {
        return {
          ok: false,
          reason: 'changed',
          error: `the graph changed: this would now delete ${String(plan.nodeIds.length)} nodes, not ${String(expect)}`,
        };
      }
      const running = jobsOn(db, plan.nodeIds, 'running');
      if (running.length > 0) {
        const list = running.map((j) => `${j.tool} on ${j.targetValue} (job ${String(j.id)})`).join(', ');
        return { ok: false, reason: 'jobs-running', error: `a job is running on a node being deleted: ${list}` };
      }

      const at = now.toISOString();
      if (plan.edgeIds.length > 0) {
        db.delete(edgeObservations).where(inIds(edgeObservations.edgeId, plan.edgeIds)).run();
        db.delete(edges).where(inIds(edges.id, plan.edgeIds)).run();
      }
      db.delete(observations).where(inIds(observations.nodeId, plan.nodeIds)).run();
      const cancelledJobs = db
        .update(jobs)
        .set({ status: 'cancelled', error: DELETED_TARGET_ERROR, finishedAt: at })
        .where(and(eq(jobs.status, 'queued'), inIds(jobs.nodeId, plan.nodeIds)))
        .returning({ id: jobs.id })
        .all()
        .map((j) => j.id);
      db.update(jobs).set({ nodeId: null }).where(inIds(jobs.nodeId, plan.nodeIds)).run();
      const removed = db
        .select({ type: nodes.type, value: nodes.value })
        .from(nodes)
        .where(inIds(nodes.id, plan.nodeIds))
        .all()
        .sort((a, b) => NODE_TYPES.indexOf(a.type) - NODE_TYPES.indexOf(b.type) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
      db.delete(nodes).where(inIds(nodes.id, plan.nodeIds)).run();

      const row = db
        .insert(deletions)
        .values({
          at,
          kind: target.kind,
          mode,
          rootType: target.type,
          rootValue: target.value,
          rootLabel: target.label,
          nodeCount: plan.nodeIds.length,
          edgeCount: plan.edgeIds.length,
          removed,
        })
        .returning({ id: deletions.id })
        .get();
      return { ok: true, deletionId: row.id, nodeIds: plan.nodeIds, edgeIds: plan.edgeIds, cancelledJobs };
    },
    { behavior: 'immediate' },
  );
}

/** Jobs by ID (for job.updated after a delete cancelled them). */
export function jobRows(db: Db, ids: readonly number[]): JobRow[] {
  return ids.length === 0 ? [] : db.select().from(jobs).where(inArray(jobs.id, [...ids])).all();
}
