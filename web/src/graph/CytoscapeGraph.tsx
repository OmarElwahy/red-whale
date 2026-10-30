// The Cytoscape wrapper (CLAUDE.md rule 6, docs/architecture.md §8). Cytoscape owns the canvas: the instance
// is created once, and new elements are diffed in imperatively. React never re-renders the graph.
import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { useEffect, useRef } from 'react';
import { applyDiff, byId, diffElements } from './diff';
import type { Element } from './elements';
import { initialLayout, layoutAdded } from './layout';
import { COLORS, graphStylesheet } from './style';

cytoscape.use(fcose);

export interface CytoscapeGraphProps {
  elements: readonly Element[];
  className?: string;
}

const savedPositions = (elements: readonly Element[]): Set<string> =>
  new Set(elements.flatMap((el) => (el.group === 'nodes' && el.position ? [el.data.id] : [])));

export function CytoscapeGraph({ elements, className }: CytoscapeGraphProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  /** What's on the canvas, as last applied. */
  const applied = useRef<Map<string, Element>>(new Map());

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
    // Cytoscape only listens to window resizes; follow the container too (panels opening, etc.).
    const resize = new ResizeObserver(() => {
      cy.resize();
    });
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      cy.destroy();
      cyRef.current = null;
      applied.current = new Map();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const first = applied.current.size === 0;
    const diff = diffElements(applied.current, elements);
    applyDiff(cy, diff);
    applied.current = byId(elements);

    const saved = savedPositions(elements);
    if (first) initialLayout(cy, saved);
    else layoutAdded(cy, diff.add.nodes.map((n) => n.data.id), saved);
  }, [elements]);

  // Cytoscape forces `position: relative` on its container with an unlayered rule that beats Tailwind's
  // utilities, so the container must not be positioned by classes: the outer div is, the inner one fills it.
  return (
    <div className={className}>
      <div ref={container} style={{ width: '100%', height: '100%', background: COLORS.canvas }} />
    </div>
  );
}
