// The active-run confirmation (docs/architecture.md §11): what it shows (tool, mode, canonical target, contacts,
// external services, the unlogged active-mode scope decision and its rule), Run active scan / Cancel, and the
// request it leads to (confirmActive, 428 → ConfirmRequired).
import { scopeCheckResponseSchema, type ToolInfo, type ToolsResponse } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmRequired, startRun } from '../src/api/runner';
import {
  ActiveRunDialog,
  canonicalValue,
  contactsText,
  needsConfirmation,
  strongestMode,
  toolsThatRun,
  type ActiveRunDialogProps,
} from '../src/jobs/ActiveRunDialog';

const HTTPX: ToolInfo = {
  name: 'httpx',
  group: 'http',
  label: 'httpx',
  description: null,
  mode: 'active',
  accepts: ['domain', 'subdomain'],
  external: [],
  contacts: 'sends HTTP(S) requests to {target} on ports 80 and 443 (GET /, at most 5 per second; redirects are not followed)',
  timeoutSec: 300,
};
const PASSIVE: ToolInfo = { ...HTTPX, name: 'lookup', label: 'lookup', mode: 'passive', contacts: null, external: ['crt.sh'], accepts: ['subdomain'] };
const DOMAIN_ONLY: ToolInfo = { ...HTTPX, name: 'dnsonly', label: 'dnsonly', mode: 'intrusive', accepts: ['domain'] };
const TOOLS: ToolsResponse = {
  groups: [{ name: 'http', label: 'HTTP probing', image: 'redwhale-tools/http:abc', imageStatus: 'built', tools: ['lookup', 'httpx', 'dnsonly'] }],
  tools: [HTTPX, PASSIVE, DOMAIN_ONLY],
};

