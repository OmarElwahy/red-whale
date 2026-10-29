import { createHash } from 'node:crypto';

/** JSON with object keys sorted and no whitespace. Array order is kept: it is part of the content. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** scans.file_hash: sha256 of the canonical JSON, so reformatted copies of a file hash the same. */
export function fileHash(parsed: unknown): string {
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}
