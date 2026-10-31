// The Scope panel (docs/architecture.md §10), under the graph like Table and Highlights: the rules (add, edit a
// note, remove), the passive-only switch, a "test a target" box, and the decision log. Default deny: with no
// include rule nothing is in scope, and App shows a banner.
import {
  NODE_TYPES,
  SCOPE_ACTIONS,
  SCOPE_KINDS,
  SCOPE_MODES,
  SCOPE_NOTE_MAX,
  type NodeType,
  type ScopeAction,
  type ScopeCheckResponse,
  type ScopeKind,
  type ScopeMode,
  type ScopeRule,
  type ScopeSource,
} from '@redwhale/shared';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApiError } from '@/api/client';
import {
  SCOPE_LOG_PANEL_SIZE,
  scopeIsEmpty,
  useAddScopeRule,
  useCheckTarget,
  usePatchScopeRule,
  usePatchScopeSettings,
  useScopeLog,
  useScopeRules,
  useScopeSettings,
} from '@/api/scope';
import { RuleText, ScopeDecisionValue } from '@/components/ScopeDecision';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatTime } from '@/panel/format';

const INPUT =
  'border-input focus-visible:ring-ring h-7 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2';
const SELECT = cn(INPUT, 'bg-card pr-1');

const PLACEHOLDER: Record<ScopeKind, string> = {
  domain: 'example.com',
  wildcard: '*.example.com',
  ip: '203.0.113.7',
  cidr: '203.0.113.0/24',
};

/** The server's reason(s) for refusing, or the message. */
function errorText(error: Error): string {
  return error instanceof ApiError && error.issues.length > 0 ? error.issues.join('; ') : error.message;
}

function Column({ title, children, className, actions }: { title: string; children: ReactNode; className?: string; actions?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto p-3', className)}>
      <div className="flex items-center gap-2">
        <h3 id={id} className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
          {title}
        </h3>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      {children}
    </section>
  );
}

function AddRuleForm() {
  const add = useAddScopeRule();
  const [kind, setKind] = useState<ScopeKind>('wildcard');
  const [action, setAction] = useState<ScopeAction>('include');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (value.trim() === '' || add.isPending) return;
    add.mutate(
      { kind, action, value, note },
      {
        onSuccess: () => {
          setValue('');
          setNote('');
        },
      },
    );
  };

  return (
    <form aria-label="Add a scope rule" className="flex flex-col gap-1.5" onSubmit={submit}>
      <div className="flex flex-wrap gap-1.5">
        <select aria-label="Action" className={SELECT} value={action} onChange={(e) => { setAction(e.target.value as ScopeAction); }}>
          {SCOPE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select aria-label="Kind" className={SELECT} value={kind} onChange={(e) => { setKind(e.target.value as ScopeKind); }}>
          {SCOPE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          aria-label="Rule value"
          className={cn(INPUT, 'min-w-40 flex-1 font-mono')}
          placeholder={PLACEHOLDER[kind]}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            add.reset();
          }}
        />
      </div>
      <div className="flex gap-1.5">
        <input
          aria-label="Note"
          className={cn(INPUT, 'flex-1')}
          placeholder="Note (e.g. where the authorization says so)"
          maxLength={SCOPE_NOTE_MAX}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
        <Button size="sm" type="submit" disabled={value.trim() === '' || add.isPending}>
          Add rule
        </Button>
      </div>
      {add.error && (
        <p role="alert" className="text-xs text-red-400">
          Refused: {errorText(add.error)}
        </p>
      )}
    </form>
  );
}

function NoteEditor({ rule, onDone }: { rule: ScopeRule; onDone: () => void }) {
  const patch = usePatchScopeRule();
  const [draft, setDraft] = useState(rule.note);
  return (
    <form
      className="flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        patch.mutate({ id: rule.id, note: draft }, { onSuccess: onDone });
      }}
    >
      <input
        aria-label={`Note for rule ${String(rule.id)}`}
        className={cn(INPUT, 'flex-1')}
        maxLength={SCOPE_NOTE_MAX}
        value={draft}
        autoFocus
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
        }}
      />
      <Button size="sm" type="submit" disabled={patch.isPending}>
        Save
      </Button>
      {patch.error && <span className="text-xs text-red-400">{errorText(patch.error)}</span>}
    </form>
  );
}

