import type { AggregateNode, GraphNode } from '@redwhale/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError, ResponseShapeError } from '@/api/client';
import { saveLayout, useExpansions, useGraph, useNeighborhoods } from '@/api/hooks';
import { Legend } from '@/components/Legend';
import { Badge } from '@/components/ui/badge';
import { canExpandNeighbors, canLoadPage, composeGraph, type ComposedGraph, type GroupState } from '@/graph/compose';
import { CytoscapeGraph } from '@/graph/CytoscapeGraph';
import { toElements } from '@/graph/elements';
import type { GraphHandlers } from '@/graph/events';
import { PositionSaver } from '@/graph/positions';
import { ContextMenu } from '@/menu/ContextMenu';
import { menuItems, safeHttpUrl, type MenuAction } from '@/menu/items';
import { SidePanel } from '@/panel/SidePanel';
import { useUi } from '@/state/ui';

type AnyNode = GraphNode | AggregateNode;

function ErrorPanel({ error }: { error: Error }) {
  const issues = error instanceof ApiError || error instanceof ResponseShapeError ? error.issues : [];
  return (
    <div className="m-auto max-w-xl rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm">
      <p className="font-semibold text-red-300">Couldn't load the graph: {error.message}</p>
      {issues.length > 0 && (
        <ul className="mt-2 list-disc pl-5 font-mono text-xs text-red-200">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-3">
        Is the API running? Start both with <code className="font-mono">pnpm dev</code>.
      </p>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground m-auto text-sm">{children}</div>;
}

/** The aggregate's own expansion, or the group a node was expanded from. */
function groupFor(composed: ComposedGraph, node: AnyNode): GroupState | undefined {
  const aggregateId = node.type === 'aggregate' ? node.id : composed.groupOf.get(node.id);
  return aggregateId === undefined ? undefined : composed.groups.get(aggregateId);
}

function canLoadMore(composed: ComposedGraph, node: AnyNode): boolean {
  if (node.type !== 'aggregate') return false;
  return canLoadPage(composed, composed.groups.get(node.id)?.remaining ?? node.total);
}

/** Saves dragged positions for the lifetime of the app, flushing when the page goes away. */
function usePositionSaver(): { saver: RefObject<PositionSaver | null>; error: string | null } {
  const saver = useRef<PositionSaver | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const s = new PositionSaver((positions, options) => saveLayout(positions, options), {
      onError: (e) => {
        setError(e instanceof Error ? e.message : String(e));
      },
      onSaved: () => {
        setError(null);
      },
    });
    saver.current = s;
    const onHide = () => {
      void s.flush({ keepalive: true });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      void s.flush();
      s.dispose();
      saver.current = null;
    };
  }, []);
  return { saver, error };
}

export function App() {
  const graph = useGraph();
  const selectedId = useUi((s) => s.selectedId);
  const focusId = useUi((s) => s.focusId);
  const expanded = useUi((s) => s.expanded);
  const neighbors = useUi((s) => s.neighbors);
  const menu = useUi((s) => s.menu);
  const { select, focus, expand, collapse, expandNeighbors, openMenu, closeMenu } = useUi.getState();

  const expansions = useExpansions(expanded);
  const neighborhoods = useNeighborhoods(neighbors);
  const composed = useMemo(
    () =>
      graph.data
        ? composeGraph({ base: graph.data, expansions: expansions.data, neighborhoods: neighborhoods.data })
        : null,
    [graph.data, expansions.data, neighborhoods.data],
  );
  const elements = useMemo(() => (composed ? toElements(composed) : []), [composed]);
  const nodesById = useMemo(() => new Map(composed?.nodes.map((n) => [n.id, n])), [composed]);
  const { saver, error: layoutError } = usePositionSaver();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') focus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [focus]);

  const run = (action: MenuAction, target: AnyNode) => {
    closeMenu();
    if (!composed) return;
    switch (action) {
      case 'focus':
        focus(target.id);
        break;
      case 'expand-neighbors':
        if (canExpandNeighbors(composed)) expandNeighbors(target.id);
        break;
      case 'copy-value':
        if (target.type !== 'aggregate') void navigator.clipboard.writeText(target.value);
        break;
      case 'open-url': {
        const url = target.type === 'url' ? safeHttpUrl(target.value) : null;
        if (url !== null) window.open(url, '_blank', 'noopener,noreferrer');
        break;
      }
      case 'expand':
        if (canLoadMore(composed, target)) expand(target.id);
        break;
      case 'collapse': {
        const group = groupFor(composed, target);
        if (group) collapse(group.aggregateId, group.members);
        break;
      }
      case 'run-tool':
        break;
    }
  };

  const handlers: GraphHandlers = {
    onSelect: (id) => {
      select(id);
      if (id === null) focus(null);
    },
    onExpand: (id) => {
      const target = nodesById.get(id);
      if (target) run('expand', target);
    },
    onContextMenu: ({ id, x, y }) => {
      openMenu({ id, x, y });
    },
    onMoved: (positions) => {
      saver.current?.queue(positions);
    },
  };

  const selected = selectedId === null ? undefined : nodesById.get(selectedId);
  const menuTarget = menu === null ? undefined : nodesById.get(menu.id);
  const overlayError = expansions.error ?? neighborhoods.error;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="text-sm font-bold tracking-[0.2em] text-red-500">RED WHALE</h1>
        {graph.data && composed && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {composed.nodes.length} of {graph.data.totals.nodes} nodes shown · {graph.data.totals.edges} edges
          </span>
        )}
        {graph.data?.truncated && (
          <Badge variant="destructive" title={`aggregated at threshold ${String(graph.data.threshold)}`}>
            truncated
          </Badge>
        )}
        {composed && composed.overBudget.length > 0 && (
          <Badge variant="destructive" title="Some expansions weren't shown: the canvas holds ~2,000 elements at most">
            element limit reached
          </Badge>
        )}
        {overlayError && (
          <Badge variant="destructive" title={overlayError.message}>
            expand failed
          </Badge>
        )}
        {layoutError !== null && (
          <Badge variant="destructive" title={layoutError}>
            layout not saved
          </Badge>
        )}
        {focusId !== null && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs"
            onClick={() => {
              focus(null);
            }}
          >
            focused · Esc to clear
          </button>
        )}
        {(graph.isFetching || expansions.isFetching || neighborhoods.isFetching) && (
          <span className="text-muted-foreground text-xs">loading…</span>
        )}
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          {graph.error ? (
            <ErrorPanel error={graph.error} />
          ) : graph.data && graph.data.totals.nodes === 0 ? (
            <Message>
              The workspace is empty. Load some data with <code className="font-mono">pnpm mock</code> or{' '}
              <code className="font-mono">pnpm ingest &lt;file.json&gt;</code>.
            </Message>
          ) : (
            <CytoscapeGraph
              elements={elements}
              selectedId={selectedId}
              focusId={focusId}
              handlers={handlers}
              className="absolute inset-0"
            />
          )}
          <Legend className="absolute bottom-4 left-4" />
          {menu && menuTarget && composed && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              title={menuTarget.label}
              items={menuItems(menuTarget, {
                group: groupFor(composed, menuTarget),
                canLoadPage: canLoadMore(composed, menuTarget),
                canExpandNeighbors: canExpandNeighbors(composed),
              })}
              onAction={(action) => {
                run(action, menuTarget);
              }}
              onClose={closeMenu}
            />
          )}
        </div>
        {selected && composed && (
          <SidePanel
            target={selected}
            group={groupFor(composed, selected)}
            parentLabel={
              selected.type === 'aggregate' && selected.parentId !== null
                ? nodesById.get(selected.parentId)?.label
                : undefined
            }
            canLoadPage={canLoadMore(composed, selected)}
            onAction={(action) => {
              run(action, selected);
            }}
            onClose={() => {
              select(null);
            }}
          />
        )}
      </main>
    </div>
  );
}
