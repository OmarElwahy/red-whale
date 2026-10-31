import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import ELK from 'elkjs/lib/elk.bundled.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyDiff, byId, diffElements } from '../src/graph/diff';
import { toElements, type Element } from '../src/graph/elements';
import { LayoutModes, treeChanged } from '../src/graph/modes';
import type { TreeEngine } from '../src/graph/tree';
import { edge, headless, node } from './fixtures';

cytoscape.use(fcose);

const elk = new ELK();
const engine: TreeEngine = (g) => elk.layout(g);

const GRAPH = {
  nodes: [node('dom', { type: 'domain' }), node('a'), node('b'), node('ip', { type: 'ip' })],
  edges: [edge('dom', 'a'), edge('dom', 'b'), edge('a', 'ip', { relation: 'resolves_to' }), edge('b', 'ip', { relation: 'resolves_to' })],
};

let cy: Core;
afterEach(() => {
  cy.destroy();
});

/** A canvas with GRAPH on it, each node at a known Force position. */
function setup(over: { engine?: TreeEngine } = {}) {
  cy = headless();
  let applied = new Map<string, Element>();
  const apply = (next: Element[]) => {
    const diff = diffElements(applied, next);
    const previous = applied;
    applyDiff(cy, diff);
    applied = byId(next);
    return { diff, previous };
  };
  apply(toElements(GRAPH));
  const force = { dom: { x: 500, y: 500 }, a: { x: 300, y: 650 }, b: { x: 700, y: 650 }, ip: { x: 500, y: 800 } };
  for (const [id, p] of Object.entries(force)) cy.getElementById(id).position(p);
  const stopMotion = vi.fn<() => void>();
  const pinned = new Set<string>();
  const modes = new LayoutModes(cy, {
    initial: 'force',
    engine: () => over.engine ?? engine,
    stopMotion,
    duration: () => 0,
    pinned,
  });
  const at = (id: string) => ({ ...cy.getElementById(id).position() });
  return { modes, apply, force, stopMotion, pinned, at };
}

