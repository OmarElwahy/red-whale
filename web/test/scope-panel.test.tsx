import {
  normalizeScopeRule,
  scopeCheckInputSchema,
  scopeRuleCreateSchema,
  scopeRulePatchSchema,
  scopeSettingsPatchSchema,
  type ScopeLogEntry,
  type ScopeRule,
} from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ScopeBanner, ScopePanel } from '../src/scope/ScopePanel';

const T = '2026-10-31T10:00:00.000Z';

/** A fake scope API: validates bodies with the shared schemas, normalizes rules like the server. */
function fakeApi(initial: ScopeRule[] = []) {
  let rules = [...initial];
  let passiveOnly = true;
  const log: ScopeLogEntry[] = [];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body as string);
    calls.push({ method, url, body });
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/api/scope/rules' && method === 'GET') {
      return json({ rules: u.searchParams.get('removed') === '1' ? rules : rules.filter((r) => r.removedAt === null) });
    }
    if (u.pathname === '/api/scope/rules' && method === 'POST') {
      const input = scopeRuleCreateSchema.parse(body);
      const n = normalizeScopeRule(input.kind, input.action, input.value);
      if (!n.ok) return json({ error: 'scope rule refused', issues: [n.error] }, 400);
      const rule: ScopeRule = { id: rules.length + 1, ...input, value: n.value, createdAt: T, removedAt: null };
      rules.push(rule);
      return json(rule, 201);
    }
    const ruleMatch = /^\/api\/scope\/rules\/(\d+)$/.exec(u.pathname);
    if (ruleMatch && method === 'PATCH') {
      const patch = scopeRulePatchSchema.parse(body);
      const id = Number(ruleMatch[1]);
      rules = rules.map((r) =>
        r.id === id ? { ...r, ...(patch.note !== undefined ? { note: patch.note } : {}), ...(patch.removed ? { removedAt: T } : {}) } : r,
      );
      return json(rules.find((r) => r.id === id));
    }
    if (u.pathname === '/api/scope/settings') {
      if (method === 'PATCH') passiveOnly = scopeSettingsPatchSchema.parse(body).passiveOnly;
      return json({ passiveOnly, updatedAt: T });
    }
    if (u.pathname === '/api/scope/check' && method === 'POST') {
      const input = scopeCheckInputSchema.parse(body);
      const entry: ScopeLogEntry = {
        id: log.length + 1,
        source: 'check',
        targetType: input.type,
        targetValue: input.value,
        mode: input.mode,
        decision: 'out',
        rule: null,
        reason: 'no domain or wildcard rule includes it (default deny)',
        at: T,
      };
      log.unshift(entry);
      return json({ ...input, decision: 'out', reason: entry.reason, rule: null, logId: entry.id });
    }
    if (u.pathname === '/api/scope/log') {
      const sources = (u.searchParams.get('source') ?? 'run').split(',');
      const items = log.filter((e) => sources.includes(e.source));
      return json({ items, page: 1, pageSize: 25, total: items.length });
    }
    return json({ error: 'not found' }, 404);
  });
  return { fetch, calls, rules: () => rules };
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const rule = (over: Partial<ScopeRule>): ScopeRule => ({
  id: 1,
  kind: 'wildcard',
  value: '*.example.com',
  action: 'include',
  note: '',
  createdAt: T,
  removedAt: null,
  ...over,
});

