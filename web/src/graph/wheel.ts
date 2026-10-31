// Smooth wheel zoom toward the cursor (docs/architecture.md §8, "feel"). Cytoscape's own wheel zoom jumps a
// fixed step per event, which is jerky on a mouse and twitchy on a touchpad. We take the wheel over instead:
// every wheel event (mouse notch, two-finger scroll, or a ctrl+wheel touchpad pinch) moves a target zoom by an
// amount proportional to the scrolled pixels, so mouse and touchpad behave the same, and the view eases toward
// the target. Touch-screen pinch stays with Cytoscape.
import type { Core } from 'cytoscape';
import { browserScheduler, type FrameScheduler } from './momentum';

const LINE_PX = 16;
/** Zoom change per scrolled pixel: one mouse notch (100 px) zooms by about 16%. */
export const WHEEL_ZOOM_PER_PX = 0.0015;
/** Pinch gestures report small deltas; this keeps the content under the fingers. */
export const PINCH_ZOOM_PER_PX = 0.01;
/** How quickly the view catches up with the target zoom: 1/e of the gap remains after this many ms. */
export const ZOOM_EASE_TAU_MS = 60;

export interface WheelLike {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

/** The wheel delta in pixels, whatever unit the browser reported it in. */
export function wheelPixels(e: Pick<WheelLike, 'deltaY' | 'deltaMode'>, pageHeight: number): number {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * pageHeight;
  return e.deltaY;
}

/** Multiplier for the zoom level: scrolling down (positive delta) zooms out. */
export function wheelZoomFactor(e: WheelLike, pageHeight: number): number {
  const rate = e.ctrlKey ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX;
  return Math.exp(-wheelPixels(e, pageHeight) * rate);
}

/** One easing frame in log space, so zooming in and out feel symmetric. Returns the zoom for this frame. */
export function easeZoom(current: number, target: number, dtMs: number): number {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / ZOOM_EASE_TAU_MS);
  const next = Math.exp(Math.log(current) + (Math.log(target) - Math.log(current)) * k);
  return Math.abs(Math.log(target / next)) < 0.002 ? target : next;
}

export interface WheelZoomOptions {
  /** Called when a wheel event arrives, before zooming: ends any glide. */
  onStart: () => void;
  reducedMotion: () => boolean;
  scheduler?: FrameScheduler;
}

export interface WheelZoom {
  /** Ends an easing zoom where it is. */
  stop: () => void;
  dispose: () => void;
}

/**
 * Takes over wheel events on `host`, an ancestor of the Cytoscape container. The listener is on the capture
 * phase and stops propagation, so Cytoscape's own (capture) wheel handler on its container never sees them.
 */
export function bindWheelZoom(cy: Core, host: HTMLElement, options: WheelZoomOptions): WheelZoom {
  const clock = options.scheduler ?? browserScheduler;
  let target: number | null = null;
  let anchor = { x: 0, y: 0 };
  let frame: number | null = null;
  let last = 0;

  const stop = () => {
    if (frame !== null) clock.cancel(frame);
    frame = null;
    target = null;
  };

  const tick = () => {
    if (target === null) return;
    const t = clock.now();
    const level = easeZoom(cy.zoom(), target, t - last);
    last = t;
    cy.zoom({ level, renderedPosition: anchor });
    if (level === target) {
      frame = null;
      target = null;
    } else {
      frame = clock.request(tick);
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (!cy.userZoomingEnabled()) return;
    e.preventDefault();
    e.stopPropagation();
    options.onStart();
    const rect = cy.container()?.getBoundingClientRect();
    anchor = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    const base = target ?? cy.zoom();
    const next = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), base * wheelZoomFactor(e, rect?.height ?? 800)));
    if (options.reducedMotion()) {
      stop();
      cy.zoom({ level: next, renderedPosition: anchor });
      return;
    }
    target = next;
    if (frame === null) {
      last = clock.now();
      frame = clock.request(tick);
    }
  };

  host.addEventListener('wheel', onWheel, { capture: true, passive: false });
  // A press on the canvas takes over from an easing zoom.
  const onTapStart = () => {
    stop();
  };
  cy.on('tapstart', onTapStart);
  return {
    stop,
    dispose: () => {
      stop();
      host.removeEventListener('wheel', onWheel, { capture: true });
      cy.off('tapstart', onTapStart);
    },
  };
}
