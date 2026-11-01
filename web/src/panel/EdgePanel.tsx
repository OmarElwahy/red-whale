// Right-hand panel for a selected edge (docs/architecture.md §8). A real edge: relation, its two ends (clickable),
// first/last seen, confidence and every scan that reported it, from GET /api/edges/:id. A parent → group edge has no
// row of its own: it shows what the view says about it (the members' tools and how many edges they are).
import type { ViewEdge } from '@redwhale/shared';
import type { ReactNode } from 'react';
import { useEdgeDetail } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatTime } from './format';
import { ProvenanceTable } from './ProvenanceTable';
import { Field, Section } from './SidePanel';

interface End {
  id: string;
  label: string;
}

function Shell({ badge, title, onClose, children }: { badge: string; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside aria-label="Edge details" className="bg-card flex w-96 shrink-0 flex-col overflow-y-auto border-l">
      <header className="flex items-start gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Badge variant="secondary" className="mb-1">
            {badge}
          </Badge>
          <h2 className="text-sm font-semibold break-words">{title}</h2>
        </div>
        <Button size="sm" variant="ghost" aria-label="Close panel" onClick={onClose}>
          ✕
        </Button>
      </header>
      {children}
    </aside>
  );
}

function EndLink({ end, onPick }: { end: End; onPick: (id: string) => void }) {
  return (
    <button
      type="button"
      className="hover:text-foreground text-left font-mono break-all underline decoration-dotted underline-offset-2"
      title="Select this node"
      onClick={() => {
        onPick(end.id);
      }}
    >
      {end.label}
    </button>
  );
}

export interface EdgePanelProps {
  /** A real edge's ID. */
  edgeId: string;
  onPickNode: (id: string) => void;
  onClose: () => void;
}

/** A real edge, from its detail. */
export function EdgePanel({ edgeId, onPickNode, onClose }: EdgePanelProps) {
  const detail = useEdgeDetail(edgeId);
  const d = detail.data?.edge.id === edgeId ? detail.data : undefined;

  if (!d) {
    return (
      <Shell badge="edge" title={detail.error ? 'Edge' : 'loading…'} onClose={onClose}>
        <Section title="Details">
          {detail.error ? (
            <p className="text-xs text-red-400">Couldn't load this edge: {detail.error.message}</p>
          ) : (
            <p className="text-muted-foreground text-xs">loading…</p>
          )}
        </Section>
      </Shell>
    );
  }

  const { edge, observations } = d;
  return (
    <Shell badge="edge" title={edge.relation} onClose={onClose}>
      <Section title="Details">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
          <Field label="Relation">{edge.relation}</Field>
          <Field label="From">
            <EndLink end={edge.source} onPick={onPickNode} />{' '}
            <span className="text-muted-foreground">({edge.source.type})</span>
          </Field>
          <Field label="To">
            <EndLink end={edge.target} onPick={onPickNode} />{' '}
            <span className="text-muted-foreground">({edge.target.type})</span>
          </Field>
          <Field label="Confidence">
            <span className="capitalize">{edge.confidence}</span>{' '}
            <span className="text-muted-foreground">
              ({String(edge.sourceCount)} {edge.sourceCount === 1 ? 'tool' : 'tools'})
            </span>
          </Field>
          <Field label="First seen">{formatTime(edge.firstSeen)}</Field>
          <Field label="Last seen">{formatTime(edge.lastSeen)}</Field>
        </dl>
      </Section>
      <Section title={`Provenance (${String(observations.length)})`}>
        <ProvenanceTable observations={observations} />
      </Section>
    </Shell>
  );
}

export interface GroupEdgePanelProps {
  /** A `group` view edge: parent → group. */
  edge: ViewEdge;
  parent: End | undefined;
  groupLabel: string;
  onPickNode: (id: string) => void;
  onClose: () => void;
}

/** A parent → group edge: the union of its member edges' tools, from the view itself (no fetch). */
export function GroupEdgePanel({ edge, parent, groupLabel, onPickNode, onClose }: GroupEdgePanelProps) {
  const tools = edge.tools ?? [];
  const count = edge.edgeCount ?? 0;
  return (
    <Shell badge="group edge" title={edge.relation ?? 'group edge'} onClose={onClose}>
      <Section title="Details">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
          {edge.relation && <Field label="Relation">{edge.relation}</Field>}
          {parent && (
            <Field label="From">
              <EndLink end={parent} onPick={onPickNode} />
            </Field>
          )}
          <Field label="To">
            <EndLink end={{ id: edge.target, label: groupLabel }} onPick={onPickNode} />
          </Field>
          <Field label="Edges">{`${String(count)} ${count === 1 ? 'edge' : 'edges'}, one per member`}</Field>
          <Field label="Reported by">{tools.length === 0 ? 'no tool' : tools.join(', ')}</Field>
        </dl>
        <p className="text-muted-foreground text-xs">
          Each tool reported at least one of these edges. Open the group and click a member's edge for its own provenance.
        </p>
      </Section>
    </Shell>
  );
}
