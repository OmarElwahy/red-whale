// What the right-click menu offers for a node, a group or a "more" node (docs/architecture.md §8). Pure, so it's
// unit-tested.
import { childTypesOf, scopeModeFor, type AggregateNode, type GraphNode, type RunnerStatus, type ToolMode, type ToolsResponse, type ViewNode } from '@redwhale/shared';

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
  /** Opens the "Run tool" submenu. */
  | 'run-menu'
  | 'run-group'
  | 'run-tool'
  /** The empty canvas: open the Add node dialog. */
  | 'add-node'
  /** A node: the Add node dialog with this node as the parent. */
  | 'add-child';

export interface MenuBadge {
  text: string;
  tone: ToolMode | 'external';
}

export interface MenuItem {
  action: MenuAction;
  label: string;
  disabled?: boolean;
  /** Why it's disabled, shown as a tooltip (and under the label in the run submenu). */
  hint?: string;
  /** run-tool / run-group: the tool or group name. */
  name?: string;
  badges?: MenuBadge[];
  /** run-menu: what it opens. */
  submenu?: MenuItem[];
}

/** What the run submenu needs to know; undefined pieces are still loading. */
export interface RunContext {
  tools: ToolsResponse | undefined;
  runner: RunnerStatus | undefined;
  passiveOnly: boolean | undefined;
  /** /api/tools failed (e.g. the runner is off on this server). */
  toolsError?: string;
}

export interface MenuContext {
  /** For a node: the open group it hangs under. For a "more" node: its group. */
  group: AggregateNode | undefined;
  canExpandNeighbors: boolean;
  /** There is room on the canvas for anything more at all. */
  hasRoom: boolean;
  /** For a group: open groups are drawn below it (so "Collapse all below" has something to do). */
  hasOpenBelow?: boolean;
  run?: RunContext;
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
    items.push(runMenu(target, ctx.run));
    const children = childTypesOf(target.type);
    items.push({
      action: 'add-child',
      label: 'Add child node…',
      ...(children.length > 0 ? {} : { disabled: true, hint: `Nothing can hang under a ${target.type}.` }),
    });
  }
  return items;
}

/** Right-click on the empty canvas. */
export function canvasMenuItems(): MenuItem[] {
  return [{ action: 'add-node', label: 'Add node…' }];
}

/** Why a tool of this mode can't run against `node` right now, as far as the UI can tell (the server decides). */
function blocked(node: GraphNode, mode: ToolMode, run: RunContext, group: string): string | null {
  if (run.runner && !run.runner.docker.reachable) return 'Docker is not running. Start Docker Desktop.';
  const image = run.runner?.images.find((i) => i.group === group)?.status;
  if (image === 'missing') return `The ${group} image is not built. Run pnpm tools:build ${group}.`;
  if (image === 'outdated') return `The ${group} image is out of date. Run pnpm tools:build ${group}.`;
  if (scopeModeFor(mode) === 'active' && run.passiveOnly !== false) return 'Passive-only mode is on (Scope panel).';
  if (node.inScope === 'n/a') return `A ${node.type} is not a target.`;
  if (node.inScope !== 'in') return 'Out of scope. Add an include rule in the Scope panel.';
  return null;
}

const badges = (mode: ToolMode, external: boolean): MenuBadge[] => [
  { text: mode, tone: mode },
  ...(external ? [{ text: 'external', tone: 'external' as const }] : []),
];

/** "Run tool ▸": each group that has a tool for this node type first, then each such tool on its own. */
export function runItems(node: GraphNode, run: RunContext): MenuItem[] {
  const tools = (run.tools?.tools ?? []).filter((t) => (t.accepts as readonly string[]).includes(node.type));
  const items: MenuItem[] = [];
  for (const group of run.tools?.groups ?? []) {
    const members = tools.filter((t) => t.group === group.name);
    if (members.length === 0) continue;
    // The group's strongest mode decides (any active tool makes the group active).
    const mode = members.find((t) => t.mode === 'intrusive')?.mode ?? members.find((t) => t.mode === 'active')?.mode ?? 'passive';
    const why = blocked(node, mode, run, group.name);
    items.push({
      action: 'run-group',
      name: group.name,
      label: `Run group: ${group.label}`,
      badges: badges(mode, members.some((t) => t.external.length > 0)),
      hint: why ?? `${members.map((t) => t.label).join(', ')}: one job each`,
      ...(why === null ? {} : { disabled: true }),
    });
  }
  for (const tool of tools) {
    const why = blocked(node, tool.mode, run, tool.group);
    items.push({
      action: 'run-tool',
      name: tool.name,
      label: tool.label,
      badges: badges(tool.mode, tool.external.length > 0),
      hint: why ?? (tool.external.length > 0 ? `Contacts ${tool.external.join(', ')}` : (tool.description ?? undefined)),
      ...(why === null ? {} : { disabled: true }),
    });
  }
  return items;
}

function runMenu(node: GraphNode, run: RunContext | undefined): MenuItem {
  const item: MenuItem = { action: 'run-menu', label: 'Run tool' };
  if (!run || run.tools === undefined) {
    return { ...item, disabled: true, hint: run?.toolsError ?? 'Loading the tools…' };
  }
  const submenu = runItems(node, run);
  if (submenu.length === 0) return { ...item, disabled: true, hint: `No tool runs against a ${node.type} yet.` };
  return { ...item, submenu };
}
