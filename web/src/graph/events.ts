// Cytoscape events → app callbacks, and selection sync. Kept out of the React wrapper so it can be tested
// against a headless Cytoscape.
import type { Core, EventObject, NodeSingular } from 'cytoscape';
import type { Position } from '@/api/hooks';

export interface GraphHandlers {
  /** A node was clicked, or the background (null). */
  onSelect: (id: string | null) => void;
  /** An edge was clicked (its canvas ID): a real one, a group → member one (its real edge), or parent → group. */
  onSelectEdge: (id: string) => void;
  /** A group (expand or collapse it) or a "more" node (load the next page) was double-clicked. */
  onDoubleTap: (id: string) => void;
  /** Right-click on a node, at its rendered position inside the container. */
  onContextMenu: (target: { id: string; x: number; y: number }) => void;
  /**
   * A dragged node came to rest, after any momentum glide (emitted by graph/momentum.ts via the wrapper, not
   * here). Not called in Tree mode, whose positions aren't saved.
   */
  onMoved: (positions: Position[]) => void;
}

const DOUBLE_TAP = 'node[kind = "aggregate"], node[kind = "more"]';

/** Every edge but group → "more": real ones and group → member show a real edge, parent → group the members' tools. */
export const CLICKABLE_EDGES = 'edge[kind != "more"]';

/** "12 subdomains: 2 critical, 1 high below", or just the label when nothing serious is below. */
export function groupTitle(node: NodeSingular): string {
  const label = String(node.data('label'));
  const risk = node.data('riskTitle') as unknown;
  return typeof risk === 'string' && risk !== '' ? `${label}: ${risk}` : label;
}

/**
 * Binds the click handlers once (drags are graph/momentum.ts's). `handlers` is read on every event, so the caller can keep the latest callbacks in
 * a ref without rebinding. Returns an unbind function.
 */
export function bindGraphEvents(cy: Core, handlers: () => GraphHandlers): () => void {
  const onTapNode = (e: EventObject) => {
    handlers().onSelect((e.target as NodeSingular).id());
  };
  const onTapEdge = (e: EventObject) => {
    handlers().onSelectEdge((e.target as NodeSingular).id());
  };
  const onTapCanvas = (e: EventObject) => {
    if (e.target === cy) handlers().onSelect(null);
  };
  const onDoubleTap = (e: EventObject) => {
    handlers().onDoubleTap((e.target as NodeSingular).id());
  };
  // A group's tooltip: its risk ("2 critical, 1 high below"), on the container since the canvas has no DOM nodes.
  const onOver = (e: EventObject) => {
    const container = cy.container();
    if (container) container.title = groupTitle(e.target as NodeSingular);
  };
  const onOut = () => {
    const container = cy.container();
    if (container) container.title = '';
  };
  const onRightClick = (e: EventObject) => {
    const { x, y } = e.renderedPosition;
    handlers().onContextMenu({ id: (e.target as NodeSingular).id(), x, y });
  };

  cy.on('tap', 'node', onTapNode);
  cy.on('tap', CLICKABLE_EDGES, onTapEdge);
  cy.on('tap', onTapCanvas);
  cy.on('dbltap', DOUBLE_TAP, onDoubleTap);
  cy.on('cxttap', 'node', onRightClick);
  cy.on('mouseover', 'node[kind = "aggregate"]', onOver);
  cy.on('mouseout', 'node[kind = "aggregate"]', onOut);
  return () => {
    cy.off('tap', 'node', onTapNode);
    cy.off('tap', CLICKABLE_EDGES, onTapEdge);
    cy.off('tap', onTapCanvas);
    cy.off('dbltap', DOUBLE_TAP, onDoubleTap);
    cy.off('cxttap', 'node', onRightClick);
    cy.off('mouseover', 'node[kind = "aggregate"]', onOver);
    cy.off('mouseout', 'node[kind = "aggregate"]', onOut);
  };
}

/** Selects exactly this node or edge (or nothing), without emitting a tap. */
export function syncSelection(cy: Core, id: string | null): void {
  cy.batch(() => {
    cy.$(':selected').filter((el) => el.id() !== id).unselect();
    if (id !== null) {
      const el = cy.getElementById(id);
      if (el.nonempty() && !el.selected()) el.select();
    }
  });
}
