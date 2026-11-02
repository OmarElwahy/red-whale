import { describe, expect, test } from 'vitest';
import type { RunnerStatus, ToolInfo, ToolsResponse } from '@redwhale/shared';
import { canvasMenuItems, menuItems, runItems, safeHttpUrl, type MenuContext, type RunContext } from '../src/menu/items';
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
  test('an ordinary node: focus, expand neighbors, expand all below, copy, and run tool (loading until the tools come)', () => {
    const items = menuItems(node('a'), ctx());
    expect(actions(items)).toEqual(['focus', 'expand-neighbors', 'expand-all-below', 'copy-value', 'run-menu', 'add-child']);
    expect(items.find((i) => i.action === 'run-menu')).toMatchObject({ disabled: true, label: 'Run tool', hint: 'Loading the tools…' });
  });

  test('"Add child node…" on a node that can have children; disabled (and why) on one that cannot', () => {
    expect(menuItems(node('a'), ctx()).find((i) => i.action === 'add-child')).toEqual({ action: 'add-child', label: 'Add child node…' });
    expect(menuItems(node('l', { type: 'leak', value: 'LinkedIn-2016' }), ctx()).find((i) => i.action === 'add-child')).toEqual({
      action: 'add-child',
      label: 'Add child node…',
      disabled: true,
      hint: 'Nothing can hang under a leak.',
    });
    expect(actions(menuItems(openGroup, ctx()))).not.toContain('add-child');
  });

  test('the empty canvas offers "Add node…"', () => {
    expect(canvasMenuItems()).toEqual([{ action: 'add-node', label: 'Add node…' }]);
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
    expect(actions(items)).toEqual(['focus', 'expand']);
    expect(items[1]?.label).toBe('Expand (420)');
  });

  test('a collapsed group that does not fit can not be expanded', () => {
    expect(menuItems(aggregate({ canLoadMore: false }), ctx())[1]).toMatchObject({ action: 'expand', disabled: true });
  });

  test('an open group: collapse, collapse all below, and load more with what is left', () => {
    const items = menuItems(openGroup, ctx({ hasOpenBelow: true }));
    expect(actions(items)).toEqual(['focus', 'collapse', 'collapse-below', 'load-more']);
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

describe('run tool submenu', () => {
  const SUBFINDER: ToolInfo = {
    name: 'subfinder', group: 'subdomain', label: 'subfinder', description: null, mode: 'passive',
    accepts: ['domain'], external: ['crt.sh', 'OTX'], timeoutSec: 600,
  };
  const CRTSH: ToolInfo = { ...SUBFINDER, name: 'crtsh', label: 'crt.sh', external: ['crt.sh'], timeoutSec: 420 };
  const TOOLS: ToolsResponse = {
    groups: [{ name: 'subdomain', label: 'subdomain enumeration', image: 'redwhale-tools/subdomain:abc', imageStatus: 'built', tools: ['subfinder', 'crtsh'] }],
    tools: [SUBFINDER, CRTSH],
  };
  const RUNNER: RunnerStatus = {
    docker: { reachable: true, version: '27.0', error: null },
    images: [{ group: 'subdomain', image: 'redwhale-tools/subdomain:abc', status: 'built' }],
    running: 0,
    queued: 0,
    maxConcurrent: 2,
  };
  const run = (over: Partial<RunContext> = {}): RunContext => ({ tools: TOOLS, runner: RUNNER, passiveOnly: true, ...over });
  const domain = (over: Parameters<typeof node>[1] = {}) => node('d', { type: 'domain', value: 'example.com', label: 'example.com', ...over });

  test('group first, then each tool that takes the node type, with mode and external badges', () => {
    const items = runItems(domain(), run());
    expect(items.map((i) => [i.action, i.name, i.label, i.disabled])).toEqual([
      ['run-group', 'subdomain', 'Run group: subdomain enumeration', undefined],
      ['run-tool', 'subfinder', 'subfinder', undefined],
      ['run-tool', 'crtsh', 'crt.sh', undefined],
    ]);
    expect(items[1]?.badges).toEqual([{ text: 'passive', tone: 'passive' }, { text: 'external', tone: 'external' }]);
    expect(items[2]?.hint).toBe('Contacts crt.sh');
    expect(menuItems(domain(), ctx({ run: run() })).find((i) => i.action === 'run-menu')?.submenu).toEqual(items);
  });

  test('a node type no tool takes: Run tool is disabled and says so', () => {
    expect(runItems(node('s'), run())).toEqual([]);
    expect(menuItems(node('s'), ctx({ run: run() })).find((i) => i.action === 'run-menu')).toMatchObject({ disabled: true, hint: 'No tool runs against a subdomain yet.' });
  });

  const down: RunnerStatus = { ...RUNNER, docker: { reachable: false, version: null, error: 'x' } };
  const image = (status: 'missing' | 'outdated'): RunnerStatus => ({ ...RUNNER, images: [{ group: 'subdomain', image: 'i', status }] });
  test.each([
    ['out of scope', domain({ inScope: 'out' }), run(), /Out of scope/],
    ['Docker down', domain(), run({ runner: down }), /Docker is not running/],
    ['image missing', domain(), run({ runner: image('missing') }), /pnpm tools:build subdomain/],
    ['image outdated', domain(), run({ runner: image('outdated') }), /out of date/],
  ])('disabled with the reason: %s', (_name, target, context, reason) => {
    const items = runItems(target, context);
    expect(items).toHaveLength(3);
    for (const i of items) {
      expect(i.disabled).toBe(true);
      expect(i.hint).toMatch(reason);
    }
  });

  test('an active tool is disabled while passive-only is on, and allowed when it is off', () => {
    const active: ToolsResponse = { ...TOOLS, tools: [{ ...SUBFINDER, mode: 'active' }] };
    expect(runItems(domain(), run({ tools: active }))[1]).toMatchObject({ disabled: true, hint: 'Passive-only mode is on (Scope panel).' });
    expect(runItems(domain(), run({ tools: active }))[0]?.badges?.[0]).toEqual({ text: 'active', tone: 'active' });
    expect(runItems(domain(), run({ tools: active, passiveOnly: false }))[1]?.disabled).toBeUndefined();
  });

  test('a server without the runner says why', () => {
    const items = menuItems(domain(), ctx({ run: run({ tools: undefined, toolsError: 'Tool runs are off: 503' }) }));
    expect(items.find((i) => i.action === 'run-menu')).toMatchObject({ action: 'run-menu', disabled: true, hint: 'Tool runs are off: 503' });
  });
});
