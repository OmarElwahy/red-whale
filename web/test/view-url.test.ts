import { graphFiltersSchema } from '@redwhale/shared';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { graphSearchParams, queryKeys } from '../src/api/query';
import { initialUiState, useUi } from '../src/state/ui';
import { syncViewWithUrl, viewFromSearch, viewToSearch } from '../src/state/url';
import { defaultView, useView, type View } from '../src/state/view';

const view = () => useView.getState();
const apiParams = () => graphSearchParams(view().filters).toString();

describe('filters → GET /api/graph params', () => {
  beforeEach(() => {
    useView.setState(defaultView);
    useUi.setState(initialUiState);
  });

  test('no filters, no params', () => {
    expect(apiParams()).toBe('');
  });

  test('each control maps to its API param, keys sorted', () => {
    view().toggle('types', 'subdomain');
    view().toggle('types', 'ip');
    view().setMinSeverity('high');
    view().toggle('confidence', 'corroborated');
    view().toggle('tool', 'nuclei');
    view().toggle('tag', 'interesting');
    view().setHideIgnored(true);
    view().setQuery('  admin ');
    expect(apiParams()).toBe(
      'confidence=corroborated&excludeTag=ignored&minSeverity=high&q=admin&tag=interesting&tool=nuclei&types=subdomain%2Cip',
    );
  });

  test('every param the store produces is one the API accepts', () => {
    view().toggle('types', 'url');
    view().setMinSeverity('medium');
    view().setHideIgnored(true);
    view().setQuery('dev');
    const parsed = graphFiltersSchema.safeParse(Object.fromEntries(new URLSearchParams(apiParams())));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(view().filters);
  });

  test('unticking the last value drops the param', () => {
    view().toggle('types', 'ip');
    view().toggle('types', 'ip');
    expect(view().filters).toEqual({});
    expect(apiParams()).toBe('');
  });

  test('"hide ignored" is excludeTag=ignored, and off removes it', () => {
    view().setHideIgnored(true);
    expect(view().filters).toEqual({ excludeTag: ['ignored'] });
    view().setHideIgnored(false);
    expect(view().filters).toEqual({});
  });

  test('a blank search is no q at all (the API rejects q=)', () => {
    view().setQuery('dev');
    view().setQuery('   ');
    expect(view().filters).toEqual({});
  });

  test('min severity "any" clears the param', () => {
    view().setMinSeverity('low');
    view().setMinSeverity(undefined);
    expect(apiParams()).toBe('');
  });

  test('mute, hops and layout are view-only: they never reach the API', () => {
    view().setMute(true);
    view().setHops(3);
    view().setLayout('tree');
    expect(apiParams()).toBe('');
    expect(Object.keys(graphFiltersSchema.shape)).not.toContain('layout');
    expect(Object.keys(graphFiltersSchema.shape)).not.toContain('mute');
    expect(Object.keys(graphFiltersSchema.shape)).not.toContain('hops');
  });

  test('changing filters keeps open groups and neighbor expansions (the server drops what no longer exists), drops focus, keeps the selection', () => {
    const expanded = [{ id: 'agg:root:ip', pages: 2, pins: [] }];
    useUi.setState({ expanded, neighbors: ['n1'], focusId: 'n1', selectedId: 'n1' });
    view().toggle('types', 'ip');
    expect(useUi.getState()).toMatchObject({ expanded, neighbors: ['n1'], focusId: null, selectedId: 'n1' });
  });

  test('a no-op change keeps expansions', () => {
    view().setQuery('dev');
    useUi.setState({ expanded: [{ id: 'agg:root:ip', pages: 1, pins: [] }] });
    view().setQuery('dev ');
    view().setMute(true);
    view().setHops(2);
    view().setLayout('tree');
    expect(useUi.getState().expanded).toHaveLength(1);
  });

  test('views are cached per filter set and per open groups', () => {
    const open = [{ id: 'agg:root:ip', pages: 1, pins: [] }];
    expect(queryKeys.view({}, open, [], [])).not.toEqual(queryKeys.view({ q: 'dev' }, open, [], []));
    expect(queryKeys.view({}, open, [], [])).not.toEqual(queryKeys.view({}, [], [], []));
  });
});

describe('view ↔ URL', () => {
  test('round-trips filters, mute, hops and layout', () => {
    const v: View = {
      filters: { types: ['subdomain', 'url'], minSeverity: 'medium', excludeTag: ['ignored'], q: 'dev' },
      mute: true,
      hops: 2,
      layout: 'tree',
    };
    const search = viewToSearch(v);
    expect(search).toBe(
      'excludeTag=ignored&minSeverity=medium&q=dev&types=subdomain%2Curl&mute=1&hops=2&layout=tree',
    );
    expect(viewFromSearch(`?${search}`)).toEqual(v);
  });

  test('round-trips the scope filter (n/a included)', () => {
    const v: View = { ...defaultView, filters: { scope: ['out', 'n/a'] } };
    const search = viewToSearch(v);
    expect(search).toBe('scope=out%2Cn%2Fa');
    expect(viewFromSearch(`?${search}`)).toEqual(v);
    expect(viewFromSearch('?scope=maybe&q=x').filters).toEqual({ q: 'x' });
  });

  test('the default view is an empty query string', () => {
    expect(viewToSearch(defaultView)).toBe('');
    expect(viewFromSearch('')).toEqual(defaultView);
  });

  test('a bad value is dropped on its own; the rest of the link still applies', () => {
    expect(viewFromSearch('?types=ip,planet&minSeverity=urgent&tool=NMAP&q=dev&confidence=verified').filters).toEqual({
      q: 'dev',
      confidence: ['verified'],
    });
  });

  test('unknown params, bad hops, other mute values and unknown layouts are ignored', () => {
    expect(viewFromSearch('?utm_source=x&hops=7&mute=yes&tag=checked&layout=radial')).toEqual({
      filters: { tag: ['checked'] },
      mute: false,
      hops: 1,
      layout: 'force',
    });
  });

  test('repeated params work like the API (?types=a&types=b)', () => {
    expect(viewFromSearch('?types=ip&types=port').filters).toEqual({ types: ['ip', 'port'] });
  });

  test('syncViewWithUrl loads the view, then mirrors changes with replaceState', () => {
    useUi.setState(initialUiState);
    const replaceState = vi.fn<History['replaceState']>();
    const win = {
      location: { pathname: '/', search: '?types=ip&hops=3', hash: '#x' } as Location,
      history: { state: null, replaceState } as unknown as History,
    };
    const stop = syncViewWithUrl(win);
    expect(view()).toMatchObject({ filters: { types: ['ip'] }, hops: 3, mute: false });
    view().setMute(true);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/?types=ip&mute=1&hops=3#x');
    stop();
    view().setMute(false);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
});
