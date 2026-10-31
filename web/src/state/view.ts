// What the analyst is looking at (Zustand): the graph filters, plus view-only settings. `filters` has the
// API's own type and only ever holds values GET /api/graph accepts, so it maps 1:1 to the query string
// (api/query.ts). `mute`, `hops` and `layout` never reach the API. The whole view round-trips through the URL (url.ts).
import { graphFiltersSchema, type GraphFilters, type Severity } from '@redwhale/shared';
import { create } from 'zustand';
import { graphSearchParams } from '@/api/query';
import { useUi } from './ui';

export type Hops = 1 | 2 | 3;
export const HOPS: readonly Hops[] = [1, 2, 3];

/** Force = fcose with saved positions; Tree = top-down hierarchy (graph/tree.ts), never saved. */
export type LayoutMode = 'force' | 'tree';
export const LAYOUT_MODES: readonly LayoutMode[] = ['force', 'tree'];

export interface View {
  filters: GraphFilters;
  /** Fade nodes whose effective severity is below medium. */
  mute: boolean;
  /** Focus mode radius. */
  hops: Hops;
  layout: LayoutMode;
}

export const defaultView: View = { filters: {}, mute: false, hops: 1, layout: 'force' };

/** Filters that are a set of values (checkbox lists in the sidebar). */
export type ListFilter = 'types' | 'confidence' | 'tool' | 'tag' | 'scope';
export type ListValue<K extends ListFilter> = NonNullable<GraphFilters[K]>[number];

export interface ViewState extends View {
  /** Adds the value to the list filter, or removes it. */
  toggle: <K extends ListFilter>(key: K, value: ListValue<K>) => void;
  setMinSeverity: (severity: Severity | undefined) => void;
  /** Debounced by the search box. Blank clears the search. */
  setQuery: (q: string) => void;
  /** Hide ignored = `excludeTag=ignored`. */
  setHideIgnored: (on: boolean) => void;
  setMute: (on: boolean) => void;
  setHops: (hops: Hops) => void;
  setLayout: (layout: LayoutMode) => void;
  resetFilters: () => void;
}

/**
 * Drops empty lists and a blank `q`, then parses with the API's schema: equal views give equal query strings,
 * and the store can't hold a value the API would answer with a 400.
 */
export function cleanFilters(filters: GraphFilters): GraphFilters {
  // `unknown`: callers spread `{ minSeverity: undefined }` in to clear a key, which the static type hides.
  const kept = Object.entries<unknown>(filters).filter(
    ([key, value]) =>
      value !== undefined &&
      !(Array.isArray(value) && value.length === 0) &&
      !(key === 'q' && typeof value === 'string' && value.trim() === ''),
  );
  return graphFiltersSchema.parse(Object.fromEntries(kept));
}

export const isHideIgnored = (filters: GraphFilters): boolean => filters.excludeTag?.includes('ignored') ?? false;

export const hasFilters = (filters: GraphFilters): boolean => Object.keys(filters).length > 0;

function toggled<T>(list: readonly T[] | undefined, value: T): T[] {
  const current = list ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

export const useView = create<ViewState>()((set, get) => {
  const setFilters = (next: GraphFilters) => {
    const filters = cleanFilters(next);
    if (graphSearchParams(filters).toString() === graphSearchParams(get().filters).toString()) return;
    set({ filters });
    useUi.getState().clearOverlays();
  };
  return {
    ...defaultView,

    toggle: (key, value) => {
      const { filters } = get();
      setFilters({ ...filters, [key]: toggled<typeof value>(filters[key], value) });
    },
    setMinSeverity: (minSeverity) => {
      setFilters({ ...get().filters, minSeverity });
    },
    setQuery: (q) => {
      setFilters({ ...get().filters, q });
    },
    setHideIgnored: (on) => {
      const { filters } = get();
      const rest = (filters.excludeTag ?? []).filter((t) => t !== 'ignored');
      setFilters({ ...filters, excludeTag: on ? [...rest, 'ignored'] : rest });
    },
    setMute: (mute) => {
      set({ mute });
    },
    setHops: (hops) => {
      set({ hops });
    },
    setLayout: (layout) => {
      set({ layout });
    },
    resetFilters: () => {
      setFilters({});
    },
  };
});
