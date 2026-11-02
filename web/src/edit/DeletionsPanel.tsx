// The "Deleted" tab: every analyst delete, newest first, with what it removed. A record, not a restore.
import { useState } from 'react';
import { useDeletions } from '@/api/edit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatTime } from '@/panel/format';
import { TypeIcon } from './TypeIcon';

export function DeletionsPanel({ className }: { className?: string }) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const list = useDeletions(page);
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {data ? `${String(data.total)} deletes` : 'loading…'} · read-only: deleted nodes can&apos;t be restored, but tools may find them again.
        </span>
        {list.error && <span className="text-red-400">Couldn&apos;t load the list: {list.error.message}</span>}
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
        {data && data.items.length === 0 && <p className="text-muted-foreground p-4 text-sm">Nothing has been deleted.</p>}
        <ul aria-label="Deletions" className="text-xs">
          {data?.items.map((d) => (
            <li key={d.id} className="border-b">
              <button
                type="button"
                aria-expanded={open === d.id}
                className="hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left"
                onClick={() => {
                  setOpen(open === d.id ? null : d.id);
                }}
              >
                <span className="text-muted-foreground tabular-nums">{formatTime(d.at)}</span>
                <TypeIcon type={d.rootType} className="size-4" />
                <span className="min-w-0 truncate font-mono">{d.rootLabel}</span>
                <span className="text-muted-foreground">
                  {d.kind === 'group' ? 'group, ' : ''}
                  {d.mode === 'subtree' ? 'with everything below' : 'only'}
                </span>
                <span className="ml-auto tabular-nums">
                  {d.nodeCount} node{d.nodeCount === 1 ? '' : 's'}, {d.edgeCount} edge{d.edgeCount === 1 ? '' : 's'}
                </span>
              </button>
              {open === d.id && (
                <ul aria-label={`Removed by delete ${String(d.id)}`} className="bg-muted/30 max-h-48 overflow-auto px-8 py-1">
                  {d.removed.map((r) => (
                    <li key={`${r.type}:${r.value}`} className="flex gap-2 py-0.5">
                      <span className="text-muted-foreground w-24 shrink-0">{r.type}</span>
                      <span className="truncate font-mono">{r.value}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
