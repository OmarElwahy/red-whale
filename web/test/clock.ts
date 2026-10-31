// A manual requestAnimationFrame clock for momentum/wheel tests.
import type { FrameScheduler } from '../src/graph/momentum';

export function fakeClock() {
  let t = 1000;
  let nextId = 0;
  const queue = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    now: () => t,
    request: (callback) => {
      queue.set(++nextId, callback);
      return nextId;
    },
    cancel: (id) => {
      queue.delete(id);
    },
  };
  return {
    scheduler,
    /** Moves time on without running frames (pointer events between frames). */
    advance(ms: number) {
      t += ms;
    },
    /** Runs up to `n` frames of `ms` each; stops early when nothing is scheduled. Returns frames run. */
    frames(n: number, ms = 16): number {
      let ran = 0;
      while (ran < n && queue.size > 0) {
        t += ms;
        const callbacks = [...queue.values()];
        queue.clear();
        for (const cb of callbacks) cb();
        ran++;
      }
      return ran;
    },
    get pending(): number {
      return queue.size;
    },
  };
}
