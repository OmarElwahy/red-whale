// The delete dialog (counts per choice, group text with hidden members, running jobs, the 409 "changed" retry) and the
// Deleted tab.
import { deletePreviewSchema, deletionsResponseSchema, type DeletePreview, type Job } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DeleteDialog, type DeleteDialogProps } from '../src/edit/DeleteDialog';
import { DeletionsPanel } from '../src/edit/DeletionsPanel';

const NODE = '00000000000000a1';
const GROUP = 'agg:00000000000000d0:has_subdomain:subdomain';

const counts = (over: Partial<DeletePreview['node']> = {}): DeletePreview['node'] => ({
  nodes: 1,
  edges: 4,
  orphans: 2,
  keptShared: 0,
  runningJobs: [],
  queuedJobs: 0,
  ...over,
});

function preview(over: Partial<DeletePreview> = {}): DeletePreview {
  return deletePreviewSchema.parse({
    target: { kind: 'node', id: NODE, type: 'subdomain', label: 'a.example.com', members: 1, hiddenByFilters: 0 },
    node: counts(),
    subtree: counts({ nodes: 4, edges: 5, orphans: 0, keptShared: 1 }),
    ...over,
  });
}

const job: Job = {
  id: 7, tool: 'subfinder', group: 'subdomain', nodeId: NODE, targetType: 'subdomain', targetValue: 'a.example.com',
  mode: 'passive', status: 'running', queuedScopeLogId: 1, scopeLogId: 2, argv: null, image: null, timeoutSec: 600,
  exitCode: null, error: null, issues: null, createdAt: '2026-11-02T10:00:00.000Z', startedAt: '2026-11-02T10:00:01.000Z',
  finishedAt: null, scanId: null, nodesCreated: null, nodesUpdated: null,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GET preview → `previews` in turn (the last one repeats); DELETE → `answers` in turn. */
function stubApi(previews: DeletePreview[], answers: Response[] = []) {
  const calls: string[] = [];
  let p = 0;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/delete-preview')) return Promise.resolve(json(previews[Math.min(p++, previews.length - 1)]));
    if (init?.method === 'DELETE') return Promise.resolve(answers.shift() ?? json({ error: 'no answer' }, 500));
    return Promise.resolve(json({ error: 'not found' }, 404));
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function open(props: Partial<DeleteDialogProps> = {}) {
  const h = { onDeleted: vi.fn(), onClose: vi.fn() };
  wrap(<DeleteDialog id={NODE} filters={{}} {...h} {...props} />);
  return h;
}

const deleteButton = () => screen.getByRole('button', { name: /^(Delete \d|Cancel job and delete)/ });

describe('DeleteDialog', () => {
  test('a node: both choices with their counts, the warning, and a DELETE with the confirmed count', async () => {
    const calls = stubApi([preview()], [json({ deletionId: 3, nodeIds: [NODE, 'b', 'c', 'd'], edgeIds: ['e'], cancelledJobs: [] })]);
    const h = open();
    expect(await screen.findByText('Delete this node only')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('Delete: a.example.com');
    expect(screen.getByText('1 node and 4 edges removed. 2 nodes left without a parent become a root.')).toBeTruthy();
    expect(screen.getByText('4 nodes and 5 edges removed. 1 shared node below stays: also under another node.')).toBeTruthy();
    expect(screen.getByText(/can't be undone/).textContent).toContain('Tools may find them again');
    expect(deleteButton().textContent).toBe('Delete 1 node');

    fireEvent.click(screen.getByLabelText(/Delete with everything below/));
    expect(deleteButton().textContent).toBe('Delete 4 nodes');
    fireEvent.click(deleteButton());
    await waitFor(() => {
      expect(h.onDeleted).toHaveBeenCalledWith({ deletionId: 3, nodeIds: [NODE, 'b', 'c', 'd'], edgeIds: ['e'], cancelledJobs: [] });
    });
    // A node's delete sends no filters.
    expect(calls).toContain(`DELETE /api/nodes/${NODE}?mode=subtree&expect=4`);
  });

  test('a group: says how many are deleted and how many the filters hide (kept); filters go with the requests', async () => {
    const calls = stubApi([
      preview({
        target: { kind: 'group', id: GROUP, type: 'subdomain', label: '37 subdomains under example.com', members: 37, hiddenByFilters: 5 },
        node: counts({ nodes: 37, edges: 40, orphans: 3 }),
        subtree: counts({ nodes: 90, edges: 120, orphans: 0 }),
      }),
    ]);
    open({ id: GROUP, filters: { excludeTag: ['ignored'] } });
    expect(await screen.findByText('Delete 37 subdomains. 5 more are hidden by your filters and will be kept.')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('Delete group: 37 subdomains under example.com');
    expect(screen.getByText('Delete the members only')).toBeTruthy();
    expect(screen.getByText('Delete the members with everything below')).toBeTruthy();
    expect(calls[0]).toBe(`GET /api/nodes/${encodeURIComponent(GROUP)}/delete-preview?excludeTag=ignored`);
  });

  test('a running job on a node being deleted: named, and the button cancels it first (cancelJobs=1)', async () => {
    const calls = stubApi(
      [preview({ subtree: counts({ nodes: 4, edges: 5, orphans: 0, runningJobs: [job], queuedJobs: 2 }) })],
      [json({ deletionId: 1, nodeIds: [NODE], edgeIds: [], cancelledJobs: [8, 9] })],
    );
    const h = open();
    fireEvent.click(await screen.findByLabelText(/Delete with everything below/));
    const status = screen.getByRole('status');
    expect(within(status).getByText('subfinder on a.example.com (job 7)')).toBeTruthy();
    expect(screen.getByText('2 queued jobs on these nodes will be cancelled.')).toBeTruthy();
    expect(deleteButton().textContent).toBe('Cancel job and delete');
    fireEvent.click(deleteButton());
    await waitFor(() => {
      expect(h.onDeleted).toHaveBeenCalled();
    });
    expect(calls).toContain(`DELETE /api/nodes/${NODE}?mode=subtree&expect=4&cancelJobs=1`);

    // Node mode doesn't touch the job's node: a plain delete.
    fireEvent.click(screen.getByLabelText(/Delete this node only/));
    expect(deleteButton().textContent).toBe('Delete 1 node');
  });

  test('the graph changed meanwhile (409): shows the new counts and asks again', async () => {
    const fresh = preview({ node: counts({ nodes: 1, edges: 6 }) });
    stubApi(
      [preview()],
      [
        json({ error: 'the graph changed', reason: 'changed', preview: fresh }, 409),
        json({ deletionId: 2, nodeIds: [NODE], edgeIds: [], cancelledJobs: [] }),
      ],
    );
    const h = open();
    await screen.findByText('Delete this node only');
    fireEvent.click(deleteButton());
    expect((await screen.findByRole('alert')).textContent).toContain('The graph changed since this opened');
    expect(screen.getByText(/^1 node and 6 edges removed/)).toBeTruthy();
    expect(h.onDeleted).not.toHaveBeenCalled();
    fireEvent.click(deleteButton());
    await waitFor(() => {
      expect(h.onDeleted).toHaveBeenCalled();
    });
  });

  test('Cancel and Escape close it without deleting', async () => {
    const calls = stubApi([preview()]);
    const h = open();
    await screen.findByText('Delete this node only');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
});

describe('DeletionsPanel', () => {
  test('lists deletes newest first; a row expands to what it removed', async () => {
    const list = deletionsResponseSchema.parse({
      items: [
        {
          id: 2, at: '2026-11-02T12:00:00.000Z', kind: 'group', mode: 'node', rootType: 'subdomain', rootValue: 'example.com',
          rootLabel: '2 subdomains under example.com', nodeCount: 2, edgeCount: 3,
          removed: [{ type: 'subdomain', value: 'a.example.com' }, { type: 'subdomain', value: 'b.example.com' }],
        },
        {
          id: 1, at: '2026-11-02T11:00:00.000Z', kind: 'node', mode: 'subtree', rootType: 'ip', rootValue: '10.0.0.2',
          rootLabel: '10.0.0.2', nodeCount: 1, edgeCount: 1, removed: [{ type: 'ip', value: '10.0.0.2' }],
        },
      ],
      page: 1, pageSize: 20, total: 2,
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(list))));
    wrap(<DeletionsPanel />);
    const rows = await screen.findAllByRole('button', { expanded: false });
    expect(rows.map((r) => r.textContent)).toEqual([
      '2026-11-02 12:00:002 subdomains under example.comgroup, only2 nodes, 3 edges',
      '2026-11-02 11:00:0010.0.0.2with everything below1 node, 1 edge',
    ]);
    fireEvent.click(rows[0] as HTMLElement);
    const removed = screen.getByRole('list', { name: 'Removed by delete 2' });
    expect(within(removed).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['subdomaina.example.com', 'subdomainb.example.com']);
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });
});
