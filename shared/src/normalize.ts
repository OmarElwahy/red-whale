// The single place where values are canonicalized before hashing into node IDs
// (docs/architecture.md §3). Validation rejects most bad values first; this is the second safety net,
// so it also accepts some sloppy-but-unambiguous input (uppercase, trailing dots, default ports).
import ipaddr from 'ipaddr.js';
import type { NodeType } from './enums';
import { stripBrackets } from './values';

export class NormalizeError extends Error {
  override name = 'NormalizeError';
}

const PORT_LOOSE_RE = /^(.+):(\d{1,5})\/(tcp|udp)$/i;
const CVE_RE = /^cve-\d{4}-\d+$/i;

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.+$/, '');
}

/** Canonical IP text. IPv6 is compressed per RFC 5952; IPv4-mapped IPv6 becomes plain IPv4. */
export function normalizeIp(value: string): string {
  const v = stripBrackets(value.trim());
  if (ipaddr.IPv4.isValidFourPartDecimal(v)) return ipaddr.IPv4.parse(v).toString();
  if (ipaddr.IPv6.isValid(v)) {
    const addr = ipaddr.IPv6.parse(v);
    return addr.isIPv4MappedAddress() ? addr.toIPv4Address().toString() : addr.toRFC5952String();
  }
  throw new NormalizeError(`not an IP address: '${value}'`);
}

/** `ip:port/proto`, with IPv6 always bracketed: `[2001:db8::1]:443/tcp`. */
function normalizePort(value: string): string {
  const m = PORT_LOOSE_RE.exec(value);
  if (!m) throw new NormalizeError(`not an ip:port/protocol value: '${value}'`);
  const ip = normalizeIp(m[1] ?? '');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new NormalizeError(`port out of range: '${value}'`);
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `${host}:${String(port)}/${(m[3] ?? '').toLowerCase()}`;
}

/** WHATWG URL serialization (lowercase host, no default port), minus the fragment and any trailing host dot. */
function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NormalizeError(`not a URL: '${value}'`);
  }
  url.hash = '';
  const host = url.hostname.replace(/\.+$/, '');
  if (host !== url.hostname && host !== '') url.hostname = host;
  return url.href;
}

export function normalize(type: NodeType, value: string): string {
  const v = value.trim();
  if (v === '') throw new NormalizeError(`empty ${type} value`);

  switch (type) {
    case 'domain':
    case 'subdomain':
      return normalizeHost(v);
    case 'email':
      return v.toLowerCase();
    case 'ip':
      return normalizeIp(v);
    case 'port':
      return normalizePort(v);
    case 'url':
      return normalizeUrl(v);
    case 'technology':
      // Merges "Nginx/1.18.0" (httpx) with "nginx/1.18.0" (nmap). The original text is kept as the node label.
      return v.toLowerCase();
    case 'vulnerability':
      return CVE_RE.test(v) ? v.toUpperCase() : v;
    case 'certificate':
      return v.toLowerCase().replace(/:/g, '');
    case 'secret':
    case 'leak':
      return v;
  }
}
