// Every scan that reported the node or edge (CLAUDE.md rule 4). A row opens to show that tool's raw data.
import { Fragment, useState } from 'react';
import type { NodeDetailResponse } from '@/api/hooks';
import { formatTime } from './format';

/** A node's observation, or an edge's (which has no role or severity). */
type Observation = Pick<NodeDetailResponse['observations'][number], 'scanId' | 'tool' | 'command' | 'data' | 'observedAt'> &
  Partial<Pick<NodeDetailResponse['observations'][number], 'role' | 'severity'>>;

export function ProvenanceTable({ observations }: { observations: readonly Observation[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (observations.length === 0) return <p className="text-muted-foreground text-xs">No observations.</p>;

  const toggle = (scanId: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(scanId)) next.add(scanId);
      return next;
    });
  };

  return (
    <table className="w-full table-fixed text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th className="w-24 py-1 font-medium">Tool</th>
          <th className="py-1 font-medium">Command</th>
          <th className="w-32 py-1 font-medium">Time (UTC)</th>
        </tr>
      </thead>
      <tbody>
        {observations.map((o) => {
          const expanded = open.has(o.scanId);
          return (
            <Fragment key={o.scanId}>
              <tr className="border-t align-top">
                <td className="py-1 pr-2">
                  <button
                    type="button"
                    className="hover:text-foreground flex items-center gap-1 text-left font-medium"
                    aria-expanded={expanded}
                    title="Show this tool's raw data"
                    onClick={() => {
                      toggle(o.scanId);
                    }}
                  >
                    <span aria-hidden>{expanded ? '▾' : '▸'}</span>
                    {o.tool}
                  </button>
                  {o.role === 'parent' && (
                    <span
                      className="text-muted-foreground block pl-3"
                      title="Only named as the parent of a finding; doesn't count toward confidence"
                    >
                      as parent
                    </span>
                  )}
                  {o.severity && <span className="text-muted-foreground block pl-3">{o.severity}</span>}
                </td>
                <td className="truncate py-1 pr-2 font-mono" title={o.command}>
                  {o.command}
                </td>
                <td className="py-1 tabular-nums">{formatTime(o.observedAt)}</td>
              </tr>
              {expanded && (
                <tr>
                  <td colSpan={3} className="pb-2">
                    <pre className="bg-background max-h-60 overflow-auto rounded-md border p-2 font-mono text-[11px]">
                      {JSON.stringify(o.data, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
