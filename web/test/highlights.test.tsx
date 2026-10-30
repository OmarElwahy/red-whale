import { highlightSchema, type Highlight } from '@redwhale/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { HighlightsView, type HighlightsViewProps } from '../src/highlights/HighlightsView';
import { node } from './fixtures';

const highlight = (id: string, notes: string, over: Parameters<typeof node>[1] = {}): Highlight =>
  highlightSchema.parse({ ...node(id, { tag: 'interesting', ...over }), notes });

const ITEMS = [
  highlight('dev', '## Exposed git\nSee [the repo](https://dev.example.com/.git/config).\n\n<img src=x onerror=alert(1)>', {
    effectiveSeverity: 'high',
  }),
  highlight('api', ''),
];

function renderView(props: Partial<HighlightsViewProps> = {}) {
  const onPick = vi.fn<HighlightsViewProps['onPick']>();
  render(
    <HighlightsView
      items={ITEMS}
      error={null}
      selectedId={null}
      isShown={() => true}
      onPick={onPick}
      {...props}
    />,
  );
  return { onPick };
}

const card = (name: string) => within(screen.getByRole('article', { name }));

describe('HighlightsView', () => {
  test('one card per interesting node, in the order the server gives (riskiest first)', () => {
    renderView();
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual([
      'dev.example.com',
      'api.example.com',
    ]);
    expect(card('dev.example.com').getByText('high')).toBeTruthy();
  });

  test('notes render as markdown, links open safely, and raw HTML is not rendered', () => {
    renderView();
    const dev = card('dev.example.com');
    expect(dev.getByRole('heading', { name: 'Exposed git' })).toBeTruthy();
    const link = dev.getByRole('link', { name: 'the repo' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('list', { name: 'Highlights' }).querySelector('img')).toBeNull();
  });

  test('a node without notes says so', () => {
    renderView();
    expect(card('api.example.com').getByText('No notes.')).toBeTruthy();
  });

  test('clicking the label picks the node', () => {
    const { onPick } = renderView();
    fireEvent.click(card('api.example.com').getByRole('button', { name: 'api.example.com' }));
    expect(onPick).toHaveBeenCalledWith('api');
  });

  test('the selected node is marked, and hidden nodes say they are not on the graph', () => {
    renderView({ selectedId: 'dev', isShown: (id) => id === 'dev' });
    expect(screen.getByRole('article', { name: 'dev.example.com' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('article', { name: 'api.example.com' }).hasAttribute('aria-current')).toBe(false);
    expect(card('api.example.com').getByText('Not on the graph right now.')).toBeTruthy();
    expect(card('dev.example.com').queryByText('Not on the graph right now.')).toBeNull();
  });

  test('empty, loading and error states', () => {
    const { unmount } = render(
      <HighlightsView items={[]} error={null} selectedId={null} isShown={() => true} onPick={vi.fn()} />,
    );
    expect(screen.getByText(/Nothing is tagged interesting yet/)).toBeTruthy();
    unmount();
    renderView({ items: undefined });
    expect(screen.getByText('loading…')).toBeTruthy();
    renderView({ error: new Error('boom') });
    expect(screen.getByText(/Couldn't load the highlights: boom/)).toBeTruthy();
  });
});
