import { describe, expect, test } from 'vitest';
import { toElements } from '../src/graph/elements';
import { bindSubtreeDrag } from '../src/graph/subtree';
import { edge, headless, node } from './fixtures';

/** dom → a → a1, dom → b; a1 is also b's child (shared). */
function setup(enabled = true) {
  const cy = headless();
  cy.add(
    toElements({
      nodes: ['dom', 'a', 'a1', 'b', 'x'].map((id) => node(id)),
      edges: [edge('dom', 'a'), edge('a', 'a1'), edge('dom', 'b'), edge('b', 'a1')],
    }),
  );
  cy.nodes().forEach((n, i) => {
    n.position({ x: i * 100, y: 0 });
  });
  const drag = bindSubtreeDrag(cy, () => enabled);
  const at = (id: string) => ({ ...cy.getElementById(id).position() });
  return { cy, drag, at };
}

describe('bindSubtreeDrag', () => {
  test('dragging a node carries its descendants; parents, siblings and strangers stay', () => {
    const { cy, at } = setup();
    const before = { dom: at('dom'), a1: at('a1'), b: at('b'), x: at('x') };
    const a = cy.getElementById('a');
    a.emit('grab');
    a.position({ x: a.position().x + 30, y: 40 });
    expect(at('a1')).toEqual({ x: before.a1.x + 30, y: 40 });
    expect(at('dom')).toEqual(before.dom);
    expect(at('b')).toEqual(before.b);
    expect(at('x')).toEqual(before.x);
    cy.destroy();
  });

  test('it keeps following through a glide (plain position changes) until end()', () => {
    const { cy, drag, at } = setup();
    const a = cy.getElementById('a');
    a.emit('grab');
    a.shift({ x: 10, y: 0 });
    a.shift({ x: 10, y: 0 });
    const a1 = at('a1');
    drag.end();
    a.shift({ x: 10, y: 0 });
    expect(at('a1')).toEqual(a1);
    cy.destroy();
  });

  test('a shared child goes with whichever parent is dragged', () => {
    const { cy, at } = setup();
    const a1 = at('a1');
    const b = cy.getElementById('b');
    b.emit('grab');
    b.shift({ x: 0, y: 25 });
    expect(at('a1')).toEqual({ x: a1.x, y: a1.y + 25 });
    cy.destroy();
  });

  test('off in Force mode', () => {
    const { cy, at } = setup(false);
    const a1 = at('a1');
    const a = cy.getElementById('a');
    a.emit('grab');
    a.shift({ x: 50, y: 50 });
    expect(at('a1')).toEqual(a1);
    cy.destroy();
  });
});
