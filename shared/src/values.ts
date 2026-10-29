// Per-type value format checks. Mirrors check_value() in tools/validate_output.py rule for rule,
// so a file accepted by one validator is accepted by the other.
import ipaddr from 'ipaddr.js';
import type { NodeType } from './enums';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[a-z0-9._%+'-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const URL_RE = /^(https?):\/\/([^/:?#]+)(:\d{1,5})?([/?#].*)?$/;
export const PORT_RE = /^(.+):(\d{1,5})\/(tcp|udp)$/;

/** Same acceptance as Python's ipaddress.ip_address(): strict dotted-quad IPv4, or IPv6 (zone IDs allowed). */
export function isIp(value: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(value) || ipaddr.IPv6.isValid(value);
}

/** Strip any leading/trailing square brackets, like Python's str.strip("[]"). */
export function stripBrackets(value: string): string {
  return value.replace(/^[[\]]+|[[\]]+$/g, '');
}

/** Returns an error message if `value` is badly formatted for `type`, otherwise null. */
export function checkValue(type: NodeType, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'value must be a non-empty string';
  }
  if (value !== value.trim()) {
    return 'value has leading/trailing spaces';
  }

  switch (type) {
    case 'domain':
    case 'subdomain':
      if (value !== value.toLowerCase()) return 'must be lowercase';
      if (value.includes('://') || value.includes('/')) return 'must not contain a scheme or path';
      if (value.endsWith('.')) return 'must not end with a dot';
      if (value.startsWith('*')) {
        return 'wildcards like *.example.com are not allowed; skip them or put them in data';
      }
      if (value.includes(':')) return 'must not contain a port';
      if (!HOST_RE.test(value)) return 'is not a valid hostname';
      return null;
    case 'ip':
      return isIp(value) ? null : 'is not a valid IPv4/IPv6 address';
    case 'port': {
      const m = PORT_RE.exec(value);
      if (!m) return 'must look like ip:port/tcp, e.g. 93.184.216.34:443/tcp';
      const ip = m[1] ?? '';
      const port = Number(m[2]);
      if (!isIp(stripBrackets(ip))) return `'${ip}' is not a valid IP`;
      if (port < 1 || port > 65535) return 'port number out of range';
      return null;
    }
    case 'url': {
      const m = URL_RE.exec(value);
      if (!m) return 'must be a full URL starting with http:// or https://';
      const host = m[2] ?? '';
      if (host !== host.toLowerCase()) return 'host part of the URL must be lowercase';
      return null;
    }
    case 'email':
      return EMAIL_RE.test(value) ? null : 'must be a valid lowercase email address';
    case 'certificate':
      return SHA256_RE.test(value)
        ? null
        : 'must be a SHA-256 fingerprint: 64 lowercase hex characters, no colons';
    case 'technology':
    case 'vulnerability':
    case 'secret':
    case 'leak':
      return null;
  }
}
