import { beforeEach, describe, expect, test } from 'vitest';
import { initialUiState, useUi } from '../src/state/ui';

const A = 'agg:0123456789abcdef:has_subdomain:subdomain';
const B = 'agg:root:ip';
const C = 'agg:1111111111111111:resolves_to:ip';
const ui = () => useUi.getState();
const open = (id: string, pages = 1, pins: string[] = []) => ({ id, pages, pins });

describe('UI state', () => {
  beforeEach(() => {
    useUi.setState(initialUiState);
  });

  test('expanding opens the first page once; loading more adds a page and moves the group last', () => {
    ui().expandGroup(A);
    ui().expandGroup(B);
    ui().expandGroup(A);
    expect(ui().expanded).toEqual([open(A), open(B)]);
    ui().loadMore(A);
    expect(ui().expanded).toEqual([open(B), open(A, 2)]);
  });

  test('expanding a group opened only for its pins loads its first page and keeps the pins', () => {
    ui().openPath('m9', [{ groupId: A, memberId: 'm9' }]);
    ui().expandGroup(A);
    expect(ui().expanded).toEqual([open(A, 1, ['m9'])]);
  });

  test('collapse closes only that group; the server then drops what was open below it', () => {
    ui().expandGroup(A);
    ui().expandGroup(C);
    ui().collapse(A, ['m1', 'm2', C]);
    expect(ui().expanded).toEqual([open(C)]);
    // The answer for that state no longer has C (its parent is folded): adopting it is the recursive collapse.
    ui().adoptView({ expand: [], neighbors: [] });
    expect(ui().expanded).toEqual([]);
  });

  test('collapsing the group of the selected node selects the group instead, drops its focus, and slides', () => {
    ui().expandGroup(A);
    ui().select('m2');
    ui().focus('m2');
    ui().collapse(A, ['m1', 'm2']);
    expect(ui().selectedId).toBe(A);
    expect(ui().focusId).toBeNull();
    expect(ui().collapsing).toMatchObject({ groupId: A, nodes: ['m1', 'm2'] });
  });

  test('collapse all below closes the groups below and keeps the group itself open', () => {
    ui().expandGroup(A);
    ui().expandGroup(C);
    ui().expandGroup(B);
    ui().select('ip1');
    ui().collapseBelow(A, [C], ['ip1']);
    expect(ui().expanded).toEqual([open(A), open(B)]);
    expect(ui().selectedId).toBe(A);
  });

  test('expand neighbors remembers the node once and opens the groups under it', () => {
    ui().expandNeighbors('n', [C]);
    ui().expandNeighbors('n', [C]);
    expect(ui().neighbors).toEqual(['n']);
    expect(ui().expanded).toEqual([open(C)]);
  });

  test('expand all below is a one-shot request, cleared when the answer is adopted', () => {
    ui().expandAllBelow('d');
    ui().expandAllBelow('d');
    expect(ui().expandAll).toEqual(['d']);
    ui().adoptView({ expand: [open(A), open(C)], neighbors: [] });
    expect(ui().expandAll).toEqual([]);
    expect(ui().expanded).toEqual([open(A), open(C)]);
  });

  test('opening a path pins each step and asks to center on the node once it is drawn', () => {
    ui().expandGroup(A);
    ui().openPath('port', [
      { groupId: A, memberId: 'sub' },
      { groupId: C, memberId: 'port' },
    ]);
    expect(ui().expanded).toEqual([open(A, 1, ['sub']), open(C, 0, ['port'])]);
    expect(ui().centerWhenShown).toBe('port');
    // Selecting something else drops the pending center; the groups stay open.
    ui().select('other');
    expect(ui().centerWhenShown).toBeNull();
  });

  test('every expand/collapse action anchors the node it acted on, once per action', () => {
    const seen: (string | undefined)[] = [];
    const seqs = new Set<number>();
    const record = () => {
      seen.push(ui().anchor?.id);
      seqs.add(ui().anchor?.seq ?? -1);
    };
    ui().expandGroup(A);
    record();
    ui().loadMore(A);
    record();
    ui().collapseBelow(A, [C], []);
    record();
    ui().collapse(A, []);
    record();
    ui().expandNeighbors('n', []);
    record();
    ui().expandAllBelow('d');
    record();
    ui().openPath('port', []);
    record();
    expect(seen).toEqual([A, A, A, A, 'n', 'd', 'port']);
    expect(seqs.size).toBe(7);
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
        ui().expandGroup(A);
      },
      () => {
        ui().loadMore(A);
      },
      () => {
        ui().collapse(A, []);
      },
      () => {
        ui().expandNeighbors('x', []);
      },
      () => {
        ui().expandAllBelow('x');
      },
    ];
    for (const act of acts) {
      ui().openMenu({ id: 'x', x: 1, y: 2 });
      act();
      expect(ui().menu).toBeNull();
    }
  });

  test('a filter change keeps open groups, drops focus and the pending center, and sends the table to page 1', () => {
    ui().expandGroup(A);
    ui().focus('n1');
    ui().openPath('n1', []);
    ui().setTableSort('label');
    ui().setTablePage(4);
    ui().clearOverlays();
    expect(ui().expanded).toEqual([open(A)]);
    expect(ui().focusId).toBeNull();
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
