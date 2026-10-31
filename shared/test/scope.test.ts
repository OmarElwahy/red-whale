import { describe, expect, test } from 'vitest';
import {
  NODE_TYPES,
  NormalizeError,
  TARGETABLE_TYPES,
  checkScope,
  compileScope,
  normalizeHostname,
  normalizeScopeRule,
  type NodeType,
  type ScopeAction,
  type ScopeKind,
  type ScopeMode,
  type ScopeRuleInput,
} from '../src';

let nextId = 1;
function rule(kind: ScopeKind, value: string, action: ScopeAction = 'include'): ScopeRuleInput {
  const normalized = normalizeScopeRule(kind, action, value);
  if (!normalized.ok) throw new Error(normalized.error);
  return { id: nextId++, kind, value: normalized.value, action };
}

const scope = (rules: ScopeRuleInput[], passiveOnly = false) => ({ rules, passiveOnly });

function decide(type: NodeType, value: string, rules: ScopeRuleInput[], mode: ScopeMode = 'passive', passiveOnly = false) {
  return checkScope(type, value, mode, scope(rules, passiveOnly));
}

describe('normalizeHostname', () => {
  test.each([
    ['Example.COM', 'example.com'],
    ['example.com.', 'example.com'],
    ['  api.example.com ', 'api.example.com'],
    ['Bücher.Example', 'xn--bcher-kva.example'],
    ['BÜCHER.example.', 'xn--bcher-kva.example'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  test.each(['', 'example.com:443', 'http://example.com', 'example.com/path', 'user@example.com', 'a b.com', '[::1]', 'a%41.com'])(
    'refuses %j',
    (input) => {
      expect(() => normalizeHostname(input)).toThrow(NormalizeError);
    },
  );
});

describe('normalizeScopeRule', () => {
  test.each<[ScopeKind, ScopeAction, string, string]>([
    ['domain', 'include', 'Example.COM.', 'example.com'],
    ['domain', 'include', 'Bücher.example', 'xn--bcher-kva.example'],
    ['wildcard', 'include', '*.Example.com', '*.example.com'],
    ['wildcard', 'include', '*.bücher.example', '*.xn--bcher-kva.example'],
    ['wildcard', 'include', '*.example.co.uk', '*.example.co.uk'],
    ['wildcard', 'exclude', '*.com', '*.com'],
    ['wildcard', 'exclude', '*.co.uk', '*.co.uk'],
    ['ip', 'include', '203.0.113.7', '203.0.113.7'],
    ['ip', 'include', '2001:0DB8::0001', '2001:db8::1'],
    ['ip', 'include', '[2001:db8::1]', '2001:db8::1'],
    ['ip', 'include', '::ffff:203.0.113.7', '203.0.113.7'],
    ['cidr', 'include', '203.0.113.0/24', '203.0.113.0/24'],
    ['cidr', 'include', '10.0.0.0/8', '10.0.0.0/8'],
    ['cidr', 'include', '2001:DB8:0000::/32', '2001:db8::/32'],
    ['cidr', 'include', '::ffff:203.0.113.0/120', '203.0.113.0/24'],
    ['cidr', 'include', '203.0.113.7/32', '203.0.113.7/32'],
    ['cidr', 'exclude', '0.0.0.0/0', '0.0.0.0/0'],
    ['cidr', 'exclude', '::/0', '::/0'],
  ])('%s %s %s → %s', (kind, action, input, expected) => {
    expect(normalizeScopeRule(kind, action, input)).toEqual({ ok: true, value: expected });
  });

  test.each<[ScopeKind, ScopeAction, string, RegExp]>([
    ['domain', 'include', '', /empty/],
    ['domain', 'include', 'localhost', /not a valid domain/],
    ['domain', 'include', '203.0.113.7', /use an ip or cidr rule/],
    ['domain', 'include', 'example.com:443', /not a hostname/],
    ['domain', 'include', '*.example.com', /not a hostname|not a valid/],
    ['wildcard', 'include', 'example.com', /starts with '\*\.'/],
    ['wildcard', 'include', 'a.*.example.com', /starts with/],
    ['wildcard', 'include', '*.*.example.com', /only one/],
    ['wildcard', 'include', '*', /starts with/],
    // Public Suffix List: ICANN and private suffixes, multi-label ones included.
    ['wildcard', 'include', '*.com', /com is a public suffix/],
    ['wildcard', 'include', '*.co.uk', /co\.uk is a public suffix.*\*\.example\.co\.uk/],
    ['wildcard', 'include', '*.com.eg', /com\.eg is a public suffix/],
    ['wildcard', 'include', '*.github.io', /github\.io is a public suffix/],
    ['wildcard', 'include', '*.COM.', /com is a public suffix/],
    ['ip', 'include', '203.0.113.0/24', /use a cidr rule/],
    ['ip', 'include', '203.0.113', /not an IPv4\/IPv6 address/],
    ['ip', 'include', '010.0.0.1', /not an IPv4\/IPv6 address/],
    ['ip', 'include', 'fe80::1%eth0', /not an IPv4\/IPv6 address/],
    ['cidr', 'include', '203.0.113.7', /not a CIDR/],
    ['cidr', 'include', '203.0.113.0/33', /too long/],
    ['cidr', 'include', '2001:db8::/129', /too long/],
    ['cidr', 'include', '203.0.113.7/24', /host bits set; did you mean 203\.0\.113\.0\/24\?/],
    ['cidr', 'include', '2001:db8::1/64', /did you mean 2001:db8::\/64\?/],
    ['cidr', 'include', '::ffff:0:0/95', /\/96 or longer/],
    // Broad includes are refused outright (no override); the message says why and what to do.
    ['cidr', 'include', '0.0.0.0/0', /0\.0\.0\.0\/0 is too broad.*at most \/8 for IPv4.*narrower/],
    ['cidr', 'include', '::/0', /::\/0 is too broad.*at most \/32 for IPv6/],
    ['cidr', 'include', '10.0.0.0/7', /too broad/],
    ['cidr', 'include', '2001:db8::/31', /too broad/],
  ])('%s %s %j is refused', (kind, action, input, message) => {
    const result = normalizeScopeRule(kind, action, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe('checkScope: default deny', () => {
  test('an empty scope allows nothing', () => {
    for (const type of TARGETABLE_TYPES) {
      const value = {
        domain: 'example.com',
        subdomain: 'a.example.com',
        ip: '203.0.113.7',
        port: '203.0.113.7:443/tcp',
        url: 'https://a.example.com/',
      }[type];
      const r = decide(type, value, []);
      expect(r.decision).toBe('out');
      expect(r.rule).toBeUndefined();
      expect(r.reason).toMatch(/the scope has no include rules \(default deny\)$/);
    }
  });

  test('a scope of only excludes allows nothing', () => {
    expect(decide('domain', 'example.com', [rule('domain', 'other.com', 'exclude')]).decision).toBe('out');
  });

  test('a target no include matches is out, with no rule', () => {
    const result = decide('domain', 'other.com', [rule('domain', 'example.com')]);
    expect(result).toEqual({ decision: 'out', reason: 'no domain or wildcard rule includes it (default deny)' });
  });
});

describe('checkScope: domains and wildcards', () => {
  const exact = rule('domain', 'example.com');
  const wild = rule('wildcard', '*.example.com');

  test('domain rules match exactly', () => {
    expect(decide('domain', 'example.com', [exact])).toMatchObject({ decision: 'in', rule: exact });
    expect(decide('subdomain', 'a.example.com', [exact]).decision).toBe('out');
  });

  test.each([
    ['a.example.com', 'in'],
    ['deep.a.b.c.example.com', 'in'],
    ['example.com', 'out'],
    ['a.example.com.evil.com', 'out'],
    ['example.com.evil.com', 'out'],
    ['evilexample.com', 'out'],
    ['aexample.com', 'out'],
    ['a.example.co', 'out'],
    ['A.Example.COM.', 'in'],
  ])('*.example.com vs %s → %s', (value, expected) => {
    expect(decide('subdomain', value, [wild]).decision).toBe(expected);
  });

  test('both rules together cover the apex and every subdomain', () => {
    expect(decide('domain', 'example.com', [wild, exact])).toMatchObject({ decision: 'in', rule: exact });
    expect(decide('subdomain', 'x.example.com', [wild, exact])).toMatchObject({ decision: 'in', rule: wild });
  });

  test('punycode: a rule typed in Unicode matches the ASCII node, and the other way round', () => {
    const unicode = rule('wildcard', '*.Bücher.example');
    expect(decide('subdomain', 'shop.xn--bcher-kva.example', [unicode]).decision).toBe('in');
    const ascii = rule('domain', 'xn--bcher-kva.example');
    expect(decide('domain', 'bücher.example', [ascii]).decision).toBe('in');
  });

  test('the reason names the rule', () => {
    const r = decide('subdomain', 'a.example.com', [wild]);
    expect(r.reason).toBe(`matches include wildcard *.example.com (#${String(wild.id)})`);
  });
});

describe('checkScope: exclude always wins', () => {
  const wild = rule('wildcard', '*.example.com');
  const exDomain = rule('domain', 'admin.example.com', 'exclude');
  const exWild = rule('wildcard', '*.corp.example.com', 'exclude');

  test.each([
    [[wild, exDomain]],
    [[exDomain, wild]],
  ])('in either order', (rules) => {
    expect(decide('subdomain', 'admin.example.com', rules)).toMatchObject({ decision: 'out', rule: exDomain });
    expect(decide('subdomain', 'www.example.com', rules)).toMatchObject({ decision: 'in', rule: wild });
  });

  test('an exclude wildcard beats an exact include', () => {
    const exactInclude = rule('domain', 'vpn.corp.example.com');
    const result = decide('subdomain', 'vpn.corp.example.com', [exactInclude, exWild]);
    expect(result).toMatchObject({ decision: 'out', rule: exWild });
    expect(result.reason).toMatch(/matches exclude wildcard \*\.corp\.example\.com/);
  });

  test('an exclude CIDR beats an include IP inside it', () => {
    const ip = rule('ip', '203.0.113.7');
    const ex = rule('cidr', '203.0.113.0/24', 'exclude');
    expect(decide('ip', '203.0.113.7', [ip, ex])).toMatchObject({ decision: 'out', rule: ex });
  });

  test('an exclude of any size is fine', () => {
    const ex = rule('cidr', '0.0.0.0/0', 'exclude');
    const inc = rule('cidr', '203.0.113.0/24');
    expect(decide('ip', '203.0.113.1', [inc, ex]).decision).toBe('out');
  });

  test('exclude wins even when passive-only would also refuse (the rule is the more useful reason)', () => {
    const r = decide('subdomain', 'admin.example.com', [wild, exDomain], 'active', true);
    expect(r).toMatchObject({ decision: 'out', rule: exDomain });
  });
});

describe('checkScope: IPs and CIDRs', () => {
  const net = rule('cidr', '203.0.113.0/24');

  test.each([
    ['203.0.113.0', 'in'],
    ['203.0.113.255', 'in'],
    ['203.0.112.255', 'out'],
    ['203.0.114.0', 'out'],
    ['::ffff:203.0.113.9', 'in'],
    ['::ffff:cb00:7109', 'in'],
  ])('203.0.113.0/24 vs %s → %s', (value, expected) => {
    expect(decide('ip', value, [net]).decision).toBe(expected);
  });

  test('/32 and /31 boundaries', () => {
    const one = rule('cidr', '198.51.100.7/32');
    expect(decide('ip', '198.51.100.7', [one]).decision).toBe('in');
    expect(decide('ip', '198.51.100.6', [one]).decision).toBe('out');
    const two = rule('cidr', '198.51.100.6/31');
    expect(decide('ip', '198.51.100.6', [two]).decision).toBe('in');
    expect(decide('ip', '198.51.100.7', [two]).decision).toBe('in');
    expect(decide('ip', '198.51.100.8', [two]).decision).toBe('out');
    expect(decide('ip', '198.51.100.5', [two]).decision).toBe('out');
  });

  test('/8 is the broadest include, inclusive at both ends', () => {
    const eight = rule('cidr', '10.0.0.0/8');
    expect(decide('ip', '10.0.0.0', [eight]).decision).toBe('in');
    expect(decide('ip', '10.255.255.255', [eight]).decision).toBe('in');
    expect(decide('ip', '11.0.0.0', [eight]).decision).toBe('out');
    expect(decide('ip', '9.255.255.255', [eight]).decision).toBe('out');
  });

  test('IPv6 CIDR', () => {
    const v6 = rule('cidr', '2001:db8:abcd::/48');
    expect(decide('ip', '2001:db8:abcd::', [v6]).decision).toBe('in');
    expect(decide('ip', '2001:DB8:ABCD:FFFF:FFFF:FFFF:FFFF:FFFF', [v6]).decision).toBe('in');
    expect(decide('ip', '2001:db8:abce::', [v6]).decision).toBe('out');
    expect(decide('ip', '2001:db8:abcc:ffff:ffff:ffff:ffff:ffff', [v6]).decision).toBe('out');
    const host = rule('cidr', '2001:db8::1/128');
    expect(decide('ip', '2001:0db8:0:0:0:0:0:1', [host]).decision).toBe('in');
    expect(decide('ip', '2001:db8::2', [host]).decision).toBe('out');
  });

  test('families never cross: an IPv4 rule never matches IPv6 and back', () => {
    const v6 = rule('cidr', '2001:db8::/32');
    expect(decide('ip', '203.0.113.7', [v6]).decision).toBe('out');
    expect(decide('ip', '2001:db8::1', [net]).decision).toBe('out');
    // ::/0 as an exclude must not swallow IPv4 either.
    const allV6 = rule('cidr', '::/0', 'exclude');
    expect(decide('ip', '203.0.113.7', [net, allV6]).decision).toBe('in');
  });

  test('an IPv4-mapped rule matches the plain IPv4 node', () => {
    const mapped = rule('ip', '::ffff:203.0.113.7');
    expect(decide('ip', '203.0.113.7', [mapped]).decision).toBe('in');
    const mappedNet = rule('cidr', '::ffff:198.51.100.0/120');
    expect(decide('ip', '198.51.100.200', [mappedNet]).decision).toBe('in');
  });

  test('ip rules match one address in any spelling', () => {
    const one = rule('ip', '2001:db8::1');
    expect(decide('ip', '2001:0DB8:0000:0000:0000:0000:0000:0001', [one]).decision).toBe('in');
    expect(decide('ip', '[2001:db8::1]', [one]).decision).toBe('in');
    expect(decide('ip', '2001:db8::2', [one]).decision).toBe('out');
  });
});

describe('checkScope: a domain never grants its IPs', () => {
  const rules = [rule('domain', 'example.com'), rule('wildcard', '*.example.com')];

  test('an IP is out even when every hostname is in', () => {
    const r = decide('ip', '203.0.113.7', rules);
    expect(r.decision).toBe('out');
    expect(r.rule).toBeUndefined();
    expect(r.reason).toMatch(/domain rules never cover IP addresses/);
  });

  test('and hostnames never match IP rules', () => {
    const r = decide('subdomain', 'www.example.org', [rule('cidr', '203.0.113.0/24')]);
    expect(r.decision).toBe('out');
  });

  test('with an IP rule that doesn’t match, the reason still says why (the CDN case)', () => {
    const r = decide('ip', '198.51.100.1', [...rules, rule('cidr', '203.0.113.0/24')]);
    expect(r.reason).toBe('no ip or cidr rule includes it (default deny; domain rules never cover IP addresses)');
  });
});

describe('checkScope: ports and URLs', () => {
  const net = rule('cidr', '203.0.113.0/24');
  const v6 = rule('cidr', '2001:db8::/32');
  const wild = rule('wildcard', '*.example.com');

  test('a port is judged by its IP', () => {
    const r = decide('port', '203.0.113.7:443/tcp', [net]);
    expect(r).toMatchObject({ decision: 'in', rule: net });
    expect(r.reason).toMatch(/^judged by its IP 203\.0\.113\.7: matches/);
    expect(decide('port', '198.51.100.7:443/tcp', [net]).decision).toBe('out');
    expect(decide('port', '[2001:db8::1]:53/udp', [v6]).decision).toBe('in');
    expect(decide('port', '2001:db8::1:53/udp', [v6]).decision).toBe('in');
    expect(decide('port', '::ffff:203.0.113.7:80/tcp', [net]).decision).toBe('in');
  });

  test('a port is never in scope through a hostname rule', () => {
    expect(decide('port', '203.0.113.7:443/tcp', [wild]).decision).toBe('out');
  });

  test('a URL is judged by its host name', () => {
    const r = decide('url', 'https://api.example.com/v1/login?x=1', [wild]);
    expect(r).toMatchObject({ decision: 'in', rule: wild });
    expect(r.reason).toMatch(/^judged by its host api\.example\.com:/);
    expect(decide('url', 'https://API.Example.com:8443/', [wild]).decision).toBe('in');
    expect(decide('url', 'https://example.com.evil.com/', [wild]).decision).toBe('out');
    expect(decide('url', 'https://evil.com/?next=https://a.example.com/', [wild]).decision).toBe('out');
  });

  test('a URL with an IP literal host is judged by IP rules', () => {
    expect(decide('url', 'http://203.0.113.7:8080/admin', [net]).decision).toBe('in');
    expect(decide('url', 'http://203.0.113.7/', [wild]).decision).toBe('out');
    expect(decide('url', 'http://[2001:db8::1]/', [v6]).decision).toBe('in');
    expect(decide('url', 'http://[::ffff:203.0.113.7]/', [net]).decision).toBe('in');
    // WHATWG canonicalizes odd IPv4 spellings, so they can't sneak past a rule.
    expect(decide('url', 'http://0xcb.0.113.7/', [net]).decision).toBe('in');
    expect(decide('url', 'http://0xcb.0.113.7/', [net, rule('ip', '203.0.113.7', 'exclude')]).decision).toBe('out');
  });
});

describe('checkScope: passive-only', () => {
  const wild = rule('wildcard', '*.example.com');

  test('while on, active checks are out and passive checks are unaffected', () => {
    const active = decide('subdomain', 'a.example.com', [wild], 'active', true);
    expect(active.decision).toBe('out');
    expect(active.rule).toBeUndefined();
    expect(active.reason).toMatch(/passive-only mode is on/);
    expect(decide('subdomain', 'a.example.com', [wild], 'passive', true).decision).toBe('in');
  });

  test('while off, active checks follow the rules', () => {
    expect(decide('subdomain', 'a.example.com', [wild], 'active', false).decision).toBe('in');
    expect(decide('subdomain', 'a.other.com', [wild], 'active', false).decision).toBe('out');
  });
});

describe('checkScope: what is not targetable', () => {
  const rules = [rule('wildcard', '*.example.com'), rule('cidr', '203.0.113.0/24')];
  const others = NODE_TYPES.filter((t) => !(TARGETABLE_TYPES as readonly string[]).includes(t));

  test('the targetable types are exactly domain, subdomain, ip, port, url', () => {
    expect(others).toEqual(['technology', 'vulnerability', 'email', 'secret', 'certificate', 'leak']);
  });

  test.each(others)('%s is n/a in both modes', (type) => {
    for (const mode of ['passive', 'active'] as const) {
      const r = decide(type, 'anything', rules, mode, true);
      expect(r.decision).toBe('n/a');
      expect(r.rule).toBeUndefined();
    }
  });
});

describe('checkScope: fails closed', () => {
  const rules = [rule('wildcard', '*.example.com'), rule('cidr', '203.0.113.0/24')];

  test.each<[NodeType, string]>([
    ['domain', 'not a host'],
    ['domain', 'example.com:443'],
    ['subdomain', '*.example.com'],
    ['ip', '203.0.113'],
    ['ip', 'a.example.com'],
    ['port', '203.0.113.7:99999/tcp'],
    ['port', 'a.example.com:443/tcp'],
    ['url', 'not a url'],
    ['url', 'ftp//a.example.com'],
  ])('an invalid %s %j is out', (type, value) => {
    const r = decide(type, value, rules);
    expect(r.decision).toBe('out');
    expect(r.reason).toMatch(new RegExp(`^can't check an invalid ${type} value`));
  });

  test('an invalid rule throws instead of being skipped', () => {
    expect(() => compileScope(scope([{ id: 1, kind: 'cidr', value: '0.0.0.0/0', action: 'include' }]))).toThrow(
      /invalid scope rule #1/,
    );
  });
});
