// shared/src/manual.ts: what the "Add node" dialog checks live, and the file POST /api/nodes ingests.
import { describe, expect, test } from 'vitest';
import {
  RELATIONS,
  RELATION_TYPES,
  childTypesOf,
  describeManualValue,
  manualDocument,
  manualIssue,
  manualWarnings,
  nodeId,
  parentTypesOf,
  relationsBetween,
  validateContract,
} from '../src';

describe('describeManualValue', () => {
  test('a valid value: the normalized value and the node ID it will have', () => {
    expect(describeManualValue('url', 'https://a.example.com:443')).toEqual({
      ok: true,
      normalized: 'https://a.example.com/',
      id: nodeId('url', 'https://a.example.com/'),
    });
    expect(describeManualValue('vulnerability', 'cve-2021-41773')).toMatchObject({ ok: true, normalized: 'CVE-2021-41773' });
    expect(describeManualValue('port', '2001:db8::1:443/tcp')).toMatchObject({ ok: true, normalized: '[2001:db8::1]:443/tcp' });
    expect(describeManualValue('ip', '::ffff:1.2.3.4')).toMatchObject({ ok: true, normalized: '1.2.3.4' });
  });

  test("an invalid value: the validator's message, as a finding would get it", () => {
    expect(describeManualValue('domain', 'Example.com')).toEqual({ ok: false, error: "domain value 'Example.com' must be lowercase" });
    expect(describeManualValue('email', 'nope')).toEqual({ ok: false, error: "email value 'nope' must be a valid lowercase email address" });
    expect(describeManualValue('secret', '')).toEqual({ ok: false, error: "secret value '' value must be a non-empty string" });
  });
});

describe('relations between types', () => {
  test('agree with the contract table', () => {
    expect(relationsBetween('domain', 'subdomain')).toEqual(['has_subdomain']);
    expect(relationsBetween('subdomain', 'ip')).toEqual(['resolves_to']);
    expect(relationsBetween('ip', 'domain')).toEqual([]);
    expect(parentTypesOf('domain')).toEqual([]);
    expect(parentTypesOf('url')).toEqual(['domain', 'subdomain', 'port', 'url']);
    expect(childTypesOf('email')).toEqual(['leak']);
    for (const r of RELATION_TYPES) {
      for (const p of RELATIONS[r].parents) for (const c of RELATIONS[r].children) expect(relationsBetween(p, c)).toContain(r);
    }
  });
});

describe('the synthetic file', () => {
  test('is a valid contract v1 file by tool manual', () => {
    const doc = manualDocument(
      { type: 'subdomain', value: 'a.example.com', parent: { type: 'domain', value: 'example.com' }, relation: 'has_subdomain' },
      new Date('2026-11-02T10:00:00Z'),
    );
    const result = validateContract(doc);
    expect(result.ok).toBe(true);
    expect(doc).toMatchObject({ tool: 'manual', command: 'added by analyst', target: 'a.example.com', started_at: '2026-11-02T10:00:00.000Z' });
  });

  test('issues and warnings lose their findings[0] prefix', () => {
    expect(manualIssue("findings[0].value: domain value 'X' must be lowercase")).toBe("value: domain value 'X' must be lowercase");
    expect(manualIssue('findings[0]: secret has no severity')).toBe('secret has no severity');
    expect(manualWarnings({ type: 'secret', value: 'key in app.js' })).toEqual([
      'secret has no severity',
      'secret has no parent; it will float alone on the graph',
    ]);
    expect(manualWarnings({ type: 'domain', value: 'example.com' })).toEqual([]);
  });
});
