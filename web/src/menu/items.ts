// What the right-click menu offers for a node, a group or a "more" node (docs/architecture.md §8). Pure, so it's
// unit-tested.
import type { AggregateNode, ViewNode } from '@redwhale/shared';

export type MenuAction =
  | 'focus'
  | 'expand-neighbors'
  | 'expand-all-below'
  | 'copy-value'
  | 'open-url'
  | 'expand'
  | 'collapse'
  | 'collapse-below'
  | 'load-more'
  | 'collapse-parent'
  | 'run-tool';

export interface MenuItem {
  action: MenuAction;
  label: string;
  disabled?: boolean;
  /** Why it's disabled, shown as a tooltip. */
  hint?: string;
}

export interface MenuContext {
  /** For a node: the open group it hangs under. For a "more" node: its group. */
  group: AggregateNode | undefined;
  canExpandNeighbors: boolean;
  /** There is room on the canvas for anything more at all. */
  hasRoom: boolean;
  /** For a group: open groups are drawn below it (so "Collapse all below" has something to do). */
  hasOpenBelow?: boolean;
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

const budget = (ok: boolean) => (ok ? {} : { disabled: true, hint: OVER_BUDGET });

function loadMore(group: AggregateNode): MenuItem {
  return { action: 'load-more', label: `Load more (${String(group.remaining)} left)`, ...budget(group.canLoadMore) };
}

export function menuItems(target: ViewNode, ctx: MenuContext): MenuItem[] {
  if (target.type === 'more') return ctx.group ? [loadMore(ctx.group)] : [];

  const items: MenuItem[] = [{ action: 'focus', label: 'Focus' }];
  if (target.type === 'aggregate') {
    if (target.expanded) {
      items.push({ action: 'collapse', label: 'Collapse' });
      items.push({
        action: 'collapse-below',
        label: 'Collapse all below',
        ...(ctx.hasOpenBelow ? {} : { disabled: true, hint: 'Nothing is open below this group' }),
      });
      if (target.remaining > 0) items.push(loadMore(target));
    } else {
      items.push({ action: 'expand', label: `Expand (${String(target.count)})`, ...budget(target.canLoadMore) });
    }
  } else {
    items.push({ action: 'expand-neighbors', label: 'Expand neighbors', ...budget(ctx.canExpandNeighbors) });
    items.push({ action: 'expand-all-below', label: 'Expand all below', ...budget(ctx.hasRoom) });
    items.push({ action: 'copy-value', label: 'Copy value' });
    if (target.type === 'url' && safeHttpUrl(target.value) !== null) {
      items.push({ action: 'open-url', label: 'Open URL in new tab' });
    }
    if (ctx.group) items.push({ action: 'collapse-parent', label: 'Collapse group' });
  }
  items.push({ action: 'run-tool', label: 'Run tool (coming later)', disabled: true, hint: 'Needs the orchestrator (Phase 6)' });
  return items;
}
