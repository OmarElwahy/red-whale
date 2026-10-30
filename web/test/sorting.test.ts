import { DEFAULT_NODE_SORT, nodeListQuerySchema } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { sortToState, stateToSort } from '../src/table/sorting';

describe('table sort ↔ sort=', () => {
  test('the default sort as table state', () => {
    expect(sortToState(DEFAULT_NODE_SORT)).toEqual([
      { id: 'effectiveSeverity', desc: true },
      { id: 'label', desc: false },
    ]);
  });

  test.each(['label', '-label', '-severity,label', 'type,-sourceCount,lastSeen', DEFAULT_NODE_SORT])(
    'round trip: %s',
    (sort) => {
      expect(stateToSort(sortToState(sort))).toBe(sort);
    },
  );

  test('what the table produces is accepted by the API', () => {
    const sort = stateToSort([
      { id: 'confidence', desc: true },
      { id: 'firstSeen', desc: false },
    ]);
    expect(nodeListQuerySchema.parse({ sort }).sort).toEqual([
      { field: 'confidence', desc: true },
      { field: 'firstSeen', desc: false },
    ]);
  });

  test('columns that are not API sort fields are dropped; nothing left is the default', () => {
    expect(stateToSort([{ id: 'tag', desc: false }])).toBe(DEFAULT_NODE_SORT);
    expect(stateToSort([])).toBe(DEFAULT_NODE_SORT);
    expect(sortToState('tag,-label')).toEqual([{ id: 'label', desc: true }]);
  });
});
