import { describe, expect, test } from 'vitest';
import { RETIRING, applyDiff, byId, diffElements, emptyDiff } from '../src/graph/diff';
import { toElements, type Element } from '../src/graph/elements';
import { aggregate, edge, headless, node } from './fixtures';

const base = () =>
  toElements({
    nodes: [node('a', { type: 'domain' }), node('b'), node('c')],
    edges: [edge('a', 'b'), edge('a', 'c')],
  });
const ids = (els: readonly { data: { id: string } }[]) => els.map((e) => e.data.id).sort();

describe('diffElements', () => {
  test('everything is an add on an empty canvas, nodes and edges separately', () => {
    const d = diffElements(new Map(), base());
    expect(ids(d.add.nodes)).toEqual(['a', 'b', 'c']);
    expect(ids(d.add.edges)).toEqual(['a->b', 'a->c']);
    expect(d.remove).toEqual([]);
    expect(d.update).toEqual([]);
  });

  test('the same elements again is an empty diff', () => {
    const d = diffElements(byId(base()), base());
    expect(emptyDiff(d)).toBe(true);
  });

  test('add, remove and update are found by id', () => {
    const next = toElements({
      nodes: [node('a', { type: 'domain' }), node('b', { severity: 'high' }), node('d')],
      edges: [edge('a', 'b'), edge('a', 'd')],
    });
    const d = diffElements(byId(base()), next);
    expect(ids(d.add.nodes)).toEqual(['d']);
    expect(ids(d.add.edges)).toEqual(['a->d']);
    expect([...d.remove].sort()).toEqual(['a->c', 'c']);
    expect(ids(d.update)).toEqual(['b']);
  });

  test('a changed tag or confidence is an update', () => {
    const next = toElements({
      nodes: [node('a', { type: 'domain', tag: 'interesting' }), node('b', { confidence: 'verified' }), node('c')],
      edges: [edge('a', 'b'), edge('a', 'c')],
    });
    expect(ids(diffElements(byId(base()), next).update)).toEqual(['a', 'b']);
  });

  test('a changed saved position alone is not an update (the canvas keeps what the analyst did)', () => {
    const next = toElements({
      nodes: [node('a', { type: 'domain', posX: 10, posY: 20 }), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('a', 'c')],
    });
    expect(emptyDiff(diffElements(byId(base()), next))).toBe(true);
  });

  test('an edge whose endpoints changed is replaced, not updated', () => {
    const current = byId(base());
    const next = base().map((el): Element =>
      el.group === 'edges' && el.data.id === 'a->c' ? { ...el, data: { ...el.data, source: 'b' } } : el,
    );
    const d = diffElements(current, next);
    expect(d.remove).toEqual(['a->c']);
    expect(ids(d.add.edges)).toEqual(['a->c']);
    expect(d.update).toEqual([]);
  });

  test('duplicate ids in the input are added once', () => {
    const els = base();
    const d = diffElements(new Map(), [...els, ...els]);
    expect(d.add.nodes).toHaveLength(3);
    expect(d.add.edges).toHaveLength(2);
  });
});

describe('applyDiff on a Cytoscape instance', () => {
  function load(els: Element[]) {
    const cy = headless();
    applyDiff(cy, diffElements(new Map(), els));
    return cy;
  }

  test('loads the elements', () => {
    const cy = load(base());
    expect(cy.nodes().map((n) => n.id()).sort()).toEqual(['a', 'b', 'c']);
    expect(cy.edges().map((e) => e.id()).sort()).toEqual(['a->b', 'a->c']);
  });

  test('unchanged elements are the same objects afterwards (no rebuild), and keep their position', () => {
    const cy = load(base());
    const a = cy.getElementById('a');
    const ab = cy.getElementById('a->b');
    a.position({ x: 123, y: 456 });

    const next = toElements({
      nodes: [node('a', { type: 'domain' }), node('b'), node('c'), node('d')],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('a', 'd')],
    });
    applyDiff(cy, diffElements(byId(base()), next));

    expect(cy.getElementById('a').same(a)).toBe(true);
    expect(cy.getElementById('a->b').same(ab)).toBe(true);
    expect(cy.getElementById('a').position()).toEqual({ x: 123, y: 456 });
    expect(cy.nodes()).toHaveLength(4);
    expect(cy.edges()).toHaveLength(3);
  });

  test('an update changes data in place and keeps the position', () => {
    const cy = load(base());
    const b = cy.getElementById('b');
    b.position({ x: 5, y: 6 });
    const next = toElements({
      nodes: [node('a', { type: 'domain' }), node('b', { severity: 'critical', tag: 'ignored' }), node('c')],
      edges: [edge('a', 'b'), edge('a', 'c')],
    });
    applyDiff(cy, diffElements(byId(base()), next));
    expect(cy.getElementById('b').same(b)).toBe(true);
    expect(b.data('severity')).toBe('critical');
    expect(b.data('tag')).toBe('ignored');
    expect(b.position()).toEqual({ x: 5, y: 6 });
  });

  test('removing a node removes it and its edges; applying the same diff state twice adds nothing', () => {
    const cy = load(base());
    const next = toElements({ nodes: [node('a', { type: 'domain' }), node('b')], edges: [edge('a', 'b')] });
    applyDiff(cy, diffElements(byId(base()), next));
    expect(cy.nodes().map((n) => n.id()).sort()).toEqual(['a', 'b']);
    expect(cy.edges().map((e) => e.id())).toEqual(['a->b']);

    applyDiff(cy, diffElements(byId(next), next));
    expect(cy.elements()).toHaveLength(3);
  });

  test('new nodes get a saved position when the server has one', () => {
    const cy = load(toElements({ nodes: [node('a', { posX: 40, posY: -8 })], edges: [] }));
    expect(cy.getElementById('a').position()).toEqual({ x: 40, y: -8 });
  });
});

