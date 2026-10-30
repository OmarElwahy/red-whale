// What the right-click menu offers for a node (docs/architecture.md §8). Pure, so it's unit-tested.
import type { AggregateNode, GraphNode } from '@redwhale/shared';
import type { GroupState } from '@/graph/compose';

export type MenuAction =
  | 'focus'
  | 'expand-neighbors'
  | 'copy-value'
  | 'open-url'
  | 'expand'
  | 'collapse'
  | 'run-tool';

export interface MenuItem {
  action: MenuAction;
  label: string;
  disabled?: boolean;
  /** Why it's disabled, shown as a tooltip. */
  hint?: string;
}

export interface MenuContext {
  /** The expansion this aggregate has, or the one this node was expanded from. */
  group: GroupState | undefined;
  canLoadPage: boolean;
  canExpandNeighbors: boolean;
}

const OVER_BUDGET = 'The canvas is at its ~2,000-element limit. Collapse a group first.';

/** The value as an http(s) URL to open, or null. Anything else (javascript:, data:, file:…) is refused. */
export function safeHttpUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

export function menuItems(target: GraphNode | AggregateNode, ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [{ action: 'focus', label: 'Focus' }];
  if (target.type === 'aggregate') {
    const loaded = ctx.group !== undefined;
    items.push({
      action: 'expand',
      label: loaded ? `Load more (${String(ctx.group?.remaining ?? 0)} left)` : `Expand (${String(target.total)})`,
      ...(ctx.canLoadPage ? {} : { disabled: true, hint: OVER_BUDGET }),
    });
    if (loaded) items.push({ action: 'collapse', label: 'Collapse group' });
  } else {
    items.push({
      action: 'expand-neighbors',
      label: 'Expand neighbors',
      ...(ctx.canExpandNeighbors ? {} : { disabled: true, hint: OVER_BUDGET }),
    });
    items.push({ action: 'copy-value', label: 'Copy value' });
    if (target.type === 'url' && safeHttpUrl(target.value) !== null) {
      items.push({ action: 'open-url', label: 'Open URL in new tab' });
    }
    if (ctx.group) items.push({ action: 'collapse', label: 'Collapse group' });
  }
  items.push({ action: 'run-tool', label: 'Run tool (coming later)', disabled: true, hint: 'Needs the orchestrator (Phase 6)' });
  return items;
}
