// Layout modes (docs/architecture.md §8): Force (fcose; saved and dragged positions are kept) and Tree (ELK,
// graph/tree.ts). Kept out of the React wrapper so the rules can be tested on a headless Cytoscape:
// - Switching animates every node to its new place and fits the view.
// - Entering Tree remembers each node's Force position; going back restores them (new nodes get fcose).
// - Tree positions are never saved and never pin anything for Force.
// - In Tree mode, any change to the tree's shape re-runs the layout and animates there; tree runs are async,
//   and only the latest one lands (a newer run, Force mode or a destroyed canvas drops it).
// - Nodes the analyst dropped in Tree mode stay where they were dropped through re-runs (and a trip to Force and
//   back), their subtrees laid out under them; Re-layout forgets them.
import type { Core, NodeSingular } from 'cytoscape';
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

/**
 * Where each new node grows out of: its nearest ancestor that was already on the canvas, walking up through other
 * new nodes. So everything an expand brings in (the group's members, and the groups under them) comes out of the
 * group that was opened. A node with no such ancestor (a new root) has no origin and appears where it is.
 */
export function growOrigins(cy: Core, ids: readonly string[]): Map<string, Position> {
  const added = new Set(ids);
  const memo = new Map<string, Position | null>();
  const originOf = (id: string, path: Set<string>): Position | null => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    path.add(id);
    const parents = cy
      .getElementById(id)
      .incomers()
      .nodes()
      .filter((p) => !p.hasClass('retiring'));
    let found: Position | null = null;
    const old = parents.filter((p) => !added.has(p.id()))[0];
    if (old) found = { ...old.position() };
    else {
      for (const p of parents) {
        if (path.has(p.id())) continue;
        found = originOf(p.id(), path);
        if (found) break;
      }
    }
    path.delete(id);
    memo.set(id, found);
    return found;
  };
  const out = new Map<string, Position>();
  for (const id of ids) {
    const from = originOf(id, new Set());
    if (from) out.set(id, from);
  }
  return out;
}

/** New nodes in Tree mode start where they grow out of (`growOrigins`), so the tree animation brings them out. */
export function startAtParents(cy: Core, ids: readonly string[]): void {
  const origins = growOrigins(cy, ids);
  cy.batch(() => {
    for (const [id, from] of origins) cy.getElementById(id).position(from);
  });
}

export class LayoutModes {
  private current: LayoutMode;
  private forceSnapshot = new Map<string, Position>();
  private treeSeq = 0;
  private disposed = false;
  /** Force mode: nodes gliding out of their parent, and where they'll stop. */
  private growing = new Map<string, Position>();
  /** Tree mode: where the last tree run put every node in the clean tree (before the analyst's drops). */
  private treeTargets = new Map<string, Position>();
  /**
   * Tree mode: where the analyst dropped nodes (each carried its subtree). A re-run puts each one back there, with
   * its subtree laid out under it; Re-layout forgets them all. Kept for nodes that leave the canvas (a collapse),
   * so they come back where they were.
   */
  private drops = new Map<string, Position>();
  /** How far the last tree run moved each dropped node's subtree off the clean tree. */
  private dropShifts = new Map<string, Position>();
  /** Back from Force: the next tree run is in a new frame, so drops are re-placed by `dropShifts`, then re-read. */
  private rebaseDrops = false;

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

  /**
   * Lays the canvas out as a tree and animates there. Resolves when the result was applied or dropped.
   *
   * Without `fit`, the camera stays put and so does what the analyst is looking at: the new tree is shifted so the
   * `anchor` (the node they just expanded or collapsed) keeps its place; with no usable anchor, the node nearest the
   * middle of the view does. A tree re-centers parents over their children, so otherwise the clicked group would
   * jump sideways on every expand, which reads as the camera moving. Tree positions are never saved, so the shift
   * is free.
   */
  async runTree(fit: boolean, anchor: string | null = null, fresh: ReadonlySet<string> = new Set()): Promise<void> {
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
    this.growing.clear();
    if (!fit) targets = this.keepInPlace(targets, anchor, fresh);
    this.treeTargets = targets;
    animateTo(this.cy, this.withDrops(targets), { fit, duration: this.duration() });
  }

