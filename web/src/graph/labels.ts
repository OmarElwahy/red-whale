// Labels at low zoom (docs/architecture.md §8). Text that would be drawn smaller than LABEL_MIN_PX isn't
// readable, and skipping it is a big rendering saving at 2,000 elements. Cytoscape's `min-zoomed-font-size`
// does that with a hard cut; this fades instead. When the zoom crosses the threshold, every node (or edge)
// label goes to half opacity, then all the way (LABEL_FADE_MS in all): two class swaps per crossing. A Cytoscape
// `transition` would restyle every label on every frame of the fade; measured at the 2,000-element cap, that
// pushed zooming's p95 frame from ~21 ms to ~35 ms. Cytoscape skips text at opacity 0, so hidden labels are free.
import type { CollectionReturnValue, Core, EventObject, SingularElementReturnValue } from 'cytoscape';
import { EDGE_FONT_PX, LABEL_FADE_MS, NODE_FONT_PX } from './style';

/** Smallest on-screen font size at which labels are shown. */
export const LABEL_MIN_PX = 8;
/** Labels reappear only this much above the threshold, so a zoom resting on it doesn't flicker. */
const HYSTERESIS_PX = 0.4;

/**
 * One class per opacity level below full: index 0 is hidden; a label with none of them is fully shown.
 * The stylesheet gives each its `text-opacity` (graph/style.ts).
 */
export const LABEL_FADE_LEVELS = ['label-hidden', 'label-fade-1'] as const;
export const LABEL_HIDDEN = LABEL_FADE_LEVELS[0];
const SHOWN = LABEL_FADE_LEVELS.length;
const STEP_MS = LABEL_FADE_MS / SHOWN;

/** Whether labels of this font size should show at this zoom, given whether they show now. */
export function labelsVisible(fontPx: number, zoom: number, showing: boolean): boolean {
  const rendered = fontPx * zoom;
  return showing ? rendered >= LABEL_MIN_PX : rendered >= LABEL_MIN_PX + HYSTERESIS_PX;
}

const ALL_LEVELS = LABEL_FADE_LEVELS.join(' ');

/** The class for a level (0 = hidden … SHOWN = no class). */
const levelClass = (level: number): string | undefined => LABEL_FADE_LEVELS[level];

interface Group {
  font: number;
  select: () => CollectionReturnValue;
  /** Whether the labels should show (the fade's target). */
  showing: boolean;
  /** Where the fade is now, 0 … SHOWN. */
  level: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function bindLabelFade(cy: Core): () => void {
  const groups: Group[] = [
    { font: NODE_FONT_PX, select: () => cy.$('node'), showing: true, level: SHOWN, timer: undefined },
    { font: EDGE_FONT_PX, select: () => cy.$('edge'), showing: true, level: SHOWN, timer: undefined },
  ];

  const paint = (g: Group) => {
    const cls = levelClass(g.level);
    cy.batch(() => {
      const eles = g.select();
      eles.removeClass(ALL_LEVELS);
      if (cls) eles.addClass(cls);
    });
  };

  const step = (g: Group) => {
    g.timer = undefined;
    const target = g.showing ? SHOWN : 0;
    if (g.level === target) return;
    g.level += g.level < target ? 1 : -1;
    paint(g);
    if (g.level !== target) g.timer = setTimeout(() => {
      step(g);
    }, STEP_MS);
  };

  const onZoom = () => {
    const zoom = cy.zoom();
    for (const g of groups) {
      const showing = labelsVisible(g.font, zoom, g.showing);
      if (showing === g.showing) continue;
      g.showing = showing;
      // A fade already running carries on toward the new target from where it is.
      if (g.timer === undefined) step(g);
    }
  };

  // New elements take the current level, without a fade.
  const onAdd = (e: EventObject) => {
    const el = e.target as SingularElementReturnValue;
    const g = el.isNode() ? groups[0] : groups[1];
    const cls = g ? levelClass(g.level) : undefined;
    el.removeClass(ALL_LEVELS);
    if (cls) el.addClass(cls);
  };

  for (const g of groups) {
    g.showing = labelsVisible(g.font, cy.zoom(), false);
    g.level = g.showing ? SHOWN : 0;
    paint(g);
  }
  cy.on('zoom', onZoom);
  cy.on('add', onAdd);
  return () => {
    for (const g of groups) clearTimeout(g.timer);
    cy.off('zoom', onZoom);
    cy.off('add', onAdd);
  };
}
