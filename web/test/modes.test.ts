import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import ELK from 'elkjs/lib/elk.bundled.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyDiff, byId, diffElements } from '../src/graph/diff';
import { toElements, type Element } from '../src/graph/elements';
import { LayoutModes, growOrigins, treeChanged } from '../src/graph/modes';
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

describe('Tree re-runs keep what the analyst is looking at in place', () => {
  const more = () =>
    toElements({
      nodes: [...GRAPH.nodes, node('c'), node('d'), node('e')],
      edges: [...GRAPH.edges, edge('dom', 'c'), edge('dom', 'd'), edge('dom', 'e')],
    });

  test('the node that was expanded or collapsed stays exactly where it was', async () => {
    const { modes, apply, at } = setup();
    await modes.switchTo('tree', new Map());
    const before = at('a');
    const { diff, previous } = apply(more());
    await modes.afterDiff(diff, previous, 'a');
    expect(at('a')).toEqual(before);
    // The rest of the tree did re-flow around it.
    expect(at('dom')).not.toEqual(before);
  });

  test('with no anchor (a live update), the node nearest the middle of the view stays put', async () => {
    const { modes, apply, at } = setup();
    await modes.switchTo('tree', new Map());
    const zoom = cy.zoom();
    const pan = cy.pan();
    const mid = { x: (cy.width() / 2 - pan.x) / zoom, y: (cy.height() / 2 - pan.y) / zoom };
    const ids = ['dom', 'a', 'b', 'ip'];
    const nearest = ids.reduce((best, id) =>
      Math.hypot(at(id).x - mid.x, at(id).y - mid.y) < Math.hypot(at(best).x - mid.x, at(best).y - mid.y) ? id : best,
    );
    const before = at(nearest);
    const { diff, previous } = apply(more());
    await modes.afterDiff(diff, previous);
    expect(at(nearest)).toEqual(before);
  });

  test('Re-layout still snaps to the clean tree and fits', async () => {
    const { modes } = setup();
    await modes.switchTo('tree', new Map());
    cy.zoom(3);
    await modes.runTree(true);
    expect(cy.zoom()).not.toBe(3);
  });
});

