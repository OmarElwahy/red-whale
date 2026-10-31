// Momentum on the canvas (docs/architecture.md §8, "feel"). A fast pan keeps gliding after release; so does a
// node thrown by a fast drag. Both slow down with friction (graph/motion.ts) on requestAnimationFrame. Any new
// pointer-down on the canvas, any wheel, and any programmatic animation (caller calls `stop()`) end a glide
// at once. With reduced motion there is no glide at all.
import type { Core, EventObject, NodeSingular } from 'cytoscape';
import {
  MAX_SPEED,
  MIN_RELEASE_SPEED,
  STOP_SPEED,
  VelocityTracker,
  capSpeed,
  glideStep,
  speed,
  type Vec,
} from './motion';

export interface FrameScheduler {
  now: () => number;
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

export const browserScheduler: FrameScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => {
    cancelAnimationFrame(id);
  },
};

export interface MomentumOptions {
  /** Read on every release, so a change in the OS setting applies at once. */
  reducedMotion: () => boolean;
  /** A dragged node came to rest: right after release, or when its glide ends or is interrupted. Once per drag. */
  onRest: (node: NodeSingular) => void;
  scheduler?: FrameScheduler;
}

export interface Momentum {
  /** Ends any glide where it is (a gliding node is reported to `onRest`). */
  stop: () => void;
  readonly gliding: boolean;
  dispose: () => void;
}

type Glide = { kind: 'pan' } | { kind: 'node'; node: NodeSingular };

export function bindMomentum(cy: Core, options: MomentumOptions): Momentum {
  const clock = options.scheduler ?? browserScheduler;
  const tracker = new VelocityTracker();
  /** What the pointer is doing right now. */
  let tracking: 'pan' | NodeSingular | null = null;
  let glide: Glide | null = null;
  let frame: number | null = null;

  const stop = () => {
    if (frame !== null) clock.cancel(frame);
    frame = null;
    const ended = glide;
    glide = null;
    if (ended?.kind === 'node' && !ended.node.removed()) options.onRest(ended.node);
  };

  /** Runs the friction loop. `v` is in model units per second for nodes, rendered px/s for the pan. */
  const run = (next: Glide, v0: Vec, stopSpeed: number, move: (delta: Vec) => void) => {
    glide = next;
    let v = v0;
    let last = clock.now();
    const tick = () => {
      if (glide !== next) return;
      if (next.kind === 'node' && next.node.removed()) {
        glide = null;
        frame = null;
        return;
      }
      const t = clock.now();
      const step = glideStep(v, t - last, stopSpeed);
      last = t;
      v = step.velocity;
      move(step.delta);
      if (step.done) {
        frame = null;
        stop();
      } else {
        frame = clock.request(tick);
      }
    };
    frame = clock.request(tick);
  };

  // Cytoscape emits `grab` before `tapstart` on a node, so a node press is already being tracked here.
  const onTapStart = (e: EventObject) => {
    stop();
    if (e.target === cy) {
      tracking = 'pan';
      tracker.reset();
      tracker.push(clock.now(), cy.pan());
    } else if (tracking === 'pan' || (tracking !== null && tracking !== e.target)) {
      tracking = null;
    }
  };
  const onPan = () => {
    if (tracking === 'pan') tracker.push(clock.now(), cy.pan());
  };
  const onTapEnd = () => {
    if (tracking !== 'pan') return;
    tracking = null;
    const v = capSpeed(tracker.velocity(clock.now()), MAX_SPEED);
    tracker.reset();
    if (options.reducedMotion() || speed(v) < MIN_RELEASE_SPEED) return;
    run({ kind: 'pan' }, v, STOP_SPEED, (d) => {
      cy.panBy(d);
    });
  };

  const onGrab = (e: EventObject) => {
    const node = e.target as NodeSingular;
    stop();
    tracking = node;
    tracker.reset();
    tracker.push(clock.now(), node.position());
  };
  const onDrag = (e: EventObject) => {
    if (tracking === e.target) tracker.push(clock.now(), (e.target as NodeSingular).position());
  };
  const onDragFree = (e: EventObject) => {
    const node = e.target as NodeSingular;
    const zoom = cy.zoom();
    // Model units per second; thresholds are in rendered px, so scale them by the zoom.
    const v = capSpeed(tracker.velocity(clock.now()), MAX_SPEED / zoom);
    tracking = null;
    tracker.reset();
    if (options.reducedMotion() || speed(v) * zoom < MIN_RELEASE_SPEED) {
      options.onRest(node);
      return;
    }
    run({ kind: 'node', node }, v, STOP_SPEED / zoom, (d) => {
      node.shift(d);
    });
  };

  cy.on('tapstart', onTapStart);
  cy.on('pan', onPan);
  cy.on('tapend', onTapEnd);
  cy.on('grab', 'node', onGrab);
  cy.on('drag', 'node', onDrag);
  cy.on('dragfree', 'node', onDragFree);

  return {
    stop,
    get gliding() {
      return glide !== null;
    },
    dispose: () => {
      if (frame !== null) clock.cancel(frame);
      frame = null;
      glide = null;
      cy.off('tapstart', onTapStart);
      cy.off('pan', onPan);
      cy.off('tapend', onTapEnd);
      cy.off('grab', 'node', onGrab);
      cy.off('drag', 'node', onDrag);
      cy.off('dragfree', 'node', onDragFree);
    },
  };
}
