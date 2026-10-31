import { describe, expect, test } from 'vitest';
import {
  FRICTION_TAU_MS,
  MAX_SPEED,
  STOP_SPEED,
  VELOCITY_WINDOW_MS,
  VelocityTracker,
  capSpeed,
  glideDistance,
  glideStep,
  speed,
  type Vec,
} from '../src/graph/motion';

/** Samples every `every` ms from `from` to `to`, moving `perMs` px per ms along x. */
function drag(tracker: VelocityTracker, from: number, to: number, perMs: number, every = 8, x0 = 0) {
  for (let t = from; t <= to; t += every) tracker.push(t, { x: x0 + (t - from) * perMs, y: 0 });
}

describe('VelocityTracker', () => {
  test('a steady fast drag released at once: its speed, in units per second', () => {
    const v = new VelocityTracker();
    drag(v, 0, 400, 2); // 2 px/ms = 2000 px/s
    expect(v.velocity(400).x).toBeCloseTo(2000, -1);
    expect(v.velocity(400).y).toBe(0);
  });

  test('only the last window counts: a slow drag that ends in a fast flick flies', () => {
    const v = new VelocityTracker();
    drag(v, 0, 1000, 0.05);
    drag(v, 1008, 1080, 3, 8, 50);
    expect(v.velocity(1080).x).toBeGreaterThan(2000);
  });

  test('a fast drag that ends in a pause does not fly', () => {
    const v = new VelocityTracker();
    drag(v, 0, 400, 2);
    // No movement for longer than the window before release.
    expect(speed(v.velocity(400 + VELOCITY_WINDOW_MS + 1))).toBe(0);
  });

  test('a short pause before release slows the throw down', () => {
    const v = new VelocityTracker();
    drag(v, 0, 400, 2);
    expect(v.velocity(440).x).toBeLessThan(v.velocity(400).x);
  });

  test('a slow drag gives a slow speed', () => {
    const v = new VelocityTracker();
    drag(v, 0, 1000, 0.05);
    expect(v.velocity(1000).x).toBeCloseTo(50, 0);
  });

  test('one sample, or none, is no speed at all', () => {
    const v = new VelocityTracker();
    expect(v.velocity(0)).toEqual({ x: 0, y: 0 });
    v.push(0, { x: 5, y: 5 });
    expect(v.velocity(0)).toEqual({ x: 0, y: 0 });
  });

  test('reset forgets earlier samples', () => {
    const v = new VelocityTracker();
    drag(v, 0, 400, 2);
    v.reset();
    expect(v.velocity(400)).toEqual({ x: 0, y: 0 });
  });
});

describe('capSpeed', () => {
  test('keeps the direction, limits the speed', () => {
    const v = capSpeed({ x: 30_000, y: 40_000 }, MAX_SPEED);
    expect(speed(v)).toBeCloseTo(MAX_SPEED);
    expect(v.x / v.y).toBeCloseTo(0.75);
  });

  test('leaves a slower speed alone', () => {
    expect(capSpeed({ x: 3, y: 4 }, MAX_SPEED)).toEqual({ x: 3, y: 4 });
  });
});

describe('glideStep', () => {
  const glide = (v0: Vec, frameMs: number) => {
    let v = v0;
    let distance = 0;
    let frames = 0;
    for (;;) {
      const step = glideStep(v, frameMs);
      distance += step.delta.x;
      v = step.velocity;
      frames++;
      if (step.done) return { distance, frames, v };
    }
  };

  test('slows down exponentially and stops below the stop speed', () => {
    const { v, distance } = glide({ x: 2000, y: 0 }, 16);
    expect(speed(v)).toBeLessThan(STOP_SPEED);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(glideDistance({ x: 2000, y: 0 }));
  });

  test('the distance does not depend on the frame rate', () => {
    const at60 = glide({ x: 2000, y: 0 }, 1000 / 60).distance;
    const at144 = glide({ x: 2000, y: 0 }, 1000 / 144).distance;
    const at30 = glide({ x: 2000, y: 0 }, 1000 / 30).distance;
    expect(at144).toBeCloseTo(at60, -1);
    expect(at30).toBeCloseTo(at60, -1);
  });

  test('a long frame (tab in the background) is clamped', () => {
    const step = glideStep({ x: 1000, y: 0 }, 5000);
    expect(step.delta.x).toBeLessThan(1000 * (FRICTION_TAU_MS / 1000));
  });
});
