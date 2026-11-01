// What the canvas shows is the server's grouped view (POST /api/graph/view, docs/architecture.md §7): the client
// only keeps which groups are open. These are the pure helpers around that view, unit-tested without a browser.
import type { AggregateNode, GraphResponse, GroupOpen, ViewNode, ViewState } from '@redwhale/shared';

/** The browser never holds more than ~2,000 elements (CLAUDE.md rule 7); the server enforces it. */
export const ELEMENT_BUDGET = 2000;
/** Head room kept free before allowing a neighbor expansion, whose size isn't known in advance. */
export const NEIGHBORS_RESERVE = 200;

type View = Pick<GraphResponse, 'nodes' | 'edges'>;

export interface ViewIndex {
  byId: Map<string, ViewNode>;
  /** Elements on the canvas (nodes + edges). */
  size: number;
  /** Member → the open group it hangs under (the first, if several). */
  memberOf: Map<string, AggregateNode>;
  /** Node or group → what hangs directly below it on the canvas. */
  children: Map<string, string[]>;
}

export function indexView(view: View): ViewIndex {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const memberOf = new Map<string, AggregateNode>();
  const children = new Map<string, string[]>();
  for (const e of view.edges) {
    const list = children.get(e.source);
    if (list) list.push(e.target);
    else children.set(e.source, [e.target]);
    if (e.kind !== 'member' || memberOf.has(e.target)) continue;
    const group = byId.get(e.source);
    if (group?.type === 'aggregate') memberOf.set(e.target, group);
  }
  return { byId, size: view.nodes.length + view.edges.length, memberOf, children };
}

/**
 * What the canvas shows directly, sent with the next request (`keep`): real edges to a parent's only child of
 * their kind, and nodes with nothing above them. If a live update folds one of them into a new group, the server
 * opens that group, so nothing the analyst is looking at disappears.
 */
export function keepFrom(view: View): { edges: string[]; roots: string[] } {
  const hasParent = new Set(view.edges.map((e) => e.target));
  return {
    edges: view.edges.filter((e) => e.kind === 'relation').map((e) => e.id),
    roots: view.nodes.filter((n) => n.type !== 'aggregate' && n.type !== 'more' && !hasParent.has(n.id)).map((n) => n.id),
  };
}

/** Everything drawn below a group (members, their groups, and so on), and the groups among it. */
export function below(ix: ViewIndex, groupId: string): { nodes: Set<string>; groups: string[] } {
  const nodes = new Set<string>();
  const groups: string[] = [];
  const stack = [...(ix.children.get(groupId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() ?? '';
    if (nodes.has(id) || id === groupId) continue;
    nodes.add(id);
    if (ix.byId.get(id)?.type === 'aggregate') groups.push(id);
    stack.push(...(ix.children.get(id) ?? []));
  }
  return { nodes, groups };
}

/** The groups hanging directly under a node. */
export function childGroups(ix: ViewIndex, nodeId: string): string[] {
  return (ix.children.get(nodeId) ?? []).filter((id) => ix.byId.get(id)?.type === 'aggregate');
}

/** Is the view the server applied the one the client asked for? */
export function sameState(applied: ViewState, asked: { expand: readonly GroupOpen[]; neighbors: readonly string[] }): boolean {
  const key = (x: GroupOpen) => `${x.id}@${String(x.pages)}:${[...x.pins].sort().join(',')}`;
  return (
    applied.neighbors.join('|') === asked.neighbors.join('|') &&
    applied.expand.map(key).join('|') === asked.expand.map(key).join('|')
  );
}

export function canExpandNeighbors(ix: Pick<ViewIndex, 'size'>, budget = ELEMENT_BUDGET): boolean {
  return ix.size + NEIGHBORS_RESERVE <= budget;
}
