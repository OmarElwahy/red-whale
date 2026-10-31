// The view in the address bar, so a refresh or a copied link opens the same view. Filters use the API's own
// param names and format (api/query.ts); `mute=1`, `hops=N` and `layout=tree` are view-only and never sent
// to the API.
import { graphFiltersSchema, type GraphFilters } from '@redwhale/shared';
import { graphSearchParams } from '@/api/query';
import { HOPS, LAYOUT_MODES, defaultView, useView, type Hops, type LayoutMode, type View } from './view';

const FILTER_KEYS = Object.keys(graphFiltersSchema.shape) as (keyof GraphFilters)[];

const isHops = (n: number): n is Hops => (HOPS as readonly number[]).includes(n);
const isLayout = (s: string | null): s is LayoutMode => (LAYOUT_MODES as readonly (string | null)[]).includes(s);

/**
 * Reads a view from `location.search`. Each filter is checked on its own with the API schema, so one bad or
 * stale value (a hand-edited link, a removed tool) is dropped without losing the rest. Unknown params are ignored.
 */
export function viewFromSearch(search: string): View {
  const params = new URLSearchParams(search);
  const accepted: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const values = params.getAll(key);
    if (values.length === 0) continue;
    const raw = values.length === 1 ? values[0] : values;
    if (graphFiltersSchema.shape[key].safeParse(raw).success) accepted[key] = raw;
  }
  const hops = Number(params.get('hops'));
  const layout = params.get('layout');
  return {
    filters: graphFiltersSchema.parse(accepted),
    mute: params.get('mute') === '1',
    hops: isHops(hops) ? hops : defaultView.hops,
    layout: isLayout(layout) ? layout : defaultView.layout,
  };
}

/** The query string for a view (no leading `?`): the API params, then the view-only ones when not default. */
export function viewToSearch(view: View): string {
  const params = graphSearchParams(view.filters);
  if (view.mute) params.set('mute', '1');
  if (view.hops !== defaultView.hops) params.set('hops', String(view.hops));
  if (view.layout !== defaultView.layout) params.set('layout', view.layout);
  return params.toString();
}

/**
 * Loads the view from the current URL, then keeps the URL in step with the store. `replaceState`, so filtering
 * doesn't fill the back button with every checkbox. Returns an unsubscribe function.
 */
export function syncViewWithUrl(win: Pick<Window, 'location' | 'history'> = window): () => void {
  useView.setState(viewFromSearch(win.location.search));
  return useView.subscribe((view) => {
    const search = viewToSearch(view);
    const { pathname, hash } = win.location;
    const next = `${pathname}${search === '' ? '' : `?${search}`}${hash}`;
    if (next !== `${pathname}${win.location.search}${hash}`) win.history.replaceState(win.history.state, '', next);
  });
}
