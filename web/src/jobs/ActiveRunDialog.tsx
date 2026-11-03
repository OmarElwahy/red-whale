// The confirmation before a run that contacts the target (any tool whose mode isn't passive; docs/architecture.md
// §11). Asked every time, no "don't ask again". It shows what will run, against exactly which value, what it will
// touch (the tool's own `contacts` text), the outside services, and what the scope says in active mode right now
// (GET /scope/check: not logged; the server logs the real decision when the run is queued, and decides again).
import { canonicalTarget, type NodeType, type TargetableType, type ToolInfo, type ToolMode, type ToolsResponse } from '@redwhale/shared';
import { useEffect, useId } from 'react';
import { useScopeDecision } from '@/api/scope';
import { RuleText, ScopeDecisionValue } from '@/components/ScopeDecision';
import { Button } from '@/components/ui/button';
import { TypeIcon } from '@/edit/TypeIcon';
import { cn } from '@/lib/utils';

export interface ActiveRunTarget {
  id: string;
  type: NodeType;
  value: string;
  label: string;
}

export interface ActiveRunDialogProps {
  node: ActiveRunTarget;
  /** The tools that would run, in run order (for a group: the members that take this node's type). */
  tools: ToolInfo[];
  /** Set for "Run group". */
  group?: { name: string; label: string };
  onConfirm: () => void;
  onClose: () => void;
}

const MODE_RANK: Record<ToolMode, number> = { passive: 0, active: 1, intrusive: 2 };

/** The strongest mode among the tools (a group with one active tool is an active run). */
export function strongestMode(tools: readonly ToolInfo[]): ToolMode {
  return tools.reduce<ToolMode>((m, t) => (MODE_RANK[t.mode] > MODE_RANK[m] ? t.mode : m), 'passive');
}

/** The tools a "Run tool ▸" click would queue: the tool itself, or the group's members that take this node type. */
export function toolsThatRun(all: ToolsResponse | undefined, kind: 'tool' | 'group', name: string, nodeType: NodeType): ToolInfo[] {
  const tools = all?.tools ?? [];
  if (kind === 'tool') return tools.filter((t) => t.name === name);
  const members = all?.groups.find((g) => g.name === name)?.tools ?? [];
  return members.flatMap((m) => tools.filter((t) => t.name === m && (t.accepts as readonly string[]).includes(nodeType)));
}

/** Does running these need the confirmation? */
export function needsConfirmation(tools: readonly ToolInfo[]): boolean {
  return tools.some((t) => t.mode !== 'passive');
}

/** The value the tool will be run against: what authorize() judges (punycode, canonical IP…). */
export function canonicalValue(type: NodeType, value: string): string {
  try {
    return canonicalTarget(type as TargetableType, value);
  } catch {
    return value;
  }
}

/** The tool's own words about what it touches, with the target filled in. Display text only. */
export function contactsText(tool: ToolInfo, target: string): string {
  if (tool.contacts === null) return tool.mode === 'passive' ? 'asks outside sources only; never contacts the target' : `contacts ${target} directly`;
  return tool.contacts.replaceAll('{target}', target);
}

const MODE_TONE: Record<ToolMode, string> = {
  passive: 'border-emerald-500/50 text-emerald-400',
  active: 'border-amber-500/60 text-amber-400',
  intrusive: 'border-red-500/60 text-red-400',
};

function ModeBadge({ mode }: { mode: ToolMode }) {
  return <span className={cn('rounded border px-1 text-[10px] leading-4 font-medium uppercase', MODE_TONE[mode])}>{mode}</span>;
}

export function ActiveRunDialog({ node, tools, group, onConfirm, onClose }: ActiveRunDialogProps) {
  const titleId = useId();
  const target = canonicalValue(node.type, node.value);
  const mode = strongestMode(tools);
  const scope = useScopeDecision({ type: node.type, value: target, mode: 'active' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const decision = scope.data?.decision;
  const allowed = decision === 'in';
  const what = group ? `group ${group.label}` : (tools[0]?.label ?? 'tool');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="bg-background flex w-full max-w-lg flex-col gap-3 rounded-lg border p-4 shadow-xl">
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
          <ModeBadge mode={mode} />
          <span className="min-w-0 truncate">Run {mode} scan: {what}</span>
        </h2>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <TypeIcon type={node.type} />
            <span className="text-muted-foreground text-xs">{node.type}</span>
            <span className="font-mono break-all" data-testid="active-run-target">
              {target}
            </span>
          </dd>
        </dl>

        <ul className="flex flex-col gap-2" aria-label="What will run">
          {tools.map((t) => (
            <li key={t.name} className="rounded-md border p-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t.label}</span>
                <ModeBadge mode={t.mode} />
              </div>
              <p className={cn('mt-1', t.mode === 'passive' ? 'text-muted-foreground' : 'text-amber-200')}>
                {t.mode === 'passive' ? 'Passive: ' : 'Contacts the target: '}
                {contactsText(t, target)}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                External services: {t.external.length > 0 ? t.external.join(', ') : 'none'}
              </p>
            </li>
          ))}
        </ul>

        <div className="rounded-md border p-2 text-sm" aria-label="Scope decision">
          <p className="text-muted-foreground text-xs">Scope, active mode (checked now, not logged; the server decides again when it runs)</p>
          {scope.isPending && <p className="text-muted-foreground">Checking the scope…</p>}
          {scope.error && <p className="text-red-600 dark:text-red-400">{scope.error.message}</p>}
          {scope.data && (
            <div className="mt-1 flex flex-col gap-1">
              <ScopeDecisionValue decision={scope.data.decision} />
              <p className="text-xs">{scope.data.reason}</p>
              {scope.data.rule ? (
                <p className="text-xs">
                  Rule: <RuleText rule={scope.data.rule} />
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">No rule decided it.</p>
              )}
            </div>
          )}
        </div>

        {decision !== undefined && !allowed && (
          <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
            The server would refuse this run. Change the scope first (Scope panel).
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={!allowed} onClick={onConfirm}>
            Run active scan
          </Button>
        </div>
      </div>
    </div>
  );
}