function RuleRow({ rule }: { rule: ScopeRule }) {
  const patch = usePatchScopeRule();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const removed = rule.removedAt !== null;
  return (
    <li aria-label={`Rule ${String(rule.id)}`} className="flex flex-col gap-1 border-b py-1.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <RuleText rule={rule} />
        {!removed && (
          <div className="ml-auto flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => {
                setEditing((v) => !v);
              }}
            >
              Note
            </Button>
            {confirming ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 border-red-800 px-2 text-red-300"
                  disabled={patch.isPending}
                  onClick={() => {
                    patch.mutate({ id: rule.id, removed: true });
                  }}
                >
                  Remove rule #{rule.id}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                title="Removing is permanent (the rule stays in the history); add it again to restore it"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <NoteEditor
          rule={rule}
          onDone={() => {
            setEditing(false);
          }}
        />
      ) : (
        rule.note !== '' && <p className="text-muted-foreground text-xs">{rule.note}</p>
      )}
      <p className="text-muted-foreground/70 text-[10px]">
        added {formatTime(rule.createdAt)}
        {rule.removedAt !== null && ` · removed ${formatTime(rule.removedAt)}`}
      </p>
      {patch.error && <p className="text-xs text-red-400">{errorText(patch.error)}</p>}
    </li>
  );
}

function RulesColumn() {
  const [showRemoved, setShowRemoved] = useState(false);
  const rules = useScopeRules(showRemoved);
  const list = rules.data ?? [];
  return (
    <Column
      title={`Rules${rules.data ? ` (${String(list.filter((r) => r.removedAt === null).length)})` : ''}`}
      className="lg:col-span-2"
      actions={
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            className="accent-red-500"
            checked={showRemoved}
            onChange={(e) => {
              setShowRemoved(e.target.checked);
            }}
          />
          show removed
        </label>
      }
    >
      <p className="text-muted-foreground text-[11px]">
        Nothing is in scope until an include rule says so; an exclude always wins. Domain rules never put the IPs a
        name resolves to in scope: add those as ip or cidr rules.
      </p>
      <AddRuleForm />
      {rules.error && <p className="text-xs text-red-400">Couldn't load the rules: {rules.error.message}</p>}
      {rules.data && list.length === 0 && <p className="text-muted-foreground text-xs">No rules yet.</p>}
      <ul aria-label="Scope rules" className="text-xs">
        {list.map((r) => (
          <RuleRow key={r.id} rule={r} />
        ))}
      </ul>
    </Column>
  );
}

function PassiveOnlySwitch() {
  const settings = useScopeSettings();
  const patch = usePatchScopeSettings();
  const on = settings.data?.passiveOnly ?? true;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          className="peer sr-only"
          checked={on}
          disabled={!settings.data || patch.isPending}
          onChange={(e) => {
            patch.mutate({ passiveOnly: e.target.checked });
          }}
        />
        <span
          aria-hidden
          className={cn(
            'peer-focus-visible:ring-ring relative h-4 w-7 rounded-full transition-colors peer-focus-visible:ring-2',
            on ? 'bg-emerald-600' : 'bg-slate-600',
          )}
        >
          <span className={cn('absolute top-0.5 size-3 rounded-full bg-white transition-all', on ? 'left-3.5' : 'left-0.5')} />
        </span>
        <span className="font-medium">Passive only</span>
      </label>
      <p className="text-muted-foreground text-[11px]">
        {on
          ? 'On: no active check is in scope (nothing that sends packets to a target), whatever the rules say.'
          : 'Off: active checks follow the rules. Turn it back on when active testing is over.'}
      </p>
      {patch.error && <p className="text-xs text-red-400">{errorText(patch.error)}</p>}
    </div>
  );
}

function CheckResult({ result }: { result: ScopeCheckResponse }) {
  return (
    <div aria-label="Check result" className="bg-card flex flex-col gap-1 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <ScopeDecisionValue decision={result.decision} />
        <span className="text-muted-foreground">
          {result.type} · {result.mode}
        </span>
      </div>
      <p className="font-mono break-all">{result.value}</p>
      <p className="text-muted-foreground">{result.reason}</p>
      {result.rule && <RuleText rule={result.rule} />}
    </div>
  );
}