const NODE = { id: '00000000000000a1', type: 'subdomain' as const, value: 'lab.redwhale.test', label: 'lab.redwhale.test' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function decision(d: 'in' | 'out', value = 'lab.redwhale.test') {
  return scopeCheckResponseSchema.parse({
    type: 'subdomain',
    value,
    mode: 'active',
    decision: d,
    reason: d === 'in' ? 'matches include domain lab.redwhale.test' : 'passive-only mode is on: active tools are not allowed',
    rule:
      d === 'in'
        ? { id: 3, kind: 'domain', value: 'lab.redwhale.test', action: 'include', note: '', createdAt: '2026-11-03T10:00:00.000Z', removedAt: null }
        : null,
    logId: null,
  });
}

function stubApi(answer: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.startsWith('/api/scope/check')) return Promise.resolve(json(answer));
      return Promise.resolve(json({ error: 'not found' }, 404));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(props: Partial<ActiveRunDialogProps> = {}) {
  const h = { onConfirm: vi.fn(), onClose: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactNode = <ActiveRunDialog node={NODE} tools={[HTTPX]} {...h} {...props} />;
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return h;
}

describe('the dialog', () => {
  test('tool, mode, canonical target, what it contacts, external services, and the scope decision with its rule', async () => {
    const calls = stubApi(decision('in'));
    open();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Run active scan: httpx');
    expect(screen.getByTestId('active-run-target').textContent).toContain('lab.redwhale.test');
    expect(dialog.textContent).toContain(
      'Contacts the target: sends HTTP(S) requests to lab.redwhale.test on ports 80 and 443 (GET /, at most 5 per second; redirects are not followed)',
    );
    expect(dialog.textContent).toContain('External services: none');
    await screen.findByText('In scope');
    expect(dialog.textContent).toContain('matches include domain lab.redwhale.test');
    expect(dialog.textContent).toContain('Rule: includedomainlab.redwhale.test#3');
    // the unlogged GET, in active mode, for the canonical value; nothing else is sent
    expect(calls).toEqual(['GET /api/scope/check?type=subdomain&value=lab.redwhale.test&mode=active']);
  });

  test('Run active scan confirms; Cancel and Escape close without running', async () => {
    stubApi(decision('in'));
    const h = open();
    const run = screen.getByRole('button', { name: 'Run active scan' });
    expect(run).toHaveProperty('disabled', true); // until the scope answered
    await waitFor(() => {
      expect(run).toHaveProperty('disabled', false);
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(h.onClose).toHaveBeenCalledTimes(2);
    expect(h.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
  });

  test('out of scope in active mode: says so, and Run active scan stays disabled', async () => {
    stubApi(decision('out'));
    const h = open();
    await screen.findByText('Out of scope');
    expect(screen.getByRole('alert').textContent).toContain('The server would refuse this run');
    expect(screen.getByText('No rule decided it.')).toBeTruthy();
    const run = screen.getByRole('button', { name: 'Run active scan' });
    expect(run).toHaveProperty('disabled', true);
    fireEvent.click(run);
    expect(h.onConfirm).not.toHaveBeenCalled();
  });

  test('a group lists every tool that would run, passive ones as passive, with their outside services', async () => {
    stubApi(decision('in'));
    open({ tools: toolsThatRun(TOOLS, 'group', 'http', 'subdomain'), group: { name: 'http', label: 'HTTP probing' } });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Run active scan: group HTTP probing');
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('lookuppassivePassive: asks outside sources only; never contacts the targetExternal services: crt.sh'),
      expect.stringContaining('httpxactiveContacts the target: sends HTTP(S) requests to lab.redwhale.test'),
    ]);
    await screen.findByText('In scope');
  });

  test('the target shown is the canonical value (punycode), and that is what the scope is asked about', async () => {
    const calls = stubApi(decision('in', 'xn--bcher-kva.example'));
    open({ node: { ...NODE, value: 'Bücher.example', label: 'Bücher.example' } });
    expect(screen.getByTestId('active-run-target').textContent).toContain('xn--bcher-kva.example');
    await screen.findByText('In scope');
    expect(calls[0]).toBe('GET /api/scope/check?type=subdomain&value=xn--bcher-kva.example&mode=active');
  });
});

describe('helpers', () => {
  test('toolsThatRun: the tool, or the group members that take the node type', () => {
    expect(toolsThatRun(TOOLS, 'tool', 'httpx', 'subdomain')).toEqual([HTTPX]);
    expect(toolsThatRun(TOOLS, 'group', 'http', 'subdomain').map((t) => t.name)).toEqual(['lookup', 'httpx']);
    expect(toolsThatRun(TOOLS, 'group', 'http', 'domain').map((t) => t.name)).toEqual(['httpx', 'dnsonly']);
    expect(toolsThatRun(undefined, 'tool', 'httpx', 'domain')).toEqual([]);
  });

  test('needsConfirmation and strongestMode', () => {
    expect(needsConfirmation([PASSIVE])).toBe(false);
    expect(needsConfirmation([PASSIVE, HTTPX])).toBe(true);
    expect(strongestMode([PASSIVE])).toBe('passive');
    expect(strongestMode([PASSIVE, HTTPX, DOMAIN_ONLY])).toBe('intrusive');
  });

  test('contactsText fills every {target}; a tool without the text still says it contacts the target', () => {
    expect(contactsText({ ...HTTPX, contacts: '{target} and {target}' }, 'a.example.com')).toBe('a.example.com and a.example.com');
    expect(contactsText({ ...HTTPX, contacts: null }, 'a.example.com')).toBe('contacts a.example.com directly');
  });

  test('canonicalValue: what authorize() judges; an invalid value is shown as is', () => {
    expect(canonicalValue('subdomain', 'API.Example.COM.')).toBe('api.example.com');
    expect(canonicalValue('ip', '::ffff:198.18.0.10')).toBe('198.18.0.10');
    expect(canonicalValue('subdomain', 'not a host')).toBe('not a host');
  });
});

describe('startRun', () => {
  test('sends confirmActive only when confirmed, and a 428 becomes ConfirmRequired', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
      return Promise.resolve(
        json({ error: 'httpx (active) would contact lab.redwhale.test directly: confirm the active run first', reason: 'confirm-required' }, 428),
      );
    });
    await expect(startRun({ kind: 'tool', tool: 'httpx', nodeId: 'n1' }, { fetch })).rejects.toBeInstanceOf(ConfirmRequired);
    await expect(startRun({ kind: 'group', group: 'http', nodeId: 'n1', confirmActive: true }, { fetch })).rejects.toThrow(
      /confirm the active run first/,
    );
    expect(bodies).toEqual([
      { tool: 'httpx', nodeId: 'n1' },
      { group: 'http', nodeId: 'n1', confirmActive: true },
    ]);
  });
});