describe('collapsing: members slide into their group', () => {
  const G = 'agg:000000000000000a:resolves_to:ip';
  const withMembers = (): Element[] =>
    toElements({
      nodes: [node('a'), aggregate({ id: G, expanded: true }), node('m1'), node('m2')],
      edges: [edge('a', G, { kind: 'group' }), edge(G, 'm1', { kind: 'member', relation: null }), edge(G, 'm2', { kind: 'member', relation: null })],
    });
  const collapsed = (): Element[] =>
    toElements({ nodes: [node('a'), aggregate({ id: G })], edges: [edge('a', G, { kind: 'group' })] });

  test('with a duration, members lose their edges at once, then slide to the group and go', async () => {
    const cy = headless();
    applyDiff(cy, diffElements(new Map(), withMembers()));
    cy.getElementById(G).position({ x: 50, y: 60 });
    applyDiff(cy, diffElements(byId(withMembers()), collapsed()), { into: G, nodes: new Set(['m1', 'm2']), duration: 20 });
    expect(cy.getElementById('m1').hasClass(RETIRING)).toBe(true);
    expect(cy.edges().map((e) => e.id())).toEqual([`a->${G}`]);
    await new Promise((r) => setTimeout(r, 80));
    expect(cy.getElementById('m1').empty()).toBe(true);
    expect(cy.nodes().map((n) => n.id()).sort()).toEqual(['a', G].sort());
  });

  test('a layout that stops every node animation mid-slide (Tree re-run) does not leave them behind', async () => {
    const cy = headless();
    applyDiff(cy, diffElements(new Map(), withMembers()));
    applyDiff(cy, diffElements(byId(withMembers()), collapsed()), { into: G, nodes: new Set(['m1', 'm2']), duration: 20 });
    // What animateTo / a subtree drag used to do: stop without completing, so `complete` never runs.
    cy.nodes().stop(true, false);
    await new Promise((r) => setTimeout(r, 200));
    expect(cy.nodes().map((n) => n.id()).sort()).toEqual(['a', G].sort());
  });

  test('a node still sliding when the next update arrives is removed then', () => {
    const cy = headless();
    applyDiff(cy, diffElements(new Map(), withMembers()));
    applyDiff(cy, diffElements(byId(withMembers()), collapsed()), { into: G, nodes: new Set(['m1', 'm2']), duration: 10_000 });
    expect(cy.nodes(`.${RETIRING}`).length).toBe(2);
    const later = toElements({ nodes: [node('a'), aggregate({ id: G, count: 413 })], edges: [edge('a', G, { kind: 'group' })] });
    applyDiff(cy, diffElements(byId(collapsed()), later));
    expect(cy.nodes().map((n) => n.id()).sort()).toEqual(['a', G].sort());
  });

  test('without a duration (reduced motion) they go at once', () => {
    const cy = headless();
    applyDiff(cy, diffElements(new Map(), withMembers()));
    applyDiff(cy, diffElements(byId(withMembers()), collapsed()), { into: G, nodes: new Set(['m1', 'm2']), duration: 0 });
    expect(cy.getElementById('m1').empty()).toBe(true);
  });

  test('a member that comes straight back while sliding is added again cleanly', () => {
    const cy = headless();
    applyDiff(cy, diffElements(new Map(), withMembers()));
    applyDiff(cy, diffElements(byId(withMembers()), collapsed()), { into: G, nodes: new Set(['m1', 'm2']), duration: 1000 });
    applyDiff(cy, diffElements(byId(collapsed()), withMembers()));
    expect(cy.getElementById('m1').hasClass(RETIRING)).toBe(false);
    expect(cy.getElementById('m1').edgesWith(cy.getElementById(G)).length).toBe(1);
  });
});