  /** Tree mode: back to the clean tree, fitted (the Re-layout button). Forgets every drop. */
  relayout(): Promise<void> {
    this.drops.clear();
    this.dropShifts.clear();
    this.rebaseDrops = false;
    return this.runTree(true);
  }

  /**
   * Tree mode: the analyst dropped this node (after any glide) and its subtree came along. Remember where, so tree
   * re-runs keep it there; drops below it moved with it, so they're re-read too. Force mode: nothing to do.
   */
  noteTreeDrop(id: string): void {
    if (this.current !== 'tree') return;
    const n = this.cy.getElementById(id);
    if (n.empty()) return;
    this.drops.set(id, { ...n.position() });
    n.successors()
      .nodes()
      .forEach((m) => {
        if (this.drops.has(m.id())) this.drops.set(m.id(), { ...m.position() });
      });
  }

  /** Dropped nodes on the canvas that the clean tree places, ancestors before their descendants. */
  private droppedNodes(clean: ReadonlyMap<string, Position>): NodeSingular[] {
    const out: NodeSingular[] = [];
    for (const id of this.drops.keys()) {
      const n = this.cy.getElementById(id);
      if (n.nonempty() && n.isNode() && !n.hasClass('retiring') && clean.has(id)) out.push(n);
    }
    // A node's ancestors are all among its descendants' ancestors, so fewer ancestors = placed first.
    return out.sort((p, q) => p.predecessors().nodes().length - q.predecessors().nodes().length);
  }

  /**
   * The clean tree with the analyst's drops applied: each dropped node goes back where it was dropped and its
   * subtree (as the tree lays it out now, new nodes included) shifts with it.
   */
  private withDrops(clean: ReadonlyMap<string, Position>): Map<string, Position> {
    const out = new Map(clean);
    const shifts = new Map<string, Position>();
    const dropped = this.droppedNodes(clean);
    for (const n of dropped) {
      const now = out.get(n.id());
      const to = this.drops.get(n.id());
      if (!now || !to) continue;
      const d = this.rebaseDrops ? (this.dropShifts.get(n.id()) ?? { x: 0, y: 0 }) : { x: to.x - now.x, y: to.y - now.y };
      shifts.set(n.id(), d);
      if (d.x === 0 && d.y === 0) continue;
      n.union(n.successors().nodes()).forEach((m) => {
        const p = out.get(m.id());
        if (p) out.set(m.id(), { x: p.x + d.x, y: p.y + d.y });
      });
    }
    if (this.rebaseDrops) {
      // A new frame (back from Force): drops not on the canvas can't be placed in it any more.
      this.drops = new Map();
      for (const n of dropped) {
        const p = out.get(n.id());
        if (p) this.drops.set(n.id(), p);
      }
      this.rebaseDrops = false;
    }
    this.dropShifts = shifts;
    return out;
  }

  /** Nodes a drop decides the place of: dropped nodes and everything below them. */
  private dropCovered(): Set<string> {
    const out = new Set<string>();
    for (const n of this.droppedNodes(this.treeTargets)) {
      out.add(n.id());
      n.successors()
        .nodes()
        .forEach((m) => {
          out.add(m.id());
        });
    }
    return out;
  }

  /** Where a node is in the tree as it stands: the last run's target (it may still be animating there). */
  private settled(id: string): Position {
    return this.treeTargets.get(id) ?? { ...this.cy.getElementById(id).position() };
  }

