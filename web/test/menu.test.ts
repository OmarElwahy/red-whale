import { describe, expect, test } from 'vitest';
import type { GroupState } from '../src/graph/compose';
import { menuItems, safeHttpUrl, type MenuContext } from '../src/menu/items';
import { aggregate, node } from './fixtures';

const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({
  group: undefined,
  canLoadPage: true,
  canExpandNeighbors: true,
  ...over,
});
const group: GroupState = { aggregateId: 'agg:root:ip', pages: 1, members: ['a'], total: 250, remaining: 150 };
const actions = (items: ReturnType<typeof menuItems>) => items.map((i) => i.action);

describe('menuItems', () => {
  test('an ordinary node: focus, expand neighbors, copy, and a disabled run tool', () => {
    const items = menuItems(node('a'), ctx());
    expect(actions(items)).toEqual(['focus', 'expand-neighbors', 'copy-value', 'run-tool']);
    expect(items.find((i) => i.action === 'run-tool')).toMatchObject({ disabled: true, label: 'Run tool (coming later)' });
  });

  test('a URL node can be opened in a new tab', () => {
    const items = menuItems(node('u', { type: 'url', value: 'https://a.example.com/login' }), ctx());
    expect(actions(items)).toContain('open-url');
  });

  test('only URL nodes get "open URL", even if the value looks like one', () => {
    expect(actions(menuItems(node('s', { type: 'subdomain', value: 'http://x.example.com/' }), ctx()))).not.toContain('open-url');
  });

  test('a URL node with a non-http value has no "open URL"', () => {
    expect(actions(menuItems(node('u', { type: 'url', value: 'javascript:alert(1)' }), ctx()))).not.toContain('open-url');
  });

  test('a node from an expanded group can collapse it', () => {
    expect(actions(menuItems(node('a'), ctx({ group })))).toContain('collapse');
  });

  test('expand neighbors is disabled, with a reason, at the element limit', () => {
    const item = menuItems(node('a'), ctx({ canExpandNeighbors: false })).find((i) => i.action === 'expand-neighbors');
    expect(item?.disabled).toBe(true);
    expect(item?.hint).toMatch(/2,000/);
  });

  test('an aggregate: expand with its size, no copy or neighbors', () => {
    const items = menuItems(aggregate({ total: 420 }), ctx());
    expect(actions(items)).toEqual(['focus', 'expand', 'run-tool']);
    expect(items[1]?.label).toBe('Expand (420)');
  });

  test('an expanded aggregate: load more with what is left, and collapse', () => {
    const items = menuItems(aggregate(), ctx({ group }));
    expect(actions(items)).toEqual(['focus', 'expand', 'collapse', 'run-tool']);
    expect(items[1]?.label).toBe('Load more (150 left)');
  });

  test('load more is disabled at the element limit', () => {
    expect(menuItems(aggregate(), ctx({ group, canLoadPage: false }))[1]).toMatchObject({ disabled: true });
  });
});

describe('safeHttpUrl', () => {
  test.each([
    ['https://a.example.com/x?y=1', 'https://a.example.com/x?y=1'],
    ['http://198.18.0.1:8080/', 'http://198.18.0.1:8080/'],
  ])('%s is allowed', (value, href) => {
    expect(safeHttpUrl(value)).toBe(href);
  });

  test.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://a.example.com/', 'not a url', ''])(
    '%s is refused',
    (value) => {
      expect(safeHttpUrl(value)).toBeNull();
    },
  );
});
