/** `2026-10-30T12:34:56.000Z` → `2026-10-30 12:34:56` (stored timestamps are always UTC). */
export const formatTime = (iso: string): string => iso.slice(0, 19).replace('T', ' ');

/** A `data` value as one line of text. */
export const formatValue = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
