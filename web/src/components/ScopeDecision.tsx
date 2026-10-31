// A scope decision as words + a small swatch: the hatch for "out", as the graph draws it.
import type { ScopeDecision, ScopeRule } from '@redwhale/shared';
import { OUT_OF_SCOPE_IMAGE, SEVERITY_COLOR } from '@/graph/style';
import { cn } from '@/lib/utils';

export const SCOPE_LABEL: Record<ScopeDecision, string> = {
  in: 'In scope',
  out: 'Out of scope',
  'n/a': 'Not targetable',
};

const TONE: Record<ScopeDecision, string> = {
  in: 'text-emerald-400',
  out: 'text-amber-400',
  'n/a': 'text-muted-foreground',
};

export function ScopeDecisionValue({ decision, className }: { decision: ScopeDecision; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', TONE[decision], className)}>
      <span
        className="size-2.5 rounded-sm border border-slate-300/60"
        style={{
          background: decision === 'out' ? `url("${OUT_OF_SCOPE_IMAGE}") center / cover, ${SEVERITY_COLOR.none}` : 'transparent',
        }}
        aria-hidden
      />
      {SCOPE_LABEL[decision]}
    </span>
  );
}

/** `include wildcard *.example.com` + the rule number, as the panel and log show a rule. */
export function RuleText({ rule }: { rule: Pick<ScopeRule, 'id' | 'kind' | 'value' | 'action' | 'removedAt'> }) {
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1', rule.removedAt !== null && 'line-through opacity-70')}>
      <span className={rule.action === 'exclude' ? 'text-amber-400' : 'text-emerald-400'}>{rule.action}</span>
      <span className="text-muted-foreground">{rule.kind}</span>
      <span className="font-mono break-all">{rule.value}</span>
      <span className="text-muted-foreground">#{rule.id}</span>
      {rule.removedAt !== null && <span className="text-muted-foreground no-underline">(removed)</span>}
    </span>
  );
}
