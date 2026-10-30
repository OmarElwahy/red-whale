import { beforeEach, describe, expect, test } from 'vitest';
import { initialUiState, useUi } from '../src/state/ui';

const A = 'agg:0123456789abcdef:has_subdomain:subdomain';
const B = 'agg:root:ip';
const ui = () => useUi.getState();

describe('UI state', () => {
  beforeEach(() => {
    useUi.setState(initialUiState);
  });

  test('expanding loads page 1; expanding again loads the next page', () => {
    ui().expand(A);
    ui().expand(B);
    ui().expand(A);
    expect(ui().expanded).toEqual([
      { id: A, pages: 2 },
      { id: B, pages: 1 },
    ]);
  });

  test('collapse forgets the expansion and the neighborhoods opened from its members', () => {
    ui().expand(A);
    ui().expandNeighbors('m1');
    ui().expandNeighbors('other');
    ui().collapse(A, ['m1', 'm2']);
    expect(ui().expanded).toEqual([]);
    expect(ui().neighbors).toEqual(['other']);
  });

  test('collapsing the group of the selected node selects the group instead, and drops its focus', () => {
    ui().expand(A);
    ui().select('m2');
    ui().focus('m2');
    ui().collapse(A, ['m1', 'm2']);
    expect(ui().selectedId).toBe(A);
    expect(ui().focusId).toBeNull();
  });

  test('expanding the same neighborhood twice is a no-op', () => {
    ui().expandNeighbors('n');
    ui().expandNeighbors('n');
    expect(ui().neighbors).toEqual(['n']);
  });

  test('every action closes the context menu', () => {
    const acts = [
      () => {
        ui().select('x');
      },
      () => {
        ui().focus('x');
      },
      () => {
        ui().expand(A);
      },
      () => {
        ui().expandNeighbors('x');
      },
    ];
    for (const act of acts) {
      ui().openMenu({ id: 'x', x: 1, y: 2 });
      act();
      expect(ui().menu).toBeNull();
    }
  });

  test('reveal remembers the node once and asks to center on it once shown', () => {
    ui().select('n1');
    ui().reveal('n1');
    ui().reveal('n1');
    expect(ui().revealed).toEqual(['n1']);
    expect(ui().centerWhenShown).toBe('n1');
    // Selecting something else drops the pending center, but the node stays on the graph.
    ui().select('n2');
    expect(ui().centerWhenShown).toBeNull();
    expect(ui().revealed).toEqual(['n1']);
  });

  test('a filter change drops reveals and sends the table back to page 1, keeping its sort', () => {
    ui().reveal('n1');
    ui().setTableSort('label');
    ui().setTablePage(4);
    ui().clearOverlays();
    expect(ui().revealed).toEqual([]);
    expect(ui().centerWhenShown).toBeNull();
    expect(ui().table).toEqual({ page: 1, sort: 'label' });
  });

  test('a new sort starts at page 1', () => {
    ui().setTablePage(3);
    ui().setTableSort('-lastSeen');
    expect(ui().table).toEqual({ page: 1, sort: '-lastSeen' });
  });

  test('the bottom panel toggles, and switches between table and highlights', () => {
    ui().toggleBottomPanel('table');
    expect(ui().bottomPanel).toBe('table');
    ui().toggleBottomPanel('highlights');
    expect(ui().bottomPanel).toBe('highlights');
    ui().toggleBottomPanel('highlights');
    expect(ui().bottomPanel).toBeNull();
  });
});
