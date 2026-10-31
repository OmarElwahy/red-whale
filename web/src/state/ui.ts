// UI state (Zustand): what's selected, focused, expanded, and where the context menu is. Server data lives in
// TanStack Query; this only says which expand pages and neighborhoods to fetch.
import { DEFAULT_NODE_SORT } from '@redwhale/shared';
import { create } from 'zustand';

export interface MenuState {
  id: string;
  /** Rendered position inside the graph container, in px. */
  x: number;
  y: number;
}

/** The panel under the graph. */
export type BottomPanel = 'table' | 'highlights';

export interface TableState {
  page: number;
  /** As GET /api/nodes takes it: `-effectiveSeverity,label`. */
  sort: string;
}

export interface UiState {
  selectedId: string | null;
  focusId: string | null;
  /** Expanded aggregates and how many pages of each are loaded, in the order they were expanded. */
  expanded: { id: string; pages: number }[];
  /** Nodes whose neighborhood was expanded, in order. */
  neighbors: string[];
  /** Hidden nodes the analyst asked to show on the graph ("Show on graph"), in order. */
  revealed: string[];
  /** Center on this node as soon as it is on the canvas (after "Show on graph"). */
  centerWhenShown: string | null;
  bottomPanel: BottomPanel | null;
  table: TableState;
  menu: MenuState | null;
  /** A request to pan to a node; `seq` changes on every request, so the same node can be centered again. */
  centerOn: { id: string; seq: number } | null;
  /** Enter was pressed in search: select and center the first match once the graph for that query is loaded. */
  jumpPending: boolean;
  /** Bumped by the Re-layout button; the canvas re-runs the tree when it changes. */
  relayoutSeq: number;

  select: (id: string | null) => void;
  focus: (id: string | null) => void;
  /** Expands the aggregate, or loads its next page if it's already expanded. */
  expand: (aggregateId: string) => void;
  /** Removes the expansion, and the neighborhoods expanded from its members. */
  collapse: (aggregateId: string, members: readonly string[]) => void;
  expandNeighbors: (id: string) => void;
  /** Shows a hidden node next to a neighbor that's on the graph, then centers on it. */
  reveal: (id: string) => void;
  clearCenterWhenShown: () => void;
  /** Opens the panel, or closes it if it's already showing. */
  toggleBottomPanel: (panel: BottomPanel) => void;
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
   * Filters changed: expand pages, neighborhoods and reveals were loaded under the old ones, so drop them, and
   * focus. The table goes back to page 1.
   */
  clearOverlays: () => void;
}

export const initialUiState = {
  selectedId: null,
  focusId: null,
  expanded: [],
  neighbors: [],
  revealed: [],
  centerWhenShown: null,
  bottomPanel: null,
  table: { page: 1, sort: DEFAULT_NODE_SORT },
  menu: null,
  centerOn: null,
  jumpPending: false,
  relayoutSeq: 0,
} satisfies Partial<UiState>;

export const useUi = create<UiState>()((set) => ({
  ...initialUiState,

  select: (id) => {
    set((s) => ({
      selectedId: id,
      menu: null,
      centerWhenShown: s.centerWhenShown === id ? s.centerWhenShown : null,
    }));
  },
  focus: (id) => {
    set({ focusId: id, menu: null });
  },
  relayout: () => {
    set((s) => ({ relayoutSeq: s.relayoutSeq + 1 }));
  },
  expand: (aggregateId) => {
    set((s) => ({
      menu: null,
      expanded: s.expanded.some((x) => x.id === aggregateId)
        ? s.expanded.map((x) => (x.id === aggregateId ? { ...x, pages: x.pages + 1 } : x))
        : [...s.expanded, { id: aggregateId, pages: 1 }],
    }));
  },
  collapse: (aggregateId, members) => {
    set((s) => {
      const gone = new Set(members);
      return {
        menu: null,
        expanded: s.expanded.filter((x) => x.id !== aggregateId),
        neighbors: s.neighbors.filter((id) => !gone.has(id)),
        selectedId: s.selectedId !== null && gone.has(s.selectedId) ? aggregateId : s.selectedId,
        focusId: s.focusId !== null && gone.has(s.focusId) ? null : s.focusId,
      };
    });
  },
  expandNeighbors: (id) => {
    set((s) => ({ menu: null, neighbors: s.neighbors.includes(id) ? s.neighbors : [...s.neighbors, id] }));
  },
  reveal: (id) => {
    set((s) => ({ revealed: s.revealed.includes(id) ? s.revealed : [...s.revealed, id], centerWhenShown: id }));
  },
  clearCenterWhenShown: () => {
    set({ centerWhenShown: null });
  },
  toggleBottomPanel: (panel) => {
    set((s) => ({ bottomPanel: s.bottomPanel === panel ? null : panel }));
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
  clearOverlays: () => {
    set((s) => ({
      expanded: [],
      neighbors: [],
      revealed: [],
      centerWhenShown: null,
      focusId: null,
      menu: null,
      table: { ...s.table, page: 1 },
    }));
  },
}));
