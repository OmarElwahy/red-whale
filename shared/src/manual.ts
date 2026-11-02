// Nodes the analyst adds by hand (POST /api/nodes, the "Add node" dialog). The same rules and wording as the contract
// validator, so the dialog can check a value live and the server answers with the same text.
import type { ContractFile } from './contract';
import { lintContract } from './lint';
import { MANUAL_TOOL, NODE_TYPES, RELATIONS, RELATION_TYPES, type NodeType, type Relation, type Severity } from './enums';
import { NormalizeError, normalize } from './normalize';
import { nodeId } from './nodeId';
import { checkValue } from './values';

export const MANUAL_COMMAND = 'added by analyst';

export type ManualValueCheck =
  | { ok: true; normalized: string; id: string }
  | { ok: false; error: string };

/**
 * Checks a typed value like the validator does (`domain value 'Example.com' must be lowercase`) and, when it passes,
 * gives the normalized value that will be stored and the node ID it will have.
 */
export function describeManualValue(type: NodeType, value: string): ManualValueCheck {
  const problem = checkValue(type, value);
  if (problem !== null) return { ok: false, error: `${type} value '${value}' ${problem}` };
  try {
    return { ok: true, normalized: normalize(type, value), id: nodeId(type, value) };
  } catch (e) {
    if (e instanceof NormalizeError) return { ok: false, error: `${type} value '${value}': ${e.message}` };
    throw e;
  }
}

/** Relations that may link a parent of this type to a child of that type (contract §4). Today at most one. */
export function relationsBetween(parentType: NodeType, childType: NodeType): Relation[] {
  return RELATION_TYPES.filter((r) => RELATIONS[r].parents.includes(parentType) && RELATIONS[r].children.includes(childType));
}

/** Types a node of this type can hang under. */
export function parentTypesOf(childType: NodeType): NodeType[] {
  return NODE_TYPES.filter((p) => relationsBetween(p, childType).length > 0);
}

/** Types that can hang under a node of this type. */
export function childTypesOf(parentType: NodeType): NodeType[] {
  return NODE_TYPES.filter((c) => relationsBetween(parentType, c).length > 0);
}

export interface ManualFinding {
  type: NodeType;
  value: string;
  parent?: { type: NodeType; value: string };
  relation?: Relation;
  severity?: Severity;
}

/** The synthetic contract v1 file that puts a hand-added node (or link) through the normal ingest. */
export function manualDocument(finding: ManualFinding, now: Date): ContractFile {
  const at = now.toISOString();
  return {
    contract_version: 1,
    tool: MANUAL_TOOL,
    target: finding.value,
    command: MANUAL_COMMAND,
    started_at: at,
    finished_at: at,
    status: 'success',
    errors: [],
    findings: [
      {
        type: finding.type,
        value: finding.value,
        ...(finding.parent ? { parent: finding.parent, relation: finding.relation } : {}),
        ...(finding.severity ? { severity: finding.severity } : {}),
      },
    ],
  };
}

/** Strips the `findings[0].` / `findings[0]: ` prefix: a manual node is one finding, so the field name is enough. */
export function manualIssue(text: string): string {
  return text.replace(/^findings\[0\]\.?/, '').replace(/^: /, '');
}

/** The validator's warnings for this one finding (e.g. "vulnerability has no severity"), without the path prefix. */
export function manualWarnings(finding: ManualFinding): string[] {
  const doc = manualDocument(finding, new Date(0));
  return lintContract(doc).map(manualIssue);
}
