// PNG export of the canvas (docs/architecture.md §8): the whole graph that's loaded, not just what's in view,
// on the canvas's dark background, drawn as it looks (focus, mute and search fading included).
import { COLORS } from './style';

/** Twice the screen resolution, but no side over 8,192 px: larger canvases fail in some browsers. */
export const PNG_OPTIONS = {
  output: 'blob',
  full: true,
  bg: COLORS.canvas,
  scale: 2,
  maxWidth: 8192,
  maxHeight: 8192,
} as const;

/** Anything that renders like `cy.png` with our options (a Core, or a fake in tests). */
export interface PngSource {
  png: (options: typeof PNG_OPTIONS) => Blob;
}

export function graphPng(cy: PngSource): Blob {
  return cy.png(PNG_OPTIONS);
}

/** `redwhale-graph-2026-10-30T12-34-56Z.png`: UTC, no colons (Windows can't save them). */
export function exportFilename(kind: 'graph', extension: 'png', now: Date = new Date()): string {
  return `redwhale-${kind}-${now.toISOString().slice(0, 19).replaceAll(':', '-')}Z.${extension}`;
}

/** Saves a blob through a temporary link. */
export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on the next tick: Firefox reads the URL after click() returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
