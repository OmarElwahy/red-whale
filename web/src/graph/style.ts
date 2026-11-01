// The graph's visual language (docs/architecture.md §8), in one place. The tables below drive both the
// Cytoscape stylesheet and the legend, so the two can't drift apart.
//
// Every node is a circle; its type is the icon inside (graph/icons.ts). Fill = severity, border = confidence,
// fuchsia outline = interesting, diagonal hatch = out of scope. The hatch, the icon and a group's risk badge are
// one stack of background images, built per node by `imageLayers` (hatch underneath, icon over it, badge on top).
import { CONFIDENCE_LEVELS, NODE_TYPES, SEVERITIES, type Confidence, type NodeType } from '@redwhale/shared';
import type { Css, NodeSingular, StylesheetJson } from 'cytoscape';
import type { SeverityKey } from './elements';
import { badgeImage, glyphImage } from './icons';

/** Legend outline for the shapes we draw, as an SVG path in Cytoscape's unit box ((-1,-1) to (1,1)). */
export const SHAPE_PATHS = {
  ellipse: 'M -1 0 A 1 1 0 1 0 1 0 A 1 1 0 1 0 -1 0 Z',
  'round-rectangle': 'M -0.7 -1 H 0.7 Q 1 -1 1 -0.7 V 0.7 Q 1 1 0.7 1 H -0.7 Q -1 1 -1 0.7 V -0.7 Q -1 -1 -0.7 -1 Z',
} as const satisfies Partial<Record<Css.NodeShape, string>>;
export type Shape = keyof typeof SHAPE_PATHS;

/** Every node type is a circle: the icon tells them apart. */
export const NODE_SHAPE: Shape = 'ellipse';

/** Node diameter in px. Domains are roots; groups are bigger so their badge and icon read. */
export const NODE_SIZE = { default: 28, domain: 40, port: 24, aggregate: 44 } as const;
const sizeOf = (type: NodeType): number => (type === 'domain' || type === 'port' ? NODE_SIZE[type] : NODE_SIZE.default);

/** The icon's width as a share of the node's. */
export const ICON_SCALE = 0.56;
/** The risk badge's width as a share of the group's. */
export const BADGE_SCALE = 0.42;

/** Fill color by severity, picked to read on a near-black canvas. 'none' = no finding on this node. */
export const SEVERITY_COLOR: Record<SeverityKey, string> = {
  none: '#64748b', // slate-500
  info: '#0ea5e9', // sky-500
  low: '#10b981', // emerald-500
  medium: '#fbbf24', // amber-400
  high: '#f97316', // orange-500
  critical: '#dc2626', // red-600
};
export const SEVERITY_KEYS: readonly SeverityKey[] = ['none', ...SEVERITIES];

/** Border by confidence: dashed = one tool, solid = two or more, thick = analyst-verified. */
export const CONFIDENCE_BORDER: Record<Confidence, { style: 'dashed' | 'solid'; width: number }> = {
  discovered: { style: 'dashed', width: 2 },
  corroborated: { style: 'solid', width: 2 },
  verified: { style: 'solid', width: 5 },
};

/** Groups have no confidence of their own; a double border marks them. An open group's is fainter. */
export const AGGREGATE_BORDER = { style: 'double', width: 4 } as const;
export const OPEN_GROUP_OPACITY = { border: 0.5, fill: 0.7 } as const;

export const COLORS = {
  canvas: '#020617', // slate-950
  border: '#cbd5e1', // slate-300
  label: '#e2e8f0', // slate-200
  edge: '#475569', // slate-600
  /** Group → member: quieter than a real relation. */
  memberEdge: '#334155', // slate-700
  edgeLabel: '#94a3b8', // slate-400
  /** "+N more" pill. */
  more: '#1e293b', // slate-800
  /** Ring for `interesting`: fuchsia, so it never blends with a severity fill. */
  interesting: '#e879f9', // fuchsia-400
  selected: '#f8fafc', // slate-50
  /** Halo on nodes a live update just added. */
  fresh: '#22d3ee', // cyan-400
} as const;