function TestTarget() {
  const check = useCheckTarget();
  const [type, setType] = useState<NodeType>('subdomain');
  const [mode, setMode] = useState<ScopeMode>('passive');
  const [value, setValue] = useState('');
  return (
    <form
      aria-label="Test a target"
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        // Only on submit (Enter / the button), never per keystroke: every check is logged.
        if (value.trim() === '' || check.isPending) return;
        check.mutate({ type, value: value.trim(), mode });
      }}
    >
      <div className="flex gap-1.5">
        <select aria-label="Target type" className={SELECT} value={type} onChange={(e) => { setType(e.target.value as NodeType); }}>
          {NODE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select aria-label="Mode" className={SELECT} value={mode} onChange={(e) => { setMode(e.target.value as ScopeMode); }}>
          {SCOPE_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-1.5">
        <input
          aria-label="Target value"
          className={cn(INPUT, 'min-w-0 flex-1 font-mono')}
          placeholder="api.example.com"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
        <Button size="sm" type="submit" disabled={value.trim() === '' || check.isPending}>
          Check
        </Button>
      </div>
      <p className="text-muted-foreground text-[10px]">Each check is recorded in the log (as a check, not a run).</p>
      {check.error && <p className="text-xs text-red-400">{errorText(check.error)}</p>}
      {check.data && <CheckResult result={check.data} />}
    </form>
  );
}

function LogColumn() {
  const [withChecks, setWithChecks] = useState(false);
  const [page, setPage] = useState(1);
  const sources: ScopeSource[] = withChecks ? ['run', 'check'] : ['run'];
  const log = useScopeLog(sources, page);
  const pages = log.data ? Math.max(1, Math.ceil(log.data.total / SCOPE_LOG_PANEL_SIZE)) : 1;
  return (
    <Column
      title={`Log${log.data ? ` (${String(log.data.total)})` : ''}`}
      actions={
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            className="accent-red-500"
            checked={withChecks}
            onChange={(e) => {
              setWithChecks(e.target.checked);
              setPage(1);
            }}
          />
          include checks
        </label>
      }
    >
      {log.error && <p className="text-xs text-red-400">Couldn't load the log: {log.error.message}</p>}
      {log.data?.total === 0 && (
        <p className="text-muted-foreground text-xs">
          {withChecks
            ? 'Nothing logged yet.'
            : 'No tool has been authorized to run yet (tools run from Phase 6B). Tick “include checks” to see tested targets.'}
        </p>
      )}
      <ol aria-label="Scope log" className="flex flex-col text-xs">
        {log.data?.items.map((e) => (
          <li key={e.id} className="flex flex-col gap-0.5 border-b py-1.5 last:border-b-0">
            <div className="flex items-center gap-2">
              <ScopeDecisionValue decision={e.decision} />
              <span
                className={cn(
                  'rounded px-1 text-[10px] uppercase',
                  e.source === 'run' ? 'bg-red-950 text-red-300' : 'bg-secondary text-muted-foreground',
                )}
              >
                {e.source}
              </span>
              <span className="text-muted-foreground">{e.mode}</span>
              <span className="text-muted-foreground/70 ml-auto text-[10px] tabular-nums">{formatTime(e.at)}</span>
            </div>
            <p className="break-all">
              <span className="text-muted-foreground">{e.targetType}</span> <span className="font-mono">{e.targetValue}</span>
            </p>
            <p className="text-muted-foreground">{e.reason}</p>
          </li>
        ))}
      </ol>
      {pages > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); }}>
            Newer
          </Button>
          <span className="text-muted-foreground tabular-nums">
            {page} / {pages}
          </span>
          <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => { setPage((p) => p + 1); }}>
            Older
          </Button>
        </div>
      )}
    </Column>
  );
}

export function ScopePanel({ className }: { className?: string }) {
  return (
    <div className={cn('grid min-h-0 grid-cols-1 divide-x overflow-y-auto lg:grid-cols-4 lg:overflow-hidden', className)}>
      <RulesColumn />
      <Column title="Settings & test">
        <PassiveOnlySwitch />
        <div className="border-t pt-2">
          <TestTarget />
        </div>
      </Column>
      <LogColumn />
    </div>
  );
}

/** Default deny, made visible: no include rule means nothing is in scope. Shown under the header. */
export function ScopeBanner({ onOpen }: { onOpen: () => void }) {
  const rules = useScopeRules();
  if (!rules.data || !scopeIsEmpty(rules.data)) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-amber-900 bg-amber-950/60 px-4 py-1.5 text-xs text-amber-200">
      <span>
        <strong>No scope defined:</strong> nothing is in scope, so no tool can run against any target.
        {rules.data.length > 0 && ' (Exclude rules alone never let anything in.)'}
      </span>
      <Button size="sm" variant="outline" className="ml-auto h-6" onClick={onOpen}>
        Open Scope
      </Button>
    </div>
  );
}
