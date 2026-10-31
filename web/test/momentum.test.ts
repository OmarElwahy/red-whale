import type { Core, NodeSingular } from 'cytoscape';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { toElements } from '../src/graph/elements';
import { bindMomentum, type Momentum } from '../src/graph/momentum';
import { fakeClock } from './clock';
import { edge, headless, node } from './fixtures';

let cy: Core;
let clock: ReturnType<typeof fakeClock>;
let reduced: boolean;
let onRest: ReturnType<typeof vi.fn<(n: NodeSingular) => void>>;
let momentum: Momentum;

beforeEach(() => {
  cy = headless();
  cy.add(toElements({ nodes: [node('a'), node('b')], edges: [edge('a', 'b')] }));
  cy.getElementById('a').position({ x: 0, y: 0 });
  cy.getElementById('b').position({ x: 100, y: 0 });
  clock = fakeClock();
  reduced = false;
  onRest = vi.fn<(n: NodeSingular) => void>();
  momentum = bindMomentum(cy, { reducedMotion: () => reduced, onRest, scheduler: clock.scheduler });
});
afterEach(() => {
  momentum.dispose();
  cy.destroy();
});

/** A background drag: `pxPerMs` along x for `ms`, sampled every 8 ms, then (optionally) a pause, then release. */
function panGesture(pxPerMs: number, ms = 200, pauseMs = 0) {
  cy.emit('tapstart');
  const start = cy.pan().x;
  for (let t = 8; t <= ms; t += 8) {
    clock.advance(8);
    cy.pan({ x: start + t * pxPerMs, y: 0 });
  }
  clock.advance(pauseMs);
  cy.emit('tapend');
}

/** Drags node `id` along x at `pxPerMs` (model units; zoom is 1) and releases it. */
function nodeGesture(id: string, pxPerMs: number, ms = 200, pauseMs = 0) {
  const n = cy.getElementById(id);
  n.emit('grab');
  n.emit('tapstart');
  const start = n.position().x;
  for (let t = 8; t <= ms; t += 8) {
    clock.advance(8);
    n.position({ x: start + t * pxPerMs, y: 0 });
    n.emit('drag');
  }
  clock.advance(pauseMs);
  n.emit('dragfree');
  return n;
}

describe('pan momentum', () => {
  test('a fast pan keeps gliding the same way after release, slows down, and stops', () => {
    panGesture(2);
    const released = cy.pan().x;
    expect(momentum.gliding).toBe(true);
    clock.frames(1);
    const first = cy.pan().x - released;
    expect(first).toBeGreaterThan(0);
    clock.frames(1);
    const second = cy.pan().x - released - first;
    expect(second).toBeLessThan(first);
    clock.frames(1000);
    expect(momentum.gliding).toBe(false);
    expect(clock.pending).toBe(0);
  });

  test('a slow pan does not glide', () => {
    panGesture(0.05, 1000);
    expect(momentum.gliding).toBe(false);
  });

  test('a fast pan that ends in a pause does not glide', () => {
    panGesture(2, 200, 120);
    expect(momentum.gliding).toBe(false);
  });

  test('a new press stops the glide at once', () => {
    panGesture(2);
    clock.frames(2);
    const at = cy.pan().x;
    cy.emit('tapstart');
    clock.frames(10);
    expect(cy.pan().x).toBe(at);
    expect(momentum.gliding).toBe(false);
  });

  test('stop() ends it (a wheel or a programmatic animation)', () => {
    panGesture(2);
    momentum.stop();
    expect(momentum.gliding).toBe(false);
    expect(clock.pending).toBe(0);
  });

  test('reduced motion: no glide', () => {
    reduced = true;
    panGesture(2);
    expect(momentum.gliding).toBe(false);
  });
});

describe('node momentum', () => {
  test('a thrown node slides on and reports its resting position once, after it stops', () => {
    const n = nodeGesture('a', 2);
    const released = n.position().x;
    expect(onRest).not.toHaveBeenCalled();
    clock.frames(1000);
    expect(n.position().x).toBeGreaterThan(released);
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(onRest.mock.calls[0]?.[0].id()).toBe('a');
  });

  test('a careful drop reports at once, where it was dropped', () => {
    const n = nodeGesture('a', 0.05, 1000);
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(n.position().x).toBeCloseTo(50);
    expect(momentum.gliding).toBe(false);
  });

  test('a drag that ends in a pause does not fly', () => {
    const n = nodeGesture('a', 2, 200, 120);
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(n.position().x).toBe(400);
  });

  test('the speed is capped', () => {
    const n = nodeGesture('a', 50);
    const released = n.position().x;
    clock.frames(1000);
    // At most MAX_SPEED (3000 px/s) × τ (0.325 s) further.
    expect(n.position().x - released).toBeLessThanOrEqual(3000 * 0.325 + 1);
  });

  test('grabbing a gliding node stops it and reports where it stopped', () => {
    const n = nodeGesture('a', 2);
    clock.frames(3);
    const at = n.position().x;
    n.emit('grab');
    expect(onRest).toHaveBeenCalledTimes(1);
    clock.frames(10);
    expect(n.position().x).toBe(at);
  });

  test('a press elsewhere stops the glide and reports the node', () => {
    nodeGesture('a', 2);
    clock.frames(2);
    cy.emit('tapstart');
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  test('reduced motion: reported at once, no glide', () => {
    reduced = true;
    const n = nodeGesture('a', 2);
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(n.position().x).toBe(400);
    expect(clock.pending).toBe(0);
  });

  test('a node removed mid-glide is not reported', () => {
    const n = nodeGesture('a', 2);
    clock.frames(2);
    cy.remove(n);
    clock.frames(1000);
    expect(onRest).not.toHaveBeenCalled();
  });

  test('dispose unbinds everything', () => {
    momentum.dispose();
    nodeGesture('a', 2);
    expect(onRest).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });
});
