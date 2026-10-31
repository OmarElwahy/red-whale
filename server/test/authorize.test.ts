import { describe, expect, test } from 'vitest';
import {
  ScopeViolation,
  assertScoped,
  authorize,
  isScopedTarget,
  recordCheck,
  type ScopedTarget,
} from '../src/scope/authorize';
import { addRule, logPage, patchRule, setSettings } from '../src/scope/store';
import { freshDb } from './helpers';

const runs = (db: ReturnType<typeof freshDb>) => logPage(db, { page: 1, pageSize: 50, sources: ['run'] });

function scoped() {
  const db = freshDb();
  const wild = addRule(db, { kind: 'wildcard', value: '*.example.com', action: 'include' });
  const net = addRule(db, { kind: 'cidr', value: '203.0.113.0/24', action: 'include' });
  const admin = addRule(db, { kind: 'domain', value: 'admin.example.com', action: 'exclude' });
  return { db, wild, net, admin };
}

describe('authorize', () => {
  test('an in-scope target comes back as a ScopedTarget with the canonical value, and is logged as run', () => {
    const { db, wild } = scoped();
    const result = authorize(db, { type: 'subdomain', value: 'API.Example.com.' }, 'passive');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toMatchObject({ type: 'subdomain', value: 'api.example.com', mode: 'passive', ruleId: wild.id });
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(isScopedTarget(result.target)).toBe(true);
    expect(() => {
      assertScoped(result.target);
    }).not.toThrow();

    const log = runs(db);
    expect(log.total).toBe(1);
    expect(log.items[0]).toMatchObject({
      id: result.target.logId,
      source: 'run',
      targetType: 'subdomain',
      targetValue: 'API.Example.com.',
      mode: 'passive',
      decision: 'in',
      rule: { id: wild.id },
    });
  });

  test('punycode: the target value is what was judged', () => {
    const db = freshDb();
    addRule(db, { kind: 'wildcard', value: '*.bücher.example', action: 'include' });
    const result = authorize(db, { type: 'subdomain', value: 'Shop.Bücher.example' }, 'passive');
    expect(result.ok && result.target.value).toBe('shop.xn--bcher-kva.example');
  });

  test('refusals are logged too, with the deciding rule', () => {
    const { db, admin } = scoped();
    const excluded = authorize(db, { type: 'subdomain', value: 'admin.example.com' }, 'passive');
    expect(excluded).toMatchObject({ ok: false, decision: 'out', rule: { id: admin.id } });
    const cdn = authorize(db, { type: 'ip', value: '198.51.100.9' }, 'passive');
    expect(cdn).toMatchObject({ ok: false, decision: 'out', rule: null });

    const log = runs(db);
    expect(log.items.map((e) => [e.targetValue, e.decision, e.rule?.id ?? null])).toEqual([
      ['198.51.100.9', 'out', null],
      ['admin.example.com', 'out', admin.id],
    ]);
  });

  test('n/a (not targetable) is refused', () => {
    const { db } = scoped();
    expect(authorize(db, { type: 'technology', value: 'nginx/1.18.0' }, 'passive')).toMatchObject({
      ok: false,
      decision: 'n/a',
    });
    expect(runs(db).items[0]?.decision).toBe('n/a');
  });

  test('an empty scope refuses everything', () => {
    const db = freshDb();
    for (const [type, value] of [
      ['domain', 'example.com'],
      ['ip', '203.0.113.7'],
      ['url', 'https://example.com/'],
    ] as const) {
      expect(authorize(db, { type, value }, 'passive')).toMatchObject({ ok: false, decision: 'out' });
    }
  });

  test('passive-only (the default) refuses active runs until it is turned off', () => {
    const { db, net } = scoped();
    const target = { type: 'port', value: '203.0.113.7:443/tcp' } as const;
    expect(authorize(db, target, 'active')).toMatchObject({ ok: false, reason: expect.stringMatching(/passive-only/) as unknown });
    setSettings(db, { passiveOnly: false });
    const allowed = authorize(db, target, 'active');
    expect(allowed).toMatchObject({ ok: true, target: { type: 'port', value: '203.0.113.7:443/tcp', mode: 'active', ruleId: net.id } });
  });

  test('it reads the scope at call time: a removed rule stops authorizing at once', () => {
    const { db, wild } = scoped();
    expect(authorize(db, { type: 'subdomain', value: 'a.example.com' }, 'passive').ok).toBe(true);
    patchRule(db, wild.id, { removed: true });
    expect(authorize(db, { type: 'subdomain', value: 'a.example.com' }, 'passive').ok).toBe(false);
  });
});

describe('recordCheck', () => {
  test('logs as check, never as run, and hands out no ScopedTarget', () => {
    const { db } = scoped();
    const result = recordCheck(db, { type: 'subdomain', value: 'a.example.com' }, 'passive');
    expect(result.decision).toBe('in');
    expect(result).not.toHaveProperty('target');
    expect(runs(db).total).toBe(0);
    expect(logPage(db, { page: 1, pageSize: 50, sources: ['check'] }).items[0]).toMatchObject({
      source: 'check',
      decision: 'in',
      id: result.logId,
    });
  });
});

describe('ScopedTarget can only come from authorize()', () => {
  const fields = {
    type: 'subdomain',
    value: 'a.example.com',
    mode: 'passive',
    ruleId: 1,
    logId: 1,
    authorizedAt: '2026-10-31T00:00:00.000Z',
  } as const;

  test('the type rejects an object literal (checked by pnpm typecheck)', () => {
    // @ts-expect-error the brand's key is a unique symbol that isn't exported, so a literal can't have it
    const forged: ScopedTarget = { ...fields };
    expect(isScopedTarget(forged)).toBe(false);
  });

  test('a cast gets past the compiler (the lint rule bans it) but not past assertScoped', () => {
    // eslint-disable-next-line no-restricted-syntax -- the forgery this test is about
    const forged = { ...fields } as unknown as ScopedTarget;
    expect(isScopedTarget(forged)).toBe(false);
    expect(() => {
      assertScoped(forged);
    }).toThrow(ScopeViolation);
  });

  test('a copy of a real one is not one', () => {
    const db = freshDb();
    addRule(db, { kind: 'wildcard', value: '*.example.com', action: 'include' });
    const result = authorize(db, { type: 'subdomain', value: 'a.example.com' }, 'passive');
    if (!result.ok) throw new Error('expected ok');
    const copy = { ...result.target };
    expect(isScopedTarget(copy)).toBe(false);
    expect(isScopedTarget(result.target)).toBe(true);
  });
});
