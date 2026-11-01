// Node type → icon (docs/architecture.md §8), in this one file. The icons are Lucide's (lucide-static 1.59.0, ISC
// license, see README "Third-party"), imported one SVG at a time with `?raw`: the bundle carries only these, as
// text, and the canvas draws them from data URIs. Nothing is fetched at run time, no icon font, no CDN.
//
// A type without a fitting icon gets short text instead (`{ text: 'JS' }`); the Record makes every new node type
// pick one or the other before it compiles.
import type { NodeType } from '@redwhale/shared';
import atSign from 'lucide-static/icons/at-sign.svg?raw';
import bug from 'lucide-static/icons/bug.svg?raw';
import databaseZap from 'lucide-static/icons/database-zap.svg?raw';
import globe from 'lucide-static/icons/globe.svg?raw';
import keyRound from 'lucide-static/icons/key-round.svg?raw';
import layers from 'lucide-static/icons/layers.svg?raw';
import link from 'lucide-static/icons/link.svg?raw';
import lock from 'lucide-static/icons/lock.svg?raw';
import network from 'lucide-static/icons/network.svg?raw';
import plug from 'lucide-static/icons/plug.svg?raw';
import server from 'lucide-static/icons/server.svg?raw';
import type { SeverityKey } from './elements';

export type Glyph = { icon: string; name: string } | { text: string };

export const GLYPH_BY_TYPE: Record<NodeType, Glyph> = {
  domain: { icon: globe, name: 'globe' },
  subdomain: { icon: network, name: 'network' },
  ip: { icon: server, name: 'server' },
  port: { icon: plug, name: 'plug' },
  url: { icon: link, name: 'link' },
  technology: { icon: layers, name: 'layers' },
  vulnerability: { icon: bug, name: 'bug' },
  email: { icon: atSign, name: 'at-sign' },
  secret: { icon: keyRound, name: 'key-round' },
  certificate: { icon: lock, name: 'lock' },
  leak: { icon: databaseZap, name: 'database-zap' },
};

/** Icon and text colors: white on the dark fills, near-black on the bright ones. */
export const INK = { light: '#ffffff', dark: '#020617' } as const;

/** Ink per severity fill (style.ts SEVERITY_COLOR), chosen for at least 4.5:1 contrast (tested). */
export const INK_BY_SEVERITY: Record<SeverityKey, string> = {
  none: INK.light,
  info: INK.dark,
  low: INK.dark,
  medium: INK.dark,
  high: INK.dark,
  critical: INK.light,
};

/** WCAG relative luminance of a `#rrggbb` color. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio between two `#rrggbb` colors (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** The glyph as a standalone 24×24 SVG in this color. Lucide draws in `currentColor` (strokes, a few fills); it becomes the ink. */
export function glyphSvg(glyph: Glyph, ink: string): string {
  if ('icon' in glyph) {
    return glyph.icon
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+class="[^"]*"/, '')
      .replace(/currentColor/g, ink)
      .replace(/stroke-width="2"/, 'stroke-width="2.25"')
      .trim();
  }
  const size = glyph.text.length <= 2 ? 13 : glyph.text.length === 3 ? 10 : 8;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<text x="12" y="12" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" ` +
    `font-size="${String(size)}" fill="${ink}">${escapeXml(glyph.text)}</text></svg>`
  );
}

export const svgDataUri = (svg: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

const glyphCache = new Map<string, string>();

/** The type's glyph as a data URI, inked for this severity fill. Built once per type and ink. */
export function glyphImage(type: NodeType, severity: SeverityKey): string {
  const ink = INK_BY_SEVERITY[severity];
  const key = `${type}|${ink}`;
  let uri = glyphCache.get(key);
  if (uri === undefined) {
    uri = svgDataUri(glyphSvg(GLYPH_BY_TYPE[type], ink));
    glyphCache.set(key, uri);
  }
  return uri;
}

/** Badge colors: red with white text when a critical is below, orange with dark text for high only. */
export const BADGE = {
  critical: { fill: '#dc2626', ink: INK.light },
  high: { fill: '#f97316', ink: INK.dark },
  ring: '#020617',
} as const;

const badgeCache = new Map<string, string>();

/** A round count badge ("3", "99+") as a data URI, for a group's corner. */
export function badgeImage(count: number, worst: 'critical' | 'high'): string {
  const text = count > 99 ? '99+' : String(count);
  const key = `${worst}|${text}`;
  let uri = badgeCache.get(key);
  if (uri === undefined) {
    const { fill, ink } = BADGE[worst];
    const size = text.length === 1 ? 14 : text.length === 2 ? 12 : 9;
    uri = svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
        `<circle cx="12" cy="12" r="10.5" fill="${fill}" stroke="${BADGE.ring}" stroke-width="2"/>` +
        `<text x="12" y="12" dy="0.36em" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" ` +
        `font-size="${String(size)}" fill="${ink}">${text}</text></svg>`,
    );
    badgeCache.set(key, uri);
  }
  return uri;
}

/** "2 critical, 1 high below" (the badge's tooltip), or '' when nothing serious is below. */
export function riskText(risk: { critical: number; high: number }): string {
  const parts = [
    risk.critical > 0 ? `${String(risk.critical)} critical` : '',
    risk.high > 0 ? `${String(risk.high)} high` : '',
  ].filter((p) => p !== '');
  return parts.length === 0 ? '' : `${parts.join(', ')} below`;
}
