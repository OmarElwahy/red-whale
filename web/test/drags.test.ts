// Momentum + subtree drags together (graph/drags.ts): a press mid-glide ends the glide, then the new drag
// carries its subtree (docs/architecture.md §8).
import type { Core, NodeSingular } from 'cytoscape';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bindDrags, type Drags } from '../src/graph/drags';
import { toElements } from '../src/graph/elements';
import { fakeClock } from './clock';
import { edge, headless, node } from './fixtures';

let cy: Core;
let clock: ReturnType<typeof fakeClock>;
let tree: boolean;
let onRest: ReturnType<typeof vi.fn<(n: NodeSingular) => void>>;
let drags: Drags;

/** dom → a → a1, dom → b → b1. */
beforeEach(() => {
  cy = headless();
  cy.add(
    toElements({
      nodes: ['dom', 'a', 'a1', 'b', 'b1'].map((id) => node(id)),
      edges: [edge('dom', 'a'), edge('a', 'a1'), edge('dom', 'b'), edge('b', 'b1')],
    }),
  );
  cy.nodes().forEach((n, i) => {
    n.position({ x: i * 100, y: 0 });
  });
  clock = fakeClock();
  tree = true;
  onRest = vi.fn<(n: NodeSingular) => void>();
  drags = bindDrags(cy, {
    carriesSubtree: () => tree,
    reducedMotion: () => false,
    onRest,
    scheduler: clock.scheduler,
  });
});
afterEach(() => {
  drags.dispose();
  cy.destroy();
});

const at = (id: string) => ({ ...cy.getElementById(id).position() });

/** Throws node `id` along x (fast enough to glide) and releases it. */
function throwNode(id: string) {
  const n = cy.getElementById(id);
  n.emit('grab');
  n.emit('tapstart');
  const start = n.position().x;
  for (let t = 8; t <= 200; t += 8) {
    clock.advance(8);
    n.position({ x: start + t * 2, y: 0 });
    n.emit('drag');
  }
  n.emit('dragfree');
}

/** Presses node `id` (Cytoscape: `grab`, then `tapstart`) and moves it down by `dy`. */
function pressAndMove(id: string, dy: number) {
  const n = cy.getElementById(id);
  n.emit('grab');
  n.emit('tapstart');
  clock.advance(8);
  n.position({ x: n.position().x, y: n.position().y + dy });
  n.emit('drag');
}

describe('a press mid-glide (Tree mode)', () => {
  test('grabbing another node ends the glide, and that node carries its subtree', () => {
    throwNode('a');
    clock.frames(2);
    expect(drags.momentum.gliding).toBe(true);
    const a = at('a');
    const a1 = at('a1');
    const b1 = at('b1');

    pressAndMove('b', 150);
    expect(drags.momentum.gliding).toBe(false);
    expect(at('b1')).toEqual({ x: b1.x, y: b1.y + 150 });

    // The glide is over: neither a nor its subtree moves on.
    clock.frames(100);
    expect(at('a')).toEqual(a);
    expect(at('a1')).toEqual(a1);
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(onRest.mock.calls[0]?.[0].id()).toBe('a');
  });

  test('grabbing the gliding node itself ends the glide, and the drag carries its subtree', () => {
    throwNode('a');
    clock.frames(2);
    const a1 = at('a1');

    pressAndMove('a', 150);
    expect(drags.momentum.gliding).toBe(false);
    expect(at('a1')).toEqual({ x: a1.x, y: a1.y + 150 });
  });

  test('grabbing a node while the canvas glides carries its subtree', () => {
    cy.emit('tapstart');
    for (let t = 8; t <= 200; t += 8) {
      clock.advance(8);
      cy.pan({ x: t * 2, y: 0 });
    }
    cy.emit('tapend');
    clock.frames(2);
    expect(drags.momentum.gliding).toBe(true);
    const b1 = at('b1');

    pressAndMove('b', 150);
    expect(drags.momentum.gliding).toBe(false);
    expect(at('b1')).toEqual({ x: b1.x, y: b1.y + 150 });
  });
});

describe('Force mode', () => {
  test('no subtree follows, and the thrown node is reported at rest once', () => {
    tree = false;
    const a1 = at('a1');
    throwNode('a');
    clock.frames(1000);
    expect(at('a1')).toEqual(a1);
    expect(onRest).toHaveBeenCalledTimes(1);
  });
});
