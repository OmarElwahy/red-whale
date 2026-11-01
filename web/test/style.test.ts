import { CONFIDENCE_LEVELS, NODE_TYPES, SEVERITIES, type GraphNode } from '@redwhale/shared';
import type { Core, NodeSingular } from 'cytoscape';
import { beforeEach, describe, expect, test } from 'vitest';
import { applyDiff, diffElements } from '../src/graph/diff';
import { toElements } from '../src/graph/elements';
import { GLYPH_BY_TYPE, INK_BY_SEVERITY, badgeImage, contrast, glyphImage, glyphSvg, riskText } from '../src/graph/icons';
import {
  AGGREGATE_BORDER,
  COLORS,
  CONFIDENCE_BORDER,
  ICON_HIDDEN,
  IGNORED_OPACITY,
  NODE_SHAPE,
  NODE_SIZE,
  OPEN_GROUP_OPACITY,
  OUT_OF_SCOPE_HATCH,
  OUT_OF_SCOPE_IMAGE,
  hatchSvg,
  imageLayers,
  SEVERITY_COLOR,
  SEVERITY_KEYS,
} from '../src/graph/style';
import { aggregate, headless, more, node } from './fixtures';

/** Cytoscape reports colors as `rgb(r,g,b)`. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String(n >> 16)},${String((n >> 8) & 255)},${String(n & 255)})`;
}
const px = (n: number) => `${String(n)}px`;

describe('style tables', () => {
  test('node types are told apart by icon: every type has one, and no two share it', () => {
    const names = NODE_TYPES.map((t) => {
      const g = GLYPH_BY_TYPE[t];
      return 'icon' in g ? g.name : `text:${g.text}`;
    });
    expect(new Set(names).size).toBe(NODE_TYPES.length);
    for (const t of NODE_TYPES) {
      const g = GLYPH_BY_TYPE[t];
      if ('icon' in g) expect(g.icon).toMatch(/^<!-- @license lucide-static v1\.59\.0 - ISC -->\s*<svg/);
    }
  });

  test.each(SEVERITY_KEYS)('the icon ink reads on the %s fill (WCAG 4.5:1 or better)', (s) => {
    expect(contrast(INK_BY_SEVERITY[s], SEVERITY_COLOR[s])).toBeGreaterThanOrEqual(4.5);
  });

  test('icons are inlined data URIs in the ink color, with no external reference', () => {
    for (const t of NODE_TYPES) {
      const svg = glyphSvg(GLYPH_BY_TYPE[t], '#020617');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('stroke="#020617"');
      expect(svg).not.toContain('currentColor');
      expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:/);
      expect(glyphImage(t, 'none').startsWith('data:image/svg+xml;utf8,')).toBe(true);
    }
  });

  test('a type without an icon gets short text instead', () => {
    const svg = glyphSvg({ text: 'JS' }, '#ffffff');
    expect(svg).toContain('>JS</text>');
    expect(svg).toContain('fill="#ffffff"');
    expect(glyphSvg({ text: '<?=' }, '#fff')).toContain('&#60;?=');
  });

  test('the badge counts to 99+, and its tooltip names what is below', () => {
    expect(decodeURIComponent(badgeImage(3, 'critical'))).toContain('>3</text>');
    expect(decodeURIComponent(badgeImage(140, 'high'))).toContain('>99+</text>');
    expect(riskText({ critical: 2, high: 1 })).toBe('2 critical, 1 high below');
    expect(riskText({ critical: 0, high: 4 })).toBe('4 high below');
    expect(riskText({ critical: 0, high: 0 })).toBe('');
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

  test.each(NODE_TYPES)('%s nodes are circles with their icon', (type) => {
    const get = put(node('n', { type, severity: 'medium' }));
    expect(get('n').style('shape')).toBe(NODE_SHAPE);
    expect(get('n').style('background-image')).toBe(glyphImage(type, 'medium'));
  });

  test('the icon is inked for the fill: white on critical, dark on medium', () => {
    expect(glyphImage('ip', 'critical')).not.toBe(glyphImage('ip', 'medium'));
    expect(decodeURIComponent(glyphImage('ip', 'critical'))).toContain(`stroke="${INK_BY_SEVERITY.critical}"`);
  });

  test('at far zoom the icon hides; the hatch stays', () => {
    const get = put(node('o', { inScope: 'out' }));
    expect(get('o').style('background-image-opacity')).toBe('1 1');
    get('o').addClass(ICON_HIDDEN);
    expect(get('o').style('background-image-opacity')).toBe('1 0');
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

  test('groups are bigger, double-bordered, colored by max severity, with the members’ icon and the label below', () => {
    const get = put(aggregate({ maxSeverity: 'high' }), node('plain'));
    const agg = get('agg:0123456789abcdef:has_subdomain:subdomain');
    expect(agg.style('shape')).toBe(NODE_SHAPE);
    expect(agg.style('width')).toBe(px(NODE_SIZE.aggregate));
    expect(agg.width()).toBeGreaterThan(get('plain').width());
    expect(agg.style('border-style')).toBe(AGGREGATE_BORDER.style);
    expect(agg.style('background-color')).toBe(rgb(SEVERITY_COLOR.high));
    expect(agg.style('background-image')).toBe(glyphImage('subdomain', 'high'));
    expect(agg.style('label')).toBe('412 subdomains');
    expect(agg.style('text-valign')).toBe('bottom');
  });

  test('a group with high/critical below gets a badge over its corner, on top of the icon', () => {
    const get = put(aggregate({ maxSeverity: 'critical', risk: { critical: 2, high: 1 } }));
    const agg = get('agg:0123456789abcdef:has_subdomain:subdomain');
    expect(agg.style('background-image')).toBe(`${glyphImage('subdomain', 'critical')} ${badgeImage(3, 'critical')}`);
    expect(agg.style('background-clip')).toBe('node none');
    expect(agg.style('background-image-containment')).toBe('inside over');
  });

  test('an open group is drawn fainter than a collapsed one', () => {
    const get = put(aggregate({ expanded: true, shown: 100, remaining: 312 }));
    const agg = get('agg:0123456789abcdef:has_subdomain:subdomain');
    expect(Number(agg.style('background-opacity'))).toBe(OPEN_GROUP_OPACITY.fill);
  });

  test('a "more" node is a pill with no icon', () => {
    const get = put(more('agg:root:ip', 150));
    expect(get('more:agg:root:ip').style('shape')).toBe('round-rectangle');
    expect(get('more:agg:root:ip').style('background-image')).toBe('none');
  });

  test('the image stack, bottom to top: hatch, icon, badge', () => {
    const roles = (d: Parameters<typeof imageLayers>[0]) => imageLayers(d, false).map((l) => l.role);
    expect(roles({ kind: 'node', type: 'ip', severity: 'high', inScope: 'out' })).toEqual(['hatch', 'icon']);
    expect(roles({ kind: 'node', type: 'ip', severity: 'high', inScope: 'in' })).toEqual(['icon']);
    expect(roles({ kind: 'aggregate', type: 'ip', severity: 'high', risk: 1, riskWorst: 'high' })).toEqual(['icon', 'badge']);
    expect(roles({ kind: 'more' })).toEqual([]);
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
    expect(get('o').style('background-image')).toBe(`${OUT_OF_SCOPE_IMAGE} ${glyphImage('subdomain', 'none')}`);
    for (const id of ['i', 'n']) expect(get(id).style('background-image')).toBe(glyphImage('subdomain', 'none'));
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
    expect(get('x').style('background-image')).toContain(OUT_OF_SCOPE_IMAGE);
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
