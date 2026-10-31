// Dev-only canvas benchmark (docs/architecture.md §8, "feel"): `await redwhale.bench()` in the browser console
// pans in a circle and zooms in and out for a few seconds, one viewport change per frame (what a gesture does),
// and reports frame times. `redwhale.bench({ zoom: false })` pans only, at the fitted zoom. The view is put
// back afterwards. Not loaded in production builds.
import type { Core } from 'cytoscape';

export interface BenchResult {
  elements: number;
  nodes: number;
  edges: number;
  frames: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  zoomRange: [number, number];
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const round = (n: number) => Math.round(n * 10) / 10;

export interface BenchOptions {
  seconds?: number;
  /** Zoom in and out while panning (default), or pan only. */
  zoom?: boolean;
}

/** Zooms between the fitted view and close enough to read edge labels, so both regimes are measured. */
export function benchCanvas(cy: Core, { seconds = 5, zoom: zooming = true }: BenchOptions = {}): Promise<BenchResult> {
  const before = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  cy.fit(undefined, 40);
  const far = cy.zoom();
  const near = zooming ? Math.min(cy.maxZoom(), Math.max(1.5, far * 4)) : far;
  const center = { x: cy.width() / 2, y: cy.height() / 2 };
  const model = { x: (center.x - cy.pan().x) / far, y: (center.y - cy.pan().y) / far };

  return new Promise((resolve) => {
    const frames: number[] = [];
    const t0 = performance.now();
    let last = t0;
    const step = (t: number) => {
      frames.push(t - last);
      last = t;
      const p = (t - t0) / (seconds * 1000);
      // Zoom in and out twice; pan around a 150 px circle four times.
      const zoom = far * Math.pow(near / far, (1 - Math.cos(p * 4 * Math.PI)) / 2);
      const angle = p * 8 * Math.PI;
      cy.viewport({
        zoom,
        pan: {
          x: center.x - model.x * zoom + 150 * Math.cos(angle),
          y: center.y - model.y * zoom + 150 * Math.sin(angle),
        },
      });
      if (p < 1) {
        requestAnimationFrame(step);
        return;
      }
      cy.viewport(before);
      const sorted = frames.slice(1).sort((a, b) => a - b);
      const total = sorted.reduce((s, f) => s + f, 0);
      resolve({
        elements: cy.elements().length,
        nodes: cy.nodes().length,
        edges: cy.edges().length,
        frames: sorted.length,
        fps: round((sorted.length / total) * 1000),
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted.at(-1) ?? 0),
        zoomRange: [round(far * 100) / 100, round(near * 100) / 100],
      });
    };
    requestAnimationFrame(step);
  });
}
