// UI state (Zustand): what's selected, focused and open, and where the context menu is. Server data lives in
// TanStack Query; this only says which groups are open (docs/architecture.md §7), which the server then draws.
import { DEFAULT_NODE_SORT, parseAggregateId, type GroupOpen, type ViewState } from '@redwhale/shared';
import { create } from 'zustand';

export interface MenuState {
  /** The node or group right-clicked; null for the empty canvas. */
  id: string | null;
  /** Rendered position inside the graph container, in px. */
  x: number;
  y: number;
  /** Canvas menu: the graph position under the click (where "Add node…" puts the node). */
  model?: { x: number; y: number };
}

/** The panel under the graph. */
export type BottomPanel = 'table' | 'highlights' | 'scope' | 'jobs' | 'deleted';

export interface TableState {
  page: number;
  /** As GET /api/nodes takes it: `-effectiveSeverity,label`. */
  sort: string;
}

/** What a collapse hides: the canvas slides those nodes into the group (graph/diff.ts). */
export interface Collapsing {
  groupId: string;
  nodes: readonly string[];
  seq: number;
}

export interface UiState {
  selectedId: string | null;
  /** A selected edge (a real one by its ID, or a parent → group edge by its view ID); never set with `selectedId`. */
  selectedEdgeId: string | null;
  focusId: string | null;
  /**
   * Open groups, oldest first (the server refuses the newest first when the element budget is short). `pins` are
   * members opened on purpose, e.g. the path to a search result.
   */
  expanded: GroupOpen[];
  /** Nodes whose parents are all drawn ("Expand neighbors"), in order. */
  neighbors: string[];
  /** One-shot "Expand all below" requests, cleared when the server's answer is adopted. */
  expandAll: string[];
  /** Center on this node as soon as it is on the canvas (after opening the path to it). */
  centerWhenShown: string | null;
  collapsing: Collapsing | null;
  /**
   * The node the analyst last expanded, collapsed or opened a path to. The next tree re-layout keeps it where it is
   * on screen (graph/modes.ts); `seq` changes on every action, so the canvas uses each one once.
   */
  anchor: { id: string; seq: number } | null;
  /** A one-line answer shown in the header until dismissed (what "Expand all below" did). */
  notice: string | null;
  bottomPanel: BottomPanel | null;
  /** "Show results" of a job: that scan's rows are highlighted in the provenance table. */
  highlightScanId: string | null;
  table: TableState;
  menu: MenuState | null;
  /** A request to pan to a node; `seq` changes on every request, so the same node can be centered again. */
  centerOn: { id: string; seq: number } | null;
  /** Enter was pressed in search: select and center the riskiest match once the graph for that query is loaded. */
  jumpPending: boolean;
  /** Bumped by the Re-layout button; the canvas re-runs the tree when it changes. */
  relayoutSeq: number;

  /** Selects a node (or nothing); clears any selected edge. */
  select: (id: string | null) => void;
  /** Selects an edge; clears the selected node. */
  selectEdge: (id: string) => void;
  focus: (id: string | null) => void;
  /** Opens a collapsed group (first page), or turns a group opened only for its pins into its first page. */
  expandGroup: (groupId: string) => void;
  /** One more page of an open group. The entry moves to the end, so it's the first refused if it doesn't fit. */
  loadMore: (groupId: string) => void;
  /**
   * Closes the group. What was drawn below it goes too; the groups open below it are dropped by the server's
   * answer (they're no longer drawn), so they come back collapsed. `hidden` = the nodes that disappear.
   */
  collapse: (groupId: string, hidden: readonly string[]) => void;
  /** Closes the groups below this one (`groups`), keeping it open. */
  collapseBelow: (groupId: string, groups: readonly string[], hidden: readonly string[]) => void;
  /** Draws every parent of the node and opens the groups directly under it. */
  expandNeighbors: (id: string, childGroups: readonly string[]) => void;
  expandAllBelow: (id: string) => void;
  /** Opens exactly the groups on the path to a node (as pins), then centers on it once it's drawn. */
  openPath: (nodeId: string, steps: readonly { groupId: string; memberId: string }[]) => void;
  /** The view the server applied (pruned, auto-opened, expand-all done) becomes the state. */
  adoptView: (state: ViewState, notice?: string | null) => void;
  dismissNotice: () => void;
  /** A one-line message in the header (e.g. what a run did, or why it was refused). */
  showNotice: (text: string) => void;
  clearCenterWhenShown: () => void;
  /** Opens the panel, or closes it if it's already showing. */
  toggleBottomPanel: (panel: BottomPanel) => void;
  /** Opens the panel (never closes it). */
  openBottomPanel: (panel: BottomPanel) => void;
  setHighlightScan: (scanId: string | null) => void;
  setTablePage: (page: number) => void;
  /** A new sort starts again at page 1. */
  setTableSort: (sort: string) => void;
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;
  center: (id: string) => void;
  requestJump: () => void;
  clearJump: () => void;
  /** Tree mode: snap back to the clean tree (bumps `relayoutSeq`). */
  relayout: () => void;
  /**
   * Filters changed. Open groups stay open (the server drops those that no longer exist); focus is dropped and
   * the table goes back to page 1.
   */
  clearOverlays: () => void;
  /**
   * These nodes and edges were deleted (here or in another tab): forget every reference to them, so nothing asks for
   * them again. A selection, focus or menu on them goes; groups under a deleted parent and pins of deleted members go.
   */
  forgetDeleted: (nodeIds: readonly string[], edgeIds: readonly string[]) => void;
}

