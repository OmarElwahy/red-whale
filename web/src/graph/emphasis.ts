// What stands out on the canvas: focus mode, muting low-risk nodes, and dimming the path above search matches.
// Each is a class toggled imperatively (CLAUDE.md rule 6) and styled in style.ts, and each works only on what's
// already on the canvas: nothing here fetches.
import { matchesQuery } from '@redwhale/shared';
import type { Collection, Core, NodeCollection, NodeSingular } from 'cytoscape';
import type { SeverityKey } from './elements';

/** Everything outside the focused neighborhood. */
export const FADED = 'faded';
/** Low-risk nodes, and edges touching them, when "mute low-risk" is on. */
export const MUTED = 'muted';
/** With a search, the nodes kept only as the path up to a match (the server's `q` keeps ancestors). */
export const SEARCH_PATH = 'search-path';

/**
 * The node, every node within `hops` steps of it (edges in either direction), and the edges among them.
 * Empty when the node isn't on the canvas.
 */
export function focusNeighborhood(cy: Core, id: string, hops: number): Collection {
  let nodes: NodeCollection = cy.getElementById(id).nodes();
  if (nodes.empty()) return cy.collection();
  for (let i = 0; i < hops; i++) nodes = nodes.union(nodes.neighborhood().nodes());
  const edges = nodes.connectedEdges().filter((e) => nodes.has(e.source()) && nodes.has(e.target()));
  return nodes.union(edges);
}

/**
 * Focus: the node's N-hop neighborhood stays bright, everything else is faded. Returns the bright part, or null
 * when focus is cleared (or the node isn't on the canvas).
 */
export function applyFocus(cy: Core, id: string | null, hops = 1): Collection | null {
  const bright = id === null ? cy.collection() : focusNeighborhood(cy, id, hops);
  if (bright.empty()) {
    cy.elements().removeClass(FADED);
    return null;
  }
  cy.batch(() => {
    bright.removeClass(FADED);
    cy.elements().difference(bright).addClass(FADED);
  });
  return bright;
}

/** Below medium. Muting uses effective severity, so a quiet parent above a critical finding stays bright. */
export const LOW_RISK: readonly SeverityKey[] = ['none', 'info', 'low'];

/** Nodes by effective severity; aggregates by their `severity`, which is the members' highest effective severity. */
const LOW_RISK_SELECTOR = LOW_RISK.flatMap((s) => [
  `node[kind = "node"][effectiveSeverity = "${s}"]`,
  `node[kind = "aggregate"][severity = "${s}"]`,
]).join(', ');

export function applyMute(cy: Core, on: boolean): void {
  cy.batch(() => {
    cy.elements().removeClass(MUTED);
    if (!on) return;
    const low = cy.nodes(LOW_RISK_SELECTOR);
    low.addClass(MUTED);
    low.connectedEdges().addClass(MUTED);
  });
}

function isMatch(node: NodeSingular, q: string): boolean {
  const value: unknown = node.data('value');
  const label: unknown = node.data('label');
  return typeof value === 'string' && typeof label === 'string' && matchesQuery({ value, label }, q);
}

/** With a search, dims the nodes that don't match themselves. Aggregates are left alone: they're groups. */
export function applySearchPath(cy: Core, q: string | undefined): void {
  cy.batch(() => {
    cy.nodes().removeClass(SEARCH_PATH);
    if (q === undefined) return;
    cy.nodes('[kind = "node"]')
      .filter((n) => !isMatch(n, q))
      .addClass(SEARCH_PATH);
  });
}
