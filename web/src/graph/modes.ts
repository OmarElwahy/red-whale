// Layout modes (docs/architecture.md §8): Force (fcose; saved and dragged positions are kept) and Tree (ELK,
// graph/tree.ts). Kept out of the React wrapper so the rules can be tested on a headless Cytoscape:
// - Switching animates every node to its new place and fits the view.
// - Entering Tree remembers each node's Force position; going back restores them (new nodes get fcose).
// - Tree positions are never saved and never pin anything for Force.
// - In Tree mode, any change to the tree's shape re-runs the layout and animates there; tree runs are async,
//   and only the latest one lands (a newer run, Force mode or a destroyed canvas drops it).
import type { Core } from 'cytoscape';
import type { LayoutMode } from '@/state/view';
import type { ElementDiff } from './diff';
import type { Element } from './elements';
import { LAYOUT_ANIMATION_MS, animateTo, forceTargets, initialLayout, layoutAdded, type Position } from './layout';
import { layoutTree, treeInput, type TreeEngine } from './tree';

export interface LayoutModesOptions {
  initial: LayoutMode;
  engine: () => TreeEngine;
  /** Ends glides and easing zooms before anything moves on its own. */
  stopMotion: () => void;
  /** Animation length for a layout change (0 with reduced motion). */
  duration?: () => number;
  /** Nodes that stay put in Force layouts: saved positions and nodes dragged this session (shared, mutable). */
  pinned: Set<string>;
  onError?: (error: unknown) => void;
  /** A tree layout started (true) or the latest one finished or was abandoned (false). It can take seconds. */
  onBusy?: (busy: boolean) => void;
}

/** Whether a diff changes the tree's shape or sibling order, so Tree mode must lay out again. */
export function treeChanged(diff: ElementDiff, previous: ReadonlyMap<string, Element>): boolean {
  if (diff.add.nodes.length + diff.add.edges.length + diff.remove.length > 0) return true;
  return diff.update.some((el) => {
    const prev = previous.get(el.data.id);
    if (!prev || prev.group !== 'nodes' || el.group !== 'nodes') return false;
    return (
      prev.data.label !== el.data.label ||
      prev.data.severity !== el.data.severity ||
      prev.data.effectiveSeverity !== el.data.effectiveSeverity
    );
  });
}

/** New nodes in Tree mode start where their parent is, so they grow out of it when the tree animates. */
export function startAtParents(cy: Core, ids: readonly string[]): void {
  const added = new Set(ids);
  cy.batch(() => {
    for (const id of ids) {
      const node = cy.getElementById(id);
      const parent = node
        .incomers()
        .nodes()
        .filter((p) => !added.has(p.id()))[0];
      if (parent) node.position({ ...parent.position() });
    }
  });
}

export class LayoutModes {
  private current: LayoutMode;
  private forceSnapshot = new Map<string, Position>();
  private treeSeq = 0;
  private disposed = false;

  constructor(
    private readonly cy: Core,
    private readonly options: LayoutModesOptions,
  ) {
    this.current = options.initial;
  }

  get mode(): LayoutMode {
    return this.current;
  }

  /** Dragged positions are saved (and pinned) in Force mode only. */
  get savesPositions(): boolean {
    return this.current === 'force';
  }

  private duration(): number {
    return this.options.duration?.() ?? LAYOUT_ANIMATION_MS;
  }

  /** Lays the canvas out as a tree and animates there. Resolves when the result was applied or dropped. */
  async runTree(fit: boolean): Promise<void> {
    const seq = ++this.treeSeq;
    this.options.onBusy?.(true);
    let targets: Map<string, Position>;
    try {
      targets = await layoutTree(treeInput(this.cy), this.options.engine());
    } catch (error) {
      if (seq === this.treeSeq) this.options.onBusy?.(false);
      this.options.onError?.(error);
      return;
    }
    // A newer run (or Force mode) owns the busy flag now.
    if (seq !== this.treeSeq || this.disposed || this.current !== 'tree') return;
    this.options.onBusy?.(false);
    this.options.stopMotion();
    animateTo(this.cy, targets, { fit, duration: this.duration() });
  }

  /**
   * After new elements were diffed onto the canvas: Force places only the new nodes (everything else stays);
   * Tree re-runs the whole tree when its shape changed.
   */
  afterDiff(diff: ElementDiff, previous: ReadonlyMap<string, Element>): Promise<void> {
    const addedIds = diff.add.nodes.map((n) => n.data.id);
    // First paint, or a filter change that replaced every node: nothing to place the new nodes around.
    const firstPaint = addedIds.length > 0 && addedIds.length === this.cy.nodes().length;
    if (this.current === 'tree') {
      if (!firstPaint) startAtParents(this.cy, addedIds);
      return treeChanged(diff, previous) ? this.runTree(firstPaint) : Promise.resolve();
    }
    if (firstPaint) initialLayout(this.cy, this.options.pinned);
    else layoutAdded(this.cy, addedIds, this.options.pinned);
    return Promise.resolve();
  }

  /** Switches layout, animating every node and fitting the view. `saved` = saved positions by node ID. */
  switchTo(next: LayoutMode, saved: ReadonlyMap<string, Position>): Promise<void> {
    if (next === this.current) return Promise.resolve();
    this.current = next;
    this.options.stopMotion();
    if (next === 'tree') {
      this.forceSnapshot = new Map(this.cy.nodes().map((n) => [n.id(), { ...n.position() }]));
      return this.runTree(true);
    }
    this.treeSeq++; // a tree run still in flight must not land in Force mode
    this.options.onBusy?.(false);
    const remembered = new Map(saved);
    for (const [id, p] of this.forceSnapshot) remembered.set(id, p);
    this.forceSnapshot = new Map();
    animateTo(this.cy, forceTargets(this.cy, remembered, this.options.pinned), {
      fit: true,
      duration: this.duration(),
    });
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.treeSeq++;
  }
}
