// Tree layout (docs/architecture.md §8, "layout modes"): a top-down layered hierarchy over the parent edges
// (domain → subdomain → IP → port → URL → …), computed by ELK's layered algorithm. ELK handles DAGs (an IP shared
// by two subdomains) and, unlike dagre, can keep the sibling order we give it: riskiest first, then by label,
// so the tree is the same on every reload.
//
// Pure apart from the engine: `treeInput` reads the canvas, `treeGraph` builds ELK's input, `treePositions`
// maps ELK's answer back to node centers. The browser engine runs ELK in a Web Worker, loaded on first use.
import type { Core, NodeSingular } from 'cytoscape';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { SeverityKey } from './elements';
import { SEVERITY_KEYS } from './style';

export interface TreeNode {
  id: string;
  /** Box the layout must keep clear: the node and its label. */
  width: number;
  height: number;
  /** Where the node's position sits relative to the center of that box (labels hang below the node). */
  offset: { x: number; y: number };
  /** Effective severity (aggregates: their highest member). */
  risk: SeverityKey;
  label: string;
}

export interface TreeEdge {
  id: string;
  /** Parent. */
  source: string;
  /** Child. */
  target: string;
}

export interface TreeInput {
  nodes: TreeNode[];
  edges: TreeEdge[];
}

export type Position = { x: number; y: number };
export type TreeEngine = (graph: ElkNode) => Promise<ElkNode>;

export const TREE_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.randomSeed': '1',
  // Keep the order we feed (riskiest first) instead of reordering siblings to save a few crossings.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.spacing.nodeNode': '16',
  // One layering for everything, so every root (the domain, a node only named as a parent) is on the top row.
  'elk.separateConnectedComponents': 'false',
};

const riskRank = (s: SeverityKey): number => SEVERITY_KEYS.indexOf(s);

/** Riskiest first, then by label, then by id (so equal labels still sort the same way every time). */
export function compareSiblings(a: TreeNode, b: TreeNode): number {
  return riskRank(b.risk) - riskRank(a.risk) || a.label.localeCompare(b.label, 'en') || (a.id < b.id ? -1 : 1);
}

/**
 * The nodes in model order: a depth-first walk from the roots (nodes with no parent on the canvas), children
 * sorted with {@link compareSiblings}. A node with two parents is placed at its first visit. Anything only
 * reachable through a cycle is walked afterwards, from its riskiest node.
 */
export function treeOrder(input: TreeInput): TreeNode[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const children = new Map<string, TreeNode[]>();
  const hasParent = new Set<string>();
  for (const e of input.edges) {
    const child = byId.get(e.target);
    if (!child || !byId.has(e.source) || e.source === e.target) continue;
    hasParent.add(e.target);
    const list = children.get(e.source) ?? [];
    list.push(child);
    children.set(e.source, list);
  }
  for (const list of children.values()) list.sort(compareSiblings);

  const order: TreeNode[] = [];
  const seen = new Set<string>();
  const walk = (start: TreeNode) => {
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop() as TreeNode;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      order.push(n);
      const kids = children.get(n.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const kid = kids[i] as TreeNode;
        if (!seen.has(kid.id)) stack.push(kid);
      }
    }
  };
  const sorted = [...input.nodes].sort(compareSiblings);
  for (const n of sorted) if (!hasParent.has(n.id)) walk(n);
  for (const n of sorted) walk(n);
  return order;
}

/** ELK's input: nodes in model order with their sizes, edges in the same order. */
export function treeGraph(input: TreeInput): ElkNode {
  const order = treeOrder(input);
  const index = new Map(order.map((n, i) => [n.id, i]));
  const known = (e: TreeEdge) => index.has(e.source) && index.has(e.target) && e.source !== e.target;
  const edges = input.edges
    .filter(known)
    .sort(
      (a, b) =>
        (index.get(a.source) ?? 0) - (index.get(b.source) ?? 0) ||
        (index.get(a.target) ?? 0) - (index.get(b.target) ?? 0),
    );
  return {
    id: 'root',
    layoutOptions: { ...TREE_LAYOUT_OPTIONS },
    children: order.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
}

/** Node positions (centers, with each node's label offset) from ELK's result. */
export function treePositions(input: TreeInput, result: ElkNode): Map<string, Position> {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Position>();
  for (const c of result.children ?? []) {
    const n = byId.get(c.id);
    if (!n || c.x === undefined || c.y === undefined) continue;
    out.set(c.id, { x: c.x + n.width / 2 + n.offset.x, y: c.y + n.height / 2 + n.offset.y });
  }
  return out;
}

export async function layoutTree(input: TreeInput, engine: TreeEngine): Promise<Map<string, Position>> {
  if (input.nodes.length === 0) return new Map();
  return treePositions(input, await engine(treeGraph(input)));
}

const MIN_WIDTH = 30;

/** What's on the canvas, as tree input. Edges always point parent → child in our graph. */
export function treeInput(cy: Core): TreeInput {
  const nodes = cy.nodes().map((n: NodeSingular): TreeNode => {
    const bb = n.boundingBox({ includeLabels: true, includeOverlays: false });
    const center = { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
    const { x, y } = n.position();
    const kind = n.data('kind') as string;
    const risk = (kind === 'aggregate' ? n.data('severity') : n.data('effectiveSeverity')) as SeverityKey;
    return {
      id: n.id(),
      width: Math.max(bb.w, MIN_WIDTH),
      height: bb.h,
      offset: { x: x - center.x, y: y - center.y },
      risk,
      label: String(n.data('label')),
    };
  });
  const edges = cy.edges().map((e) => ({ id: e.id(), source: e.source().id(), target: e.target().id() }));
  return { nodes, edges };
}

let workerElk: Promise<{ layout: (g: ElkNode) => Promise<ElkNode> }> | null = null;

/** ELK in a Web Worker, so a 2,000-node layout never blocks the canvas. Loaded the first time Tree is used. */
export const browserTreeEngine: TreeEngine = async (graph) => {
  workerElk ??= Promise.all([import('elkjs/lib/elk-api.js'), import('elkjs/lib/elk-worker.min.js?url')]).then(
    ([api, worker]) => new api.default({ workerFactory: () => new Worker(worker.default) }),
  );
  return (await workerElk).layout(graph);
};
