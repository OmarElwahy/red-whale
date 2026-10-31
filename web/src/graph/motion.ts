// The physics behind the canvas's momentum (docs/architecture.md §8, "feel"). Pure, so it's unit-tested;
// graph/momentum.ts drives it from requestAnimationFrame.

export interface Vec {
  x: number;
  y: number;
}

/** Only pointer movement this recent counts toward the release velocity. */
export const VELOCITY_WINDOW_MS = 80;
/** Fastest glide, in rendered px/s. */
export const MAX_SPEED = 3000;
/** A glide stops once it's slower than this (rendered px/s). */
export const STOP_SPEED = 20;
/** Releases slower than this don't glide at all (rendered px/s): a careful drop stays where it was dropped. */
export const MIN_RELEASE_SPEED = 150;
/** Friction time constant: speed falls to 1/e every this many ms. */
export const FRICTION_TAU_MS = 325;
/** Below this span the samples are too close together for a meaningful speed. */
const MIN_SPAN_MS = 10;

export const ZERO: Readonly<Vec> = { x: 0, y: 0 };

export const speed = (v: Vec): number => Math.hypot(v.x, v.y);

/** Scales `v` down so its speed is at most `max`. */
export function capSpeed(v: Vec, max: number): Vec {
  const s = speed(v);
  return s <= max || s === 0 ? { ...v } : { x: (v.x / s) * max, y: (v.y / s) * max };
}

/**
 * Release velocity from pointer samples. Only the last {@link VELOCITY_WINDOW_MS} before `now` count, and the
 * time since the last sample counts as standing still: a fast drag that ends in a pause, or a slow drag, gives
 * (close to) zero. Units: position units per second.
 */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  push(t: number, p: Vec): void {
    this.samples.push({ t, x: p.x, y: p.y });
    // Keep a little more than the window; the rest can never count again.
    const cutoff = t - VELOCITY_WINDOW_MS * 2;
    while (this.samples.length > 2 && (this.samples[0]?.t ?? t) < cutoff) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
  }

  velocity(now: number): Vec {
    const recent = this.samples.filter((s) => s.t >= now - VELOCITY_WINDOW_MS && s.t <= now);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || first === last) return { ...ZERO };
    const span = now - first.t;
    if (span < MIN_SPAN_MS) return { ...ZERO };
    return { x: ((last.x - first.x) / span) * 1000, y: ((last.y - first.y) / span) * 1000 };
  }
}

export interface GlideStep {
  /** Distance to move this frame. */
  delta: Vec;
  /** Velocity after this frame. */
  velocity: Vec;
  /** True when the glide should end after this frame. */
  done: boolean;
}

/**
 * One frame of friction: exponential decay, integrated exactly over `dtMs` so the glide distance doesn't depend
 * on the frame rate. `stopSpeed` is in the same units as `v`.
 */
export function glideStep(v: Vec, dtMs: number, stopSpeed: number = STOP_SPEED): GlideStep {
  const dt = Math.max(0, Math.min(dtMs, 100)); // a long frame (tab in background) shouldn't jump far
  const decay = Math.exp(-dt / FRICTION_TAU_MS);
  const travel = (FRICTION_TAU_MS / 1000) * (1 - decay);
  const velocity = { x: v.x * decay, y: v.y * decay };
  return { delta: { x: v.x * travel, y: v.y * travel }, velocity, done: speed(velocity) < stopSpeed };
}

/** Total distance a glide covers from velocity `v` (geometric limit, ignoring the stop threshold). */
export const glideDistance = (v: Vec): number => speed(v) * (FRICTION_TAU_MS / 1000);
