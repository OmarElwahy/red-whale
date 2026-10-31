import { statsResponseSchema } from '@redwhale/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FilterSidebar } from '../src/filters/FilterSidebar';
import { SEARCH_DEBOUNCE_MS } from '../src/filters/SearchBox';
import { initialUiState, useUi } from '../src/state/ui';
import { defaultView, useView } from '../src/state/view';

const stats = statsResponseSchema.parse({
  totals: { nodes: 520, edges: 600, scans: 7, observations: 900 },
  byType: {
    domain: 1,
    subdomain: 412,
    ip: 40,
    port: 30,
    url: 20,
    technology: 9,
    vulnerability: 5,
    email: 1,
    secret: 1,
    certificate: 1,
    leak: 0,
  },
  bySeverity: { info: 3, low: 4, medium: 2, high: 1, critical: 1, none: 509 },
  byConfidence: { discovered: 400, corroborated: 119, verified: 1 },
  byTag: { interesting: 2, checked: 3, ignored: 6, none: 509 },
  byScope: { in: 300, out: 200, 'n/a': 20 },
  byTool: { httpx: 40, nuclei: 5, subfinder: 412 },
});

const view = () => useView.getState();
const group = (name: string) => within(screen.getByRole('group', { name }));

describe('FilterSidebar', () => {
  beforeEach(() => {
    useView.setState(defaultView);
    useUi.setState(initialUiState);
  });

  test('counts are labeled as workspace totals', () => {
    render(<FilterSidebar stats={stats} />);
    expect(screen.getByText(/workspace totals; they don’t change with filters/)).toBeTruthy();
    const subdomain = group('Type').getByLabelText(/subdomain/);
    const count = subdomain.closest('label')?.querySelector('[title]');
    expect(count?.textContent).toBe('412');
    expect(count?.getAttribute('title')).toMatch(/Workspace total/);
  });

  test('severity counts explain they are own severity, and that the filter keeps the path', () => {
    render(<FilterSidebar stats={stats} />);
    const high = group('Min severity').getByLabelText(/high\+/);
    expect(high.closest('label')?.querySelector('[title]')?.getAttribute('title')).toMatch(
      /1 node with their own severity = high .*keeps the nodes above each finding/,
    );
  });

  test('the scope filter lists in / out / not targetable with their totals', () => {
    render(<FilterSidebar stats={stats} />);
    const scope = group('Scope');
    expect(scope.getByLabelText(/out of scope/).closest('label')?.textContent).toContain('200');
    fireEvent.click(scope.getByLabelText(/out of scope/));
    fireEvent.click(scope.getByLabelText(/not targetable/));
    expect(view().filters).toEqual({ scope: ['out', 'n/a'] });
  });

  test('ticking options writes the API filters', () => {
    render(<FilterSidebar stats={stats} />);
    fireEvent.click(group('Type').getByLabelText(/^ip/));
    fireEvent.click(group('Min severity').getByLabelText(/medium\+/));
    fireEvent.click(group('Confidence').getByLabelText(/corroborated/));
    fireEvent.click(group('Tool').getByLabelText(/nuclei/));
    fireEvent.click(group('Tag').getByLabelText(/interesting/));
    fireEvent.click(screen.getByLabelText(/hide ignored/));
    expect(view().filters).toEqual({
      types: ['ip'],
      minSeverity: 'medium',
      confidence: ['corroborated'],
      tool: ['nuclei'],
      tag: ['interesting'],
      excludeTag: ['ignored'],
    });
    fireEvent.click(group('Min severity').getByLabelText('any'));
    expect(view().filters.minSeverity).toBeUndefined();
  });

  test('hide ignored is off by default and shows the ignored count', () => {
    render(<FilterSidebar stats={stats} />);
    const box = screen.getByLabelText<HTMLInputElement>(/hide ignored/);
    expect(box.checked).toBe(false);
    expect(box.closest('label')?.textContent).toContain('6');
  });

  test('mute and hops are view settings', () => {
    render(<FilterSidebar stats={stats} />);
    fireEvent.click(screen.getByLabelText(/mute low-risk/));
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    expect(view()).toMatchObject({ mute: true, hops: 3, filters: {} });
    expect(screen.getByRole('button', { name: '3' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a tool from a link that this workspace lacks is still listed, so it can be unticked', () => {
    useView.setState({ filters: { tool: ['amass'] } });
    render(<FilterSidebar stats={stats} />);
    const amass = group('Tool').getByLabelText<HTMLInputElement>(/amass/);
    expect(amass.checked).toBe(true);
    fireEvent.click(amass);
    expect(view().filters).toEqual({});
  });

  test('reset appears with filters and clears them', () => {
    render(<FilterSidebar stats={stats} />);
    expect(screen.queryByRole('button', { name: 'reset' })).toBeNull();
    fireEvent.click(group('Type').getByLabelText(/^url/));
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(view().filters).toEqual({});
  });

  test('without stats yet, options render without counts', () => {
    render(<FilterSidebar stats={undefined} />);
    expect(group('Type').getByLabelText(/subdomain/).closest('label')?.querySelector('[title]')).toBeNull();
  });
});

describe('SearchBox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useView.setState(defaultView);
    useUi.setState(initialUiState);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const input = () => screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search' });

  test('typing sets q after a pause, not on every keystroke', () => {
    render(<FilterSidebar stats={stats} />);
    fireEvent.change(input(), { target: { value: 'ad' } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
    });
    fireEvent.change(input(), { target: { value: 'admin' } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
    });
    expect(view().filters.q).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(view().filters.q).toBe('admin');
    expect(useUi.getState().jumpPending).toBe(false);
  });

  test('Enter searches right away and asks for a jump', () => {
    render(<FilterSidebar stats={stats} />);
    fireEvent.change(input(), { target: { value: 'dev' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(view().filters.q).toBe('dev');
    expect(useUi.getState().jumpPending).toBe(true);
  });

  test('clearing the box clears the search', () => {
    useView.setState({ filters: { q: 'dev' } });
    render(<FilterSidebar stats={stats} />);
    expect(input().value).toBe('dev');
    fireEvent.change(input(), { target: { value: '' } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(view().filters).toEqual({});
  });

  test('reset empties the box', () => {
    render(<FilterSidebar stats={stats} />);
    fireEvent.change(input(), { target: { value: 'dev' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(input().value).toBe('');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(view().filters).toEqual({});
  });
});
