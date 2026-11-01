import { describe, expect, test } from 'vitest';
import { menuItems, safeHttpUrl, type MenuContext } from '../src/menu/items';
import { aggregate, more, node } from './fixtures';

const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({
  group: undefined,
  canExpandNeighbors: true,
  hasRoom: true,
  ...over,
});
const openGroup = aggregate({ id: 'agg:root:ip', childType: 'ip', count: 250, expanded: true, shown: 100, remaining: 150 });
const actions = (items: ReturnType<typeof menuItems>) => items.map((i) => i.action);

describe('menuItems', () => {
  test('an ordinary node: focus, expand neighbors, expand all below, copy, and a disabled run tool', () => {
    const items = menuItems(node('a'), ctx());
    expect(actions(items)).toEqual(['focus', 'expand-neighbors', 'expand-all-below', 'copy-value', 'run-tool']);
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

  test('a member of an open group can collapse it', () => {
    expect(actions(menuItems(node('a'), ctx({ group: openGroup })))).toContain('collapse-parent');
  });

  test('expand neighbors and expand all below are disabled, with a reason, at the element limit', () => {
    const items = menuItems(node('a'), ctx({ canExpandNeighbors: false, hasRoom: false }));
    for (const action of ['expand-neighbors', 'expand-all-below']) {
      const item = items.find((i) => i.action === action);
      expect(item?.disabled).toBe(true);
      expect(item?.hint).toMatch(/2,000/);
    }
  });

  test('a collapsed group: expand with its size, no copy or neighbors', () => {
    const items = menuItems(aggregate({ count: 420 }), ctx());
    expect(actions(items)).toEqual(['focus', 'expand', 'run-tool']);
    expect(items[1]?.label).toBe('Expand (420)');
  });

  test('a collapsed group that does not fit can not be expanded', () => {
    expect(menuItems(aggregate({ canLoadMore: false }), ctx())[1]).toMatchObject({ action: 'expand', disabled: true });
  });

  test('an open group: collapse, collapse all below, and load more with what is left', () => {
    const items = menuItems(openGroup, ctx({ hasOpenBelow: true }));
    expect(actions(items)).toEqual(['focus', 'collapse', 'collapse-below', 'load-more', 'run-tool']);
    expect(items[3]?.label).toBe('Load more (150 left)');
    expect(items[2]?.disabled).toBeUndefined();
  });

  test('collapse all below is disabled when nothing is open below', () => {
    expect(menuItems(openGroup, ctx()).find((i) => i.action === 'collapse-below')).toMatchObject({ disabled: true });
  });

  test('load more is disabled at the element limit', () => {
    const full = { ...openGroup, canLoadMore: false };
    expect(menuItems(full, ctx()).find((i) => i.action === 'load-more')).toMatchObject({ disabled: true });
  });

  test('a "more" node only loads more of its group', () => {
    expect(actions(menuItems(more(openGroup.id, 150), ctx({ group: openGroup })))).toEqual(['load-more']);
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
