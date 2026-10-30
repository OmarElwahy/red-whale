// The Cytoscape wrapper (CLAUDE.md rule 6, docs/architecture.md §8). Cytoscape owns the canvas: the instance
// is created once, and new elements are diffed in imperatively. React never re-renders the graph.
import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { useEffect, useRef } from 'react';
import { applyDiff, byId, diffElements } from './diff';
import type { Element } from './elements';
import { applyFocus, applyMute, applySearchPath, focusNeighborhood } from './emphasis';
import { bindGraphEvents, syncSelection, type GraphHandlers } from './events';
import { initialLayout, layoutAdded } from './layout';
import { COLORS, graphStylesheet } from './style';

cytoscape.use(fcose);

export interface CytoscapeGraphProps {
  elements: readonly Element[];
  selectedId: string | null;
  focusId: string | null;
  /** Focus radius. */
  hops: number;
  /** Fade nodes below medium effective severity. */
  mute: boolean;
  /** The search the elements were loaded with: nodes that don't match it are path nodes, drawn dimmer. */
  query: string | undefined;
  /** Pan to this node when `seq` changes. */
  centerOn: { id: string; seq: number } | null;
  handlers: GraphHandlers;
  className?: string;
}

const savedPositions = (elements: readonly Element[]): string[] =>
  elements.flatMap((el) => (el.group === 'nodes' && el.position ? [el.data.id] : []));

export function CytoscapeGraph({
  elements,
  selectedId,
  focusId,
  hops,
  mute,
  query,
  centerOn,
  handlers,
  className,
}: CytoscapeGraphProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  /** What's on the canvas, as last applied. */
  const applied = useRef<Map<string, Element>>(new Map());
  /** Nodes that stay where they are when layouts run: saved positions, plus nodes dragged this session. */
  const pinned = useRef<Set<string>>(new Set());
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!container.current) return;
    const cy = cytoscape({
      container: container.current,
      style: graphStylesheet(),
      minZoom: 0.05,
      maxZoom: 4,
      textureOnViewport: true,
      hideEdgesOnViewport: true,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    const unbind = bindGraphEvents(cy, () => ({
      ...handlersRef.current,
      onMoved: (positions) => {
        for (const p of positions) pinned.current.add(p.id);
        handlersRef.current.onMoved(positions);
      },
    }));
    // Cytoscape only listens to window resizes; follow the container too (panels opening, etc.).
    const resize = new ResizeObserver(() => {
      cy.resize();
    });
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      unbind();
      cy.destroy();
      cyRef.current = null;
      applied.current = new Map();
      pinned.current = new Set();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const diff = diffElements(applied.current, elements);
    applyDiff(cy, diff);
    applied.current = byId(elements);

    for (const id of savedPositions(elements)) pinned.current.add(id);
    // First paint, or a filter change that replaced every node: nothing to place the new nodes around.
    const fresh = diff.add.nodes.length > 0 && diff.add.nodes.length === cy.nodes().length;
    if (fresh) initialLayout(cy, pinned.current);
    else layoutAdded(cy, diff.add.nodes.map((n) => n.data.id), pinned.current);
  }, [elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy) syncSelection(cy, selectedId);
  }, [selectedId, elements]);

  // Re-applied when elements change, so nodes that arrive while focused (or muted, or searched) get styled too.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy) applyFocus(cy, focusId, hops);
  }, [focusId, hops, elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy) applyMute(cy, mute);
  }, [mute, elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy) applySearchPath(cy, query);
  }, [query, elements]);

  // Zoom to the neighborhood only when focus is turned on, moves, or changes radius; not on every data update.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || focusId === null) return;
    const bright = focusNeighborhood(cy, focusId, hops);
    if (bright.nonempty()) cy.animate({ fit: { eles: bright, padding: 80 }, duration: 300 });
  }, [focusId, hops]);

  // Search jump: pan to the node, zooming in if the view is too far out to read labels.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || centerOn === null) return;
    const node = cy.getElementById(centerOn.id);
    if (node.empty()) return;
    const zoom = Math.max(cy.zoom(), 1);
    const { x, y } = node.position();
    cy.stop();
    cy.animate({ zoom, pan: { x: cy.width() / 2 - x * zoom, y: cy.height() / 2 - y * zoom }, duration: 300 });
  }, [centerOn]);

  // Cytoscape forces `position: relative` on its container with an unlayered rule that beats Tailwind's
  // utilities, so the container must not be positioned by classes: the outer div is, the inner one fills it.
  return (
    <div className={className}>
      <div ref={container} style={{ width: '100%', height: '100%', background: COLORS.canvas }} />
    </div>
  );
}
