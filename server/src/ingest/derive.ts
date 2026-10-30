// Derived node state (docs/architecture.md §4–5). Pure: everything is recomputed from the node's
// full observation set, so the result doesn't depend on the order files were ingested in.
import { SEVERITIES, type Confidence, type ObservationRole, type Severity } from '@redwhale/shared';

export interface ObservationInput {
  scanId: string;
  tool: string;
  role: ObservationRole;
  severity: Severity | null;
  data: Record<string, unknown>;
  observedAt: string;
}

export interface DerivedNodeState {
  sourceCount: number;
  confidence: Confidence;
  severity: Severity | null;
  data: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

export function maxSeverity(a: Severity | null, b: Severity | null): Severity | null {
  if (a === null) return b;
  if (b === null) return a;
  return SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oldest first; ties broken by tool then scan, so the order is fully deterministic. */
export function compareObservations(a: ObservationInput, b: ObservationInput): number {
  return compareText(a.observedAt, b.observedAt) || compareText(a.tool, b.tool) || compareText(a.scanId, b.scanId);
}

export function deriveNodeState(observations: readonly ObservationInput[], current: Confidence): DerivedNodeState {
  const sorted = [...observations].sort(compareObservations);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) throw new Error('deriveNodeState needs at least one observation');

  // Only findings count: a tool that merely names the node as a parent doesn't corroborate it.
  // Parent rows still count as sightings for first/last seen.
  const sourceCount = new Set(sorted.filter((o) => o.role === 'finding').map((o) => o.tool)).size;
  let severity: Severity | null = null;
  let data: Record<string, unknown> = {};
  for (const o of sorted) {
    severity = maxSeverity(severity, o.severity);
    data = { ...data, ...o.data };
  }

  return {
    sourceCount,
    // `verified` is the analyst's call and is never downgraded automatically.
    confidence: current === 'verified' ? 'verified' : sourceCount >= 2 ? 'corroborated' : 'discovered',
    severity,
    data,
    firstSeen: first.observedAt,
    lastSeen: last.observedAt,
  };
}
