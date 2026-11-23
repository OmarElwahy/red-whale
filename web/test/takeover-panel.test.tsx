import { takeoverWatchResponseSchema, type TakeoverRegistration, type TakeoverWatchRow } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defaultView, useView } from '../src/state/view';
import { TakeoverPanel, daysClass, registrationsTitle } from '../src/takeover/TakeoverPanel';

const T = '2026-11-30T10:00:00.000Z';

function reg(domain: string, over: Partial<TakeoverRegistration> = {}): TakeoverRegistration {
  return { nodeId: `n-${domain}`, domain, registered: true, expiresAt: '2028-01-01T00:00:00Z', daysLeft: 761, source: 'rdap', reason: null, ...over };
}

function row(subdomain: string, over: Partial<TakeoverWatchRow> = {}): TakeoverWatchRow {
  const own = reg('northwind.example');
  return {
    nodeId: `n-${subdomain}`,
    subdomain,
    status: 'ok',
    inScope: true,
    chain: [],
    chainEnd: subdomain,
    service: null,
    registration: own,
    registrations: [own],
    vulnerabilities: [],
    lastCheck: { scanId: 's', at: T, status: 'success' },
    lastFailure: null,
    pending: false,
    ...over,
  };
}

const gone = reg('gone-7q2x.example', { registered: false, expiresAt: null, daysLeft: null, reason: 'RDAP 404' });
const soon = reg('cdn-x.example', { expiresAt: '2026-12-21T12:00:00Z', daysLeft: 20 });

const ROWS: TakeoverWatchRow[] = [
  row('a.northwind.example', {
    status: 'takeable',
    chain: ['gone-7q2x.example'],
    chainEnd: 'gone-7q2x.example',
    registration: gone,
    registrations: [gone, reg('northwind.example')],
    vulnerabilities: [{ nodeId: 'v1', label: 'takeover-unregistered-domain', severity: 'critical' }],
  }),
  row('b.northwind.example', { status: 'expiring', chain: ['b.cdn-x.example'], chainEnd: 'b.cdn-x.example', registration: soon, registrations: [soon, reg('northwind.example')] }),
  row('g.northwind.example', { inScope: false, chain: ['g.svc.azurewebsites.net'], chainEnd: 'g.svc.azurewebsites.net', service: 'azurewebsites.net' }),
  row('f.northwind.example', {
    status: 'not-checked',
    chainEnd: null,
    registration: null,
    registrations: [],
    lastCheck: null,
    lastFailure: { jobId: 4, at: T, error: 'the image is missing' },
    pending: true,
  }),
  row('x.elsewhere.example', { status: 'out-of-scope', inScope: false, chainEnd: null, registration: null, registrations: [], lastCheck: null }),
];

const RESPONSE = takeoverWatchResponseSchema.parse({
  items: ROWS,
  page: 1,
  pageSize: 100,
  total: ROWS.length,
  counts: { takeable: 1, expiring: 1, unknown: 0, ok: 1, 'not-checked': 1, 'out-of-scope': 1 },
  now: '2026-12-01T12:00:00.000Z',
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: string[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(url.startsWith('/api/takeover/watch?') ? json(RESPONSE) : json({ error: 'not found' }, 404));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  useView.setState(defaultView);
});

function renderPanel(selectedId: string | null = null) {
  const onPick = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TakeoverPanel onPick={onPick} selectedId={selectedId} />
    </QueryClientProvider>,
  );
  return { onPick };
}

async function rows(): Promise<HTMLElement[]> {
  await screen.findByRole('table', { name: 'Takeover watch' });
  return screen.getAllByRole('row').slice(1);
}

const at = (list: HTMLElement[], i: number) => {
  const el = list[i];
  if (!el) throw new Error(`no row ${String(i)}`);
  return el;
};

describe('TakeoverPanel', () => {
  test('rows in the server order, with status, chain end, the weakest link and days left; counts above', async () => {
    renderPanel();
    const list = await rows();
    expect(calls[0]).toBe('/api/takeover/watch?page=1&pageSize=100');
    expect(list.map((r) => within(r).getAllByRole('button')[0]?.textContent)).toEqual(ROWS.map((r) => r.subdomain));

    const takeable = at(list, 0);
    const expiring = at(list, 1);
    const outChecked = at(list, 2);
    const notChecked = at(list, 3);
    const outNever = at(list, 4);
    expect(within(takeable).getByText('takeable now').getAttribute('title')).toBe('takeover-unregistered-domain');
    expect(within(takeable).getByText('no').className).toContain('text-red-400');
    expect(within(expiring).getByText('20').className).toContain('text-red-400');
    expect(within(expiring).getByText('2026-12-21')).toBeTruthy();
    expect(within(outChecked).getByText('out of scope, not refreshed')).toBeTruthy();
    expect(within(outChecked).getByText('(azurewebsites.net service)')).toBeTruthy();
    expect(within(notChecked).getByText('last check failed: the image is missing')).toBeTruthy();
    expect(within(notChecked).getByText('checking…')).toBeTruthy();
    expect(within(outNever).getByText('not checked (out of scope)')).toBeTruthy();

    const counts = screen.getByRole('list', { name: 'Status counts' });
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'takeable now: 1',
      'expiring: 1',
      'ok: 1',
      'not checked: 1',
      'not checked (out of scope): 1',
    ]);
  });

  test('the domain cell’s tooltip names every domain looked up and its state', async () => {
    renderPanel();
    const list = await rows();
    const cell = at(within(at(list, 0)).getAllByRole('cell'), 3); // Domain
    expect(cell.getAttribute('title')).toBe(
      'gone-7q2x.example: NOT registered (rdap: RDAP 404)\nnorthwind.example: registered, expires 2028-01-01 (761 days) (rdap)',
    );
    expect(within(cell).getByText('+1')).toBeTruthy();
  });

  test('clicking a row (or its subdomain) picks the node; the selected row is marked', async () => {
    const { onPick } = renderPanel('n-b.northwind.example');
    const list = await rows();
    fireEvent.click(at(within(at(list, 3)).getAllByRole('cell'), 2)); // anywhere on the row
    expect(onPick).toHaveBeenLastCalledWith('n-f.northwind.example');
    fireEvent.click(within(at(list, 0)).getByRole('button', { name: 'a.northwind.example' }));
    expect(onPick).toHaveBeenLastCalledWith('n-a.northwind.example');
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(at(list, 1).getAttribute('aria-selected')).toBe('true');
  });

  test('follows the graph\'s "show external CNAME names" filter', async () => {
    useView.getState().setShowExternal(true);
    renderPanel();
    await rows();
    expect(calls[0]).toBe('/api/takeover/watch?page=1&pageSize=100&showExternal=1');
  });

  test('days-left colours and the tooltip text', () => {
    expect(daysClass(null)).toBe('');
    expect(daysClass(-3)).toContain('text-red-400');
    expect(daysClass(29)).toContain('text-red-400');
    expect(daysClass(30)).toContain('text-amber-400');
    expect(daysClass(89)).toContain('text-amber-400');
    expect(daysClass(90)).toBe('');
    expect(registrationsTitle(row('z', { registrations: [reg('u.example', { registered: null, expiresAt: null, daysLeft: null, source: 'whois', reason: 'no expiry' })] }))).toBe(
      'u.example: unknown (whois: no expiry)',
    );
  });
});
