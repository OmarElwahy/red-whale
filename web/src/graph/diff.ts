// Element diffing for the Cytoscape wrapper (docs/architecture.md §8): new data is applied as
// add/remove/update by id, so unchanged elements keep their identity, position and selection.
import type { Core, NodeSingular } from 'cytoscape';
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

/** Collapsing a group: these removed nodes slide into it and fade before they go. */
export interface Retire {
  into: string;
  nodes: ReadonlySet<string>;
  duration: number;
}

/** Marks a node that is sliding into its group: already gone as far as the app is concerned. */
export const RETIRING = 'retiring';

/** Extra time after a slide before its nodes are removed anyway. */
const RETIRE_GRACE_MS = 80;

/** Removes a sliding node now, whatever its animation is doing. Safe to call twice, or after the canvas is gone. */
function finishRetiring(cy: Core, n: NodeSingular): void {
  if (cy.destroyed() || !n.inside()) return;
  n.stop(true, false);
  cy.remove(n);
}

/**
 * Applies a diff in one batch: remove, add nodes, add edges, update data. With `retire`, removed nodes it names
 * lose their edges at once, slide to the group and fade, then go (no animation when `duration` is 0).
 *
 * The removal never depends on the animation finishing: layouts stop node animations without completing them
 * (Tree re-runs right after a collapse), which would leave the node behind, edgeless and unclickable. A timer
 * removes it regardless, and any node still sliding is swept at the start of the next diff.
 */
export function applyDiff(cy: Core, diff: ElementDiff, retire?: Retire): void {
  if (emptyDiff(diff)) return;
  const into = retire && retire.duration > 0 ? cy.getElementById(retire.into) : null;
  const sliding: NodeSingular[] = [];
  cy.batch(() => {
    // Anything still sliding from an earlier collapse goes now (and can come straight back if this diff adds it).
    cy.nodes(`.${RETIRING}`).forEach((n) => {
      finishRetiring(cy, n);
    });
    let gone = cy.collection();
    for (const id of diff.remove) {
      const el = cy.getElementById(id);
      if (retire && into?.nonempty() && el.isNode() && retire.nodes.has(id)) {
        cy.remove(el.connectedEdges());
        el.addClass(RETIRING);
        sliding.push(el);
        continue;
      }
      gone = gone.union(el);
    }
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
  if (!into || !retire) return;
  const to = { ...into.position() };
  for (const n of sliding) {
    n.animate(
      { position: to, style: { opacity: 0 } },
      {
        duration: retire.duration,
        complete: () => {
          finishRetiring(cy, n);
        },
      },
    );
    setTimeout(() => {
      finishRetiring(cy, n);
    }, retire.duration + RETIRE_GRACE_MS);
  }
}

/** Index elements by id (first one wins, like diffElements), as the wrapper remembers what it last applied. */
export function byId(elements: readonly Element[]): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const el of elements) if (!map.has(el.data.id)) map.set(el.data.id, el);
  return map;
}
