// Live updates on the canvas (docs/architecture.md §8): nodes that arrive because of a `graph.updated` event are
// highlighted for a moment, so the analyst sees what a new scan added without anything else moving.
import type { Core } from 'cytoscape';
import type { ElementDiff } from './diff';
import type { Element } from './elements';

export const FLASH_MS = 2500;

/**
 * Which nodes to flash after a diff: new nodes a recent event named, and aggregates that grew while an event is
 * recent (new members landed inside them, so no new node appears).
 */
export function flashIds(
  diff: ElementDiff,
  previous: ReadonlyMap<string, Element>,
  fresh: { has: (id: string) => boolean; readonly size: number },
): string[] {
  if (fresh.size === 0) return [];
  const added = diff.add.nodes.filter((n) => fresh.has(n.data.id)).map((n) => n.data.id);
  const grown = diff.update.flatMap((el) => {
    if (el.group !== 'nodes' || el.data.kind !== 'aggregate') return [];
    const prev = previous.get(el.data.id);
    const before = prev?.group === 'nodes' && prev.data.kind === 'aggregate' ? prev.data.count : Infinity;
    return el.data.count > before ? [el.data.id] : [];
  });
  return [...added, ...grown];
}

/** Adds the `fresh` class for FLASH_MS. */
export function flash(cy: Core, ids: readonly string[]): void {
  for (const id of ids) cy.getElementById(id).flashClass('fresh', FLASH_MS);
}
