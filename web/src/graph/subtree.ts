// Tree mode: dragging a node carries everything below it (its descendants through parent edges), so the tree
// stays clean. The subtree follows the node's position, which covers the drag itself and any momentum glide
// after it; call `end()` when the node comes to rest. In a DAG, a shared node goes with whichever parent moves.
import type { Core, EventObject, NodeCollection, NodeSingular } from 'cytoscape';

export interface SubtreeDrag {
  /** The carried node is at rest: stop following it. */
  end: () => void;
  dispose: () => void;
}

export function bindSubtreeDrag(cy: Core, enabled: () => boolean): SubtreeDrag {
  let carrier: NodeSingular | null = null;
  let below: NodeCollection = cy.collection();
  let last = { x: 0, y: 0 };

  const onPosition = () => {
    if (!carrier || carrier.removed()) return;
    const { x, y } = carrier.position();
    const delta = { x: x - last.x, y: y - last.y };
    last = { x, y };
    if (delta.x === 0 && delta.y === 0) return;
    const alive = below.filter((n) => !n.removed());
    cy.batch(() => {
      alive.shift(delta);
    });
  };

  const end = () => {
    carrier?.off('position', undefined, onPosition);
    carrier = null;
    below = cy.collection();
  };

  const onGrab = (e: EventObject) => {
    end();
    if (!enabled()) return;
    const node = e.target as NodeSingular;
    carrier = node;
    // Anything still animating to its tree position would fight the drag.
    cy.nodes().stop(true, false);
    below = node.successors().nodes().difference(node);
    last = { ...node.position() };
    node.on('position', onPosition);
  };

  cy.on('grab', 'node', onGrab);
  return {
    end,
    dispose: () => {
      end();
      cy.off('grab', 'node', onGrab);
    },
  };
}
