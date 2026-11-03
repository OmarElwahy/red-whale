import type { Job } from '@redwhale/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RunRefused, startRun } from '../src/api/runner';
import { JobsPanel, formatDuration, jobDuration, jobFindings } from '../src/jobs/JobsPanel';
import { runnerSummary } from '../src/jobs/RunnerIndicator';

const T = '2026-11-02T10:00:00.000Z';

function job(over: Partial<Job> = {}): Job {
  return {
    id: 1,
    tool: 'subfinder',
    group: 'subdomain',
    nodeId: 'n-domain',
    targetType: 'domain',
    targetValue: 'example.com',
    mode: 'passive',
    status: 'succeeded',
    queuedScopeLogId: 1,
    scopeLogId: 2,
    argv: ['python3', '-I', '/opt/redwhale/subdomain/subfinder/run.py', '--target', 'example.com', '--out', '/out'],
    image: 'redwhale-tools/subdomain:abc',
    timeoutSec: 600,
    exitCode: 0,
    error: null,
    issues: null,
    createdAt: T,
    startedAt: T,
    finishedAt: '2026-11-02T10:01:15.000Z',
    scanId: 'scan-1',
    nodesCreated: 14,
    nodesUpdated: 6,
    ...over,
  };
}

const JOBS = [
  job({ id: 3, status: 'running', tool: 'httpx', group: 'http', mode: 'active', finishedAt: null, scanId: null, nodesCreated: null, nodesUpdated: null, exitCode: null }),
  job({ id: 2, status: 'failed', tool: 'assetfinder', error: 'result.json does not follow the contract', issues: ['findings[0].value: bad'], scanId: null, nodesCreated: null, nodesUpdated: null }),
  job(),
];

function fakeApi() {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const calls: string[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('/api/jobs?')) return Promise.resolve(json({ items: JOBS, page: 1, pageSize: 25, total: 3 }));
    if (url === '/api/jobs/3/cancel') return Promise.resolve(json({ job: { ...JOBS[0], status: 'running' } }));
    if (url === '/api/jobs/2') {
      return Promise.resolve(json({ job: JOBS[1], tails: { stdout: '', stderr: '[run] assetfinder --subs-only example.com\n', raw: null } }));
    }
    return Promise.resolve(json({ error: 'not found' }, 404));
  });
  return { fetch, calls };
}

let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  api = fakeApi();
  vi.stubGlobal('fetch', api.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPickNode = vi.fn();
  const onShowResults = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <JobsPanel onPickNode={onPickNode} onShowResults={onShowResults} />
    </QueryClientProvider>,
  );
  return { onPickNode, onShowResults };
}

/** The table's body rows, once the jobs are in (row 0 is the header). */
async function rows(): Promise<HTMLElement[]> {
  await screen.findByText('+14 new, 6 updated');
  return screen.getAllByRole('row').slice(1);
}

function at(list: HTMLElement[], i: number): HTMLElement {
  const el = list[i];
  if (!el) throw new Error(`no row ${String(i)}`);
  return el;
}

describe('JobsPanel', () => {
  test('lists jobs newest first with status, duration, what they found, and the actions that apply', async () => {
    renderPanel();
    const list = await rows();
    const [running, failed, done] = [at(list, 0), at(list, 1), at(list, 2)];
    expect(within(running).getByText('running')).toBeTruthy();
    expect(within(running).getByTitle('Contacted the target directly (confirmed by the analyst)').textContent).toBe('active');
    expect(within(done).queryByTitle(/Contacted the target/)).toBeNull(); // passive jobs get no badge
    expect(within(running).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(running).queryByRole('button', { name: 'Show results' })).toBeNull();
    expect(within(failed).getAllByText('result.json does not follow the contract').length).toBeGreaterThan(0);
    expect(within(done).getByText('+14 new, 6 updated')).toBeTruthy();
    expect(within(done).getByText('1m 15s')).toBeTruthy();
    expect(within(done).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test('cancel, show results, and the target link', async () => {
    const { onPickNode, onShowResults } = renderPanel();
    const list = await rows();
    fireEvent.click(within(at(list, 0)).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => {
      expect(api.calls).toContain('POST /api/jobs/3/cancel');
    });
    fireEvent.click(within(at(list, 2)).getByRole('button', { name: 'Show results' }));
    expect(onShowResults).toHaveBeenCalledWith(expect.objectContaining({ id: 1, scanId: 'scan-1' }));
    fireEvent.click(within(at(list, 2)).getByRole('button', { name: 'example.com' }));
    expect(onPickNode).toHaveBeenCalledWith('n-domain');
  });

  test('raw output: the command, the issues, and the tail of each stream with a link to the full one', async () => {
    renderPanel();
    const list = await rows();
    fireEvent.click(within(at(list, 1)).getByRole('button', { name: 'Raw output' }));
    const dialog = await screen.findByRole('dialog', { name: 'Job 2 output' });
    await within(dialog).findByText('findings[0].value: bad');
    expect(within(dialog).getByText('No raw kept for this job.')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'open full raw' }).getAttribute('href')).toBe('/api/jobs/2/output/raw');
    fireEvent.click(within(dialog).getByRole('tab', { name: /stderr/ }));
    expect(within(dialog).getByText(/\[run\] assetfinder/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('job helpers', () => {
  test.each([
    [0, '0s'],
    [59_400, '59s'],
    [75_000, '1m 15s'],
    [3_725_000, '1h 2m'],
  ])('formatDuration(%d) = %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  test('duration ticks while running; nothing before the start', () => {
    expect(jobDuration(job({ finishedAt: null }), Date.parse(T) + 5_000)).toBe('5s');
    expect(jobDuration(job({ startedAt: null, finishedAt: null }), 0)).toBeNull();
  });

  test('what a run found', () => {
    expect(jobFindings(job())).toBe('+14 new, 6 updated');
    expect(jobFindings(job({ nodesCreated: 0, nodesUpdated: 0 }))).toBe('nothing new');
    expect(jobFindings(job({ nodesCreated: null }))).toBeNull();
  });

  test('runner chip', () => {
    const ok = { docker: { reachable: true, version: '27.0', error: null }, images: [{ group: 'subdomain', image: 'i', status: 'built' as const }], running: 1, queued: 2, maxConcurrent: 2 };
    expect(runnerSummary(ok, null).tone).toBe('ok');
    expect(runnerSummary({ ...ok, images: [{ group: 'subdomain', image: 'i', status: 'missing' }] }, null)).toMatchObject({ tone: 'warn' });
    expect(runnerSummary({ ...ok, docker: { reachable: false, version: null, error: 'Docker is not running' } }, null)).toMatchObject({ tone: 'down', label: 'Docker off' });
    expect(runnerSummary(undefined, new Error('the tool runner is not enabled'))).toMatchObject({ tone: 'off', label: 'runner off' });
  });

  test('startRun: a 403 is RunRefused with the scope reason; other errors are plain', async () => {
    const refused = { error: 'out of scope: no include rule matches example.com', decision: 'out', jobs: [job({ status: 'refused' })] };
    const f403 = vi.fn(() => Promise.resolve(new Response(JSON.stringify(refused), { status: 403 })));
    const err = await startRun({ kind: 'group', group: 'subdomain', nodeId: 'n' }, { fetch: f403 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunRefused);
    expect((err as RunRefused).message).toBe('out of scope: no include rule matches example.com');
    const f409 = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'image not built' }), { status: 409 })));
    await expect(startRun({ kind: 'tool', tool: 'subfinder', nodeId: 'n' }, { fetch: f409 })).rejects.toThrow('image not built');
  });
});
