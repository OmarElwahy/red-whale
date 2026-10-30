import { DEFAULT_NODE_SORT, NODE_PAGE_SIZE, nodeListQuerySchema, type GraphNode } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NodeTable, type NodeTableProps } from '../src/table/NodeTable';
import { initialUiState, useUi } from '../src/state/ui';
import { defaultView, useView } from '../src/state/view';
import { node } from './fixtures';

/** 120 nodes, n000 … n119, in "sort order" (the fake server ignores sort; the real one is tested in server/). */
const ALL: GraphNode[] = Array.from({ length: 120 }, (_, i) => node(`n${String(i).padStart(3, '0')}`));

/** A fake GET /api/nodes that validates its query like the server and pages the 120 nodes, honoring `at`. */
function fakeApi() {
  const urls: URL[] = [];
  const fetch = vi.fn((input: string) => {
    const url = new URL(input, 'http://127.0.0.1:5173');
    urls.push(url);
    const params = Object.fromEntries(url.searchParams);
    const query = nodeListQuerySchema.safeParse(params);
    if (url.pathname !== '/api/nodes' || !query.success) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }));
    }
    const { pageSize, at } = query.data;
    const listed = query.data.types ? ALL.filter((n) => query.data.types?.includes(n.type)) : ALL;
    const index = at === undefined ? -1 : listed.findIndex((n) => n.id === at);
    const page = index === -1 ? query.data.page : Math.floor(index / pageSize) + 1;
    const body = { items: listed.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: listed.length };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  });
  return { fetch, urls };
}

