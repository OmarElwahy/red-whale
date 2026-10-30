// The graph's visual language (docs/architecture.md §8), in one place. The tables below drive both the
// Cytoscape stylesheet and the legend, so the two can't drift apart.
import { CONFIDENCE_LEVELS, NODE_TYPES, SEVERITIES, type Confidence, type NodeType } from '@redwhale/shared';
import type { Css, StylesheetJson } from 'cytoscape';
import type { SeverityKey } from './elements';

/**
 * Legend outline for each Cytoscape shape we use, as an SVG path in the same unit box Cytoscape uses
 * ((-1,-1) to (1,1)). Only shapes listed here can be assigned to a node type.
 */
export const SHAPE_PATHS = {
  'round-hexagon': 'M -1 0 L -0.5 -0.87 L 0.5 -0.87 L 1 0 L 0.5 0.87 L -0.5 0.87 Z',
  ellipse: 'M -1 0 A 1 1 0 1 0 1 0 A 1 1 0 1 0 -1 0 Z',
  'round-rectangle': 'M -0.7 -1 H 0.7 Q 1 -1 1 -0.7 V 0.7 Q 1 1 0.7 1 H -0.7 Q -1 1 -1 0.7 V -0.7 Q -1 -1 -0.7 -1 Z',
  rectangle: 'M -1 -1 H 1 V 1 H -1 Z',
  'round-tag': 'M -1 -1 H 0.25 L 1 0 L 0.25 1 H -1 Z',
  barrel: 'M -0.8 -1 H 0.8 Q 1.1 0 0.8 1 H -0.8 Q -1.1 0 -0.8 -1 Z',
  triangle: 'M 0 -1 L 1 1 L -1 1 Z',
  rhomboid: 'M -1 -1 H 0.33 L 1 1 H -0.33 Z',
  diamond: 'M 0 -1 L 1 0 L 0 1 L -1 0 Z',
  octagon: 'M -0.41 -1 H 0.41 L 1 -0.41 V 0.41 L 0.41 1 H -0.41 L -1 0.41 V -0.41 Z',
  'concave-hexagon': 'M -1 -0.95 L -0.75 0 L -1 0.95 H 1 L 0.75 0 L 1 -0.95 Z',
} as const satisfies Partial<Record<Css.NodeShape, string>>;
export type Shape = keyof typeof SHAPE_PATHS;

export const SHAPE_BY_TYPE: Record<NodeType, Shape> = {
  domain: 'round-hexagon',
  subdomain: 'ellipse',
  ip: 'round-rectangle',
  port: 'rectangle',
  url: 'round-tag',
  technology: 'barrel',
  vulnerability: 'triangle',
  email: 'rhomboid',
  secret: 'diamond',
  certificate: 'octagon',
  leak: 'concave-hexagon',
};

/** Node diameter in px. Domains are roots, ports are many and small. */
export const NODE_SIZE = { default: 28, domain: 40, port: 20, aggregate: 60 } as const;
const sizeOf = (type: NodeType): number => (type === 'domain' || type === 'port' ? NODE_SIZE[type] : NODE_SIZE.default);

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

/** Aggregates have no confidence of their own; a double border marks them as a group. */
export const AGGREGATE_BORDER = { style: 'double', width: 4 } as const;

export const COLORS = {
  canvas: '#020617', // slate-950
  border: '#cbd5e1', // slate-300
  label: '#e2e8f0', // slate-200
  edge: '#475569', // slate-600
  /** Ring for `interesting`: fuchsia, so it never blends with a severity fill. */
  interesting: '#e879f9', // fuchsia-400
  selected: '#f8fafc', // slate-50
  /** Halo on nodes a live update just added. */
  fresh: '#22d3ee', // cyan-400
} as const;

export const IGNORED_OPACITY = 0.3;
export const SEARCH_PATH_OPACITY = 0.45;
export const MUTED_OPACITY = 0.2;
export const FADED_OPACITY = 0.12;
export const INTERESTING_RING = { width: 3, offset: 3 } as const;

export function graphStylesheet(): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        width: NODE_SIZE.default,
        height: NODE_SIZE.default,
        'background-color': SEVERITY_COLOR.none,
        'border-color': COLORS.border,
        'border-width': CONFIDENCE_BORDER.discovered.width,
        'border-style': CONFIDENCE_BORDER.discovered.style,
        label: 'data(label)',
        color: COLORS.label,
        'font-size': 10,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'ellipsis',
        'text-max-width': '140px',
        'text-outline-color': COLORS.canvas,
        'text-outline-width': 2,
        'min-zoomed-font-size': 8,
      },
    },
    ...NODE_TYPES.map((type) => ({
      selector: `node[type = "${type}"]`,
      style: { shape: SHAPE_BY_TYPE[type], width: sizeOf(type), height: sizeOf(type) },
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
        'font-size': 11,
        'font-weight': 'bold',
        'text-valign': 'center',
        'text-margin-y': 0,
        'text-wrap': 'wrap',
        'text-max-width': `${String(NODE_SIZE.aggregate * 2)}px`,
        color: COLORS.selected,
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
      },
    },
    {
      selector: 'edge:selected',
      style: { 'line-color': COLORS.selected, 'target-arrow-color': COLORS.selected, width: 2.5 },
    },
    // Search: nodes kept only as the path up to a match. Still clickable.
    { selector: '.search-path', style: { opacity: SEARCH_PATH_OPACITY } },
    // "Mute low-risk": after the path, so a low-risk path node is as faint as any other low-risk node.
    { selector: '.muted', style: { opacity: MUTED_OPACITY } },
    // Focus mode: outside the focused neighborhood. Last, so it wins over every other opacity.
    { selector: '.faded', style: { opacity: FADED_OPACITY, events: 'no' } },
  ];
}
