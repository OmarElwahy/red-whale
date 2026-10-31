// The Cytoscape wrapper (CLAUDE.md rule 6, docs/architecture.md §8). Cytoscape owns the canvas: the instance
// is created once, and new elements are diffed in imperatively. React never re-renders the graph.
//
// Feel: the canvas never changes how it draws mid-gesture (no texture or hidden edges while moving); pans and
// node drags carry momentum (momentum.ts), the wheel zooms smoothly toward the cursor (wheel.ts), and labels
// fade in and out at the readability threshold (labels.ts). Layout modes (modes.ts): Force and Tree, animated
// between; Tree positions are never saved.
import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { LayoutMode } from '@/state/view';
import { benchCanvas, type BenchOptions, type BenchResult } from './bench';
import { applyDiff, byId, diffElements } from './diff';
import type { Element } from './elements';
import { applyFocus, applyMute, applySearchPath, focusNeighborhood } from './emphasis';
import { bindGraphEvents, syncSelection, type GraphHandlers } from './events';
import { graphPng } from './export';
import { flash, flashIds } from './flash';
import { bindLabelFade } from './labels';
import { LAYOUT_ANIMATION_MS, type Position } from './layout';
import { LayoutModes } from './modes';
import { bindMomentum, type Momentum } from './momentum';
import { motionMs, prefersReducedMotion } from './reducedMotion';
import { COLORS, graphStylesheet } from './style';
import { bindSubtreeDrag, type SubtreeDrag } from './subtree';
import { browserTreeEngine, type TreeEngine } from './tree';
import { bindWheelZoom, type WheelZoom } from './wheel';

cytoscape.use(fcose);

/** What the app can ask of the canvas directly. */
export interface GraphHandle {
  /** The whole loaded graph as a PNG, or null before the canvas exists. */
  png: () => Blob | null;
}

export interface CytoscapeGraphProps {
  ref?: Ref<GraphHandle>;
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
  /** IDs named by recent live updates: when they first appear on the canvas, they flash. */
  fresh: ReadonlyMap<string, number>;
  layout: LayoutMode;
  /** Tree mode: re-run the tree and fit when this changes (the Re-layout button). */
  relayoutSeq: number;
  handlers: GraphHandlers;
  /** Runs the tree layout (default: ELK in a Web Worker). */
  treeEngine?: TreeEngine;
  /** A tree layout is running (it can take seconds near the element cap). */
  onLayoutBusy?: (busy: boolean) => void;
  className?: string;
}

const savedPositions = (elements: ReadonlyMap<string, Element>): Map<string, Position> => {
  const out = new Map<string, Position>();
  for (const [id, el] of elements) if (el.group === 'nodes' && el.position) out.set(id, el.position);
  return out;
};

