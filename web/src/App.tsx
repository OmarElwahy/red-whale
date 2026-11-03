import type { AggregateNode, GraphNode, GraphResponse, ToolInfo, ViewEdge, ViewNode } from '@redwhale/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError, ResponseShapeError } from '@/api/client';
import type { LiveStatus } from '@/api/live';
import { useLiveUpdates } from '@/api/useLiveUpdates';
import {
  fetchFirstMatch,
  fetchPath,
  saveLayout,
  useGraphPath,
  useGraphView,
  useHighlights,
  useNodeDetail,
  useStats,
} from '@/api/hooks';
import { queryKeys } from '@/api/query';
import { Legend } from '@/components/Legend';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FilterSidebar } from '@/filters/FilterSidebar';
import {
  ELEMENT_BUDGET,
  below,
  canExpandNeighbors,
  childGroups,
  indexView,
  keepFrom,
  sameState,
  type ViewIndex,
} from '@/graph/groups';
import { CytoscapeGraph, type GraphHandle } from '@/graph/CytoscapeGraph';
import { ExportButtons } from '@/graph/ExportButtons';
import { toElements } from '@/graph/elements';
import type { GraphHandlers } from '@/graph/events';
import { PositionSaver } from '@/graph/positions';
import { ContextMenu } from '@/menu/ContextMenu';
import { canvasMenuItems, menuItems, safeHttpUrl, type MenuAction, type RunContext } from '@/menu/items';
import { AddNodeDialog, type NodeRef } from '@/edit/AddNodeDialog';
import { DeleteDialog } from '@/edit/DeleteDialog';
import { DeletionsPanel } from '@/edit/DeletionsPanel';
import { forgetDeleted } from '@/api/useLiveUpdates';
import { HighlightsView } from '@/highlights/HighlightsView';
import { ConfirmRequired, RunRefused, useRunnerStatus, useStartRun, useTools, type RunRequest } from '@/api/runner';
import { scopeIsEmpty, useScopeRules, useScopeSettings } from '@/api/scope';
import { ActiveRunDialog, needsConfirmation, toolsThatRun, type ActiveRunTarget } from '@/jobs/ActiveRunDialog';
import { JobsPanel } from '@/jobs/JobsPanel';
import { RunnerIndicator } from '@/jobs/RunnerIndicator';
import { ScopeBanner, ScopePanel } from '@/scope/ScopePanel';
import { EdgePanel, GroupEdgePanel } from '@/panel/EdgePanel';
import { SidePanel } from '@/panel/SidePanel';
import { useLive } from '@/state/live';
import { useUi, type BottomPanel } from '@/state/ui';
import { NodeTable } from '@/table/NodeTable';
import { LAYOUT_MODES, hasFilters, useView, type LayoutMode } from '@/state/view';


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

function LiveIndicator({ status }: { status: LiveStatus }) {
  const open = status === 'open';
  return (
    <span
      className="text-muted-foreground mr-2 inline-flex items-center gap-1.5 text-xs"
      title={open ? 'New scans appear as soon as they are ingested' : 'Live updates are off until the API is back'}
    >
      <span className={cn('size-2 rounded-full', open ? 'bg-emerald-500' : 'animate-pulse bg-amber-400')} aria-hidden />
      {open ? 'live' : status === 'connecting' ? 'connecting…' : 'reconnecting…'}
    </span>
  );
}

function PanelToggle({
  panel,
  current,
  children,
}: {
  panel: BottomPanel;
  current: BottomPanel | null;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={current === panel ? 'secondary' : 'ghost'}
      aria-pressed={current === panel}
      onClick={() => {
        useUi.getState().toggleBottomPanel(panel);
      }}
    >
      {children}
    </Button>
  );
}

/** Header toggle for the Scope panel, with how many rules are active and whether passive-only is on. */
function ScopeToggle({ current }: { current: BottomPanel | null }) {
  const rules = useScopeRules();
  const settings = useScopeSettings();
  const active = rules.data?.length;
  const empty = rules.data !== undefined && scopeIsEmpty(rules.data);
  return (
    <PanelToggle panel="scope" current={current}>
      <span className="inline-flex items-center gap-1.5">
        {empty && <span className="size-2 rounded-full bg-amber-400" aria-hidden />}
        Scope{active === undefined ? '' : ` (${String(active)})`}
        {settings.data?.passiveOnly && <span className="text-muted-foreground text-[10px] font-normal">passive</span>}
      </span>
    </PanelToggle>
  );
}

