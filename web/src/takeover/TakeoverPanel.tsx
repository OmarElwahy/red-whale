// The Takeover watch tab (TW-2, docs/architecture.md §8, §11): every subdomain's takeover status from its latest
// takeover-check, riskiest first. The server builds and orders the rows; this only shows them. Clicking a row picks
// the subdomain (its path opens, as from the table view).
import {
  TAKEOVER_EXPIRING_DAYS,
  TAKEOVER_RED_DAYS,
  TAKEOVER_STATUSES,
  type TakeoverRegistration,
  type TakeoverStatus,
  type TakeoverWatchRow,
} from '@redwhale/shared';
import { useState } from 'react';
import { useTakeoverWatch } from '@/api/takeover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useView } from '@/state/view';
import { formatTime } from '@/panel/format';

export const STATUS_LABEL: Record<TakeoverStatus, string> = {
  takeable: 'takeable now',
  expiring: 'expiring',
  unknown: 'unknown',
  ok: 'ok',
  'not-checked': 'not checked',
  'out-of-scope': 'not checked (out of scope)',
};

const STATUS_STYLE: Record<TakeoverStatus, string> = {
  takeable: 'bg-red-600/20 text-red-300',
  expiring: 'bg-amber-500/20 text-amber-300',
  unknown: 'bg-slate-500/25 text-slate-300',
  ok: 'bg-emerald-600/20 text-emerald-300',
  'not-checked': 'bg-muted text-muted-foreground',
  'out-of-scope': 'bg-muted text-muted-foreground',
};

/** Red under 30 days (and once expired), amber under 90. */
export function daysClass(days: number | null): string {
  if (days === null) return '';
  if (days < TAKEOVER_RED_DAYS) return 'text-red-400 font-medium';
  if (days < TAKEOVER_EXPIRING_DAYS) return 'text-amber-400';
  return '';
}

function registeredText(r: TakeoverRegistration): string {
  if (r.registered === true) return 'yes';
  if (r.registered === false) return 'no';
  return 'unknown';
}

/** One line per looked-up domain, for the tooltip. */
export function registrationsTitle(row: TakeoverWatchRow): string {
  return row.registrations
    .map((r) => {
      const state =
        r.registered === true
          ? `registered${r.expiresAt ? `, expires ${r.expiresAt.slice(0, 10)}` : ''}${r.daysLeft === null ? '' : ` (${String(r.daysLeft)} days)`}`
          : r.registered === false
            ? 'NOT registered'
            : 'unknown';
      const extra = [r.source, r.reason].filter(Boolean).join(': ');
      return `${r.domain}: ${state}${extra ? ` (${extra})` : ''}`;
    })
    .join('\n');
}

function Row({ row, selected, onPick }: { row: TakeoverWatchRow; selected: boolean; onPick: (id: string) => void }) {
  const r = row.registration;
  const notes = [
    !row.inScope && row.lastCheck ? 'out of scope, not refreshed' : null,
    row.lastFailure ? `last check failed: ${row.lastFailure.error}` : null,
    row.pending ? 'checking…' : null,
  ].filter((n): n is string => n !== null);
  return (
    <tr
      className={cn('hover:bg-accent cursor-pointer border-t align-top', selected && 'bg-accent')}
      aria-selected={selected}
      onClick={() => {
        onPick(row.nodeId);
      }}
    >
      <td className="px-3 py-1">
        <button
          type="button"
          className="font-mono hover:underline"
          title="Show this subdomain"
          onClick={(e) => {
            e.stopPropagation();
            onPick(row.nodeId);
          }}
        >
          {row.subdomain}
        </button>
        {notes.map((n) => (
          <span key={n} className={cn('block text-[11px]', n.startsWith('last check failed') ? 'text-red-400' : 'text-muted-foreground')}>
            {n}
          </span>
        ))}
      </td>
      <td className="py-1">
        <span
          className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', STATUS_STYLE[row.status])}
          title={row.vulnerabilities.length > 0 ? row.vulnerabilities.map((v) => v.label).join(', ') : undefined}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </td>
      <td className="truncate py-1 pr-2 font-mono" title={row.chain.length > 0 ? [row.subdomain, ...row.chain].join(' → ') : undefined}>
        {row.chainEnd ?? '—'}
        {row.service && <span className="text-muted-foreground ml-1 font-sans text-[11px]">({row.service} service)</span>}
      </td>
      <td className="truncate py-1 pr-2 font-mono" title={registrationsTitle(row) || undefined}>
        {r?.domain ?? '—'}
        {row.registrations.length > 1 && (
          <span className="text-muted-foreground ml-1 font-sans text-[11px]">+{row.registrations.length - 1}</span>
        )}
      </td>
      <td className={cn('py-1', r?.registered === false && 'font-medium text-red-400')}>{r ? registeredText(r) : '—'}</td>
      <td className="py-1 tabular-nums">{r?.expiresAt?.slice(0, 10) ?? '—'}</td>
      <td className={cn('py-1 tabular-nums', daysClass(r?.daysLeft ?? null))}>{r?.daysLeft ?? '—'}</td>
      <td className="text-muted-foreground py-1 pr-3 tabular-nums">
        {row.lastCheck ? formatTime(row.lastCheck.at) : '—'}
        {row.lastCheck && row.lastCheck.status !== 'success' && <span className="ml-1">({row.lastCheck.status})</span>}
      </td>
    </tr>
  );
}

export function TakeoverPanel({
  className,
  selectedId,
  onPick,
}: {
  className?: string;
  selectedId?: string | null;
  onPick: (nodeId: string) => void;
}) {
  const [page, setPage] = useState(1);
  // The same switch as the graph's (filter sidebar ▸ Scope): external chain names are hidden in both.
  const showExternal = useView((s) => s.filters.showExternal === '1');
  const watch = useTakeoverWatch(page, showExternal);
  const data = watch.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
        {data ? (
          <ul aria-label="Status counts" className="flex flex-wrap gap-1.5">
            {TAKEOVER_STATUSES.filter((s) => data.counts[s] > 0).map((s) => (
              <li key={s} className={cn('rounded px-1.5 py-0.5', STATUS_STYLE[s])}>
                {STATUS_LABEL[s]}: <span className="tabular-nums">{data.counts[s]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">loading…</span>
        )}
        {watch.error && <span className="text-red-400">Couldn&apos;t load the watch: {watch.error.message}</span>}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={page <= 1}
          onClick={() => {
            setPage(page - 1);
          }}
        >
          ‹ Prev
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= pages}
          onClick={() => {
            setPage(page + 1);
          }}
        >
          Next ›
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {data && data.total === 0 && <p className="text-muted-foreground p-4 text-sm">No subdomains yet.</p>}
        {data && data.total > 0 && (
          <table aria-label="Takeover watch" className="w-full table-fixed text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="w-64 px-3 py-1 font-medium">Subdomain</th>
                <th className="w-44 py-1 font-medium">Status</th>
                <th className="w-64 py-1 font-medium">Chain end</th>
                <th className="w-52 py-1 font-medium">Domain</th>
                <th className="w-20 py-1 font-medium">Registered</th>
                <th className="w-24 py-1 font-medium">Expires</th>
                <th className="w-20 py-1 font-medium">Days left</th>
                <th className="w-44 py-1 font-medium">Last checked (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <Row key={row.nodeId} row={row} selected={row.nodeId === selectedId} onPick={onPick} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