export function CytoscapeGraph({
  ref,
  elements,
  selectedId,
  focusId,
  hops,
  mute,
  query,
  centerOn,
  fresh,
  layout,
  relayoutSeq,
  handlers,
  treeEngine = browserTreeEngine,
  onLayoutBusy,
  className,
}: CytoscapeGraphProps) {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  /** What's on the canvas, as last applied. */
  const applied = useRef<Map<string, Element>>(new Map());
  /** Nodes that stay where they are when Force layouts run: saved positions, plus nodes dragged this session. */
  const pinned = useRef<Set<string>>(new Set());
  const handlersRef = useRef(handlers);
  const freshRef = useRef(fresh);
  const engineRef = useRef(treeEngine);
  const busyRef = useRef(onLayoutBusy);
  const initialLayoutMode = useRef(layout);
  const modes = useRef<LayoutModes | null>(null);
  const motion = useRef<{ momentum: Momentum; wheel: WheelZoom; subtree: SubtreeDrag } | null>(null);
  const firstRelayout = useRef(relayoutSeq);
  useEffect(() => {
    handlersRef.current = handlers;
    freshRef.current = fresh;
    engineRef.current = treeEngine;
    busyRef.current = onLayoutBusy;
  });

  useImperativeHandle(ref, () => ({ png: () => (cyRef.current ? graphPng(cyRef.current) : null) }), []);

  useEffect(() => {
    if (!container.current || !host.current) return;
    const cy = cytoscape({
      container: container.current,
      style: graphStylesheet(),
      minZoom: 0.05,
      maxZoom: 4,
      // Draw the real graph at every moment: no bitmap stand-in, hidden edges or blur while moving.
      textureOnViewport: false,
      hideEdgesOnViewport: false,
      hideLabelsOnViewport: false,
      motionBlur: false,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    const unbind = bindGraphEvents(cy, () => handlersRef.current);
    const stopMotion = () => {
      motion.current?.momentum.stop();
      motion.current?.wheel.stop();
    };
    const layoutModes = new LayoutModes(cy, {
      initial: initialLayoutMode.current,
      engine: () => engineRef.current,
      stopMotion,
      duration: () => motionMs(LAYOUT_ANIMATION_MS),
      pinned: pinned.current,
      onError: (error) => {
        console.error('tree layout failed', error);
      },
      onBusy: (busy) => {
        busyRef.current?.(busy);
      },
    });
    modes.current = layoutModes;
    const subtree = bindSubtreeDrag(cy, () => layoutModes.mode === 'tree');
    const momentum = bindMomentum(cy, {
      reducedMotion: prefersReducedMotion,
      onRest: (node) => {
        subtree.end();
        if (!layoutModes.savesPositions) return;
        const { x, y } = node.position();
        pinned.current.add(node.id());
        handlersRef.current.onMoved([{ id: node.id(), x, y }]);
      },
    });
    const wheel = bindWheelZoom(cy, host.current, {
      onStart: () => {
        momentum.stop();
      },
      reducedMotion: prefersReducedMotion,
    });
    motion.current = { momentum, wheel, subtree };
    const unbindLabels = bindLabelFade(cy);
    // Cytoscape only listens to window resizes; follow the container too (panels opening, etc.).
    const resize = new ResizeObserver(() => {
      cy.resize();
    });
    resize.observe(container.current);
    const devWindow = window as Window & { redwhale?: { bench: (o?: BenchOptions) => Promise<BenchResult>; cy: Core } };
    if (import.meta.env.DEV) devWindow.redwhale = { bench: (o) => benchCanvas(cy, o), cy };
    const pinnedSet = pinned.current;
    return () => {
      if (import.meta.env.DEV) delete devWindow.redwhale;
      resize.disconnect();
      unbindLabels();
      wheel.dispose();
      momentum.dispose();
      subtree.dispose();
      layoutModes.dispose();
      motion.current = null;
      modes.current = null;
      unbind();
      cy.destroy();
      cyRef.current = null;
      applied.current = new Map();
      pinnedSet.clear();
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !modes.current) return;
    const diff = diffElements(applied.current, elements);
    const previous = applied.current;
    applyDiff(cy, diff);
    applied.current = byId(elements);
    for (const id of savedPositions(applied.current).keys()) pinned.current.add(id);
    const firstPaint = diff.add.nodes.length > 0 && diff.add.nodes.length === cy.nodes().length;
    void modes.current.afterDiff(diff, previous);
    if (!firstPaint) flash(cy, flashIds(diff, previous, freshRef.current));
  }, [elements]);

  useEffect(() => {
    void modes.current?.switchTo(layout, savedPositions(applied.current));
    motion.current?.subtree.end();
  }, [layout]);

  // Re-layout button: back to the clean tree, fitted.
  useEffect(() => {
    if (relayoutSeq === firstRelayout.current || modes.current?.mode !== 'tree') return;
    void modes.current.runTree(true);
  }, [relayoutSeq]);

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
    if (bright.empty()) return;
    motion.current?.momentum.stop();
    motion.current?.wheel.stop();
    cy.animate({ fit: { eles: bright, padding: 80 }, duration: motionMs(300) });
  }, [focusId, hops]);

  // Search jump: pan to the node, zooming in if the view is too far out to read labels.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || centerOn === null) return;
    const node = cy.getElementById(centerOn.id);
    if (node.empty()) return;
    const zoom = Math.max(cy.zoom(), 1);
    const { x, y } = node.position();
    motion.current?.momentum.stop();
    motion.current?.wheel.stop();
    cy.stop();
    cy.animate({
      zoom,
      pan: { x: cy.width() / 2 - x * zoom, y: cy.height() / 2 - y * zoom },
      duration: motionMs(300),
    });
  }, [centerOn]);

  // Cytoscape forces `position: relative` on its container with an unlayered rule that beats Tailwind's
  // utilities, so the container must not be positioned by classes: the outer div is, the inner one fills it.
  // The outer div also takes the wheel over (wheel.ts).
  return (
    <div ref={host} className={className}>
      <div ref={container} style={{ width: '100%', height: '100%', background: COLORS.canvas }} />
    </div>
  );
}
