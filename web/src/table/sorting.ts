// The table's sort state ↔ GET /api/nodes `sort=` (docs/architecture.md §6). TanStack Table holds sorting as
// `[{ id, desc }]` with column IDs named after the API's sort fields, so the mapping is one to one.
import { DEFAULT_NODE_SORT, NODE_SORT_FIELDS, type NodeSortField } from '@redwhale/shared';
import type { SortingState } from '@tanstack/react-table';

export const isSortField = (id: string): id is NodeSortField => (NODE_SORT_FIELDS as readonly string[]).includes(id);

/** `-effectiveSeverity,label` → `[{ id: 'effectiveSeverity', desc: true }, { id: 'label', desc: false }]`. */
export function sortToState(sort: string): SortingState {
  return sort
    .split(',')
    .map((part) => part.trim())
    .map((part) => ({ id: part.replace(/^-/, ''), desc: part.startsWith('-') }))
    .filter((s) => isSortField(s.id));
}

/** The inverse. Columns that aren't API sort fields are dropped; nothing left means the default sort. */
export function stateToSort(state: SortingState): string {
  const parts = state.filter((s) => isSortField(s.id)).map((s) => `${s.desc ? '-' : ''}${s.id}`);
  return parts.length === 0 ? DEFAULT_NODE_SORT : parts.join(',');
}
