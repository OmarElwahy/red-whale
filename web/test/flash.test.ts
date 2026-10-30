import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { applyDiff, byId, diffElements } from '../src/graph/diff';
import { toElements, type Element } from '../src/graph/elements';
import { FLASH_MS, flash, flashIds } from '../src/graph/flash';
import { layoutAdded } from '../src/graph/layout';
import { aggregate, edge, headless, node } from './fixtures';

const AGG = 'agg:0123456789abcdef:has_subdomain:subdomain';

beforeAll(() => {
  cytoscape.use(fcose);
});
afterEach(() => {
  vi.useRealTimers();
});

/** What the canvas shows before the update: a domain, two subdomains, and an aggregate of 40 more. */
const before = (): Element[] =>
  toElements({
    nodes: [node('a', { type: 'domain' }), node('b'), node('c'), aggregate({ id: AGG, count: 40, total: 42 })],
    edges: [edge('a', 'b'), edge('a', 'c'), edge('a', AGG)],
  });

/** After a new scan: two new subdomains (a critical one stays visible), a URL under b, and 3 more in the group. */
const after = (): Element[] =>
  toElements({
    nodes: [
      node('a', { type: 'domain' }),
      node('b'),
      node('c'),
      node('d', { severity: 'critical' }),
      node('e', { tag: 'interesting' }),
      node('u', { type: 'url' }),
      aggregate({ id: AGG, count: 43, total: 47, label: '43 subdomains' }),
    ],
    edges: [edge('a', 'b'), edge('a', 'c'), edge('a', 'd'), edge('a', 'e'), edge('b', 'u'), edge('a', AGG)],
  });

function placed(): Core {
  const cy = headless();
  applyDiff(cy, diffElements(new Map(), before()));
  const at: Record<string, { x: number; y: number }> = {
    a: { x: 0, y: 0 },
    b: { x: 120, y: -40 },
    c: { x: 120, y: 40 },
    [AGG]: { x: -150, y: 0 },
  };
  cy.nodes().forEach((n) => {
    const p = at[n.id()];
    if (p) n.position(p);
  });
  return cy;
}

const positions = (cy: Core, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { ...cy.getElementById(id).position() }]));

describe('a live update on the canvas', () => {
  test('new nodes are laid out around the existing ones, which do not move at all', () => {
    const cy = placed();
    const existing = ['a', 'b', 'c', AGG];
    const was = positions(cy, existing);

    const diff = diffElements(byId(before()), after());
    applyDiff(cy, diff);
    layoutAdded(cy, diff.add.nodes.map((n) => n.data.id), new Set());

    expect(positions(cy, existing)).toEqual(was);
    for (const id of ['d', 'e', 'u']) {
      const p = cy.getElementById(id).position();
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    // The URL starts next to its parent b, not somewhere random.
    const u = cy.getElementById('u').position();
    expect(Math.hypot(u.x - 120, u.y + 40)).toBeLessThan(400);
  });

  test('the new nodes the event named flash, and so does the aggregate that grew', () => {
    const diff = diffElements(byId(before()), after());
    // 'u' wasn't in the event (say, it came from a neighborhood refetch): it doesn't flash.
    const fresh = new Set(['d', 'e', 'x-not-on-canvas']);
    expect(flashIds(diff, byId(before()), fresh)).toEqual(['d', 'e', AGG]);
  });

  test('no recent event: nothing flashes (expanding a group is not a live update)', () => {
    const diff = diffElements(byId(before()), after());
    expect(flashIds(diff, byId(before()), new Set())).toEqual([]);
  });

  test('an aggregate that shrank or stayed the same does not flash', () => {
    const smaller = toElements({
      nodes: [node('a', { type: 'domain' }), node('b'), node('c'), aggregate({ id: AGG, count: 39, total: 42 })],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('a', AGG)],
    });
    const diff = diffElements(byId(before()), smaller);
    expect(diff.update.map((el) => el.data.id)).toEqual([AGG]);
    expect(flashIds(diff, byId(before()), new Set(['zz']))).toEqual([]);
  });

  test('flash adds the class for FLASH_MS, then removes it', () => {
    vi.useFakeTimers();
    const cy = placed();
    flash(cy, ['b', AGG]);
    expect(cy.getElementById('b').hasClass('fresh')).toBe(true);
    expect(cy.getElementById(AGG).hasClass('fresh')).toBe(true);
    expect(cy.getElementById('c').hasClass('fresh')).toBe(false);
    vi.advanceTimersByTime(FLASH_MS);
    expect(cy.nodes('.fresh')).toHaveLength(0);
  });

  test('the fresh halo is drawn (stylesheet)', () => {
    const cy = placed();
    const b = cy.getElementById('b');
    b.addClass('fresh');
    expect(Number(b.style('underlay-opacity'))).toBeGreaterThan(0.5);
  });
});