/** The group's parent, if it's a group ID with one. */
function groupParent(id: string): string | null {
  if (!id.startsWith('agg:')) return null;
  const key = parseAggregateId(id);
  return 'error' in key ? null : key.parentId;
}

export const initialUiState = {
  selectedId: null,
  selectedEdgeId: null,
  focusId: null,
  expanded: [],
  neighbors: [],
  expandAll: [],
  centerWhenShown: null,
  collapsing: null,
  anchor: null,
  notice: null,
  bottomPanel: null,
  highlightScanId: null,
  table: { page: 1, sort: DEFAULT_NODE_SORT },
  menu: null,
  centerOn: null,
  jumpPending: false,
  relayoutSeq: 0,
} satisfies Partial<UiState>;

/** After hiding these nodes: a hidden selection moves to the group, a hidden focus is cleared. */
function afterHiding(s: UiState, groupId: string, hidden: readonly string[]) {
  const gone = new Set(hidden);
  return {
    menu: null,
    selectedId: s.selectedId !== null && gone.has(s.selectedId) ? groupId : s.selectedId,
    focusId: s.focusId !== null && gone.has(s.focusId) ? null : s.focusId,
    collapsing: hidden.length > 0 ? { groupId, nodes: hidden, seq: (s.collapsing?.seq ?? 0) + 1 } : s.collapsing,
  };
}

const opened = (id: string): GroupOpen => ({ id, pages: 1, pins: [] });

/** This action's node stays put on screen through the re-layout it causes. */
const anchored = (s: UiState, id: string) => ({ anchor: { id, seq: (s.anchor?.seq ?? 0) + 1 } });

