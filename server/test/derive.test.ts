import type { Severity } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { deriveNodeState, maxSeverity, type ObservationInput } from '../src/ingest/derive';

function obs(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    scanId: 's1',
    tool: 'subfinder',
    severity: null,
    data: {},
    observedAt: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

describe('confidence', () => {
  test('one observation is discovered', () => {
    expect(deriveNodeState([obs()], 'discovered')).toMatchObject({ sourceCount: 1, confidence: 'discovered' });
  });

  test('two scans from the same tool are still discovered', () => {
    const state = deriveNodeState([obs({ scanId: 's1' }), obs({ scanId: 's2' })], 'discovered');
    expect(state).toMatchObject({ sourceCount: 1, confidence: 'discovered' });
  });

  test('two tools are corroborated', () => {
    const state = deriveNodeState([obs({ tool: 'subfinder' }), obs({ scanId: 's2', tool: 'nmap' })], 'discovered');
    expect(state).toMatchObject({ sourceCount: 2, confidence: 'corroborated' });
  });

  test('a corroborated node can drop back to discovered (e.g. its observations shrank)', () => {
    expect(deriveNodeState([obs()], 'corroborated').confidence).toBe('discovered');
  });

  test('verified is never downgraded, but source_count is still recomputed', () => {
    expect(deriveNodeState([obs()], 'verified')).toMatchObject({ sourceCount: 1, confidence: 'verified' });
    const two = [obs({ tool: 'a' }), obs({ scanId: 's2', tool: 'b' })];
    expect(deriveNodeState(two, 'verified')).toMatchObject({ sourceCount: 2, confidence: 'verified' });
  });
});

describe('severity', () => {
  test('is the highest across observations', () => {
    const severities: (Severity | null)[] = ['low', null, 'high', 'medium'];
    const list = severities.map((severity, i) => obs({ scanId: `s${String(i)}`, severity }));
    expect(deriveNodeState(list, 'discovered').severity).toBe('high');
  });

  test('is null when no observation has one', () => {
    expect(deriveNodeState([obs(), obs({ scanId: 's2' })], 'discovered').severity).toBeNull();
  });

  test('maxSeverity follows the SEVERITIES order', () => {
    expect(maxSeverity('info', 'critical')).toBe('critical');
    expect(maxSeverity('medium', 'low')).toBe('medium');
    expect(maxSeverity(null, 'info')).toBe('info');
    expect(maxSeverity(null, null)).toBeNull();
  });
});

describe('data merge', () => {
  const older = obs({ scanId: 'old', observedAt: '2026-10-29T10:00:00.000Z', data: { version: '1', only_old: true } });
  const newer = obs({ scanId: 'new', observedAt: '2026-10-30T10:00:00.000Z', data: { version: '2', only_new: true } });

  test('the most recently observed value wins, whatever the input order', () => {
    const expected = { version: '2', only_old: true, only_new: true };
    expect(deriveNodeState([older, newer], 'discovered').data).toEqual(expected);
    expect(deriveNodeState([newer, older], 'discovered').data).toEqual(expected);
  });

  test('ties on time are broken by tool, then scan', () => {
    const a = obs({ scanId: 'z', tool: 'alpha', data: { k: 'alpha' } });
    const b = obs({ scanId: 'a', tool: 'beta', data: { k: 'beta' } });
    expect(deriveNodeState([b, a], 'discovered').data).toEqual({ k: 'beta' });
    expect(deriveNodeState([a, b], 'discovered').data).toEqual({ k: 'beta' });
  });
});

test('first_seen / last_seen are the earliest and latest observation times', () => {
  const list = [
    obs({ scanId: 'b', observedAt: '2026-10-29T10:00:00.500Z' }),
    obs({ scanId: 'a', observedAt: '2026-10-29T10:00:00.000Z' }),
    obs({ scanId: 'c', observedAt: '2026-10-31T09:00:00.000Z' }),
  ];
  expect(deriveNodeState(list, 'discovered')).toMatchObject({
    firstSeen: '2026-10-29T10:00:00.000Z',
    lastSeen: '2026-10-31T09:00:00.000Z',
  });
});

test('throws on an empty observation list', () => {
  expect(() => deriveNodeState([], 'discovered')).toThrow();
});
