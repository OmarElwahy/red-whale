// File names for the report downloads.
import { fileTimestamp } from '@/graph/export';

/** The label in safe characters: letters, digits, `.`, `_`, `-`; anything else becomes `-`. At most 60. */
export function safeLabel(label: string): string {
  const safe = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, '');
  return safe === '' ? 'node' : safe;
}

/** `redwhale-report-CVE-2021-41773-2026-11-28T12-00-00Z.md` */
export function reportFilename(label: string, extension: 'md' | 'html', now: Date = new Date()): string {
  return `redwhale-report-${safeLabel(label)}-${fileTimestamp(now)}.${extension}`;
}
