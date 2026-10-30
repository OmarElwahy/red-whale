import { describe, expect, test } from 'vitest';
import { firstMatch } from '../src/filters/search';
import { aggregate, node } from './fixtures';

describe('firstMatch', () => {
  const domain = node('a', { type: 'domain', label: 'example.com', value: 'example.com', effectiveSeverity: 'critical' });
  const quiet = node('b', { label: 'admin.example.com', value: 'admin.example.com' });
  const risky = node('c', { label: 'old-admin.example.com', value: 'old-admin.example.com', effectiveSeverity: 'high' });
  const alsoRisky = node('d', { label: 'admin2.example.com', value: 'admin2.example.com', effectiveSeverity: 'high' });

  test('the riskiest match, then by label', () => {
    expect(firstMatch([domain, quiet, risky, alsoRisky], 'admin')?.id).toBe('d');
  });

  test('path nodes kept above the matches never count, however risky', () => {
    expect(firstMatch([domain, quiet], 'ADMIN')?.id).toBe('b');
  });

  test('when every match is inside a group, the riskiest group', () => {
    const low = aggregate({ id: 'agg:root:ip', maxSeverity: 'low', label: '30 ips' });
    const high = aggregate({ maxSeverity: 'high' });
    expect(firstMatch([domain, low, high], 'admin')?.id).toBe(high.id);
  });

  test('nothing to jump to', () => {
    expect(firstMatch([domain], 'admin')).toBeNull();
    expect(firstMatch([domain, quiet], '  ')).toBeNull();
  });
});
