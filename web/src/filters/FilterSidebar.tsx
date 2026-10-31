// Left sidebar: search, view toggles, and the filters. Every control writes the view store (state/view.ts),
// whose filters map 1:1 to GET /api/graph params. Counts come from /api/stats and are workspace totals.
import {
  CONFIDENCE_LEVELS,
  NODE_TYPES,
  SCOPE_DECISIONS,
  SEVERITIES,
  TAGS,
  type Severity,
  type StatsResponse,
} from '@redwhale/shared';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HOPS, hasFilters, isHideIgnored, useView, type ListFilter, type ListValue } from '@/state/view';
import { SearchBox } from './SearchBox';

/** Passive-mode decision, as the graph marks it. */
const SCOPE_FILTER_LABEL: Record<string, string> = { in: 'in scope', out: 'out of scope', 'n/a': 'not targetable' };

const TOTAL_HINT = 'Workspace total: doesn’t change with filters';

function Count({ n, title = TOTAL_HINT }: { n: number | undefined; title?: string }) {
  if (n === undefined) return null;
  return (
    <span className="text-muted-foreground/70 ml-auto text-[10px] tabular-nums" title={title}>
      {n}
    </span>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wider uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

function Choice({
  type,
  name,
  checked,
  onChange,
  children,
  count,
  countTitle,
}: {
  type: 'checkbox' | 'radio';
  name?: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  count?: number;
  countTitle?: string;
}) {
  return (
    <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded px-1 py-0.5">
      <input type={type} name={name} checked={checked} onChange={onChange} className="accent-red-500" />
      <span className="truncate">{children}</span>
      <Count n={count} title={countTitle} />
    </label>
  );
}

function CheckList<K extends ListFilter>({
  title,
  filter,
  options,
  counts,
  labels,
}: {
  title: string;
  filter: K;
  options: readonly ListValue<K>[];
  counts: Partial<Record<string, number>> | undefined;
  /** Display text per option, when the value itself isn't clear enough. */
  labels?: Partial<Record<string, string>>;
}) {
  const selected = useView((s) => s.filters[filter]) as readonly ListValue<K>[] | undefined;
  const toggle = useView((s) => s.toggle);
  return (
    <Group title={title}>
      {options.map((value) => (
        <Choice
          key={value}
          type="checkbox"
          checked={selected?.includes(value) ?? false}
          onChange={() => {
            toggle(filter, value);
          }}
          count={counts === undefined ? undefined : (counts[value] ?? 0)}
        >
          {labels?.[value] ?? value}
        </Choice>
      ))}
    </Group>
  );
}

const severityHint = (s: Severity, n: number) =>
  `${String(n)} node${n === 1 ? '' : 's'} with their own severity = ${s} (workspace total). ` +
  `The filter also keeps the nodes above each finding, so the graph can show more.`;

function MinSeverity({ counts }: { counts: StatsResponse['bySeverity'] | undefined }) {
  const min = useView((s) => s.filters.minSeverity);
  const setMinSeverity = useView((s) => s.setMinSeverity);
  return (
    <Group title="Min severity">
      <Choice
        type="radio"
        name="minSeverity"
        checked={min === undefined}
        onChange={() => {
          setMinSeverity(undefined);
        }}
      >
        any
      </Choice>
      {SEVERITIES.map((s) => (
        <Choice
          key={s}
          type="radio"
          name="minSeverity"
          checked={min === s}
          onChange={() => {
            setMinSeverity(s);
          }}
          count={counts?.[s]}
          countTitle={counts === undefined ? undefined : severityHint(s, counts[s])}
        >
          {s === 'critical' ? s : `${s}+`}
        </Choice>
      ))}
    </Group>
  );
}

function ViewOptions({ ignoredCount }: { ignoredCount: number | undefined }) {
  const mute = useView((s) => s.mute);
  const hops = useView((s) => s.hops);
  const hideIgnored = useView((s) => isHideIgnored(s.filters));
  const { setMute, setHops, setHideIgnored } = useView.getState();
  return (
    <Group title="View">
      <Choice
        type="checkbox"
        checked={mute}
        onChange={() => {
          setMute(!mute);
        }}
      >
        <span title="Fade nodes with nothing medium or worse at or below them">mute low-risk</span>
      </Choice>
      <Choice
        type="checkbox"
        checked={hideIgnored}
        onChange={() => {
          setHideIgnored(!hideIgnored);
        }}
        count={ignoredCount}
      >
        hide ignored
      </Choice>
      <div className="flex items-center gap-2 px-1 py-0.5">
        <span id="focus-hops">focus hops</span>
        <div role="group" aria-labelledby="focus-hops" className="ml-auto flex gap-1">
          {HOPS.map((h) => (
            <Button
              key={h}
              size="sm"
              variant={hops === h ? 'default' : 'outline'}
              aria-pressed={hops === h}
              className="h-6 w-6 px-0"
              onClick={() => {
                setHops(h);
              }}
            >
              {h}
            </Button>
          ))}
        </div>
      </div>
    </Group>
  );
}

export function FilterSidebar({ stats, className }: { stats: StatsResponse | undefined; className?: string }) {
  const filters = useView((s) => s.filters);
  const resetFilters = useView((s) => s.resetFilters);
  // A tool picked in a link may not be in this workspace; keep it listed so it can be unticked.
  const tools = [...new Set([...Object.keys(stats?.byTool ?? {}), ...(filters.tool ?? [])])].sort();

  return (
    <aside aria-label="Filters" className={cn('flex flex-col gap-4 overflow-y-auto border-r p-3 text-xs', className)}>
      <SearchBox />
      <ViewOptions ignoredCount={stats?.byTag.ignored} />
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Filters</h2>
        {hasFilters(filters) && (
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={resetFilters}>
            reset
          </button>
        )}
      </div>
      <p className="text-muted-foreground -mt-3 text-[10px]">Numbers are workspace totals; they don’t change with filters.</p>
      <CheckList title="Type" filter="types" options={NODE_TYPES} counts={stats?.byType} />
      <MinSeverity counts={stats?.bySeverity} />
      <CheckList title="Confidence" filter="confidence" options={CONFIDENCE_LEVELS} counts={stats?.byConfidence} />
      <CheckList title="Tool" filter="tool" options={tools} counts={stats?.byTool} />
      <CheckList title="Tag" filter="tag" options={TAGS} counts={stats?.byTag} />
      <CheckList title="Scope" filter="scope" options={SCOPE_DECISIONS} counts={stats?.byScope} labels={SCOPE_FILTER_LABEL} />
    </aside>
  );
}
