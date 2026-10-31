import type { Core } from 'cytoscape';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PINCH_ZOOM_PER_PX,
  WHEEL_ZOOM_PER_PX,
  bindWheelZoom,
  easeZoom,
  wheelPixels,
  wheelZoomFactor,
  type WheelZoom,
} from '../src/graph/wheel';
import { fakeClock } from './clock';
import { headless } from './fixtures';

describe('wheel math', () => {
  test('lines and pages become pixels', () => {
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 800)).toBe(48);
    expect(wheelPixels({ deltaY: 1, deltaMode: 2 }, 800)).toBe(800);
    expect(wheelPixels({ deltaY: 120, deltaMode: 0 }, 800)).toBe(120);
  });

  test('down zooms out, up zooms in, by the same factor', () => {
    const out = wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 800);
    const inn = wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false }, 800);
    expect(out).toBeLessThan(1);
    expect(out * inn).toBeCloseTo(1);
  });

  test('mouse and touchpad scroll the same: one 100 px notch = ten 10 px touchpad events', () => {
    const notch = wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 800);
    const pad = wheelZoomFactor({ deltaY: 10, deltaMode: 0, ctrlKey: false }, 800) ** 10;
    expect(pad).toBeCloseTo(notch);
    expect(notch).toBeCloseTo(Math.exp(-100 * WHEEL_ZOOM_PER_PX));
  });

  test('a ctrl+wheel pinch zooms faster per pixel (its deltas are small)', () => {
    expect(wheelZoomFactor({ deltaY: 10, deltaMode: 0, ctrlKey: true }, 800)).toBeCloseTo(
      Math.exp(-10 * PINCH_ZOOM_PER_PX),
    );
  });

  test('easing approaches the target from either side and lands exactly on it', () => {
    let z = 1;
    let frames = 0;
    while (z !== 2 && frames < 100) {
      const next = easeZoom(z, 2, 16);
      expect(next).toBeGreaterThan(z);
      z = next;
      frames++;
    }
    expect(z).toBe(2);
    expect(frames).toBeLessThan(40);
    expect(easeZoom(2, 1, 16)).toBeLessThan(2);
  });
});

describe('bindWheelZoom', () => {
  let cy: Core;
  let host: EventTarget;
  let clock: ReturnType<typeof fakeClock>;
  let reduced: boolean;
  let onStart: ReturnType<typeof vi.fn<() => void>>;
  let wheel: WheelZoom;

  beforeEach(() => {
    cy = headless();
    host = new EventTarget();
    clock = fakeClock();
    reduced = false;
    onStart = vi.fn<() => void>();
    wheel = bindWheelZoom(cy, host as unknown as HTMLElement, {
      onStart,
      reducedMotion: () => reduced,
      scheduler: clock.scheduler,
    });
  });
  afterEach(() => {
    wheel.dispose();
    cy.destroy();
  });

  function scroll(deltaY: number, ctrlKey = false) {
    const e = Object.assign(new Event('wheel', { cancelable: true }), {
      deltaY,
      deltaMode: 0,
      ctrlKey,
      clientX: 0,
      clientY: 0,
    });
    const stopped = vi.spyOn(e, 'stopPropagation');
    host.dispatchEvent(e);
    return { prevented: e.defaultPrevented, stopped: stopped.mock.calls.length > 0 };
  }

  test('takes the event over: no page scroll, and Cytoscape never sees it', () => {
    expect(scroll(100)).toEqual({ prevented: true, stopped: true });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test('eases toward the target over a few frames instead of jumping', () => {
    scroll(-100);
    expect(cy.zoom()).toBe(1);
    clock.frames(1);
    const first = cy.zoom();
    expect(first).toBeGreaterThan(1);
    clock.frames(200);
    expect(cy.zoom()).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_PER_PX));
    expect(clock.pending).toBe(0);
  });

  test('events during the easing accumulate', () => {
    scroll(-100);
    clock.frames(1);
    scroll(-100);
    clock.frames(200);
    expect(cy.zoom()).toBeCloseTo(Math.exp(200 * WHEEL_ZOOM_PER_PX));
  });

  test('stays within the zoom limits', () => {
    cy.maxZoom(4);
    for (let i = 0; i < 50; i++) scroll(-1000);
    clock.frames(500);
    expect(cy.zoom()).toBe(cy.maxZoom());
  });

  test('reduced motion: the zoom applies at once', () => {
    reduced = true;
    scroll(-100);
    expect(cy.zoom()).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_PER_PX));
    expect(clock.pending).toBe(0);
  });

  test('a press on the canvas stops the easing where it is', () => {
    scroll(-100);
    clock.frames(1);
    const at = cy.zoom();
    cy.emit('tapstart');
    clock.frames(50);
    expect(cy.zoom()).toBe(at);
  });

  test('dispose removes the listener', () => {
    wheel.dispose();
    expect(scroll(100).prevented).toBe(false);
  });
});