/** Label font sizes in px at zoom 1. Labels fade out below an on-screen size (graph/labels.ts). */
export const NODE_FONT_PX = 10;
export const EDGE_FONT_PX = 8;
/** How long labels take to fade in or out when the zoom crosses the readability threshold (graph/labels.ts). */
export const LABEL_FADE_MS = 150;
/** Icon size in px at zoom 1 on a default node; icons hide below an on-screen size like labels (graph/labels.ts). */
export const ICON_PX = NODE_SIZE.default * ICON_SCALE;
/** Class that hides icons (not the hatch or a badge) at far zoom. */
export const ICON_HIDDEN = 'icon-hidden';

/**
 * Out of scope: thin, semi-transparent diagonal stripes drawn over the fill (a background image, under the
 * border). The severity color still reads between them, and it touches none of the other channels: not the fill,
 * the confidence border, the `interesting` outline, or the selection/fresh underlay. The stripes scale with the
 * node, so the marker is there at every zoom (a corner badge would vanish when zoomed out).
 */
export const OUT_OF_SCOPE_HATCH = {
  /** Stripe color: the canvas, so it reads as "cut away" on every fill. */
  color: COLORS.canvas,
  opacity: 0.55,
  /** In the 24-unit tile the image is drawn from (the node's width = 24 units). */
  width: 1.6,
  spacing: 5,
} as const;

