import type { Core } from 'cytoscape';
import { describe, expect, test } from 'vitest';
import { toElements } from '../src/graph/elements';
import {
  FADED,
  MUTED,
  SEARCH_PATH,
  applyFocus,
  applyMute,
  applySearchPath,
  focusNeighborhood,
} from '../src/graph/emphasis';
import { FADED_OPACITY, MUTED_OPACITY, SEARCH_PATH_OPACITY } from '../src/graph/style';
import { aggregate, edge, headless, node } from './fixtures';

const AGG = 'agg:0123456789abcdef:has_subdomain:subdomain';
const QUIET_AGG = 'agg:root:ip';

/**
 *        a ──→ AGG
 *      ↙   ↘
 *     b ──→ c ──→ d ──→ e
 */
function setup() {
  const cy = headless();
  cy.add(
    toElements({
      nodes: [
        node('a', { type: 'domain', label: 'example.com', effectiveSeverity: 'critical' }),
        node('b', { label: 'api.example.com', effectiveSeverity: 'low' }),
        node('c', { label: 'dev.example.com', effectiveSeverity: 'medium' }),
        node('d', { type: 'url', label: 'https://dev.example.com/api', severity: 'critical', effectiveSeverity: 'critical' }),
        node('e', { type: 'technology', label: 'nginx', effectiveSeverity: null }),
        aggregate({ id: AGG, maxSeverity: 'high' }),
        aggregate({ id: QUIET_AGG, childType: 'ip', relation: null, parentId: null, maxSeverity: 'info' }),
      ],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('a', AGG)],
    }),
  );
  return cy;
}

const ids = (cy: Core, cls: string) =>
  cy
    .elements(`.${cls}`)
    .map((e) => e.id())
    .sort();

describe('focusNeighborhood', () => {
  const bright = (cy: Core, id: string, hops: number) =>
    focusNeighborhood(cy, id, hops)
      .map((e) => e.id())
      .sort();

  test('1 hop: the node, its direct neighbors and the edges to them', () => {
    expect(bright(setup(), 'd', 1)).toEqual(['c', 'c->d', 'd', 'd->e', 'e']);
  });

  test('2 hops follow edges in both directions, and keep edges between bright nodes', () => {
    // a and b are both 2 hops from d; the a→b edge between them stays bright too.
    expect(bright(setup(), 'd', 2)).toEqual(['a', 'a->b', 'a->c', 'b', 'b->c', 'c', 'c->d', 'd', 'd->e', 'e']);
  });

  test('3 hops reach the aggregate', () => {
    const cy = setup();
    expect(bright(cy, 'd', 3)).toContain(AGG);
    expect(bright(cy, 'd', 3)).toContain(`a->${AGG}`);
  });

  test('a node that is not on the canvas has no neighborhood', () => {
    expect(bright(setup(), 'gone', 2)).toEqual([]);
  });
});

describe('applyFocus', () => {
  test('fades everything outside the N-hop neighborhood', () => {
    const cy = setup();
    applyFocus(cy, 'd', 1);
    expect(ids(cy, FADED)).toEqual(['a', 'a->b', 'a->c', `a->${AGG}`, 'b', 'b->c', AGG, QUIET_AGG].sort());
    applyFocus(cy, 'd', 2);
    expect(ids(cy, FADED)).toEqual([`a->${AGG}`, AGG, QUIET_AGG].sort());
  });

  test('hops default to 1, matching Phase 4', () => {
    const cy = setup();
    expect(
      applyFocus(cy, 'e')
        ?.map((e) => e.id())
        .sort(),
    ).toEqual(['d', 'd->e', 'e']);
  });

  test('moving focus re-fades, and null clears it', () => {
    const cy = setup();
    applyFocus(cy, 'd', 1);
    applyFocus(cy, 'e', 1);
    expect(ids(cy, FADED)).not.toContain('e');
    expect(ids(cy, FADED)).toContain('c');
    expect(applyFocus(cy, null, 2)).toBeNull();
    expect(ids(cy, FADED)).toEqual([]);
  });

  test('focus on a node that is not on the canvas clears it', () => {
    const cy = setup();
    applyFocus(cy, 'c', 1);
    expect(applyFocus(cy, 'gone', 1)).toBeNull();
    expect(ids(cy, FADED)).toEqual([]);
  });

  test('faded elements are drawn faint and ignore the mouse', () => {
    const cy = setup();
    applyFocus(cy, 'e', 1);
    const b = cy.getElementById('b');
    expect(Number(b.style('opacity'))).toBe(FADED_OPACITY);
    expect(b.style('events')).toBe('no');
  });
});

