// Search jump (Enter in the search box): which node on the canvas to select and center.
import { SEVERITIES, matchesQuery, type AggregateNode, type GraphNode, type Severity } from '@redwhale/shared';

type AnyNode = GraphNode | AggregateNode;

const rank = (s: Severity | null): number => (s === null ? -1 : SEVERITIES.indexOf(s));

const byRiskThenLabel = (a: { risk: number; label: string }, b: { risk: number; label: string }) =>
  b.risk - a.risk || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/**
 * The riskiest node on the canvas that matches `q` (effective severity, then label). Path nodes the server
 * keeps above the matches don't count. When every match is hidden inside a group, the riskiest group, since a
 * search graph's groups hold matches or the path to them. Null when nothing fits.
 */
export function firstMatch(nodes: readonly AnyNode[], q: string): AnyNode | null {
  if (q.trim() === '') return null;
  const matches = nodes
    .filter((n): n is GraphNode => n.type !== 'aggregate' && matchesQuery(n, q))
    .map((n) => ({ node: n, risk: rank(n.effectiveSeverity), label: n.label }));
  if (matches.length > 0) return matches.sort(byRiskThenLabel)[0]?.node ?? null;
  const groups = nodes
    .filter((n): n is AggregateNode => n.type === 'aggregate')
    .map((n) => ({ node: n, risk: rank(n.maxSeverity), label: n.label }));
  return groups.sort(byRiskThenLabel)[0]?.node ?? null;
}
