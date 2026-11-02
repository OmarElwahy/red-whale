import { nodeDetailResponseSchema, nodePatchSchema } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NodeDetailResponse } from '../src/api/hooks';
import { SidePanel, type SidePanelProps } from '../src/panel/SidePanel';
import { aggregate, node } from './fixtures';

const ID = '00000000000000a1';

function makeDetail(overrides: Parameters<typeof node>[1] = {}): NodeDetailResponse {
  const n = node(ID, {
    type: 'url',
    value: 'https://a.example.com/login',
    label: 'https://a.example.com/login',
    severity: 'high',
    effectiveSeverity: 'high',
    confidence: 'corroborated',
    sourceCount: 2,
    ...overrides,
  });
  return nodeDetailResponseSchema.parse({
    node: { ...n, data: { status: 200, title: 'Sign in' }, notes: '' },
    scope: { decision: n.inScope, reason: 'test scope', rule: null },
    edges: [],
    observations: [
      {
        scanId: 's1',
        tool: 'httpx',
        command: 'httpx -u https://a.example.com/login',
        role: 'finding',
        severity: null,
        data: { status: 200 },
        observedAt: '2026-10-29T08:15:00.000Z',
        jobId: null,
      },
      {
        scanId: 's2',
        tool: 'nuclei',
        command: 'nuclei -u https://a.example.com/login -t exposures',
        role: 'finding',
        severity: 'high',
        data: { template: 'exposed-login' },
        observedAt: '2026-10-30T09:30:00.000Z',
        jobId: null,
      },
      {
        scanId: 's3',
        tool: 'katana',
        command: 'katana -u https://a.example.com',
        role: 'parent',
        severity: null,
        data: {},
        observedAt: '2026-10-30T11:00:00.000Z',
        jobId: null,
      },
    ],
  });
}

/** A fake API: GET returns the node, PATCH validates the body like the server and applies it. */
function fakeApi(initial = makeDetail()) {
  let detail = initial;
  const patches: unknown[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url === `/api/nodes/${ID}` && init?.method === 'PATCH') {
      const body: unknown = JSON.parse(init.body as string);
      patches.push(body);
      const parsed = nodePatchSchema.safeParse(body);
      if (!parsed.success) return Promise.resolve(json({ error: 'invalid request' }, 400));
      detail = { ...detail, node: { ...detail.node, ...parsed.data } };
      return Promise.resolve(json(detail));
    }
    if (url === `/api/nodes/${ID}`) return Promise.resolve(json(detail));
    return Promise.resolve(json({ error: 'not found' }, 404));
  });
  return { fetch, patches };
}

function renderPanel(props: Partial<SidePanelProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onAction = vi.fn<SidePanelProps['onAction']>();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SidePanel
        target={node(ID, { type: 'url', label: 'https://a.example.com/login' })}
        onAction={onAction}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onAction, onClose };
}

