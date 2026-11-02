import { edgeDetailResponseSchema } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EdgePanel, GroupEdgePanel } from '../src/panel/EdgePanel';
import { edge } from './fixtures';

const EDGE = '00000000000000e1';

const detail = edgeDetailResponseSchema.parse({
  edge: {
    id: EDGE,
    relation: 'has_subdomain',
    source: { id: 'd1', type: 'domain', label: 'example.com' },
    target: { id: 's1', type: 'subdomain', label: 'api.example.com' },
    sourceCount: 2,
    confidence: 'corroborated',
    firstSeen: '2026-10-29T10:01:12.000Z',
    lastSeen: '2026-10-29T11:00:00.000Z',
  },
  observations: [
    { scanId: 'scan-1', tool: 'subfinder', command: 'subfinder -d example.com', data: {}, observedAt: '2026-10-29T10:01:12.000Z', jobId: null },
    { scanId: 'scan-2', tool: 'amass', command: 'amass enum -d example.com', data: {}, observedAt: '2026-10-29T11:00:00.000Z', jobId: null },
  ],
});

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url === `/api/edges/${EDGE}`
          ? new Response(JSON.stringify(detail), { headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ error: 'edge x not found' }), { status: 404, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EdgePanel', () => {
  test('relation, both ends, confidence, first/last seen and the provenance table', async () => {
    wrap(<EdgePanel edgeId={EDGE} onPickNode={vi.fn()} onClose={vi.fn()} />);
    const panel = await screen.findByRole('complementary', { name: 'Edge details' });
    await within(panel).findByText('api.example.com');
    expect(within(panel).getByText('Corroborated', { exact: false })).toBeTruthy();
    expect(within(panel).getByText('(2 tools)')).toBeTruthy();
    expect(within(panel).getByText('2026-10-29 10:01:12', { selector: 'dd' })).toBeTruthy();
    expect(within(panel).getByText('Provenance (2)')).toBeTruthy();
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['▸subfinder', '▸amass']);
    expect(within(panel).getByText('amass enum -d example.com')).toBeTruthy();
  });

  test('clicking an end selects that node; ✕ closes', async () => {
    const onPickNode = vi.fn();
    const onClose = vi.fn();
    wrap(<EdgePanel edgeId={EDGE} onPickNode={onPickNode} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'api.example.com' }));
    expect(onPickNode.mock.calls).toEqual([['d1'], ['s1']]);
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('an edge that is gone says so', async () => {
    wrap(<EdgePanel edgeId="0000000000000000" onPickNode={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/Couldn't load this edge/)).toBeTruthy();
  });
});

test('GroupEdgePanel: the relation, both ends, how many member edges and every tool behind them, no fetch', () => {
  const onPickNode = vi.fn();
  wrap(
    <GroupEdgePanel
      edge={edge('d1', 'agg:d1:has_subdomain:subdomain', { kind: 'group', tools: ['amass', 'subfinder'], edgeCount: 4 })}
      parent={{ id: 'd1', label: 'example.com' }}
      groupLabel="4 subdomains"
      onPickNode={onPickNode}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText('4 edges, one per member')).toBeTruthy();
  expect(screen.getByText('amass, subfinder')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '4 subdomains' }));
  expect(onPickNode).toHaveBeenCalledWith('agg:d1:has_subdomain:subdomain');
  expect(fetch).not.toHaveBeenCalled();
});
