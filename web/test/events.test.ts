import type { Core } from 'cytoscape';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { toElements } from '../src/graph/elements';
import { bindGraphEvents, syncSelection, type GraphHandlers } from '../src/graph/events';
import { aggregate, edge, headless, node } from './fixtures';

const AGG = 'agg:0123456789abcdef:has_subdomain:subdomain';

function setup() {
  const cy = headless();
  cy.add(
    toElements({
      nodes: [node('a', { type: 'domain' }), node('b'), node('c'), node('d'), aggregate({ id: AGG })],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('c', 'd'), edge('a', AGG)],
    }),
  );
  return cy;
}

function spies() {
  return {
    onSelect: vi.fn<GraphHandlers['onSelect']>(),
    onExpand: vi.fn<GraphHandlers['onExpand']>(),
    onContextMenu: vi.fn<GraphHandlers['onContextMenu']>(),
    onMoved: vi.fn<GraphHandlers['onMoved']>(),
  };
}

describe('bindGraphEvents', () => {
  let cy: Core;
  let h: ReturnType<typeof spies>;
  let unbind: () => void;
  beforeEach(() => {
    cy = setup();
    h = spies();
    unbind = bindGraphEvents(cy, () => h);
  });
  afterEach(() => {
    cy.destroy();
  });

  test('clicking a node selects it; clicking the background clears the selection', () => {
    cy.getElementById('b').emit('tap');
    cy.emit('tap');
    expect(h.onSelect.mock.calls).toEqual([['b'], [null]]);
  });

  test('double-clicking an aggregate expands it', () => {
    cy.getElementById(AGG).emit('dbltap');
    expect(h.onExpand).toHaveBeenCalledWith(AGG);
  });

  test('double-clicking an ordinary node does not expand anything', () => {
    cy.getElementById('b').emit('dbltap');
    expect(h.onExpand).not.toHaveBeenCalled();
  });

  test('right-click opens the menu at the rendered position of the click', () => {
    cy.getElementById('c').emit({ type: 'cxttap', renderedPosition: { x: 120, y: 45 } } as never);
    expect(h.onContextMenu).toHaveBeenCalledWith({ id: 'c', x: 120, y: 45 });
  });

  test('the end of a drag is left to graph/momentum.ts (it reports the resting position)', () => {
    cy.getElementById('d').emit('dragfree');
    expect(h.onMoved).not.toHaveBeenCalled();
  });

  test('the latest handlers are used without rebinding', () => {
    const next = spies();
    h = next;
    cy.getElementById('b').emit('tap');
    expect(next.onSelect).toHaveBeenCalledWith('b');
  });

  test('unbinding stops all callbacks', () => {
    unbind();
    cy.getElementById('b').emit('tap');
    cy.getElementById(AGG).emit('dbltap');
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onExpand).not.toHaveBeenCalled();
  });
});

describe('syncSelection', () => {
  test('selects exactly the given node, or nothing', () => {
    const cy = setup();
    cy.getElementById('b').select();
    syncSelection(cy, 'c');
    expect(cy.$(':selected').map((e) => e.id())).toEqual(['c']);
    syncSelection(cy, null);
    expect(cy.$(':selected').length).toBe(0);
  });
});
