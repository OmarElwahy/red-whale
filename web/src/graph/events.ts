// Cytoscape events → app callbacks, and selection sync. Kept out of the React wrapper so it can be tested
// against a headless Cytoscape.
import type { Core, EventObject, NodeSingular } from 'cytoscape';
import type { Position } from '@/api/hooks';

export interface GraphHandlers {
  /** A node was clicked, or the background (null). */
  onSelect: (id: string | null) => void;
  /** An aggregate was double-clicked. */
  onExpand: (aggregateId: string) => void;
  /** Right-click on a node, at its rendered position inside the container. */
  onContextMenu: (target: { id: string; x: number; y: number }) => void;
  /** A drag ended. */
  onMoved: (positions: Position[]) => void;
}

/**
 * Binds the handlers once. `handlers` is read on every event, so the caller can keep the latest callbacks in
 * a ref without rebinding. Returns an unbind function.
 */
export function bindGraphEvents(cy: Core, handlers: () => GraphHandlers): () => void {
  const onTapNode = (e: EventObject) => {
    handlers().onSelect((e.target as NodeSingular).id());
  };
  const onTapCanvas = (e: EventObject) => {
    if (e.target === cy) handlers().onSelect(null);
  };
  const onDoubleTap = (e: EventObject) => {
    handlers().onExpand((e.target as NodeSingular).id());
  };
  const onRightClick = (e: EventObject) => {
    const { x, y } = e.renderedPosition;
    handlers().onContextMenu({ id: (e.target as NodeSingular).id(), x, y });
  };
  const onDragEnd = (e: EventObject) => {
    const node = e.target as NodeSingular;
    const { x, y } = node.position();
    handlers().onMoved([{ id: node.id(), x, y }]);
  };

  cy.on('tap', 'node', onTapNode);
  cy.on('tap', onTapCanvas);
  cy.on('dbltap', 'node[kind = "aggregate"]', onDoubleTap);
  cy.on('cxttap', 'node', onRightClick);
  cy.on('dragfree', 'node', onDragEnd);
  return () => {
    cy.off('tap', 'node', onTapNode);
    cy.off('tap', onTapCanvas);
    cy.off('dbltap', 'node[kind = "aggregate"]', onDoubleTap);
    cy.off('cxttap', 'node', onRightClick);
    cy.off('dragfree', 'node', onDragEnd);
  };
}

/** Selects exactly this node (or nothing), without emitting a tap. */
export function syncSelection(cy: Core, id: string | null): void {
  cy.batch(() => {
    cy.$(':selected').filter((el) => el.id() !== id).unselect();
    if (id !== null) {
      const el = cy.getElementById(id);
      if (el.nonempty() && !el.selected()) el.select();
    }
  });
}
