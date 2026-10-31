import { CONFIDENCE_LEVELS, NODE_TYPES, SEVERITIES, type GraphNode } from '@redwhale/shared';
import type { Core, NodeSingular } from 'cytoscape';
import { beforeEach, describe, expect, test } from 'vitest';
import { applyDiff, diffElements } from '../src/graph/diff';
import { toElements } from '../src/graph/elements';
import {
  AGGREGATE_BORDER,
  COLORS,
  CONFIDENCE_BORDER,
  IGNORED_OPACITY,
  NODE_SIZE,
  OUT_OF_SCOPE_HATCH,
  OUT_OF_SCOPE_IMAGE,
  hatchSvg,
  SEVERITY_COLOR,
  SEVERITY_KEYS,
  SHAPE_BY_TYPE,
  SHAPE_PATHS,
} from '../src/graph/style';
import { aggregate, headless, node } from './fixtures';

/** Cytoscape reports colors as `rgb(r,g,b)`. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String(n >> 16)},${String((n >> 8) & 255)},${String(n & 255)})`;
}
const px = (n: number) => `${String(n)}px`;

describe('style tables', () => {
  test('every node type has a shape, and every shape has a legend path', () => {
    for (const t of NODE_TYPES) expect(SHAPE_PATHS[SHAPE_BY_TYPE[t]]).toMatch(/^M /);
  });

  test('node types are told apart by shape', () => {
    expect(new Set(Object.values(SHAPE_BY_TYPE)).size).toBe(NODE_TYPES.length);
  });

  test('every severity (and "none") has a distinct color; the interesting ring matches none of them', () => {
    expect(SEVERITY_KEYS).toEqual(['none', ...SEVERITIES]);
    const colors = SEVERITY_KEYS.map((s) => SEVERITY_COLOR[s]);
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain(COLORS.interesting);
  });

  test('confidence borders: dashed, solid, thick', () => {
    expect(CONFIDENCE_BORDER.discovered.style).toBe('dashed');
    expect(CONFIDENCE_BORDER.corroborated.style).toBe('solid');
    expect(CONFIDENCE_BORDER.verified.style).toBe('solid');
    expect(CONFIDENCE_BORDER.verified.width).toBeGreaterThan(CONFIDENCE_BORDER.corroborated.width);
  });
});

describe('computed styles on a Cytoscape instance', () => {
  let cy: Core;
  beforeEach(() => {
    cy = headless();
  });

  function put(...nodes: Parameters<typeof toElements>[0]['nodes']): (id: string) => NodeSingular {
    applyDiff(cy, diffElements(new Map(), toElements({ nodes, edges: [] })));
    return (id) => cy.getElementById(id);
  }

  test.each(NODE_TYPES)('%s nodes get their shape', (type) => {
    const get = put(node('n', { type }));
    expect(get('n').style('shape')).toBe(SHAPE_BY_TYPE[type]);
  });

  test.each([null, ...SEVERITIES] as const)('severity %s sets the fill color', (severity) => {
    const get = put(node('n', { severity }));
    expect(get('n').style('background-color')).toBe(rgb(SEVERITY_COLOR[severity ?? 'none']));
  });

  test('fill follows the node’s own severity, not the effective one', () => {
    const get = put(node('n', { severity: null, effectiveSeverity: 'critical' }));
    expect(get('n').style('background-color')).toBe(rgb(SEVERITY_COLOR.none));
  });

  test.each(CONFIDENCE_LEVELS)('confidence %s sets the border', (confidence) => {
    const get = put(node('n', { confidence }));
    expect(get('n').style('border-style')).toBe(CONFIDENCE_BORDER[confidence].style);
    expect(get('n').style('border-width')).toBe(px(CONFIDENCE_BORDER[confidence].width));
  });

  test('aggregates are bigger, double-bordered, colored by max severity, with the count as the label', () => {
    const get = put(aggregate({ maxSeverity: 'high' }), node('plain'));
    const agg = get('agg:0123456789abcdef:has_subdomain:subdomain');
    expect(agg.style('shape')).toBe(SHAPE_BY_TYPE.subdomain);
    expect(agg.style('width')).toBe(px(NODE_SIZE.aggregate));
    expect(agg.width()).toBeGreaterThan(get('plain').width());
    expect(agg.style('border-style')).toBe(AGGREGATE_BORDER.style);
    expect(agg.style('background-color')).toBe(rgb(SEVERITY_COLOR.high));
    expect(agg.style('label')).toBe('412\nsubdomains');
    expect(agg.style('text-valign')).toBe('center');
  });

  test('ignored nodes are faded; others are opaque', () => {
    const get = put(node('i', { tag: 'ignored' }), node('c', { tag: 'checked' }));
    expect(Number(get('i').style('opacity'))).toBe(IGNORED_OPACITY);
    expect(Number(get('c').style('opacity'))).toBe(1);
  });

  test('interesting nodes get a ring that leaves the confidence border alone', () => {
    const get = put(node('x', { tag: 'interesting', confidence: 'verified' }), node('y'));
    expect(get('x').style('outline-color')).toBe(rgb(COLORS.interesting));
    expect(Number.parseFloat(get('x').style('outline-width') as string)).toBeGreaterThan(0);
    expect(get('x').style('border-width')).toBe(px(CONFIDENCE_BORDER.verified.width));
    expect(Number.parseFloat(get('y').style('outline-width') as string)).toBe(0);
  });

  test('out-of-scope nodes are hatched; in-scope and not-targetable nodes are not', () => {
    const get = put(node('o', { inScope: 'out' }), node('i', { inScope: 'in' }), node('n', { inScope: 'n/a' }));
    expect(get('o').style('background-image')).toBe(OUT_OF_SCOPE_IMAGE);
    for (const id of ['i', 'n']) expect(get(id).style('background-image')).toBe('none');
  });

  test.each(SEVERITY_KEYS)('the hatch leaves the %s fill, the confidence border and the interesting ring alone', (s) => {
    const severity = s === 'none' ? null : s;
    const get = put(
      node('o', { severity, inScope: 'out', tag: 'interesting', confidence: 'verified' }),
      node('i', { severity, inScope: 'in', tag: 'interesting', confidence: 'verified' }),
    );
    for (const prop of ['background-color', 'border-width', 'border-style', 'border-color', 'outline-color', 'outline-width', 'opacity']) {
      expect(get('o').style(prop), prop).toBe(get('i').style(prop));
    }
    expect(get('o').style('background-color')).toBe(rgb(SEVERITY_COLOR[s]));
  });

  test('a scope change restyles a node already on the canvas', () => {
    const get = put(node('x', { inScope: 'in' }));
    const current = new Map(toElements({ nodes: [node('x', { inScope: 'in' })], edges: [] }).map((e) => [e.data.id, e]));
    const diff = diffElements(current, toElements({ nodes: [node('x', { inScope: 'out' })], edges: [] }));
    expect(diff.update).toHaveLength(1);
    applyDiff(cy, diff);
    expect(get('x').style('background-image')).toBe(OUT_OF_SCOPE_IMAGE);
  });

  test('the stripes are thin and see-through, so the fill reads between them', () => {
    expect(OUT_OF_SCOPE_HATCH.opacity).toBeLessThanOrEqual(0.6);
    expect(OUT_OF_SCOPE_HATCH.width / OUT_OF_SCOPE_HATCH.spacing).toBeLessThan(0.4);
    const svg = hatchSvg();
    expect(svg).toContain(`stroke-opacity="${String(OUT_OF_SCOPE_HATCH.opacity)}"`);
    expect(svg.match(/<line /g)?.length).toBeGreaterThan(8);
    expect(OUT_OF_SCOPE_IMAGE.startsWith('data:image/svg+xml;utf8,')).toBe(true);
  });

  test('selecting a node keeps its severity color', () => {
    const n: Partial<GraphNode> = { severity: 'medium' };
    const get = put(node('s', n));
    get('s').select();
    expect(get('s').style('background-color')).toBe(rgb(SEVERITY_COLOR.medium));
  });
});
