import type { GraphNode } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import {
  ELEMENT_BUDGET,
  EXPAND_PAGE_SIZE,
  canExpandNeighbors,
  canLoadPage,
  composeGraph,
  type ExpandPage,
  type Expansion,
} from '../src/graph/compose';
import { aggregate, edge, node } from './fixtures';

const P = '0123456789abcdef';
const AGG = `agg:${P}:has_subdomain:subdomain`;

const parent = node(P, { type: 'domain', value: 'example.com', label: 'example.com' });
const members = (from: number, to: number): GraphNode[] =>
  Array.from({ length: to - from }, (_, i) => node(`m${String(from + i)}`));

/** Base graph: the domain, one sticky (visible) member m0, and an aggregate hiding 249 more. */
const base = () => ({
  nodes: [parent, node('m0', { severity: 'high' }), aggregate({ id: AGG, label: '249 subdomains', count: 249, total: 250 })],
  edges: [edge(P, 'm0'), edge(P, AGG)],
});

function page(n: number, nodes: GraphNode[], total = 250): ExpandPage {
  return { aggregate: { id: AGG }, nodes, edges: nodes.map((m) => edge(P, m.id)), page: n, total };
}
const expansion = (...pages: ExpandPage[]): Expansion => ({ aggregateId: AGG, pages });
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('composeGraph', () => {
  test('with nothing expanded, the canvas is the base graph', () => {
    const c = composeGraph({ base: base(), expansions: [], neighborhoods: [] });
    expect(ids(c.nodes)).toEqual([P, 'm0', AGG]);
    expect(c.edges).toHaveLength(2);
    expect(c.size).toBe(5);
    expect(c.groups.size).toBe(0);
  });

  test('a loaded page adds its members, and the aggregate shows what is left', () => {
    // Members come riskiest first, so the sticky m0 is on page 1 too.
    const c = composeGraph({ base: base(), expansions: [expansion(page(1, members(0, 100)))], neighborhoods: [] });
    expect(c.nodes.filter((n) => n.id.startsWith('m'))).toHaveLength(100);
    const agg = c.nodes.find((n) => n.id === AGG);
    expect(agg).toMatchObject({ type: 'aggregate', count: 150, total: 250, label: '150 more subdomains' });
    expect(c.groups.get(AGG)).toMatchObject({ pages: 1, total: 250, remaining: 150 });
    expect(c.groups.get(AGG)?.members).toHaveLength(100);
    expect(c.groupOf.get('m42')).toBe(AGG);
    expect(c.edges.some((e) => e.source === P && e.target === 'm42')).toBe(true);
  });

  test('once every page is loaded the aggregate and its edge are gone', () => {
    const c = composeGraph({
      base: base(),
      expansions: [expansion(page(1, members(0, 100)), page(2, members(100, 200)), page(3, members(200, 250)))],
      neighborhoods: [],
    });
    expect(c.nodes.some((n) => n.id === AGG)).toBe(false);
    expect(c.edges.some((e) => e.target === AGG)).toBe(false);
    expect(c.groups.get(AGG)?.remaining).toBe(0);
    expect(c.nodes).toHaveLength(251);
  });

  test('a member already on the canvas is not duplicated, and the base copy wins', () => {
    const c = composeGraph({ base: base(), expansions: [expansion(page(1, members(0, 100)))], neighborhoods: [] });
    expect(c.nodes.filter((n) => n.id === 'm0')).toHaveLength(1);
    expect(c.nodes.find((n) => n.id === 'm0')).toMatchObject({ severity: 'high' });
    expect(c.edges.filter((e) => e.id === `${P}->m0`)).toHaveLength(1);
  });

  test('an expansion whose aggregate is not on the canvas is ignored', () => {
    const { nodes, edges } = base();
    const c = composeGraph({
      base: { nodes: nodes.filter((n) => n.id !== AGG), edges },
      expansions: [expansion(page(1, members(0, 100)))],
      neighborhoods: [],
    });
    expect(c.nodes).toHaveLength(2);
    expect(c.groups.size).toBe(0);
  });

  test('a neighborhood is merged in, and edges to nodes that are not on the canvas are dropped', () => {
    const c = composeGraph({
      base: base(),
      expansions: [],
      neighborhoods: [
        {
          center: 'm0',
          nodes: [node('m0'), node('ip1', { type: 'ip', value: '198.18.0.1' })],
          edges: [edge('m0', 'ip1', { relation: 'resolves_to' }), edge('ip1', 'nowhere', { relation: 'has_port' })],
        },
      ],
    });
    expect(ids(c.nodes)).toContain('ip1');
    expect(ids(c.edges)).toContain('m0->ip1');
    expect(ids(c.edges)).not.toContain('ip1->nowhere');
    expect(c.size).toBe(c.nodes.length + c.edges.length);
  });

  test('a neighborhood of an expanded member only shows while that group is expanded', () => {
    const nb = { center: 'm5', nodes: [node('m5'), node('ip5', { type: 'ip' })], edges: [edge('m5', 'ip5')] };
    // Listed before the expansion that brings in its center: still applied.
    const open = composeGraph({ base: base(), expansions: [expansion(page(1, members(0, 100)))], neighborhoods: [nb] });
    expect(ids(open.nodes)).toContain('ip5');

    const collapsed = composeGraph({ base: base(), expansions: [], neighborhoods: [nb] });
    expect(ids(collapsed.nodes)).not.toContain('ip5');
    expect(ids(collapsed.nodes)).not.toContain('m5');
  });

  test('a page that would go over the element budget is skipped and reported', () => {
    const budget = 5 + 2 * 100 + 10; // base + one page, but not two
    const c = composeGraph({
      base: base(),
      expansions: [expansion(page(1, members(0, 100)), page(2, members(100, 200)))],
      neighborhoods: [],
      budget,
    });
    expect(c.overBudget).toEqual([`${AGG}#2`]);
    expect(c.groups.get(AGG)).toMatchObject({ pages: 1, remaining: 150 });
    expect(c.size).toBeLessThanOrEqual(budget);
  });

  test('a neighborhood that would go over the budget is skipped', () => {
    const c = composeGraph({
      base: base(),
      expansions: [],
      neighborhoods: [{ center: P, nodes: members(500, 510), edges: [] }],
      budget: 10,
    });
    expect(c.overBudget).toEqual([`neighbors:${P}`]);
    expect(c.nodes).toHaveLength(3);
  });
});

describe('budget checks', () => {
  test('a page fits if its members and their edges stay inside the budget', () => {
    expect(canLoadPage({ size: ELEMENT_BUDGET - 2 * EXPAND_PAGE_SIZE }, 1000)).toBe(true);
    expect(canLoadPage({ size: ELEMENT_BUDGET - 2 * EXPAND_PAGE_SIZE + 1 }, 1000)).toBe(false);
    // A short last page needs less room.
    expect(canLoadPage({ size: ELEMENT_BUDGET - 10 }, 5)).toBe(true);
  });

  test('nothing left means nothing to load', () => {
    expect(canLoadPage({ size: 0 }, 0)).toBe(false);
  });

  test('neighbors need some head room', () => {
    expect(canExpandNeighbors({ size: 100 })).toBe(true);
    expect(canExpandNeighbors({ size: ELEMENT_BUDGET - 1 })).toBe(false);
  });
});