/** The hatch as an SVG: 45° stripes across a 24×24 tile, overdrawn so the corners are covered too. */
export function hatchSvg({ color, opacity, width, spacing } = OUT_OF_SCOPE_HATCH): string {
  const lines: string[] = [];
  for (let c = -24; c <= 48; c += spacing) {
    lines.push(`<line x1="${String(c)}" y1="0" x2="${String(c - 24)}" y2="24"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<g stroke="${color}" stroke-opacity="${String(opacity)}" stroke-width="${String(width)}">${lines.join('')}</g></svg>`
  );
}

export const OUT_OF_SCOPE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(hatchSvg())}`;

export const IGNORED_OPACITY = 0.3;
export const SEARCH_PATH_OPACITY = 0.45;
export const MUTED_OPACITY = 0.2;
export const FADED_OPACITY = 0.12;
export const INTERESTING_RING = { width: 3, offset: 3 } as const;

// --- background image stack -----------------------------------------------------------------------------

export interface ImageLayer {
  role: 'hatch' | 'icon' | 'badge';
  url: string;
  fit: 'cover' | 'none';
  width: string;
  height: string;
  x: string;
  y: string;
  offsetX: number;
  offsetY: number;
  clip: 'node' | 'none';
  containment: 'inside' | 'over';
  opacity: number;
}

/** What a node's data says about its images. */
export interface LayerInput {
  kind: string;
  type?: NodeType;
  severity?: SeverityKey;
  inScope?: string;
  risk?: number;
  riskWorst?: string;
}

const pct = (n: number) => `${String(Math.round(n * 1000) / 10)}%`;

/**
 * The node's background images, bottom to top: the out-of-scope hatch, the type's icon (inked for the fill), and
 * a group's risk badge in its top-right corner. `iconHidden` (far zoom) keeps the icon's slot but draws it
 * transparent, so the hatch and the badge stay.
 */
export function imageLayers(d: LayerInput, iconHidden: boolean): ImageLayer[] {
  const layers: ImageLayer[] = [];
  if (d.kind === 'more' || d.type === undefined) return layers;
  if (d.kind === 'node' && d.inScope === 'out') {
    layers.push({
      role: 'hatch',
      url: OUT_OF_SCOPE_IMAGE,
      fit: 'cover',
      width: 'auto',
      height: 'auto',
      x: '50%',
      y: '50%',
      offsetX: 0,
      offsetY: 0,
      clip: 'node',
      containment: 'inside',
      opacity: 1,
    });
  }
  layers.push({
    role: 'icon',
    url: glyphImage(d.type, d.severity ?? 'none'),
    fit: 'none',
    width: pct(ICON_SCALE),
    height: pct(ICON_SCALE),
    x: '50%',
    y: '50%',
    offsetX: 0,
    offsetY: 0,
    clip: 'node',
    containment: 'inside',
    opacity: iconHidden ? 0 : 1,
  });
  if (d.kind === 'aggregate' && (d.risk ?? 0) > 0 && (d.riskWorst === 'critical' || d.riskWorst === 'high')) {
    const offset = NODE_SIZE.aggregate * 0.1;
    layers.push({
      role: 'badge',
      url: badgeImage(d.risk ?? 0, d.riskWorst),
      fit: 'none',
      width: pct(BADGE_SCALE),
      height: pct(BADGE_SCALE),
      x: '100%',
      y: '0%',
      offsetX: offset,
      offsetY: -offset,
      clip: 'none',
      containment: 'over',
      opacity: 1,
    });
  }
  return layers;
}

const layerCache = new Map<string, ImageLayer[]>();

function layersOf(ele: NodeSingular): ImageLayer[] {
  const d = ele.data() as LayerInput;
  const hidden = ele.hasClass(ICON_HIDDEN);
  const key = `${d.kind}|${d.type ?? ''}|${d.severity ?? ''}|${d.inScope ?? ''}|${String(d.risk ?? 0)}|${d.riskWorst ?? ''}|${String(hidden)}`;
  let layers = layerCache.get(key);
  if (!layers) {
    layers = imageLayers(d, hidden);
    layerCache.set(key, layers);
  }
  return layers;
}

/** One Cytoscape background property for the whole stack (Cytoscape takes a list per image). */
function stack<T>(pick: (l: ImageLayer) => T, none: T): (ele: NodeSingular) => T[] {
  return (ele) => {
    const layers = layersOf(ele);
    return layers.length === 0 ? [none] : layers.map(pick);
  };
}

const imageStyle = {
  'background-image': (ele: NodeSingular) => {
    const layers = layersOf(ele);
    return layers.length === 0 ? 'none' : layers.map((l) => l.url);
  },
  'background-fit': stack((l) => l.fit, 'none'),
  'background-width': stack((l) => l.width, 'auto'),
  'background-height': stack((l) => l.height, 'auto'),
  'background-position-x': stack((l) => l.x, '50%'),
  'background-position-y': stack((l) => l.y, '50%'),
  'background-offset-x': stack((l) => l.offsetX, 0),
  'background-offset-y': stack((l) => l.offsetY, 0),
  'background-clip': stack((l) => l.clip, 'node'),
  'background-image-containment': stack((l) => l.containment, 'inside'),
  'background-image-opacity': stack((l) => l.opacity, 1),
} as const;

export function graphStylesheet(): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        shape: NODE_SHAPE,
        width: NODE_SIZE.default,
        height: NODE_SIZE.default,
        'background-color': SEVERITY_COLOR.none,
        'border-color': COLORS.border,
        'border-width': CONFIDENCE_BORDER.discovered.width,
        'border-style': CONFIDENCE_BORDER.discovered.style,
        label: 'data(label)',
        color: COLORS.label,
        'font-size': NODE_FONT_PX,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'ellipsis',
        'text-max-width': '140px',
        'text-outline-color': COLORS.canvas,
        'text-outline-width': 2,
        ...(imageStyle as unknown as Css.Node),
      },
    },
    ...NODE_TYPES.filter((type) => sizeOf(type) !== NODE_SIZE.default).map((type) => ({
      selector: `node[kind = "node"][type = "${type}"]`,
      style: { width: sizeOf(type), height: sizeOf(type) },
    })),
    ...SEVERITY_KEYS.map((s) => ({
      selector: `node[severity = "${s}"]`,
      style: { 'background-color': SEVERITY_COLOR[s] },
    })),
    ...CONFIDENCE_LEVELS.map((c) => ({
      selector: `node[confidence = "${c}"]`,
      style: { 'border-style': CONFIDENCE_BORDER[c].style, 'border-width': CONFIDENCE_BORDER[c].width },
    })),
    {
      selector: 'node[kind = "aggregate"]',
      style: {
        width: NODE_SIZE.aggregate,
        height: NODE_SIZE.aggregate,
        'border-style': AGGREGATE_BORDER.style,
        'border-width': AGGREGATE_BORDER.width,
        'font-weight': 'bold',
        // Room for the badge, which sits over the corner.
        'bounds-expansion': NODE_SIZE.aggregate * 0.25,
      },
    },
    {
      selector: 'node[kind = "aggregate"][?expanded]',
      style: { 'border-opacity': OPEN_GROUP_OPACITY.border, 'background-opacity': OPEN_GROUP_OPACITY.fill },
    },
    {
      selector: 'node[kind = "more"]',
      style: {
        shape: 'round-rectangle',
        width: 72,
        height: 20,
        'background-color': COLORS.more,
        'border-style': 'dashed',
        'border-width': 1,
        'border-color': COLORS.edgeLabel,
        'text-valign': 'center',
        'text-margin-y': 0,
        'font-size': 9,
        color: COLORS.label,
      },
    },
    { selector: 'node[tag = "ignored"]', style: { opacity: IGNORED_OPACITY } },
    {
      selector: 'node[tag = "interesting"]',
      style: {
        'outline-color': COLORS.interesting,
        'outline-width': INTERESTING_RING.width,
        'outline-offset': INTERESTING_RING.offset,
        'outline-style': 'solid',
        'outline-opacity': 1,
      },
    },
    // Replace Cytoscape's default selection look (which recolors the fill) with a halo.
    {
      selector: 'node:selected',
      style: { 'underlay-color': COLORS.selected, 'underlay-padding': 8, 'underlay-opacity': 0.25 },
    },
    // Live update: a brief, bright halo on what a new scan just added (graph/flash.ts).
    {
      selector: 'node.fresh',
      style: { 'underlay-color': COLORS.fresh, 'underlay-padding': 12, 'underlay-opacity': 0.7 },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': COLORS.edge,
        'target-arrow-color': COLORS.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        // The relation, along the edge, on a small canvas-colored plate so it reads over other edges.
        label: 'data(label)',
        'font-size': EDGE_FONT_PX,
        color: COLORS.edgeLabel,
        'text-rotation': 'autorotate',
        'text-background-color': COLORS.canvas,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
      },
    },
    // Group → member: plain, quieter; the relation is on the parent → group edge.
    {
      selector: 'edge[kind = "member"]',
      style: { width: 1, 'line-color': COLORS.memberEdge, 'target-arrow-color': COLORS.memberEdge, 'arrow-scale': 0.6 },
    },
    {
      selector: 'edge[kind = "more"]',
      style: { width: 1, 'line-style': 'dashed', 'line-color': COLORS.memberEdge, 'target-arrow-shape': 'none' },
    },
    {
      selector: 'edge:selected',
      style: { 'line-color': COLORS.selected, 'target-arrow-color': COLORS.selected, width: 2.5 },
    },
    // Labels too small to read at this zoom (graph/labels.ts): stepped out, then skipped by the renderer.
    { selector: '.label-fade-1', style: { 'text-opacity': 0.5 } },
    { selector: '.label-hidden', style: { 'text-opacity': 0 } },
    // Search: nodes kept only as the path up to a match. Still clickable.
    { selector: '.search-path', style: { opacity: SEARCH_PATH_OPACITY } },
    // "Mute low-risk": after the path, so a low-risk path node is as faint as any other low-risk node.
    { selector: '.muted', style: { opacity: MUTED_OPACITY } },
    // Collapsing: members sliding into their group (graph/diff.ts). Not clickable on the way.
    { selector: '.retiring', style: { events: 'no' } },
    // Focus mode: outside the focused neighborhood. Last, so it wins over every other opacity.
    { selector: '.faded', style: { opacity: FADED_OPACITY, events: 'no' } },
  ];
}
