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

/**
 * New nodes after an update: start each one next to a neighbor that's already placed, then run fcose on just
 * the new nodes and those neighbors, with the neighbors (and any saved positions) pinned. Nothing else moves.
 */
export function layoutAdded(cy: Core, addedIds: readonly string[], savedIds: ReadonlySet<string>): void {
  let added: CollectionReturnValue = cy.collection();
  for (const id of addedIds) added = added.union(cy.getElementById(id));
  const newNodes = added.nodes();
  if (newNodes.empty()) return;

  const anchors = newNodes.neighborhood().nodes().difference(newNodes);
  const loose = newNodes.filter((n) => !savedIds.has(n.id()));
  loose.forEach((n, i) => {
    const anchor = n.neighborhood().nodes().intersection(anchors).nodes().first();
    if (anchor.empty()) return;
    // Golden-angle spiral around the anchor: deterministic and spread out.
    const angle = i * 2.39996;
    const r = 60 + 6 * Math.sqrt(i);
    const { x, y } = anchor.position();
    n.position({ x: x + r * Math.cos(angle), y: y + r * Math.sin(angle) });
  });

  const fixed = anchors.union(newNodes.filter((n) => savedIds.has(n.id())));
  const scope = newNodes.union(anchors);
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
