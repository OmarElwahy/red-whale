import type { GraphResponse } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { below, canExpandNeighbors, childGroups, indexView, keepFrom, sameState } from '../src/graph/groups';
import { aggregate, edge, more, node } from './fixtures';

const SUBS = 'agg:0000000000000d00:has_subdomain:subdomain';
const IPS = 'agg:00000000000000b0:resolves_to:ip';

/**
 *   d ──has_subdomain──→ SUBS (open) ──→ a, b, +more
 *   b ──resolves_to──→ IPS (open) ──→ ip1, ip2
 *   a ──serves──→ u (only child: a real edge)
 */
function view(): Pick<GraphResponse, 'nodes' | 'edges'> {
  return {
    nodes: [
      node('0000000000000d00', { type: 'domain' }),
      aggregate({ id: SUBS, parentId: '0000000000000d00', expanded: true, shown: 2, remaining: 3, count: 5 }),
      node('a'),
      node('00000000000000b0'),
      more(SUBS, 3),
      aggregate({ id: IPS, parentId: '00000000000000b0', childType: 'ip', relation: 'resolves_to', expanded: true, count: 2, shown: 2, remaining: 0 }),
      node('ip1', { type: 'ip' }),
      node('ip2', { type: 'ip' }),
      node('u', { type: 'url' }),
    ],
    edges: [
      edge('0000000000000d00', SUBS, { kind: 'group', id: `edge:${SUBS}` }),
      edge(SUBS, 'a', { kind: 'member', relation: null }),
      edge(SUBS, '00000000000000b0', { kind: 'member', relation: null }),
      edge(SUBS, `more:${SUBS}`, { kind: 'more', relation: null }),
      edge('00000000000000b0', IPS, { kind: 'group', relation: 'resolves_to' }),
      edge(IPS, 'ip1', { kind: 'member', relation: null }),
      edge(IPS, 'ip2', { kind: 'member', relation: null }),
      edge('a', 'u', { relation: 'serves', id: 'real-a-u' }),
    ],
  };
}

describe('indexView', () => {
  test('size, and which open group each member hangs under', () => {
    const ix = indexView(view());
    expect(ix.size).toBe(17);
    expect(ix.memberOf.get('a')?.id).toBe(SUBS);
    expect(ix.memberOf.get('ip2')?.id).toBe(IPS);
    expect(ix.memberOf.has('u')).toBe(false);
  });
});

describe('below', () => {
  test('everything drawn below a group, and the groups among it', () => {
    const b = below(indexView(view()), SUBS);
    expect([...b.nodes].sort()).toEqual(['00000000000000b0', IPS, 'a', 'ip1', 'ip2', `more:${SUBS}`, 'u'].sort());
    expect(b.groups).toEqual([IPS]);
  });

  test('the groups directly under a node', () => {
    const ix = indexView(view());
    expect(childGroups(ix, '0000000000000d00')).toEqual([SUBS]);
    expect(childGroups(ix, 'a')).toEqual([]);
  });
});

describe('keepFrom', () => {
  test('real edges to an only child, and nodes with nothing above them; never groups or member edges', () => {
    expect(keepFrom(view())).toEqual({ edges: ['real-a-u'], roots: ['0000000000000d00'] });
  });
});

describe('sameState', () => {
  const open = (id: string, pages = 1, pins: string[] = []) => ({ id, pages, pins });

  test('equal when the same groups are open with the same pages and pins (pin order does not matter)', () => {
    expect(sameState({ expand: [open(SUBS, 1, ['x', 'y'])], neighbors: [] }, { expand: [open(SUBS, 1, ['y', 'x'])], neighbors: [] })).toBe(true);
  });

  test('a dropped group, a refused page or a dropped neighbor expansion is a difference', () => {
    const asked = { expand: [open(SUBS, 2), open(IPS)], neighbors: ['n'] };
    expect(sameState({ expand: [open(SUBS, 2)], neighbors: ['n'] }, asked)).toBe(false);
    expect(sameState({ expand: [open(SUBS, 1), open(IPS)], neighbors: ['n'] }, asked)).toBe(false);
    expect(sameState({ expand: [open(SUBS, 2), open(IPS)], neighbors: [] }, asked)).toBe(false);
  });
});

test('neighbor expansions need head room', () => {
  expect(canExpandNeighbors({ size: 1800 })).toBe(true);
  expect(canExpandNeighbors({ size: 1801 })).toBe(false);
});
