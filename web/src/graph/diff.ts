// Element diffing for the Cytoscape wrapper (docs/architecture.md §8): new data is applied as
// add/remove/update by id, so unchanged elements keep their identity, position and selection.
import type { Core } from 'cytoscape';
import type { EdgeElement, Element, NodeElement } from './elements';

export interface ElementDiff {
  add: { nodes: NodeElement[]; edges: EdgeElement[] };
  /** IDs to remove. Removing a node also removes its edges in Cytoscape. */
  remove: string[];
  /** Same id, changed data. Positions are never touched: the analyst may have moved the node. */
  update: Element[];
}

function sameData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}

/** An element that changed group or edge endpoints can't be updated in place; it is replaced. */
function replaceable(prev: Element, next: Element): boolean {
  if (prev.group !== next.group) return true;
  return (
    prev.group === 'edges' &&
    next.group === 'edges' &&
    (prev.data.source !== next.data.source || prev.data.target !== next.data.target)
  );
}

export function emptyDiff(diff: ElementDiff): boolean {
  return diff.add.nodes.length + diff.add.edges.length + diff.remove.length + diff.update.length === 0;
}

/** What to do to turn `current` (what's on the canvas) into `next`. */
export function diffElements(current: ReadonlyMap<string, Element>, next: readonly Element[]): ElementDiff {
  const diff: ElementDiff = { add: { nodes: [], edges: [] }, remove: [], update: [] };
  const add = (el: Element) => {
    if (el.group === 'nodes') diff.add.nodes.push(el);
    else diff.add.edges.push(el);
  };
  const seen = new Set<string>();
  for (const el of next) {
    const id = el.data.id;
    if (seen.has(id)) continue; // de-duplicate by id; the first one wins
    seen.add(id);
    const prev = current.get(id);
    if (prev === undefined) {
      add(el);
    } else if (replaceable(prev, el)) {
      diff.remove.push(id);
      add(el);
    } else if (!sameData(prev.data, el.data)) {
      diff.update.push(el);
    }
  }
  for (const id of current.keys()) if (!seen.has(id)) diff.remove.push(id);
  return diff;
}

/** Applies a diff in one batch: remove, add nodes, add edges, update data. */
export function applyDiff(cy: Core, diff: ElementDiff): void {
  if (emptyDiff(diff)) return;
  cy.batch(() => {
    let gone = cy.collection();
    for (const id of diff.remove) gone = gone.union(cy.getElementById(id));
    cy.remove(gone);
    if (diff.add.nodes.length > 0) cy.add(diff.add.nodes);
    if (diff.add.edges.length > 0) cy.add(diff.add.edges);
    for (const el of diff.update) {
      const ele = cy.getElementById(el.data.id);
      const stale = Object.keys(ele.data() as Record<string, unknown>).filter((k) => !(k in el.data));
      if (stale.length > 0) ele.removeData(stale.join(' '));
      ele.data(el.data);
    }
  });
}

/** Index elements by id (first one wins, like diffElements), as the wrapper remembers what it last applied. */
export function byId(elements: readonly Element[]): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const el of elements) if (!map.has(el.data.id)) map.set(el.data.id, el);
  return map;
}
