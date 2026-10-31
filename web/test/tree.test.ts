import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, test } from 'vitest';
import { toElements } from '../src/graph/elements';
import {
  compareSiblings,
  layoutTree,
  treeGraph,
  treeInput,
  treeOrder,
  type TreeEdge,
  type TreeEngine,
  type TreeInput,
  type TreeNode,
} from '../src/graph/tree';
import type { SeverityKey } from '../src/graph/elements';
import { aggregate, edge, headless, node } from './fixtures';

const elk = new ELK();
const engine: TreeEngine = (g) => elk.layout(g);

const n = (id: string, risk: SeverityKey = 'none', label = id): TreeNode => ({
  id,
  width: 40,
  height: 30,
  offset: { x: 0, y: -6 },
  risk,
  label,
});
const e = (source: string, target: string): TreeEdge => ({ id: `${source}>${target}`, source, target });

/** domain → three subdomains; two of them resolve to one shared IP; one subdomain has a critical URL. */
function sample(): TreeInput {
  return {
    nodes: [
      n('dom'),
      n('s-api', 'none', 'api'),
      n('s-app', 'none', 'app'),
      n('s-www', 'critical', 'www'),
      n('ip-shared'),
      n('url-www', 'critical'),
      n('p443'),
    ],
    edges: [
      e('dom', 's-app'),
      e('dom', 's-api'),
      e('dom', 's-www'),
      e('s-api', 'ip-shared'),
      e('s-app', 'ip-shared'),
      e('ip-shared', 'p443'),
      e('s-www', 'url-www'),
    ],
  };
}

describe('treeOrder', () => {
  test('depth-first from the root, siblings riskiest first then by label; a shared node once', () => {
    expect(treeOrder(sample()).map((x) => x.id)).toEqual([
      'dom', 's-www', 'url-www', 's-api', 'ip-shared', 'p443', 's-app',
    ]);
  });

  test('does not depend on input order', () => {
    const a = sample();
    const b = { nodes: [...a.nodes].reverse(), edges: [...a.edges].reverse() };
    expect(treeOrder(b).map((x) => x.id)).toEqual(treeOrder(a).map((x) => x.id));
  });

  test('every node appears once, even in a cycle with no root', () => {
    const input = { nodes: [n('a'), n('b'), n('c', 'high')], edges: [e('a', 'b'), e('b', 'a'), e('a', 'c')] };
    expect(treeOrder(input).map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('several roots (a node only named as a parent is a root too), riskiest root first', () => {
    const input = { nodes: [n('dom'), n('legacy', 'none', 'legacy'), n('x', 'high')], edges: [e('dom', 'x')] };
    expect(treeOrder(input).map((x) => x.id)).toEqual(['dom', 'x', 'legacy']);
  });

  test('equal risk and label fall back to the id', () => {
    expect(compareSiblings(n('b', 'low', 'same'), n('a', 'low', 'same'))).toBeGreaterThan(0);
  });
});

describe('treeGraph', () => {
  test('nodes in model order with their sizes; edges follow the same order; dangling edges dropped', () => {
    const input = sample();
    input.edges.push(e('dom', 'not-on-canvas'));
    const g = treeGraph(input);
    expect(g.children?.map((c) => c.id)).toEqual(treeOrder(input).map((x) => x.id));
    expect(g.children?.[0]).toEqual({ id: 'dom', width: 40, height: 30 });
    expect(g.edges?.map((x) => x.id)).not.toContain('dom>not-on-canvas');
    expect(g.edges?.[0]?.id).toBe('dom>s-www');
    expect(g.layoutOptions?.['elk.direction']).toBe('DOWN');
  });
});

describe('layoutTree (real ELK)', () => {
  test('top-down: every child sits below each of its parents, shared IP included', async () => {
    const input = sample();
    const pos = await layoutTree(input, engine);
    expect(pos.size).toBe(input.nodes.length);
    for (const edgeIn of input.edges) {
      expect(pos.get(edgeIn.target)?.y, edgeIn.id).toBeGreaterThan(pos.get(edgeIn.source)?.y ?? Infinity);
    }
  });

  test('siblings left to right, riskiest first', async () => {
    const pos = await layoutTree(sample(), engine);
    const xs = ['s-www', 's-api', 's-app'].map((id) => pos.get(id)?.x ?? NaN);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  test('applies the label offset: positions are node centers, not box centers', async () => {
    const input = { nodes: [n('only')], edges: [] };
    const pos = await layoutTree(input, engine);
    const [g] = [treeGraph(input)];
    const laid = await engine(g);
    const box = laid.children?.[0];
    expect(pos.get('only')).toEqual({ x: (box?.x ?? 0) + 20, y: (box?.y ?? 0) + 15 - 6 });
  });

  test('the same input lays out the same way every time', async () => {
    const a = await layoutTree(sample(), engine);
    const b = await layoutTree(sample(), engine);
    expect([...b]).toEqual([...a]);
  });

  test('every root is on the top row, a parent-only node included', async () => {
    const input = sample();
    input.nodes.push(n('legacy'), n('ip-legacy'));
    input.edges.push(e('legacy', 'ip-legacy'));
    const pos = await layoutTree(input, engine);
    expect(pos.get('legacy')?.y).toBe(pos.get('dom')?.y);
  });

  test('a cycle does not throw', async () => {
    const input = { nodes: [n('a'), n('b')], edges: [e('a', 'b'), e('b', 'a')] };
    expect((await layoutTree(input, engine)).size).toBe(2);
  });

  test('an empty canvas needs no engine', async () => {
    const never: TreeEngine = () => Promise.reject(new Error('called'));
    expect((await layoutTree({ nodes: [], edges: [] }, never)).size).toBe(0);
  });
});

describe('treeInput', () => {
  test('reads nodes, aggregates (by their highest member) and edges from the canvas', () => {
    const cy = headless();
    const AGG = 'agg:aaaaaaaaaaaaaaaa:has_subdomain:subdomain';
    cy.add(
      toElements({
        nodes: [
          node('a', { type: 'domain', effectiveSeverity: 'high' }),
          node('b'),
          aggregate({ id: AGG, maxSeverity: 'critical' }),
        ],
        edges: [edge('a', 'b'), edge('a', AGG)],
      }),
    );
    const input = treeInput(cy);
    expect(input.nodes.map((x) => [x.id, x.risk])).toEqual([
      ['a', 'high'],
      ['b', 'none'],
      [AGG, 'critical'],
    ]);
    expect(input.edges.map((x) => [x.source, x.target])).toEqual([
      ['a', 'b'],
      ['a', AGG],
    ]);
    for (const x of input.nodes) expect(x.width).toBeGreaterThanOrEqual(30);
    cy.destroy();
  });
});
