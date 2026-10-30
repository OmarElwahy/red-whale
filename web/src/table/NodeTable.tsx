// The table view (docs/architecture.md §8): GET /api/nodes under the graph's filters, paged and sorted on the
// server. Kept in step with the graph: clicking a row picks the node, and the selected node's row is highlighted,
// turning to the page that holds it (`?at=`) when the selection changes.
import type { GraphNode } from '@redwhale/shared';
import {
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table';
import { useEffect, useRef, useState } from 'react';
import { useLocateNode, useNodeList } from '@/api/hooks';
import { SeverityValue } from '@/components/SeverityValue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatTime } from '@/panel/format';
import { useUi } from '@/state/ui';
import { useView } from '@/state/view';
import { isSortField, sortToState, stateToSort } from './sorting';

export interface NodeTableProps {
  selectedId: string | null;
  /** Is the node on the canvas? Rows for hidden nodes (inside an aggregate) are drawn dimmer. */
  isShown: (id: string) => boolean;
  onPick: (node: GraphNode) => void;
  className?: string;
}

const features = tableFeatures({ rowSortingFeature });
const helper = createColumnHelper<typeof features, GraphNode>();
const columns = helper.columns([
  helper.accessor('type', { header: 'Type', cell: (c) => c.getValue() }),
  helper.accessor('label', {
    header: 'Label',
    cell: (c) => {
      const { label, value } = c.row.original;
      return (
        <span className="block max-w-[28rem] truncate" title={value}>
          {label}
          {value !== label && <span className="text-muted-foreground ml-2 font-mono">{value}</span>}
        </span>
      );
    },
  }),
  helper.accessor('severity', {
    header: 'Severity',
    sortDescFirst: true,
    cell: (c) => <SeverityValue severity={c.getValue()} />,
  }),
  helper.accessor('effectiveSeverity', {
    header: 'Below it',
    sortDescFirst: true,
    cell: (c) => <SeverityValue severity={c.getValue()} />,
  }),
  helper.accessor('confidence', {
    header: 'Confidence',
    cell: (c) => <span className="capitalize">{c.getValue()}</span>,
  }),
  helper.accessor('sourceCount', { header: 'Tools', sortDescFirst: true, cell: (c) => c.getValue() }),
  helper.accessor('tag', { header: 'Tag', enableSorting: false, cell: (c) => c.getValue() ?? '' }),
  helper.accessor('lastSeen', { header: 'Last seen', sortDescFirst: true, cell: (c) => formatTime(c.getValue()) }),
]);

const isShiftClick = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'shiftKey' in e && e.shiftKey === true;

/**
 * Turns to the page that holds the selected node whenever the selection changes. Runs on every render, but looks
 * each selection up once: paging away from the selected row afterwards must not jump back.
 */
function useFollowSelection(selectedId: string | null, ids: readonly string[] | undefined) {
  const filters = useView((s) => s.filters);
  const { page: current, sort } = useUi((s) => s.table);
  const locate = useLocateNode();
  const handled = useRef<string | null>(null);
  const [notListed, setNotListed] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId === null || selectedId.startsWith('agg:') || ids === undefined || handled.current === selectedId) {
      return;
    }
    handled.current = selectedId;
    if (ids.includes(selectedId)) return;
    const id = selectedId;
    locate(filters, sort, id, current).then(
      (found) => {
        if (useUi.getState().selectedId !== id) return;
        if (found === null) setNotListed(id);
        else useUi.getState().setTablePage(found);
      },
      () => {
        // The table keeps its page; the error shows on the next list fetch if the API is down.
      },
    );
  }, [selectedId, ids, filters, sort, current, locate]);

  return notListed !== null && notListed === selectedId;
}

export function NodeTable({ selectedId, isShown, onPick, className }: NodeTableProps) {
  const filters = useView((s) => s.filters);
  const { page, sort } = useUi((s) => s.table);
  const list = useNodeList(filters, page, sort);
  const data = list.data;

  const sorting = sortToState(sort);
  const table = useTable({
    features,
    columns,
    data: data?.items ?? EMPTY,
    getRowId: (n) => n.id,
    state: { sorting },
    onSortingChange: (updater) => {
      const next: SortingState = typeof updater === 'function' ? updater(sorting) : updater;
      useUi.getState().setTableSort(stateToSort(next));
    },
    manualSorting: true,
    enableSortingRemoval: false,
    enableMultiSort: true,
    isMultiSortEvent: isShiftClick,
  });

  // Only a page loaded for the current filters/sort/page counts: the placeholder is the previous one.
  const notListed = useFollowSelection(
    selectedId,
    data && !list.isPlaceholderData ? data.items.map((n) => n.id) : undefined,
  );

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground tabular-nums">
          {from}–{to} of {total} nodes
        </span>
        {list.isFetching && <span className="text-muted-foreground">loading…</span>}
        {list.error && <span className="text-red-400">Couldn't load the table: {list.error.message}</span>}
        {notListed && (
          <span className="text-muted-foreground">
            The selected node isn't in this list (the table lists search matches only, not the path above them).
          </span>
        )}
        <span className="text-muted-foreground ml-auto">Shift-click a header to sort by several columns.</span>
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => {
            useUi.getState().setTablePage(page - 1);
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
            useUi.getState().setTablePage(page + 1);
          }}
        >
          Next ›
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table role="grid" aria-label="Nodes" className="w-full border-collapse text-xs">
          <thead className="bg-card sticky top-0">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const column = header.column;
                  const sortable = isSortField(column.id) && column.getCanSort();
                  const dir = column.getIsSorted();
                  const index = column.getSortIndex();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                      className="border-b px-2 py-1.5 text-left font-semibold whitespace-nowrap"
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className="hover:text-foreground inline-flex items-center gap-1"
                          onClick={column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={header} />
                          <span className="text-muted-foreground" aria-hidden>
                            {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}
                            {dir !== false && sorting.length > 1 ? String(index + 1) : ''}
                          </span>
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const selected = row.id === selectedId;
              const shown = isShown(row.id);
              return (
                <tr
                  key={row.id}
                  aria-selected={selected}
                  tabIndex={0}
                  title={shown ? undefined : 'Hidden inside a group on the graph'}
                  className={cn(
                    'hover:bg-accent/60 cursor-pointer border-b',
                    selected && 'bg-accent',
                    !shown && 'text-muted-foreground',
                  )}
                  onClick={() => {
                    onPick(row.original);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onPick(row.original);
                    }
                  }}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-2 py-1 whitespace-nowrap">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && total === 0 && <p className="text-muted-foreground p-4 text-sm">No nodes match these filters.</p>}
      </div>
    </div>
  );
}

const EMPTY: GraphNode[] = [];
