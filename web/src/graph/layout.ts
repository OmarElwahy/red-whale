// fcose layouts (docs/architecture.md §8). Nodes with saved positions stay where they were saved; new nodes
// are laid out around what's already on the canvas instead of re-running the whole graph.
import type { CollectionReturnValue, Core, NodeCollection } from 'cytoscape';
import type { FcoseFixedNodeConstraint, FcoseLayoutOptions } from 'cytoscape-fcose';

const BASE: Omit<FcoseLayoutOptions, 'randomize' | 'quality'> = {
  name: 'fcose',
  animate: false,
  nodeDimensionsIncludeLabels: false,
  idealEdgeLength: 80,
  nodeRepulsion: 6000,
  nodeSeparation: 80,
  padding: 40,
};

const pin = (nodes: NodeCollection): FcoseFixedNodeConstraint[] =>
  nodes.map((n) => ({ nodeId: n.id(), position: { ...n.position() } }));

/** First paint: lay out everything, keeping nodes with a saved position fixed. */
export function initialLayout(cy: Core, savedIds: ReadonlySet<string>): void {
  const nodes = cy.nodes();
  if (nodes.empty()) return;
  const saved = nodes.filter((n) => savedIds.has(n.id()));
  if (saved.length === nodes.length) {
    cy.fit(undefined, BASE.padding);
    return;
  }
  const options: FcoseLayoutOptions = { ...BASE, quality: 'default', randomize: true, fit: true, fixedNodeConstraint: pin(saved) };
  cy.layout(options).run();
}

/** Up to this many nodes on the canvas, everything already placed takes part (pinned) when new nodes are laid out. */
const CONTEXT_LIMIT = 800;

/**
 * Starts each new node next to a placed neighbor, breadth-first, so a chain of new nodes (a group's members, each
 * with its own groups below) unrolls outward instead of piling up at the origin. Siblings fan out on the side of
 * their anchor that faces away from the anchor's other placed neighbors (members hang below their group).
 */
function seed(cy: Core, newNodes: NodeCollection, savedIds: ReadonlySet<string>): void {
  const placed = new Set<string>(
    cy
      .nodes()
      .difference(newNodes)
      .map((n) => n.id()),
  );
  for (const n of newNodes) if (savedIds.has(n.id())) placed.add(n.id());
  const children = new Map<string, number>();
  let waiting = newNodes.filter((n) => !placed.has(n.id()));
  for (let progress = true; progress && waiting.nonempty(); ) {
    progress = false;
    const placedNow: string[] = [];
    waiting.forEach((n) => {
      const anchor = n.neighborhood().nodes().filter((m) => placed.has(m.id()))[0];
      if (!anchor) return;
      const a = anchor.position();
      // Away from the anchor's other placed neighbors.
      const others = anchor.neighborhood().nodes().filter((m) => placed.has(m.id()) && m.id() !== n.id());
      let away = Math.PI / 2;
      if (others.nonempty()) {
        let cx = 0;
        let cy = 0;
        others.forEach((m) => {
          cx += m.position().x;
          cy += m.position().y;
        });
        away = Math.atan2(a.y - cy / others.length, a.x - cx / others.length);
      }
      const i = children.get(anchor.id()) ?? 0;
      children.set(anchor.id(), i + 1);
      const ring = Math.floor(i / 9);
      const slot = i % 9;
      const angle = away + (slot % 2 === 0 ? 1 : -1) * Math.ceil(slot / 2) * 0.32;
      const r = 90 + 60 * ring;
      n.position({ x: a.x + r * Math.cos(angle), y: a.y + r * Math.sin(angle) });
      placedNow.push(n.id());
    });
    for (const id of placedNow) placed.add(id);
    if (placedNow.length > 0) {
      progress = true;
      waiting = waiting.filter((n) => !placed.has(n.id()));
    }
  }
}