describe('applyMute', () => {
  test('mutes nodes below medium by effective severity, and edges touching them', () => {
    const cy = setup();
    applyMute(cy, true);
    // a has no finding of its own, but sits above a critical one: it stays bright. So do c (medium) and AGG (high).
    expect(ids(cy, MUTED)).toEqual(['a->b', 'b', 'b->c', 'd->e', 'e', QUIET_AGG].sort());
  });

  test('off clears it', () => {
    const cy = setup();
    applyMute(cy, true);
    applyMute(cy, false);
    expect(ids(cy, MUTED)).toEqual([]);
  });

  test('muted nodes are faint but still clickable; focus fades them further', () => {
    const cy = setup();
    applyMute(cy, true);
    const b = cy.getElementById('b');
    expect(Number(b.style('opacity'))).toBe(MUTED_OPACITY);
    expect(b.style('events')).toBe('yes');
    applyFocus(cy, 'e', 1);
    expect(Number(b.style('opacity'))).toBe(FADED_OPACITY);
  });
});

describe('applySearchPath', () => {
  test('nodes that do not match the search are path nodes; aggregates are left alone', () => {
    const cy = setup();
    applySearchPath(cy, 'API');
    expect(ids(cy, SEARCH_PATH)).toEqual(['a', 'c', 'e']);
    expect(Number(cy.getElementById('a').style('opacity'))).toBe(SEARCH_PATH_OPACITY);
    expect(Number(cy.getElementById('b').style('opacity'))).toBe(1);
  });

  test('a new search re-marks; no search clears', () => {
    const cy = setup();
    applySearchPath(cy, 'api');
    applySearchPath(cy, 'nginx');
    expect(ids(cy, SEARCH_PATH)).toEqual(['a', 'b', 'c', 'd']);
    applySearchPath(cy, undefined);
    expect(ids(cy, SEARCH_PATH)).toEqual([]);
  });
});

describe('focus steps through groups', () => {
  const G = 'agg:000000000000000a:resolves_to:ip';
  /** p ──→ G (open) ──→ m1, m2;  m1 ──→ x */
  function grouped() {
    const cy = headless();
    cy.add(
      toElements({
        nodes: [
          node('000000000000000a'),
          aggregate({ id: G, parentId: '000000000000000a', childType: 'ip', relation: 'resolves_to', expanded: true }),
          node('m1', { type: 'ip' }),
          node('m2', { type: 'ip' }),
          node('x', { type: 'port' }),
        ],
        edges: [
          edge('000000000000000a', G, { kind: 'group', relation: 'resolves_to' }),
          edge(G, 'm1', { kind: 'member', relation: null }),
          edge(G, 'm2', { kind: 'member', relation: null }),
          edge('m1', 'x', { relation: 'has_port' }),
        ],
      }),
    );
    return cy;
  }
  const nodesOf = (cy: Core, id: string, hops: number) =>
    focusNeighborhood(cy, id, hops)
      .nodes()
      .map((n) => n.id())
      .sort();

  test('1 hop from a parent reaches the members of its groups (the group is no hop of its own)', () => {
    expect(nodesOf(grouped(), '000000000000000a', 1)).toEqual(['000000000000000a', G, 'm1', 'm2'].sort());
  });

  test('1 hop from a member reaches its group’s parent, not its siblings', () => {
    expect(nodesOf(grouped(), 'm1', 1)).toEqual(['000000000000000a', G, 'm1', 'x'].sort());
  });
});