describe('LayoutModes', () => {
  test('Tree: a top-down hierarchy, the shared IP below both parents; positions are not saved', async () => {
    const { modes, at, stopMotion } = setup();
    expect(modes.savesPositions).toBe(true);
    await modes.switchTo('tree', new Map());
    expect(modes.mode).toBe('tree');
    expect(modes.savesPositions).toBe(false);
    expect(stopMotion).toHaveBeenCalled();
    expect(at('a').y).toBeGreaterThan(at('dom').y);
    expect(at('b').y).toBeGreaterThan(at('dom').y);
    expect(at('ip').y).toBeGreaterThan(Math.max(at('a').y, at('b').y));
  });

  test('back to Force restores every Force position exactly', async () => {
    const { modes, at, force } = setup();
    await modes.switchTo('tree', new Map());
    cy.getElementById('a').position({ x: -999, y: -999 }); // dragged in Tree mode
    await modes.switchTo('force', new Map());
    for (const [id, p] of Object.entries(force)) expect(at(id)).toEqual(p);
  });

  test('switching fits the view to the new layout', async () => {
    const { modes } = setup();
    cy.viewport({ zoom: 0.1, pan: { x: 5000, y: 5000 } });
    await modes.switchTo('tree', new Map());
    const extent = cy.extent();
    const bb = cy.nodes().boundingBox();
    expect(extent.x1).toBeLessThanOrEqual(bb.x1);
    expect(extent.x2).toBeGreaterThanOrEqual(bb.x2);
  });

  test('a node added in Tree mode re-runs the tree; back in Force it gets a place, the rest are restored', async () => {
    const { modes, apply, at, force } = setup();
    await modes.switchTo('tree', new Map());
    const next = toElements({
      nodes: [...GRAPH.nodes, node('url', { type: 'url', value: 'https://a.example.com/' })],
      edges: [...GRAPH.edges, edge('a', 'url', { relation: 'serves' })],
    });
    const { diff, previous } = apply(next);
    await modes.afterDiff(diff, previous);
    expect(at('url').y).toBeGreaterThan(at('a').y);

    await modes.switchTo('force', new Map());
    for (const [id, p] of Object.entries(force)) expect(at(id)).toEqual(p);
    expect(Number.isFinite(at('url').x)).toBe(true);
  });

  test('back to Force with no snapshot (opened in Tree mode) uses saved positions', async () => {
    cy = headless();
    applyDiff(cy, diffElements(new Map(), toElements(GRAPH)));
    const modes = new LayoutModes(cy, {
      initial: 'tree',
      engine: () => engine,
      stopMotion: () => undefined,
      duration: () => 0,
      pinned: new Set(['dom', 'a', 'b', 'ip']),
    });
    const saved = new Map([
      ['dom', { x: 1, y: 2 }],
      ['a', { x: 3, y: 4 }],
      ['b', { x: 5, y: 6 }],
      ['ip', { x: 7, y: 8 }],
    ]);
    await modes.switchTo('force', saved);
    expect(cy.getElementById('b').position()).toEqual({ x: 5, y: 6 });
  });

  test('a tree result that lands after switching back to Force is dropped', async () => {
    let release: () => void = () => undefined;
    const slow: TreeEngine = (g) =>
      new Promise((resolve) => {
        release = () => {
          void elk.layout(g).then(resolve);
        };
      });
    const { modes, at, force } = setup({ engine: slow });
    const pending = modes.switchTo('tree', new Map());
    await modes.switchTo('force', new Map());
    release();
    await pending;
    for (const [id, p] of Object.entries(force)) expect(at(id)).toEqual(p);
  });

  test('only the latest of two overlapping tree runs lands', async () => {
    const order: string[] = [];
    let first = true;
    const racing: TreeEngine = async (g) => {
      const mine = first ? 'first' : 'second';
      first = false;
      const out = await elk.layout(g);
      if (mine === 'first') {
        await new Promise((r) => setTimeout(r, 30));
        // Recognizable if it ever lands.
        for (const c of out.children ?? []) c.x = (c.x ?? 0) + 100_000;
      }
      order.push(mine);
      return out;
    };
    const { modes, at } = setup({ engine: racing });
    const one = modes.switchTo('tree', new Map());
    const two = modes.runTree(false);
    await Promise.all([one, two]);
    expect(order).toEqual(['second', 'first']);
    expect(at('a').x).toBeLessThan(50_000);
  });

  test('reports busy while a tree layout runs, and not busy once it lands or Force takes over', async () => {
    cy = headless();
    applyDiff(cy, diffElements(new Map(), toElements(GRAPH)));
    const busy: boolean[] = [];
    const modes = new LayoutModes(cy, {
      initial: 'force',
      engine: () => engine,
      stopMotion: () => undefined,
      duration: () => 0,
      pinned: new Set(),
      onBusy: (b) => busy.push(b),
    });
    await modes.switchTo('tree', new Map());
    expect(busy).toEqual([true, false]);
    const pending = modes.runTree(false);
    await modes.switchTo('force', new Map());
    await pending;
    expect(busy).toEqual([true, false, true, false]);
  });

  test('Force mode diffs place only new nodes; nothing on the canvas moves', async () => {
    const { modes, apply, at, force } = setup();
    const next = toElements({
      nodes: [...GRAPH.nodes, node('c')],
      edges: [...GRAPH.edges, edge('dom', 'c')],
    });
    const { diff, previous } = apply(next);
    await modes.afterDiff(diff, previous);
    for (const [id, p] of Object.entries(force)) expect(at(id)).toEqual(p);
  });
});

describe('treeChanged', () => {
  const base = toElements(GRAPH);
  const map = byId(base);
  const changed = (mutate: (els: Element[]) => Element[]) => treeChanged(diffElements(map, mutate(base)), map);

  test('a tag change does not move the tree', () => {
    expect(
      changed((els) =>
        els.map((el) => (el.data.id === 'a' && el.group === 'nodes' ? { ...el, data: { ...el.data, tag: 'checked' } } : el)),
      ),
    ).toBe(false);
  });

  test('a severity change can reorder siblings: it does', () => {
    expect(
      changed((els) =>
        els.map((el) =>
          el.data.id === 'a' && el.group === 'nodes' ? { ...el, data: { ...el.data, effectiveSeverity: 'high' } } : el,
        ),
      ),
    ).toBe(true);
  });

  test('added or removed elements do', () => {
    expect(changed((els) => els.filter((el) => el.data.id !== 'b'))).toBe(true);
  });
});