let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  api = fakeApi();
  vi.stubGlobal('fetch', api.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('node panel: scope', () => {
  test('shows the decision, the reason and the deciding rule with its note', async () => {
    const detail = makeDetail({ inScope: 'out' });
    api = fakeApi({
      ...detail,
      scope: {
        decision: 'out',
        reason: 'judged by its host a.example.com: matches exclude domain a.example.com (#4)',
        rule: {
          id: 4,
          kind: 'domain',
          value: 'a.example.com',
          action: 'exclude',
          note: 'Third-party SaaS',
          createdAt: '2026-10-31T10:00:00.000Z',
          removedAt: null,
        },
      },
    });
    vi.stubGlobal('fetch', api.fetch);
    renderPanel();
    const scope = within(await screen.findByRole('region', { name: 'Scope' }));
    expect(scope.getByText('Out of scope')).toBeTruthy();
    expect(scope.getByText(/matches exclude domain a\.example\.com/)).toBeTruthy();
    expect(scope.getByText('exclude')).toBeTruthy();
    expect(scope.getByText('#4')).toBeTruthy();
    expect(scope.getByText('Third-party SaaS')).toBeTruthy();
  });

  test('a not-targetable node says so, with no rule', async () => {
    api = fakeApi({ ...makeDetail({ inScope: 'n/a' }), scope: { decision: 'n/a', reason: "a technology isn't something a tool is pointed at", rule: null } });
    vi.stubGlobal('fetch', api.fetch);
    renderPanel();
    const scope = within(await screen.findByRole('region', { name: 'Scope' }));
    expect(scope.getByText('Not targetable')).toBeTruthy();
    expect(scope.queryByText(/^#\d+$/)).toBeNull();
  });
});

describe('node panel', () => {
  test('shows the details from GET /api/nodes/:id', async () => {
    renderPanel();
    await screen.findByText('(2 tools)');
    const details = within(screen.getByRole('region', { name: 'Details' }));
    expect(details.getByText('https://a.example.com/login')).toBeTruthy();
    expect(details.getByText('high')).toBeTruthy();
    expect(details.getByText('corroborated')).toBeTruthy();
    expect(details.getByText('(2 tools)')).toBeTruthy();
    const data = within(screen.getByRole('region', { name: 'Data' }));
    expect(data.getByText('title')).toBeTruthy();
    expect(data.getByText('Sign in')).toBeTruthy();
  });

  test('the provenance table lists tool, command and time for every observation', async () => {
    renderPanel();
    const table = within(await screen.findByRole('table'));
    const rows = table.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('httpx');
    expect(rows[0]?.textContent).toContain('httpx -u https://a.example.com/login');
    expect(rows[0]?.textContent).toContain('2026-10-29 08:15:00');
    expect(rows[1]?.textContent).toContain('nuclei');
    expect(rows[1]?.textContent).toContain('2026-10-30 09:30:00');
    expect(rows[1]?.textContent).not.toContain('as parent');
    expect(rows[2]?.textContent).toContain('katana');
    expect(rows[2]?.textContent).toContain('as parent');
  });

  test('a node only referenced as a parent says so instead of "(0 tools)"', async () => {
    api = fakeApi(makeDetail({ confidence: 'discovered', sourceCount: 0 }));
    vi.stubGlobal('fetch', api.fetch);
    renderPanel();
    const details = within(await screen.findByRole('region', { name: 'Details' }));
    expect(await details.findByText('(only referenced as a parent)')).toBeTruthy();
    expect(details.queryByText(/0 tools/)).toBeNull();
  });

  test("a provenance row opens to show that tool's raw data", async () => {
    renderPanel();
    const toggle = await screen.findByRole('button', { name: /nuclei/ });
    expect(screen.queryByText(/exposed-login/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/"template": "exposed-login"/)).toBeTruthy();
  });

  test('picking a tag PATCHes it, and the picker follows the answer', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'interesting' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'interesting' }).getAttribute('aria-pressed')).toBe('true');
    });
    expect(api.patches).toEqual([{ tag: 'interesting' }]);
  });

  test('clicking the active tag clears it with tag: null', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'ignored' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ignored' }).getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(screen.getByRole('button', { name: 'ignored' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ignored' }).getAttribute('aria-pressed')).toBe('false');
    });
    expect(api.patches).toEqual([{ tag: 'ignored' }, { tag: null }]);
  });

  test('notes are saved with the Save button, not while typing', async () => {
    renderPanel();
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    fireEvent.change(box, { target: { value: '# Login\nDefault creds?' } });
    expect(screen.getByText('unsaved')).toBeTruthy();
    expect(api.patches).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(() => {
      expect(screen.queryByText('unsaved')).toBeNull();
    });
    expect(api.patches).toEqual([{ notes: '# Login\nDefault creds?' }]);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Notes' }).value).toBe('# Login\nDefault creds?');
  });

  test('Ctrl+Enter saves the notes too', async () => {
    renderPanel();
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    fireEvent.change(box, { target: { value: 'checked with burp' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(api.patches).toEqual([{ notes: 'checked with burp' }]);
    });
  });

  test('Save is disabled until the notes change', async () => {
    renderPanel();
    const save = await screen.findByRole('button', { name: 'Save notes' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test('the preview renders markdown, but not raw HTML', async () => {
    renderPanel();
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    fireEvent.change(box, { target: { value: '**weak** password <img src=x onerror="alert(1)">' } });
    fireEvent.click(screen.getByRole('button', { name: 'preview' }));
    const region = within(screen.getByRole('region', { name: 'Notes' }));
    expect(region.getByText('weak').tagName).toBe('STRONG');
    expect(document.querySelector('.markdown img')).toBeNull();
  });

  test('a member of an open group can collapse that group', async () => {
    const memberOf = aggregate({ id: 'agg:root:url', label: '30 URLs', childType: 'url', count: 30, expanded: true, shown: 30, remaining: 0 });
    const { onAction } = renderPanel({ memberOf });
    expect(await screen.findByText(/In the group “30 URLs”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse group' }));
    expect(onAction).toHaveBeenCalledWith('collapse-parent');
  });

  test('the close button closes the panel', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a node on the graph has no "Show on graph"', async () => {
    renderPanel();
    await screen.findByRole('region', { name: 'Tag' });
    expect(screen.queryByRole('button', { name: 'Show on graph' })).toBeNull();
  });

  test('a hidden node offers "Show on graph"', async () => {
    const onReveal = vi.fn();
    renderPanel({ reveal: { blocked: null, onReveal } });
    const graph = within(await screen.findByRole('region', { name: 'Graph' }));
    expect(graph.getByText(/isn't on the graph right now/)).toBeTruthy();
    fireEvent.click(graph.getByRole('button', { name: 'Show on graph' }));
    expect(onReveal).toHaveBeenCalledOnce();
  });

  test('when it cannot be shown, the button is disabled and the reason is written out', async () => {
    const onReveal = vi.fn();
    const reason = 'The graph is at its ~2,000-element limit. Collapse a group to make room.';
    renderPanel({ reveal: { blocked: reason, onReveal } });
    const graph = within(await screen.findByRole('region', { name: 'Graph' }));
    const button = graph.getByRole('button', { name: 'Show on graph' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(graph.getByText(reason)).toBeTruthy();
    fireEvent.click(button);
    expect(onReveal).not.toHaveBeenCalled();
  });
});

describe('group panel', () => {
  const agg = aggregate({ label: '412 subdomains', count: 412, risk: { critical: 2, high: 1 } });

  test('shows the group and what is below it, and offers Expand; no node detail is fetched', () => {
    const { onAction } = renderPanel({ target: agg, parentLabel: 'example.com' });
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText('412 subdomain')).toBeTruthy();
    expect(screen.getByText('2 critical, 1 high below')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(onAction).toHaveBeenCalledWith('expand');
    expect(api.fetch).not.toHaveBeenCalled();
  });

  test('once open: collapse, load more with what is left, and collapse all below', () => {
    const open = { ...agg, expanded: true, shown: 200, remaining: 212 };
    const { onAction } = renderPanel({ target: open, hasOpenBelow: true });
    expect(screen.getByText('200 of 412')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more (212 left)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all below' }));
    expect(onAction.mock.calls).toEqual([['collapse'], ['load-more'], ['collapse-below']]);
  });

  test('collapse all below is disabled when nothing is open below', () => {
    renderPanel({ target: { ...agg, expanded: true, shown: 412, remaining: 0 } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Collapse all below' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
  });

  test('expand is disabled at the element limit', () => {
    renderPanel({ target: { ...agg, canLoadMore: false } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Expand' }).disabled).toBe(true);
  });
});