let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  useUi.setState(initialUiState);
  useView.setState(defaultView);
  api = fakeApi();
  vi.stubGlobal('fetch', api.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTable(props: Partial<NodeTableProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = vi.fn<NodeTableProps['onPick']>();
  const all: NodeTableProps = { selectedId: null, isShown: () => true, onPick, ...props };
  const view = render(
    <QueryClientProvider client={client}>
      <NodeTable {...all} />
    </QueryClientProvider>,
  );
  const rerender = (next: Partial<NodeTableProps>) => {
    view.rerender(
      <QueryClientProvider client={client}>
        <NodeTable {...all} {...next} />
      </QueryClientProvider>,
    );
  };
  return { onPick, rerender };
}

const grid = () => screen.getByRole('grid', { name: 'Nodes' });
const bodyRows = () => within(grid()).getAllByRole('row').slice(1);
const lastUrl = () => api.urls.at(-1);

describe('NodeTable', () => {
  test('lists page 1 of GET /api/nodes with the default sort', async () => {
    renderTable();
    expect(await within(grid()).findByText('n000.example.com')).toBeTruthy();
    expect(bodyRows()).toHaveLength(NODE_PAGE_SIZE.default);
    expect(lastUrl()?.searchParams.get('page')).toBe('1');
    expect(lastUrl()?.searchParams.get('sort')).toBe(DEFAULT_NODE_SORT);
    expect(screen.getByText(/1–50 of 120 nodes/)).toBeTruthy();
  });

  test('uses the same filters as the graph', async () => {
    useView.setState({ filters: { types: ['subdomain'], minSeverity: 'high', q: 'dev' } });
    renderTable();
    await waitFor(() => {
      expect(api.fetch).toHaveBeenCalled();
    });
    const params = lastUrl()?.searchParams;
    expect(params?.get('types')).toBe('subdomain');
    expect(params?.get('minSeverity')).toBe('high');
    expect(params?.get('q')).toBe('dev');
  });

  test('clicking a header sorts on the server; clicking again flips it; shift-click adds a column', async () => {
    renderTable();
    await within(grid()).findByText('n000.example.com');
    fireEvent.click(within(grid()).getByRole('button', { name: /Label/ }));
    await waitFor(() => {
      expect(lastUrl()?.searchParams.get('sort')).toBe('label');
    });
    fireEvent.click(within(grid()).getByRole('button', { name: /Label/ }));
    await waitFor(() => {
      expect(lastUrl()?.searchParams.get('sort')).toBe('-label');
    });
    fireEvent.click(within(grid()).getByRole('button', { name: /Last seen/ }), { shiftKey: true });
    await waitFor(() => {
      expect(lastUrl()?.searchParams.get('sort')).toBe('-label,-lastSeen');
    });
    expect(within(grid()).getByRole('columnheader', { name: /Label/ }).getAttribute('aria-sort')).toBe('descending');
  });

  test('a new sort goes back to page 1', async () => {
    renderTable();
    await within(grid()).findByText('n000.example.com');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await within(grid()).findByText('n050.example.com');
    fireEvent.click(within(grid()).getByRole('button', { name: /Type/ }));
    await waitFor(() => {
      expect(lastUrl()?.searchParams.get('page')).toBe('1');
    });
  });

  test('tag is not sortable (the API has no tag sort)', async () => {
    renderTable();
    await within(grid()).findByText('n000.example.com');
    const tag = within(grid()).getByRole('columnheader', { name: 'Tag' });
    expect(within(tag).queryByRole('button')).toBeNull();
  });

  test('Next and Prev page through; Prev is disabled on page 1 and Next on the last page', async () => {
    renderTable();
    await within(grid()).findByText('n000.example.com');
    expect(screen.getByRole('button', { name: /Prev/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await within(grid()).findByText('n100.example.com')).toBeTruthy();
    expect(bodyRows()).toHaveLength(20);
    expect(screen.getByRole('button', { name: /Next/ }).hasAttribute('disabled')).toBe(true);
  });

  test('clicking a row (or Enter on it) picks that node', async () => {
    const { onPick } = renderTable();
    fireEvent.click(await within(grid()).findByText('n003.example.com'));
    expect(onPick).toHaveBeenLastCalledWith(ALL[3]);
    const row = bodyRows()[4];
    if (!row) throw new Error('no row');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith(ALL[4]);
  });

  test("the selected node's row is highlighted", async () => {
    renderTable({ selectedId: 'n002' });
    await within(grid()).findByText('n002.example.com');
    const selected = bodyRows().filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected.map((r) => r.textContent)).toEqual([expect.stringContaining('n002.example.com')]);
  });

  test('rows of nodes hidden from the graph say so', async () => {
    renderTable({ isShown: (id) => id !== 'n001' });
    await within(grid()).findByText('n001.example.com');
    expect(bodyRows()[1]?.getAttribute('title')).toBe('Hidden inside a group on the graph');
    expect(bodyRows()[0]?.getAttribute('title')).toBeNull();
  });

  test('selecting a node on another page turns to that page (?at=)', async () => {
    const { rerender } = renderTable();
    await within(grid()).findByText('n000.example.com');
    act(() => {
      useUi.getState().select('n077');
    });
    rerender({ selectedId: 'n077' });
    const row = (await within(grid()).findByText('n077.example.com')).closest('tr');
    expect(row?.getAttribute('aria-selected')).toBe('true');
    expect(useUi.getState().table.page).toBe(2);
    expect(api.urls.some((u) => u.searchParams.get('at') === 'n077')).toBe(true);
  });

  test('after following the selection, paging away does not jump back', async () => {
    useUi.setState({ selectedId: 'n077' });
    renderTable({ selectedId: 'n077' });
    await within(grid()).findByText('n077.example.com');
    fireEvent.click(screen.getByRole('button', { name: /Prev/ }));
    await within(grid()).findByText('n000.example.com');
    expect(useUi.getState().table.page).toBe(1);
    expect(api.urls.filter((u) => u.searchParams.has('at'))).toHaveLength(1);
  });

  test("a selected node that isn't in the list: no jump, and a hint", async () => {
    useUi.setState({ selectedId: 'not-listed' });
    renderTable({ selectedId: 'not-listed' });
    expect(await screen.findByText(/The selected node isn't in this list/)).toBeTruthy();
    expect(useUi.getState().table.page).toBe(1);
  });

  test('an aggregate selection is not looked up', async () => {
    renderTable({ selectedId: 'agg:root:ip' });
    await within(grid()).findByText('n000.example.com');
    expect(api.urls.some((u) => u.searchParams.has('at'))).toBe(false);
  });
});