/** Force | Tree, plus Re-layout while in Tree mode. View-only: it lives in the URL, never in API params. */
function LayoutToggle({ layout }: { layout: LayoutMode }) {
  const { setLayout } = useView.getState();
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Layout">
      <span className="text-muted-foreground mr-1 text-xs">Layout</span>
      {LAYOUT_MODES.map((m) => (
        <Button
          key={m}
          size="sm"
          variant={layout === m ? 'secondary' : 'ghost'}
          aria-pressed={layout === m}
          onClick={() => {
            setLayout(m);
          }}
        >
          {m === 'force' ? 'Force' : 'Tree'}
        </Button>
      ))}
      {layout === 'tree' && (
        <Button
          size="sm"
          variant="ghost"
          title="Snap back to the clean tree (dragged branches move back)"
          onClick={useUi.getState().relayout}
        >
          Re-layout
        </Button>
      )}
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground m-auto text-sm">{children}</div>;
}

/** The header line for an "Expand all below" answer. */
function expandAllNotice(view: GraphResponse): string | null {
  if (view.expandAll.length === 0) return null;
  const opened = view.expandAll.reduce((n, r) => n + r.opened, 0);
  const hidden = view.expandAll.reduce((n, r) => n + r.hidden, 0);
  const groups = `${String(opened)} group${opened === 1 ? '' : 's'}`;
  if (hidden === 0) return `Expand all below: opened ${groups}`;
  const why = view.truncated ? ' (element limit)' : '';
  return `Expand all below: opened ${groups}; ${String(hidden)} nodes below are still collapsed${why}`;
}

function groupNode(ix: ViewIndex, id: string): AggregateNode | undefined {
  const n = ix.byId.get(id);
  return n?.type === 'aggregate' ? n : undefined;
}

