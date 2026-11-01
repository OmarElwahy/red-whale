// Right-hand panel for the selected node (docs/architecture.md §8): details, provenance, tag and notes from
// GET /api/nodes/:id; for a group, its size, what's below it, and the expand / load more / collapse controls.
import type { AggregateNode, GraphNode, Tag } from '@redwhale/shared';
import { useId, type ReactNode } from 'react';
import { useNodeDetail, usePatchNode } from '@/api/hooks';
import { Badge } from '@/components/ui/badge';
import { RuleText, ScopeDecisionValue } from '@/components/ScopeDecision';
import { SeverityValue } from '@/components/SeverityValue';
import { Button } from '@/components/ui/button';
import { riskText } from '@/graph/icons';
import type { MenuAction } from '@/menu/items';
import { formatTime, formatValue } from './format';
import { NotesEditor } from './NotesEditor';
import { ProvenanceTable } from './ProvenanceTable';
import { TagPicker } from './TagPicker';

export interface SidePanelProps {
  target: GraphNode | AggregateNode;
  /** For a node: the open group it hangs under. */
  memberOf?: AggregateNode;
  /** Label of the group's parent node, when it's on the canvas. */
  parentLabel?: string;
  /** For an open group: groups are open below it. */
  hasOpenBelow?: boolean;
  /**
   * Set when the node isn't on the graph (e.g. picked in the table while it's inside a collapsed group). `blocked`
   * is why it can't be shown, or null when it can.
   */
  reveal?: { blocked: string | null; onReveal: () => void };
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t px-4 py-3">
      <h3 id={id} className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function AggregatePanel({ target, parentLabel, hasOpenBelow = false, onAction }: SidePanelProps & { target: AggregateNode }) {
  const risk = riskText(target.risk);
  const full = 'The canvas is at its ~2,000-element limit';
  return (
    <>
      <Section title="Group">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
          <Field label="Members">
            {target.count} {target.childType}
          </Field>
          {target.relation && <Field label="Relation">{target.relation}</Field>}
          {parentLabel !== undefined && <Field label="Parent">{parentLabel}</Field>}
          <Field label="Max severity">
            <SeverityValue severity={target.maxSeverity} />
          </Field>
          <Field label="Below it">{risk === '' ? 'nothing high or critical' : risk}</Field>
          {target.expanded && <Field label="Shown">{`${String(target.shown)} of ${String(target.count)}`}</Field>}
        </dl>
      </Section>
      <Section title={target.expanded ? 'Open' : 'Collapsed'}>
        <div className="flex flex-wrap gap-2">
          {target.expanded ? (
            <>
              <Button
                size="sm"
                variant="outline"
                title="Double-click the group does the same"
                onClick={() => {
                  onAction('collapse');
                }}
              >
                Collapse
              </Button>
              {target.remaining > 0 && (
                <Button
                  size="sm"
                  disabled={!target.canLoadMore}
                  title={target.canLoadMore ? 'Double-click the "more" node does the same' : full}
                  onClick={() => {
                    onAction('load-more');
                  }}
                >
                  {`Load more (${String(target.remaining)} left)`}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={!hasOpenBelow}
                onClick={() => {
                  onAction('collapse-below');
                }}
              >
                Collapse all below
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={!target.canLoadMore}
              title={target.canLoadMore ? 'Double-click the group does the same' : full}
              onClick={() => {
                onAction('expand');
              }}
            >
              Expand
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}

function RevealSection({ blocked, onReveal }: NonNullable<SidePanelProps['reveal']>) {
  return (
    <Section title="Graph">
      <p className="text-muted-foreground text-xs">
        This node isn't on the graph right now (it's inside a collapsed group, or the filters leave it out).
      </p>
      <div>
        <Button size="sm" disabled={blocked !== null} onClick={onReveal}>
          Show on graph
        </Button>
      </div>
      {blocked !== null && <p className="text-xs text-amber-400">{blocked}</p>}
    </Section>
  );
}

function NodePanel({ target, memberOf, reveal, onAction }: SidePanelProps & { target: GraphNode }) {
  const detail = useNodeDetail(target.id);
  const patch = usePatchNode(target.id);
  const node = detail.data?.node;

  if (detail.error) {
    return (
      <Section title="Details">
        <p className="text-xs text-red-400">Couldn't load this node: {detail.error.message}</p>
      </Section>
    );
  }
  if (!node || !detail.data) {
    return (
      <Section title="Details">
        <p className="text-muted-foreground text-xs">loading…</p>
      </Section>
    );
  }

  const setTag = (tag: Tag | null) => {
    patch.mutate({ tag });
  };
  // One mutation serves both; show its error next to whichever field it was saving.
  const tagError = patch.variables?.tag !== undefined ? patch.error : null;
  const data = Object.entries(node.data);

  return (
    <>
      <Section title="Details">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
          <Field label="Value">
            <span className="font-mono">{node.value}</span>
          </Field>
          <Field label="Severity">
            <SeverityValue severity={node.severity} />
          </Field>
          {node.effectiveSeverity !== node.severity && (
            <Field label="Below it">
              <SeverityValue severity={node.effectiveSeverity} />
            </Field>
          )}
          <Field label="Confidence">
            <span className="capitalize">{node.confidence}</span>{' '}
            <span className="text-muted-foreground">
              {node.sourceCount === 0
                ? '(only referenced as a parent)'
                : `(${String(node.sourceCount)} ${node.sourceCount === 1 ? 'tool' : 'tools'})`}
            </span>
          </Field>
          <Field label="First seen">{formatTime(node.firstSeen)}</Field>
          <Field label="Last seen">{formatTime(node.lastSeen)}</Field>
        </dl>
        {memberOf && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">In the group “{memberOf.label}”.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onAction('collapse-parent');
              }}
            >
              Collapse group
            </Button>
          </div>
        )}
      </Section>
      <Section title="Scope">
        <div className="flex flex-col gap-1 text-xs">
          <ScopeDecisionValue decision={detail.data.scope.decision} />
          <p className="text-muted-foreground">{detail.data.scope.reason}</p>
          {detail.data.scope.rule && (
            <div className="flex flex-col gap-0.5">
              <RuleText rule={detail.data.scope.rule} />
              {detail.data.scope.rule.note !== '' && (
                <p className="text-muted-foreground">{detail.data.scope.rule.note}</p>
              )}
            </div>
          )}
          <p className="text-muted-foreground/70 text-[10px]">Passive mode; rules are in the Scope panel.</p>
        </div>
      </Section>
      {reveal && <RevealSection {...reveal} />}
      <Section title="Tag">
        <TagPicker value={node.tag} onChange={setTag} disabled={patch.isPending} />
        {tagError && <p className="text-xs text-red-400">Tag not saved: {tagError.message}</p>}
      </Section>
      <Section title="Data">
        {data.length === 0 ? (
          <p className="text-muted-foreground text-xs">No data.</p>
        ) : (
          <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
            {data.map(([k, v]) => (
              <Field key={k} label={k}>
                <span className="font-mono">{formatValue(v)}</span>
              </Field>
            ))}
          </dl>
        )}
      </Section>
      <Section title={`Provenance (${String(detail.data.observations.length)})`}>
        <ProvenanceTable observations={detail.data.observations} />
      </Section>
      <Section title="Notes">
        <NotesEditor
          key={node.id}
          notes={node.notes}
          saving={patch.isPending}
          error={patch.variables?.notes !== undefined ? patch.error : null}
          onSave={(notes) => patch.mutateAsync({ notes })}
        />
      </Section>
    </>
  );
}

export function SidePanel(props: SidePanelProps) {
  const { target, onClose } = props;
  return (
    <aside aria-label="Node details" className="bg-card flex w-96 shrink-0 flex-col overflow-y-auto border-l">
      <header className="flex items-start gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Badge variant="secondary" className="mb-1 capitalize">
            {target.type === 'aggregate' ? `group of ${target.childType}` : target.type}
          </Badge>
          <h2 className="text-sm font-semibold break-words">{target.label}</h2>
        </div>
        <Button size="sm" variant="ghost" aria-label="Close panel" onClick={onClose}>
          ✕
        </Button>
      </header>
      {target.type === 'aggregate' ? (
        <AggregatePanel {...props} target={target} />
      ) : (
        <NodePanel key={target.id} {...props} target={target} />
      )}
    </aside>
  );
}