let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  api = fakeApi();
  vi.stubGlobal('fetch', api.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScopeBanner', () => {
  test('shows with no rules, and says excludes alone allow nothing', async () => {
    const onOpen = vi.fn();
    wrap(<ScopeBanner onOpen={onOpen} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/No scope defined/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Scope' }));
    expect(onOpen).toHaveBeenCalled();
  });

  test('with only an exclude rule it still shows', async () => {
    api = fakeApi([rule({ action: 'exclude' })]);
    vi.stubGlobal('fetch', api.fetch);
    wrap(<ScopeBanner onOpen={vi.fn()} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/Exclude rules alone never let anything in/);
  });

  test('hidden once an include rule exists', async () => {
    api = fakeApi([rule({})]);
    vi.stubGlobal('fetch', api.fetch);
    wrap(<ScopeBanner onOpen={vi.fn()} />);
    await waitFor(() => {
      expect(api.calls.some((c) => c.url.startsWith('/api/scope/rules'))).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('ScopePanel: rules', () => {
  test('adding a rule POSTs it and lists the normalized value', async () => {
    wrap(<ScopePanel />);
    const form = within(screen.getByRole('form', { name: 'Add a scope rule' }));
    fireEvent.change(form.getByLabelText('Rule value'), { target: { value: '*.Bücher.example' } });
    fireEvent.change(form.getByLabelText('Note'), { target: { value: 'from the SOW' } });
    fireEvent.click(form.getByRole('button', { name: 'Add rule' }));
    const list = within(screen.getByRole('list', { name: 'Scope rules' }));
    expect(await list.findByText('*.xn--bcher-kva.example')).toBeTruthy();
    expect(list.getByText('from the SOW')).toBeTruthy();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'wildcard',
      action: 'include',
      value: '*.Bücher.example',
      note: 'from the SOW',
    });
    expect(form.getByLabelText<HTMLInputElement>('Rule value').value).toBe('');
  });

  test('a refused rule shows the server’s reason', async () => {
    wrap(<ScopePanel />);
    const form = within(screen.getByRole('form', { name: 'Add a scope rule' }));
    fireEvent.change(form.getByLabelText('Rule value'), { target: { value: '*.co.uk' } });
    fireEvent.click(form.getByRole('button', { name: 'Add rule' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/co\.uk is a public suffix/);
  });

  test('removing takes a second click, then PATCHes removed: true', async () => {
    api = fakeApi([rule({ id: 3 })]);
    vi.stubGlobal('fetch', api.fetch);
    wrap(<ScopePanel />);
    const row = within(await screen.findByRole('listitem', { name: 'Rule 3' }));
    fireEvent.click(row.getByRole('button', { name: 'Remove' }));
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
    fireEvent.click(row.getByRole('button', { name: 'Remove rule #3' }));
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/scope/rules/3', body: { removed: true } });
    });
    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: 'Rule 3' })).toBeNull();
    });
    // Still there, as history.
    fireEvent.click(screen.getByLabelText('show removed'));
    expect(within(await screen.findByRole('listitem', { name: 'Rule 3' })).getByText('(removed)')).toBeTruthy();
  });

  test('a note can be edited', async () => {
    api = fakeApi([rule({ id: 2 })]);
    vi.stubGlobal('fetch', api.fetch);
    wrap(<ScopePanel />);
    const row = within(await screen.findByRole('listitem', { name: 'Rule 2' }));
    fireEvent.click(row.getByRole('button', { name: 'Note' }));
    fireEvent.change(row.getByLabelText('Note for rule 2'), { target: { value: 'VPN range' } });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    expect(await row.findByText('VPN range')).toBeTruthy();
  });
});

describe('ScopePanel: passive only', () => {
  test('starts on, and the switch PATCHes the setting', async () => {
    wrap(<ScopePanel />);
    const toggle = await screen.findByRole('switch', { name: 'Passive only' });
    await waitFor(() => {
      expect((toggle as HTMLInputElement).disabled).toBe(false);
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/scope/settings', body: { passiveOnly: false } });
    });
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Passive only' }).checked).toBe(false);
    });
  });
});

describe('ScopePanel: test a target', () => {
  test('typing checks nothing; submitting POSTs once and shows the answer', async () => {
    wrap(<ScopePanel />);
    const form = within(screen.getByRole('form', { name: 'Test a target' }));
    fireEvent.change(form.getByLabelText('Target type'), { target: { value: 'ip' } });
    fireEvent.change(form.getByLabelText('Mode'), { target: { value: 'active' } });
    for (const v of ['2', '20', '203.0.113.7']) fireEvent.change(form.getByLabelText('Target value'), { target: { value: v } });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls.filter((c) => c.url.startsWith('/api/scope/check'))).toEqual([]);

    fireEvent.submit(form.getByLabelText('Target value'));
    const result = within(await screen.findByLabelText('Check result'));
    expect(result.getByText('Out of scope')).toBeTruthy();
    expect(result.getByText(/default deny/)).toBeTruthy();
    expect(api.calls.filter((c) => c.url.startsWith('/api/scope/check'))).toEqual([
      { method: 'POST', url: '/api/scope/check', body: { type: 'ip', value: '203.0.113.7', mode: 'active' } },
    ]);
  });
});

describe('ScopePanel: log', () => {
  test('shows runs by default; "include checks" adds the test box entries', async () => {
    wrap(<ScopePanel />);
    expect(await screen.findByText(/No tool has been authorized to run yet/)).toBeTruthy();
    const form = within(screen.getByRole('form', { name: 'Test a target' }));
    fireEvent.change(form.getByLabelText('Target value'), { target: { value: 'api.example.com' } });
    fireEvent.click(form.getByRole('button', { name: 'Check' }));
    await screen.findByLabelText('Check result');

    const log = within(screen.getByRole('list', { name: 'Scope log' }));
    expect(log.queryByText('api.example.com')).toBeNull();
    fireEvent.click(screen.getByLabelText('include checks'));
    expect(await log.findByText('api.example.com')).toBeTruthy();
    expect(api.calls.some((c) => c.url.includes('source=check%2Crun'))).toBe(true);
  });
});