/** Open groups drawn below this group, and every node drawn below those. */
function openBelow(ix: ViewIndex, groupId: string): { groups: string[]; hidden: string[] } {
  const groups = below(ix, groupId).groups.filter((g) => groupNode(ix, g)?.expanded === true);
  const hidden = new Set<string>();
  for (const g of groups) for (const id of below(ix, g).nodes) hidden.add(id);
  return { groups, hidden: [...hidden] };
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

/**
 * The selected edge's panel: a parent → group edge from the view (gone with its group); a real edge from its detail,
 * so its panel stays when the edge leaves the canvas.
 */
function SelectedEdgePanel({
  id,
  edge,
  ix,
  onPickNode,
  onClose,
}: {
  id: string;
  edge: ViewEdge | undefined;
  ix: ViewIndex;
  onPickNode: (id: string) => void;
  onClose: () => void;
}) {
  if (edge?.kind === 'group') {
    const parent = ix.byId.get(edge.source);
    return (
      <GroupEdgePanel
        edge={edge}
        parent={parent ? { id: parent.id, label: parent.label } : undefined}
        groupLabel={ix.byId.get(edge.target)?.label ?? 'group'}
        onPickNode={onPickNode}
        onClose={onClose}
      />
    );
  }
  if (id.startsWith('edge:')) return null;
  return <EdgePanel key={id} edgeId={id} onPickNode={onPickNode} onClose={onClose} />;
}

export function App() {
  const filters = useView((s) => s.filters);
  const mute = useView((s) => s.mute);
  const hops = useView((s) => s.hops);
  const layout = useView((s) => s.layout);
  const relayoutSeq = useUi((s) => s.relayoutSeq);
  const [layingOut, setLayingOut] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  /** The Add node dialog: under which node (or none), and where on the canvas (null: laid out automatically). */
  const [adding, setAdding] = useState<{ parent: NodeRef | null; position: { x: number; y: number } | null } | null>(null);
  /** The delete dialog's node or group. */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** A run that contacts the target, waiting for the analyst's confirmation (asked every time). */
  const [activeRun, setActiveRun] = useState<{
    req: RunRequest;
    label: string;
    node: ActiveRunTarget;
    tools: ToolInfo[];
    group?: { name: string; label: string };
  } | null>(null);
  useLiveUpdates();
  const liveStatus = useLive((s) => s.status);
  const fresh = useLive((s) => s.fresh);
  const stats = useStats();
  const highlights = useHighlights();
  const tools = useTools();
  const runner = useRunnerStatus();
  const scopeSettings = useScopeSettings();
  const startRun = useStartRun();
  const runContext: RunContext = {
    tools: tools.data,
    runner: runner.data,
    passiveOnly: scopeSettings.data?.passiveOnly,
    ...(tools.error ? { toolsError: `Tool runs are off: ${tools.error.message}` } : {}),
  };
  const graphRef = useRef<GraphHandle>(null);
  const queryClient = useQueryClient();
  const selectedId = useUi((s) => s.selectedId);
  const selectedEdgeId = useUi((s) => s.selectedEdgeId);
  const focusId = useUi((s) => s.focusId);
  const expanded = useUi((s) => s.expanded);
  const neighbors = useUi((s) => s.neighbors);
  const expandAll = useUi((s) => s.expandAll);
  const collapsing = useUi((s) => s.collapsing);
  const anchor = useUi((s) => s.anchor);
  const notice = useUi((s) => s.notice);
  const centerWhenShown = useUi((s) => s.centerWhenShown);
  const bottomPanel = useUi((s) => s.bottomPanel);
  const menu = useUi((s) => s.menu);
  const centerOn = useUi((s) => s.centerOn);
  const jumpPending = useUi((s) => s.jumpPending);
  const ui = useUi.getState();
  const { select, selectEdge, focus, openMenu, closeMenu, center, clearJump } = ui;

  // What the canvas shows directly goes with every request (`keep`), so a live update that folds it into a new
  // group gets that group opened instead.
  const keep = useRef<{ edges: string[]; roots: string[] }>({ edges: [], roots: [] });
  const graph = useGraphView({ filters, expand: expanded, neighbors, expandAll }, () => keep.current);
  const view = graph.data;
  const ix = useMemo(() => (view ? indexView(view) : null), [view]);
  const elements = useMemo(() => (view ? toElements(view) : []), [view]);
  const edgeById = useMemo(() => new Map(view?.edges.map((e) => [e.id, e]) ?? []), [view]);
  // The selected edge on the canvas: a parent → group edge by its own ID; a real edge drawn directly, or else as a
  // group → member edge standing for it.
  const canvasEdgeId = useMemo(() => {
    if (selectedEdgeId === null) return null;
    if (edgeById.has(selectedEdgeId)) return selectedEdgeId;
    return view?.edges.find((e) => e.edgeId === selectedEdgeId)?.id ?? null;
  }, [selectedEdgeId, edgeById, view]);
  useEffect(() => {
    if (view) keep.current = keepFrom(view);
  }, [view]);
  const { saver, error: layoutError } = usePositionSaver();

  // The server answers with the view it applied: groups dropped (collapsed above, gone under these filters, over
  // budget), auto-opened, or opened by "Expand all below". That becomes the state, under a key that already has
  // this answer, so nothing is fetched twice.
  useEffect(() => {
    if (!view || graph.isPlaceholderData) return;
    const now = useUi.getState();
    const asked = { expand: now.expanded, neighbors: now.neighbors };
    if (now.expandAll.length === 0 && sameState(view.state, asked)) return;
    queryClient.setQueryData(queryKeys.view(filters, view.state.expand, view.state.neighbors, []), view);
    now.adoptView(view.state, now.expandAll.length > 0 ? expandAllNotice(view) : null);
  }, [view, graph.isPlaceholderData, filters, queryClient]);

  const isShown = (id: string) => ix?.byId.has(id) ?? false;

  // A node selected while it isn't on the canvas (picked in the table, hidden by a collapse or a filter change):
  // its panel is built from its detail, and offers "Show on graph" unless the filters leave it out.
  const hiddenId =
    selectedId !== null &&
    !selectedId.startsWith('agg:') &&
    !selectedId.startsWith('more:') &&
    ix !== null &&
    !ix.byId.has(selectedId)
      ? selectedId
      : null;
  const hidden = useNodeDetail(hiddenId);
  const hiddenPath = useGraphPath(hiddenId, filters);
  const hiddenNode = hiddenId !== null && hidden.data?.node.id === hiddenId ? hidden.data.node : null;

  // The latest view, for callbacks that run after an await.
  const ixRef = useRef<ViewIndex | null>(null);
  useEffect(() => {
    ixRef.current = ix;
  }, [ix]);

  /** Opens exactly the groups on the path to the node, then centers on it once it's drawn. */
  const showOnGraph = useCallback(
    async (id: string) => {
      if (ixRef.current?.byId.has(id)) {
        center(id);
        return;
      }
      const path = await fetchPath(id, useView.getState().filters);
      if (path.inView) useUi.getState().openPath(id, path.steps);
    },
    [center],
  );

  // Center on a node as soon as it is on the canvas (after opening the path to it).
  useEffect(() => {
    if (centerWhenShown === null || !ix?.byId.has(centerWhenShown)) return;
    useUi.getState().clearCenterWhenShown();
    center(centerWhenShown);
  }, [centerWhenShown, ix, center]);

  // The search the canvas was loaded with: while a new one loads, the previous graph is still shown.
  const [loadedQuery, setLoadedQuery] = useState(filters.q);
  if (view && !graph.isPlaceholderData && loadedQuery !== filters.q) setLoadedQuery(filters.q);

  // Search jump (Enter): the riskiest match anywhere, opened down to if it's inside collapsed groups.
  useEffect(() => {
    if (!jumpPending) return;
    clearJump();
    const current = useView.getState().filters;
    if (current.q === undefined) return;
    void fetchFirstMatch(current).then((match) => {
      if (!match) return;
      select(match.id);
      void showOnGraph(match.id);
    });
  }, [jumpPending, clearJump, select, showOnGraph]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') focus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [focus]);

  const collapseGroup = (groupId: string) => {
    if (!ix) return;
    ui.collapse(groupId, [...below(ix, groupId).nodes]);
  };

  /** Queues a run. The server decides (scope at queueing and again at the start); the header says what happened. */
  const runTool = (req: RunRequest, label: string) => {
    startRun.mutate(req, {
      onSuccess: (jobs) => {
        ui.showNotice(`${label}: queued ${String(jobs.length)} job${jobs.length === 1 ? '' : 's'}`);
        ui.openBottomPanel('jobs');
      },
      onError: (e) => {
        ui.showNotice(
          e instanceof RunRefused
            ? `${label} refused: ${e.message}`
            : e instanceof ConfirmRequired
              ? `${label} not started: ${e.message}`
              : `${label} failed: ${e.message}`,
        );
      },
    });
  };

  const run = (action: MenuAction, target: ViewNode | null, name?: string) => {
    const at = menu?.model;
    closeMenu();
    if (action === 'add-node') {
      // Force: the node stays where the analyst right-clicked (saved like a drag). Tree: the tree places it.
      setAdding({ parent: null, position: at && layout === 'force' ? at : null });
      return;
    }
    if (!ix || target === null) return;
    const group = target.type === 'aggregate' ? target : undefined;
    switch (action) {
      case 'focus':
        focus(target.id);
        break;
      case 'expand-neighbors':
        if (canExpandNeighbors(ix)) {
          const closed = childGroups(ix, target.id).filter((id) => groupNode(ix, id)?.expanded === false);
          ui.expandNeighbors(target.id, closed);
        }
        break;
      case 'expand-all-below':
        ui.expandAllBelow(target.id);
        break;
      case 'copy-value':
        if (target.type !== 'aggregate' && target.type !== 'more') void navigator.clipboard.writeText(target.value);
        break;
      case 'open-url': {
        const url = target.type === 'url' ? safeHttpUrl(target.value) : null;
        if (url !== null) window.open(url, '_blank', 'noopener,noreferrer');
        break;
      }
      case 'expand':
        if (group?.canLoadMore) ui.expandGroup(group.id);
        break;
      case 'collapse':
        if (group) collapseGroup(group.id);
        break;
      case 'collapse-below':
        if (group) {
          const { groups, hidden: gone } = openBelow(ix, group.id);
          ui.collapseBelow(group.id, groups, gone);
        }
        break;
      case 'load-more': {
        const owner = target.type === 'more' ? groupNode(ix, target.groupId) : group;
        if (owner?.canLoadMore) ui.loadMore(owner.id);
        break;
      }
      case 'collapse-parent': {
        const parent = ix.memberOf.get(target.id);
        if (parent) collapseGroup(parent.id);
        break;
      }
      case 'run-tool':
      case 'run-group':
        if (target.type !== 'aggregate' && target.type !== 'more' && name !== undefined) {
          const req: RunRequest =
            action === 'run-tool' ? { kind: 'tool', tool: name, nodeId: target.id } : { kind: 'group', group: name, nodeId: target.id };
          const label = `${action === 'run-tool' ? name : `group ${name}`} on ${target.label}`;
          const willRun = toolsThatRun(tools.data, req.kind, name, target.type);
          if (needsConfirmation(willRun)) {
            // It contacts the target: say exactly what and against what, and wait for "Run active scan".
            const groupInfo = action === 'run-group' ? tools.data?.groups.find((g) => g.name === name) : undefined;
            setActiveRun({
              req,
              label,
              node: { id: target.id, type: target.type, value: target.value, label: target.label },
              tools: willRun,
              ...(groupInfo ? { group: { name: groupInfo.name, label: groupInfo.label } } : {}),
            });
          } else {
            runTool(req, label);
          }
        }
        break;
      case 'add-child':
        // Laid out next to its parent (no saved position), in either mode.
        if (target.type !== 'aggregate' && target.type !== 'more') {
          setAdding({ parent: { id: target.id, type: target.type, value: target.value, label: target.label }, position: null });
        }
        break;
      case 'delete':
        if (target.type !== 'more') setDeleting(target.id);
        break;
      case 'run-menu':
        break;
    }
  };

  const handlers: GraphHandlers = {
    onSelectEdge: (id) => {
      const e = edgeById.get(id);
      if (!e) return;
      // A group → member edge stands for its real edge: that's what the panel shows (and keeps if it's hidden).
      selectEdge(e.kind === 'group' ? e.id : (e.edgeId ?? e.id));
    },
    onSelect: (id) => {
      // A "more" node stands for its group.
      const more = id !== null ? ix?.byId.get(id) : undefined;
      select(more?.type === 'more' ? more.groupId : id);
      if (id === null) focus(null);
    },
    onDoubleTap: (id) => {
      const target = ix?.byId.get(id);
      if (target?.type === 'aggregate') run(target.expanded ? 'collapse' : 'expand', target);
      else if (target?.type === 'more') run('load-more', target);
    },
    onContextMenu: ({ id, x, y }) => {
      openMenu({ id, x, y });
    },
    onCanvasContextMenu: ({ x, y, modelX, modelY }) => {
      openMenu({ id: null, x, y, model: { x: modelX, y: modelY } });
    },
    onMoved: (positions) => {
      saver.current?.queue(positions);
    },
  };

  /** Table row or highlight: select it, and open the groups down to it if it's inside collapsed ones. */
  const pick = (id: string) => {
    select(id);
    void showOnGraph(id);
  };

  /** An edge panel's end: a group has no path to open, so it's selected and centered; a node is picked like a row. */
  const pickNode = (id: string) => {
    if (id.startsWith('agg:')) {
      select(id);
      center(id);
    } else pick(id);
  };

  const shownNode = selectedId === null ? undefined : ix?.byId.get(selectedId);
  const selected: GraphNode | AggregateNode | undefined =
    shownNode && shownNode.type !== 'more' ? shownNode : (hiddenNode ?? undefined);
  const revealBlocked =
    hiddenPath.data === undefined
      ? 'Checking where it is…'
      : !hiddenPath.data.inView
        ? 'The current filters leave it out.'
        : ix !== null && ix.size >= ELEMENT_BUDGET
          ? 'The graph is at its ~2,000-element limit. Collapse a group to make room.'
          : null;
  const menuTarget = menu === null || menu.id === null ? undefined : ix?.byId.get(menu.id);
  const filtered = hasFilters(filters);
  const workspaceEmpty =
    stats.data?.totals.nodes === 0 || (view !== undefined && view.totals.nodes === 0 && !filtered);
  const noMatches = !workspaceEmpty && filtered && view?.totals.nodes === 0;
  const realShown = view ? view.nodes.filter((n) => n.type !== 'aggregate' && n.type !== 'more').length : 0;
  const overBudget = view !== undefined && (view.overBudget.length > 0 || view.truncated);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="text-sm font-bold tracking-[0.2em] text-red-500">RED WHALE</h1>
        {view && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {realShown} of {view.totals.nodes} nodes shown · {view.totals.edges} edges
            {filtered && stats.data && <> · filtered from {stats.data.totals.nodes}</>}
          </span>
        )}
        {overBudget && (
          <Badge
            variant="destructive"
            title="Some groups weren't opened: the canvas holds ~2,000 elements at most. Collapse a group to make room."
          >
            element limit reached
          </Badge>
        )}
        {notice !== null && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs"
            title="Dismiss"
            onClick={ui.dismissNotice}
          >
            {notice} ✕
          </button>
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
            focused · {hops} hop{hops === 1 ? '' : 's'} · Esc to clear
          </button>
        )}
        {graph.isFetching && (
          <span className="text-muted-foreground text-xs">loading…</span>
        )}
        {layingOut && layout === 'tree' && <span className="text-muted-foreground text-xs">laying out tree…</span>}
        <div className="ml-auto flex items-center gap-1">
          <LiveIndicator status={liveStatus} />
          <RunnerIndicator />
          <LayoutToggle layout={layout} />
          <span className="bg-border mx-1 h-5 w-px" aria-hidden />
          <Button
            size="sm"
            variant={legendOpen ? 'secondary' : 'ghost'}
            aria-pressed={legendOpen}
            onClick={() => {
              setLegendOpen((o) => !o);
            }}
          >
            Legend
          </Button>
          <PanelToggle panel="table" current={bottomPanel}>
            Table
          </PanelToggle>
          <PanelToggle panel="highlights" current={bottomPanel}>
            Highlights{highlights.data ? ` (${String(highlights.data.length)})` : ''}
          </PanelToggle>
          <ScopeToggle current={bottomPanel} />
          <PanelToggle panel="deleted" current={bottomPanel}>
            Deleted
          </PanelToggle>
          <PanelToggle panel="jobs" current={bottomPanel}>
            Jobs{runner.data && runner.data.running + runner.data.queued > 0 ? ` (${String(runner.data.running + runner.data.queued)})` : ''}
          </PanelToggle>
          <span className="bg-border mx-1 h-5 w-px" aria-hidden />
          <ExportButtons
            png={() => graphRef.current?.png() ?? null}
            pngDisabled={graph.error !== null || workspaceEmpty || view === undefined}
          />
        </div>
      </header>
      <ScopeBanner
        onOpen={() => {
          if (bottomPanel !== 'scope') useUi.getState().toggleBottomPanel('scope');
        }}
      />
      <main className="flex min-h-0 flex-1">
        <FilterSidebar stats={stats.data} className="w-60 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            {graph.error ? (
              <ErrorPanel error={graph.error} />
            ) : workspaceEmpty ? (
              <Message>
                The workspace is empty. Load some data with <code className="font-mono">pnpm mock</code> or{' '}
                <code className="font-mono">pnpm ingest &lt;file.json&gt;</code>, or{' '}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAdding({ parent: null, position: null });
                  }}
                >
                  add a node
                </Button>
                .
              </Message>
            ) : (
              <CytoscapeGraph
                ref={graphRef}
                elements={elements}
                selectedId={selectedId ?? canvasEdgeId}
                focusId={focusId}
                hops={hops}
                mute={mute}
                query={loadedQuery}
                centerOn={centerOn}
                fresh={fresh}
                alsoFlash={view && !graph.isPlaceholderData ? view.autoFolded : []}
                collapsing={collapsing}
                anchor={anchor}
                layout={layout}
                relayoutSeq={relayoutSeq}
                onLayoutBusy={setLayingOut}
                handlers={handlers}
                className="absolute inset-0"
              />
            )}
            {noMatches && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <p className="text-muted-foreground text-sm">Nothing matches these filters.</p>
                <Button variant="outline" size="sm" onClick={useView.getState().resetFilters}>
                  Reset filters
                </Button>
              </div>
            )}
            {legendOpen && (
              <Legend
                className="absolute bottom-4 left-4"
                onClose={() => {
                  setLegendOpen(false);
                }}
              />
            )}
            {menu && menuTarget && ix && (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                title={menuTarget.label}
                items={menuItems(menuTarget, {
                  group: menuTarget.type === 'more' ? groupNode(ix, menuTarget.groupId) : ix.memberOf.get(menuTarget.id),
                  canExpandNeighbors: canExpandNeighbors(ix),
                  hasRoom: ix.size < ELEMENT_BUDGET,
                  hasOpenBelow: menuTarget.type === 'aggregate' && openBelow(ix, menuTarget.id).groups.length > 0,
                  run: runContext,
                })}
                onAction={(item) => {
                  run(item.action, menuTarget, item.name);
                }}
                onClose={closeMenu}
              />
            )}
            {menu && menu.id === null && (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                title="Canvas"
                items={canvasMenuItems()}
                onAction={(item) => {
                  run(item.action, null);
                }}
                onClose={closeMenu}
              />
            )}
          </div>
          {bottomPanel === 'table' && (
            <section aria-label="Table" className="flex h-[40%] min-h-40 shrink-0 flex-col border-t">
              <NodeTable
                selectedId={selectedId}
                isShown={isShown}
                onPick={(node) => {
                  pick(node.id);
                }}
                className="flex-1"
              />
            </section>
          )}
          {bottomPanel === 'scope' && (
            <section aria-label="Scope" className="flex h-[45%] min-h-48 shrink-0 flex-col border-t">
              <ScopePanel className="flex-1" />
            </section>
          )}
          {bottomPanel === 'jobs' && (
            <section aria-label="Jobs" className="flex h-[40%] min-h-40 shrink-0 flex-col border-t">
              <JobsPanel
                className="flex-1"
                onPickNode={(id) => {
                  ui.setHighlightScan(null);
                  pick(id);
                }}
                onShowResults={(job) => {
                  if (job.nodeId === null) return;
                  ui.setHighlightScan(job.scanId);
                  pick(job.nodeId);
                }}
              />
            </section>
          )}
          {bottomPanel === 'deleted' && (
            <section aria-label="Deleted" className="flex h-[40%] min-h-40 shrink-0 flex-col border-t">
              <DeletionsPanel className="flex-1" />
            </section>
          )}
          {bottomPanel === 'highlights' && (
            <section aria-label="Highlights" className="flex h-[40%] min-h-40 shrink-0 flex-col border-t">
              <HighlightsView
                items={highlights.data}
                error={highlights.error}
                selectedId={selectedId}
                isShown={isShown}
                onPick={pick}
                className="min-h-0 flex-1"
              />
            </section>
          )}
        </div>
        {selectedEdgeId !== null && ix && (
          <SelectedEdgePanel
            id={selectedEdgeId}
            edge={edgeById.get(selectedEdgeId)}
            ix={ix}
            onPickNode={pickNode}
            onClose={() => {
              select(null);
            }}
          />
        )}
        {selected && ix && (
          <SidePanel
            target={selected}
            memberOf={ix.memberOf.get(selected.id)}
            parentLabel={
              selected.type === 'aggregate' && selected.parentId !== null
                ? ix.byId.get(selected.parentId)?.label
                : undefined
            }
            hasOpenBelow={selected.type === 'aggregate' && openBelow(ix, selected.id).groups.length > 0}
            reveal={
              hiddenNode
                ? {
                    blocked: revealBlocked,
                    onReveal: () => {
                      void showOnGraph(hiddenNode.id);
                    },
                  }
                : undefined
            }
            onAction={(action) => {
              run(action, selected);
            }}
            onClose={() => {
              select(null);
            }}
          />
        )}
      </main>
      {deleting !== null && (
        <DeleteDialog
          id={deleting}
          filters={filters}
          onDeleted={(result) => {
            setDeleting(null);
            // At once, not when the event comes back: nothing on screen should point at them meanwhile.
            forgetDeleted(result.nodeIds, result.edgeIds);
            ui.showNotice(`Deleted ${String(result.nodeIds.length)} node${result.nodeIds.length === 1 ? '' : 's'}`);
            void queryClient.invalidateQueries({ queryKey: queryKeys.all });
          }}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
      {activeRun && (
        <ActiveRunDialog
          node={activeRun.node}
          tools={activeRun.tools}
          {...(activeRun.group ? { group: activeRun.group } : {})}
          onConfirm={() => {
            setActiveRun(null);
            runTool({ ...activeRun.req, confirmActive: true }, activeRun.label);
          }}
          onClose={() => {
            setActiveRun(null);
          }}
        />
      )}
      {adding && (
        <AddNodeDialog
          parent={adding.parent}
          position={adding.position}
          onDone={(id) => {
            setAdding(null);
            pick(id);
          }}
          onSelectExisting={(id) => {
            setAdding(null);
            pick(id);
          }}
          onClose={() => {
            setAdding(null);
          }}
        />
      )}
    </div>
  );
}