describe('growing out of the opened node', () => {
  test('every new node comes from its nearest ancestor that was already on the canvas, through chains of new ones', () => {
    cy = headless();
    applyDiff(cy, diffElements(new Map(), toElements({ nodes: [node('g', { type: 'domain' })], edges: [] })));
    cy.getElementById('g').position({ x: 40, y: 60 });
    const next = toElements({
      nodes: [node('g', { type: 'domain' }), node('m'), node('ip', { type: 'ip' }), node('root', { type: 'ip' })],
      edges: [edge('g', 'm'), edge('m', 'ip', { relation: 'resolves_to' })],
    });
    applyDiff(cy, diffElements(byId(toElements({ nodes: [node('g', { type: 'domain' })], edges: [] })), next));
    const origins = growOrigins(cy, ['m', 'ip', 'root']);
    expect(origins.get('m')).toEqual({ x: 40, y: 60 });
    expect(origins.get('ip')).toEqual({ x: 40, y: 60 });
    // Nothing above it on the canvas: it appears where it is.
    expect(origins.has('root')).toBe(false);
  });

  test('Force: new nodes start at the opened node and glide to their place; centering uses where they stop', async () => {
    cy = headless();
    let applied = new Map<string, Element>();
    const apply = (els: Element[]) => {
      const diff = diffElements(applied, els);
      const previous = applied;
      applyDiff(cy, diff);
      applied = byId(els);
      return { diff, previous };
    };
    apply(toElements({ nodes: [node('dom', { type: 'domain' })], edges: [] }));
    cy.getElementById('dom').position({ x: 500, y: 500 });
    const modes = new LayoutModes(cy, { initial: 'force', engine: () => engine, stopMotion: vi.fn(), duration: () => 40, pinned: new Set() });
    const { diff, previous } = apply(
      toElements({ nodes: [node('dom', { type: 'domain' }), node('a'), node('b')], edges: [edge('dom', 'a'), edge('dom', 'b')] }),
    );
    await modes.afterDiff(diff, previous);
    expect(cy.getElementById('a').position()).toEqual({ x: 500, y: 500 });
    const target = modes.growTarget('a');
    expect(target).toBeDefined();
    expect(Math.hypot((target?.x ?? 500) - 500, (target?.y ?? 500) - 500)).toBeGreaterThan(20);
    await new Promise((r) => setTimeout(r, 200));
    expect(cy.getElementById('a').position()).toEqual(target);
    expect(modes.growTarget('a')).toBeUndefined();
  });

  test('with reduced motion they are simply in place', async () => {
    const { modes, apply } = setup();
    const { diff, previous } = apply(toElements({ nodes: [...GRAPH.nodes, node('c')], edges: [...GRAPH.edges, edge('dom', 'c')] }));
    await modes.afterDiff(diff, previous);
    expect(modes.growTarget('c')).toBeUndefined();
    expect(cy.getElementById('c').position()).not.toEqual({ x: 500, y: 500 });
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

describe('Tree: nodes the analyst dropped stay where they were dropped', () => {
  /** A subtree drag (graph/subtree.ts) followed by the drop: `id` and everything below it move by `by`. */
  const drop = (modes: LayoutModes, id: string, by: { x: number; y: number }) => {
    const n = cy.getElementById(id);
    n.union(n.successors().nodes()).shift(by);
    modes.noteTreeDrop(id);
    return { ...n.position() };
  };
  const withUrl = (parent: string, extra: ReturnType<typeof node>[] = []) =>
    toElements({
      nodes: [...GRAPH.nodes, node('url', { type: 'url', value: 'https://a.example.com/' }), ...extra],
      edges: [...GRAPH.edges, edge(parent, 'url', { relation: 'serves' }), ...extra.map((n) => edge('dom', n.id))],
    });

  test('a live update re-runs the tree; the dropped node stays put and its new child appears under it', async () => {
    const { modes, apply, at } = setup();
    await modes.switchTo('tree', new Map());
    const dropped = drop(modes, 'a', { x: 400, y: 250 });
    const { diff, previous } = apply(withUrl('a', [node('c'), node('d')]));
    await modes.afterDiff(diff, previous);
    expect(at('a')).toEqual(dropped);
    expect(at('url').y).toBeGreaterThan(at('a').y);
    expect(Math.abs(at('url').x - at('a').x)).toBeLessThan(200);
  });

  test('a dropped node inside a dropped subtree keeps its own place too', async () => {
    const { modes, apply, at } = setup();
    await modes.switchTo('tree', new Map());
    const a = drop(modes, 'a', { x: 400, y: 0 });
    const ip = drop(modes, 'ip', { x: 0, y: 300 });
    const { diff, previous } = apply(withUrl('b'));
    await modes.afterDiff(diff, previous);
    expect(at('a')).toEqual(a);
    expect(at('ip')).toEqual(ip);
  });

  test('dragging a parent carries the drops below it', async () => {
    const { modes, apply, at } = setup();
    await modes.switchTo('tree', new Map());
    drop(modes, 'ip', { x: 0, y: 300 });
    drop(modes, 'a', { x: -250, y: 100 }); // ip comes along
    const ip = at('ip');
    const { diff, previous } = apply(withUrl('b'));
    await modes.afterDiff(diff, previous);
    expect(at('ip')).toEqual(ip);
  });

  test('Re-layout forgets every drop: back to the clean tree', async () => {
    const { modes, at } = setup();
    await modes.switchTo('tree', new Map());
    const clean = { x: at('a').x - at('dom').x, y: at('a').y - at('dom').y };
    drop(modes, 'a', { x: 400, y: 250 });
    await modes.relayout();
    expect(at('a').x - at('dom').x).toBeCloseTo(clean.x, 6);
    expect(at('a').y - at('dom').y).toBeCloseTo(clean.y, 6);
  });

  test('Force and back: the drop is kept where it was relative to the tree', async () => {
    const { modes, at } = setup();
    await modes.switchTo('tree', new Map());
    drop(modes, 'a', { x: 400, y: 250 });
    const rel = { x: at('a').x - at('dom').x, y: at('a').y - at('dom').y };
    await modes.switchTo('force', new Map());
    await modes.switchTo('tree', new Map());
    expect(at('a').x - at('dom').x).toBeCloseTo(rel.x, 6);
    expect(at('a').y - at('dom').y).toBeCloseTo(rel.y, 6);
  });

  test('Force mode: a drop is not a tree drop', async () => {
    const { modes, apply, at } = setup();
    drop(modes, 'a', { x: 400, y: 250 });
    await modes.switchTo('tree', new Map());
    const { diff, previous } = apply(withUrl('a'));
    await modes.afterDiff(diff, previous);
    expect(at('a').y).toBeGreaterThan(at('dom').y);
    expect(at('a').y).toBeLessThan(at('url').y);
  });
});