export const useUi = create<UiState>()((set) => ({
  ...initialUiState,

  select: (id) => {
    set((s) => ({
      selectedId: id,
      selectedEdgeId: null,
      menu: null,
      centerWhenShown: s.centerWhenShown === id ? s.centerWhenShown : null,
    }));
  },
  selectEdge: (id) => {
    set({ selectedId: null, selectedEdgeId: id, menu: null, centerWhenShown: null });
  },
  focus: (id) => {
    set({ focusId: id, menu: null });
  },
  relayout: () => {
    set((s) => ({ relayoutSeq: s.relayoutSeq + 1 }));
  },
  expandGroup: (groupId) => {
    set((s) => {
      const current = s.expanded.find((x) => x.id === groupId);
      if (current && current.pages >= 1) return { menu: null };
      return {
        ...anchored(s, groupId),
        menu: null,
        expanded: current
          ? s.expanded.map((x) => (x.id === groupId ? { ...x, pages: 1 } : x))
          : [...s.expanded, opened(groupId)],
      };
    });
  },
  loadMore: (groupId) => {
    set((s) => {
      const current = s.expanded.find((x) => x.id === groupId);
      const next = current ? { ...current, pages: current.pages + 1 } : opened(groupId);
      return { ...anchored(s, groupId), menu: null, expanded: [...s.expanded.filter((x) => x.id !== groupId), next] };
    });
  },
  collapse: (groupId, hidden) => {
    set((s) => ({
      ...afterHiding(s, groupId, hidden),
      ...anchored(s, groupId),
      expanded: s.expanded.filter((x) => x.id !== groupId),
    }));
  },
  collapseBelow: (groupId, groups, hidden) => {
    const closing = new Set(groups);
    set((s) => ({
      ...afterHiding(s, groupId, hidden),
      ...anchored(s, groupId),
      expanded: s.expanded.filter((x) => !closing.has(x.id)),
    }));
  },
  expandNeighbors: (id, childGroups) => {
    set((s) => {
      const open = new Set(s.expanded.map((x) => x.id));
      return {
        ...anchored(s, id),
        menu: null,
        neighbors: s.neighbors.includes(id) ? s.neighbors : [...s.neighbors, id],
        expanded: [...s.expanded, ...childGroups.filter((g) => !open.has(g)).map(opened)],
      };
    });
  },
  expandAllBelow: (id) => {
    set((s) => ({ ...anchored(s, id), menu: null, expandAll: s.expandAll.includes(id) ? s.expandAll : [...s.expandAll, id] }));
  },
  openPath: (nodeId, steps) => {
    set((s) => {
      let expanded = s.expanded;
      for (const { groupId, memberId } of steps) {
        const current = expanded.find((x) => x.id === groupId);
        if (!current) expanded = [...expanded, { id: groupId, pages: 0, pins: [memberId] }];
        else if (!current.pins.includes(memberId)) {
          expanded = expanded.map((x) => (x.id === groupId ? { ...x, pins: [...x.pins, memberId] } : x));
        }
      }
      return { ...anchored(s, nodeId), expanded, centerWhenShown: nodeId };
    });
  },
  adoptView: (state, notice) => {
    set((s) => ({ expanded: state.expand, neighbors: state.neighbors, expandAll: [], notice: notice ?? s.notice }));
  },
  dismissNotice: () => {
    set({ notice: null });
  },
  showNotice: (text) => {
    set({ notice: text });
  },
  clearCenterWhenShown: () => {
    set({ centerWhenShown: null });
  },
  toggleBottomPanel: (panel) => {
    set((s) => ({ bottomPanel: s.bottomPanel === panel ? null : panel }));
  },
  openBottomPanel: (panel) => {
    set({ bottomPanel: panel });
  },
  setHighlightScan: (scanId) => {
    set({ highlightScanId: scanId });
  },
  setTablePage: (page) => {
    set((s) => ({ table: { ...s.table, page } }));
  },
  setTableSort: (sort) => {
    set({ table: { page: 1, sort } });
  },
  openMenu: (menu) => {
    set({ menu });
  },
  closeMenu: () => {
    set({ menu: null });
  },
  center: (id) => {
    set((s) => ({ centerOn: { id, seq: (s.centerOn?.seq ?? 0) + 1 } }));
  },
  requestJump: () => {
    set({ jumpPending: true });
  },
  clearJump: () => {
    set({ jumpPending: false });
  },
  forgetDeleted: (nodeIds, edgeIds) => {
    if (nodeIds.length === 0 && edgeIds.length === 0) return;
    const gone = new Set(nodeIds);
    const goneEdges = new Set(edgeIds);
    /** A deleted node, or a group hanging under one. */
    const lost = (id: string | null) => {
      if (id === null) return false;
      if (gone.has(id)) return true;
      const parent = groupParent(id);
      return parent !== null && gone.has(parent);
    };
    set((s) => {
      const expanded = s.expanded
        .filter((x) => !lost(x.id))
        .map((x) => (x.pins.some((p) => gone.has(p)) ? { ...x, pins: x.pins.filter((p) => !gone.has(p)) } : x))
        // An entry opened only for its pins means nothing once they're gone.
        .filter((x) => x.pages > 0 || x.pins.length > 0);
      const selectionLost = lost(s.selectedId) || (s.selectedEdgeId !== null && goneEdges.has(s.selectedEdgeId));
      return {
        selectedId: lost(s.selectedId) ? null : s.selectedId,
        selectedEdgeId: s.selectedEdgeId !== null && goneEdges.has(s.selectedEdgeId) ? null : s.selectedEdgeId,
        focusId: lost(s.focusId) ? null : s.focusId,
        menu: s.menu !== null && lost(s.menu.id) ? null : s.menu,
        anchor: s.anchor !== null && lost(s.anchor.id) ? null : s.anchor,
        centerWhenShown: lost(s.centerWhenShown) ? null : s.centerWhenShown,
        centerOn: s.centerOn !== null && lost(s.centerOn.id) ? null : s.centerOn,
        expanded,
        neighbors: s.neighbors.filter((id) => !gone.has(id)),
        expandAll: s.expandAll.filter((id) => !gone.has(id)),
        notice: selectionLost ? 'What you had selected was deleted.' : s.notice,
      };
    });
  },
  clearOverlays: () => {
    set((s) => ({
      centerWhenShown: null,
      focusId: null,
      menu: null,
      table: { ...s.table, page: 1 },
    }));
  },
}));
