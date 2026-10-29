// Turns a validated contract file into the rows ingest will write. Pure: no database access.
// Server-side IDs are made here (via shared/nodeId.ts); a value that can't be normalized rejects the file.
import {
  NormalizeError,
  edgeId,
  nodeId,
  normalize,
  type ContractFile,
  type NodeType,
  type Relation,
  type Severity,
} from '@redwhale/shared';
import { maxSeverity } from './derive';

export interface PlannedNode {
  id: string;
  type: NodeType;
  value: string;
  label: string;
}

export interface PlannedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: Relation;
}

/** One per node per file: repeated findings are merged (data in file order, highest severity). */
export interface PlannedObservation {
  nodeId: string;
  severity: Severity | null;
  data: Record<string, unknown>;
}

export interface IngestPlan {
  nodes: Map<string, PlannedNode>;
  edges: Map<string, PlannedEdge>;
  observations: Map<string, PlannedObservation>;
}

export type PlanResult = { ok: true; plan: IngestPlan } | { ok: false; errors: string[] };

export function planIngest(file: ContractFile): PlanResult {
  const plan: IngestPlan = { nodes: new Map(), edges: new Map(), observations: new Map() };
  const errors: string[] = [];

  /** Adds the node (first label wins) and returns its ID, or null if the value can't be normalized. */
  function addNode(type: NodeType, raw: string, path: string): string | null {
    let id: string;
    let value: string;
    try {
      value = normalize(type, raw);
      id = nodeId(type, raw);
    } catch (e) {
      if (!(e instanceof NormalizeError)) throw e;
      errors.push(`${path}: ${e.message}`);
      return null;
    }
    if (!plan.nodes.has(id)) plan.nodes.set(id, { id, type, value, label: raw.trim() });
    return id;
  }

  function observe(id: string, data: Record<string, unknown>, severity: Severity | null) {
    const prev = plan.observations.get(id);
    plan.observations.set(id, {
      nodeId: id,
      severity: maxSeverity(prev?.severity ?? null, severity),
      data: { ...prev?.data, ...data },
    });
  }

  file.findings.forEach((f, i) => {
    const where = `findings[${String(i)}]`;
    const childId = addNode(f.type, f.value, `${where}.value`);
    if (childId) observe(childId, f.data ?? {}, f.severity ?? null);

    if (f.parent == null || f.relation == null) return;
    // A parent reference counts as that tool observing the parent (decisions log, 2026-10-29).
    const parentId = addNode(f.parent.type, f.parent.value, `${where}.parent.value`);
    if (parentId) observe(parentId, {}, null);

    if (childId && parentId) {
      const id = edgeId(parentId, f.relation, childId);
      plan.edges.set(id, { id, sourceId: parentId, targetId: childId, relation: f.relation });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, plan };
}