  /** Shifts the whole new tree so one node (the anchor, else the one nearest the view's middle) doesn't move. */
  private keepInPlace(
    targets: Map<string, Position>,
    anchor: string | null,
    fresh: ReadonlySet<string>,
  ): Map<string, Position> {
    let id = anchor !== null && targets.has(anchor) ? anchor : null;
    if (id === null) {
      // A node a drop places doesn't move with the clean tree, so it can't be what keeps the view steady.
      const covered = this.dropCovered();
      const zoom = this.cy.zoom();
      const pan = this.cy.pan();
      const mid = { x: (this.cy.width() / 2 - pan.x) / zoom, y: (this.cy.height() / 2 - pan.y) / zoom };
      let best = Infinity;
      for (const candidate of targets.keys()) {
        if (fresh.has(candidate) || covered.has(candidate)) continue;
        const p = this.settled(candidate);
        const d = Math.hypot(p.x - mid.x, p.y - mid.y);
        if (d < best) {
          best = d;
          id = candidate;
        }
      }
    }
    const to = id === null ? undefined : targets.get(id);
    if (id === null || !to) return targets;
    const at = this.settled(id);
    const dx = at.x - to.x;
    const dy = at.y - to.y;
    if (dx === 0 && dy === 0) return targets;
    return new Map([...targets].map(([k, p]) => [k, { x: p.x + dx, y: p.y + dy }]));
  }

  /**
   * After new elements were diffed onto the canvas: Force places only the new nodes (everything else stays);
   * Tree re-runs the whole tree when its shape changed.
   */
  afterDiff(diff: ElementDiff, previous: ReadonlyMap<string, Element>, anchor: string | null = null): Promise<void> {
    const addedIds = diff.add.nodes.map((n) => n.data.id);
    // First paint, or a filter change that replaced every node: nothing to place the new nodes around.
    const firstPaint = addedIds.length > 0 && addedIds.length === this.cy.nodes().length;
    if (this.current === 'tree') {
      if (!firstPaint) startAtParents(this.cy, addedIds);
      return treeChanged(diff, previous) ? this.runTree(firstPaint, anchor, new Set(addedIds)) : Promise.resolve();
    }
    if (firstPaint) {
      initialLayout(this.cy, this.options.pinned);
      return Promise.resolve();
    }
    // Where they come from is read before the layout (nothing already on the canvas moves in it).
    const origins = growOrigins(this.cy, addedIds);
    layoutAdded(this.cy, addedIds, this.options.pinned);
    this.grow(origins);
    return Promise.resolve();
  }

  /** Where a node that is growing out of its parent will come to rest (for centering on it mid-animation). */
  growTarget(id: string): Position | undefined {
    return this.growing.get(id);
  }

  /**
   * Force mode: the new nodes are laid out; move each back to where it grows out of and glide it to its place
   * (the counterpart of a collapse sliding members into their group). No animation with reduced motion.
   */
  private grow(origins: ReadonlyMap<string, Position>): void {
    const duration = this.duration();
    if (duration <= 0 || origins.size === 0) return;
    const moves: { id: string; to: Position }[] = [];
    this.cy.batch(() => {
      for (const [id, from] of origins) {
        const node = this.cy.getElementById(id);
        if (node.empty()) continue;
        const to = { ...node.position() };
        this.growing.set(id, to);
        moves.push({ id, to });
        node.position(from);
      }
    });
    for (const { id, to } of moves) {
      this.cy.getElementById(id).animate(
        { position: to },
        {
          duration,
          easing: 'ease-out',
          complete: () => {
            this.growing.delete(id);
          },
        },
      );
    }
  }

  /** Switches layout, animating every node and fitting the view. `saved` = saved positions by node ID. */
  switchTo(next: LayoutMode, saved: ReadonlyMap<string, Position>): Promise<void> {
    if (next === this.current) return Promise.resolve();
    this.current = next;
    this.options.stopMotion();
    this.growing.clear();
    if (next === 'tree') {
      this.forceSnapshot = new Map(this.cy.nodes().map((n) => [n.id(), { ...n.position() }]));
      return this.runTree(true);
    }
    this.treeSeq++; // a tree run still in flight must not land in Force mode
    // Remember each drop as its shift off the clean tree (drops since the last run included): the next tree run
    // is in a new frame. Already pending (Tree was left before its first run landed): the shifts stand.
    if (!this.rebaseDrops) this.withDrops(this.treeTargets);
    this.rebaseDrops = true;
    this.options.onBusy?.(false);
    const remembered = new Map(saved);
    for (const [id, p] of this.forceSnapshot) remembered.set(id, p);
    this.forceSnapshot = new Map();
    this.treeTargets = new Map();
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
