// UI state (Zustand): what's selected, focused, expanded, and where the context menu is. Server data lives in
// TanStack Query; this only says which expand pages and neighborhoods to fetch.
import { create } from 'zustand';

export interface MenuState {
  id: string;
  /** Rendered position inside the graph container, in px. */
  x: number;
  y: number;
}

export interface UiState {
  selectedId: string | null;
  focusId: string | null;
  /** Expanded aggregates and how many pages of each are loaded, in the order they were expanded. */
  expanded: { id: string; pages: number }[];
  /** Nodes whose neighborhood was expanded, in order. */
  neighbors: string[];
  menu: MenuState | null;
  /** A request to pan to a node; `seq` changes on every request, so the same node can be centered again. */
  centerOn: { id: string; seq: number } | null;
  /** Enter was pressed in search: select and center the first match once the graph for that query is loaded. */
  jumpPending: boolean;

  select: (id: string | null) => void;
  focus: (id: string | null) => void;
  /** Expands the aggregate, or loads its next page if it's already expanded. */
  expand: (aggregateId: string) => void;
  /** Removes the expansion, and the neighborhoods expanded from its members. */
  collapse: (aggregateId: string, members: readonly string[]) => void;
  expandNeighbors: (id: string) => void;
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;
  center: (id: string) => void;
  requestJump: () => void;
  clearJump: () => void;
  /** Filters changed: expand pages and neighborhoods were loaded under the old ones, so drop them, and focus. */
  clearOverlays: () => void;
}

export const initialUiState = {
  selectedId: null,
  focusId: null,
  expanded: [],
  neighbors: [],
  menu: null,
  centerOn: null,
  jumpPending: false,
} satisfies Partial<UiState>;

export const useUi = create<UiState>()((set) => ({
  ...initialUiState,

  select: (id) => {
    set({ selectedId: id, menu: null });
  },
  focus: (id) => {
    set({ focusId: id, menu: null });
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
    set({ expanded: [], neighbors: [], focusId: null, menu: null });
  },
}));