/**
 * New nodes after an update: start each one next to a neighbor that's already placed (breadth-first, so chains
 * of new nodes unroll outward), then run fcose on the new nodes with everything already placed pinned, so they
 * settle without landing on top of what's there. Nothing that was on the canvas moves.
 */
export function layoutAdded(cy: Core, addedIds: readonly string[], savedIds: ReadonlySet<string>): void {
  let added: CollectionReturnValue = cy.collection();
  for (const id of addedIds) added = added.union(cy.getElementById(id));
  const newNodes = added.nodes();
  if (newNodes.empty()) return;

  const anchors = newNodes.neighborhood().nodes().difference(newNodes);
  seed(cy, newNodes, savedIds);

  // Small canvases: every placed node repels the newcomers. Big ones: only the direct neighbors, to stay fast.
  const old = cy.nodes().difference(newNodes).not('.retiring');
  const context = cy.nodes().length <= CONTEXT_LIMIT && anchors.nonempty() ? old : anchors;
  const fixed = context.union(newNodes.filter((n) => savedIds.has(n.id())));
  const scope = newNodes.union(context);
  // With no placed neighbor there's nothing to start from, so let fcose scatter the new nodes itself.
  const randomize = anchors.empty();
  const options: FcoseLayoutOptions = {
    ...BASE,
    // fcose requires 'proof' quality when it starts from the current positions.
    quality: randomize ? 'default' : 'proof',
    randomize,
    fit: false,
    fixedNodeConstraint: pin(fixed),
  };
  scope.union(scope.edgesWith(scope)).layout(options).run();
}

export type Position = { x: number; y: number };

/** Layout switches and tree re-runs: how long nodes take to reach their new positions. */
export const LAYOUT_ANIMATION_MS = 400;
const FIT_PADDING = 40;

/**
 * Moves every node to `targets` (nodes not in the map stay put), optionally fitting the view to the result,
 * as one animation. A duration of 0 jumps (reduced motion). Stops whatever node animation was running first.
 */
export function animateTo(
  cy: Core,
  targets: ReadonlyMap<string, Position>,
  { fit, duration }: { fit: boolean; duration: number },
): void {
  // Nodes sliding into a collapsed group are leaving: leave their animation alone (graph/diff.ts).
  const nodes = cy
    .nodes()
    .filter((n) => !n.hasClass('retiring'))
    .nodes();
  nodes.stop(true, false);
  const positions = Object.fromEntries(nodes.map((n) => [n.id(), targets.get(n.id()) ?? { ...n.position() }]));
  cy.layout({
    name: 'preset',
    positions,
    fit,
    padding: FIT_PADDING,
    animate: duration > 0,
    animationDuration: duration,
    animationEasing: 'ease-out',
  }).run();
}

/**
 * Where Force mode puts every node, without moving anything on screen: nodes with a remembered position (their
 * Force position before Tree mode, or a saved one) go back to it, and the rest are laid out by fcose around
 * them, as after a live update. Computed by placing the nodes, running the (synchronous) layouts, reading the
 * result, then restoring positions and viewport; the caller animates to the result.
 */
export function forceTargets(
  cy: Core,
  remembered: ReadonlyMap<string, Position>,
  pinned: ReadonlySet<string>,
): Map<string, Position> {
  const nodes = cy.nodes();
  const start = new Map(nodes.map((n) => [n.id(), { ...n.position() }]));
  const viewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };

  const loose: string[] = [];
  cy.batch(() => {
    nodes.forEach((n) => {
      const p = remembered.get(n.id());
      if (p) n.position(p);
      else loose.push(n.id());
    });
  });
  if (loose.length === nodes.length) initialLayout(cy, pinned);
  else if (loose.length > 0) layoutAdded(cy, loose, new Set([...pinned].filter((id) => remembered.has(id))));

  const final = new Map(nodes.map((n) => [n.id(), { ...n.position() }]));
  cy.batch(() => {
    nodes.forEach((n) => {
      const p = start.get(n.id());
      if (p) n.position(p);
    });
  });
  cy.viewport(viewport);
  return final;
}
