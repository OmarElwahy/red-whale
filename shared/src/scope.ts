// The scope guard's rules (docs/architecture.md §10): what the analyst may point a tool at. Pure, so the
// server (authorize, graph inScope), the API (/scope/check) and tests all decide the same way.
//
// Default deny: nothing is in scope until an include rule says so, and an exclude rule always wins.
// Hostnames are only ever matched against domain/wildcard rules and IPs against ip/cidr rules, so a domain in
// scope never puts the IPs it resolves to in scope (a CDN address is someone else's machine).
import ipaddr from 'ipaddr.js';
import { getPublicSuffix } from 'tldts';
import type { NodeType } from './enums';
import { NormalizeError, normalize, normalizeHostname, normalizeIp } from './normalize';
import { PORT_RE, isHostname } from './values';

export const SCOPE_KINDS = ['domain', 'wildcard', 'ip', 'cidr'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const SCOPE_ACTIONS = ['include', 'exclude'] as const;
export type ScopeAction = (typeof SCOPE_ACTIONS)[number];

/** `n/a`: the node isn't something a tool is pointed at (a technology, a CVE, a leak …). */
export const SCOPE_DECISIONS = ['in', 'out', 'n/a'] as const;
export type ScopeDecision = (typeof SCOPE_DECISIONS)[number];

/** passive = the target isn't touched (e.g. certificate-transparency lookups); active = packets go to it. */
export const SCOPE_MODES = ['passive', 'active'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

/** Who asked: the "test a target" box (`check`) or something about to run a tool (`run`, only via authorize()). */
export const SCOPE_SOURCES = ['check', 'run'] as const;
export type ScopeSource = (typeof SCOPE_SOURCES)[number];

/** Node types a tool can be pointed at. Every other type is `n/a`. */
export const TARGETABLE_TYPES = ['domain', 'subdomain', 'ip', 'port', 'url'] as const satisfies readonly NodeType[];
export type TargetableType = (typeof TARGETABLE_TYPES)[number];

export function isTargetable(type: NodeType): type is TargetableType {
  return (TARGETABLE_TYPES as readonly NodeType[]).includes(type);
}

/** Include CIDRs can't be broader than this (excludes can be any size). */
export const MAX_INCLUDE_PREFIX = { ipv4: 8, ipv6: 32 } as const;

/** What checkScope needs from a rule. The server passes whole rows; the matching row comes back as `rule`. */
export interface ScopeRuleInput {
  id: number;
  kind: ScopeKind;
  /** Normalized with normalizeScopeRule. */
  value: string;
  action: ScopeAction;
}

export interface Scope<R extends ScopeRuleInput = ScopeRuleInput> {
  /** Active rules only (removed rules are left out by the caller). */
  rules: readonly R[];
  /** While on, every active check is `out`. */
  passiveOnly: boolean;
}

export interface ScopeResult<R extends ScopeRuleInput = ScopeRuleInput> {
  decision: ScopeDecision;
  /** The rule that decided it: the exclude or include that matched. Absent for default deny, n/a, passive-only. */
  rule?: R;
  reason: string;
}

// --- rule values ------------------------------------------------------------------------------------

export type RuleValueResult = { ok: true; value: string } | { ok: false; error: string };

const ok = (value: string): RuleValueResult => ({ ok: true, value });
const fail = (error: string): RuleValueResult => ({ ok: false, error });

/** Strict IP text: dotted-quad IPv4 or IPv6, no zone ID. */
function isPlainIp(v: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(v) || (ipaddr.IPv6.isValid(v) && !v.includes('%'));
}

function hostnameRule(raw: string, what: string): RuleValueResult {
  let host: string;
  try {
    host = normalizeHostname(raw);
  } catch (e) {
    return fail(e instanceof NormalizeError ? e.message : String(e));
  }
  if (isPlainIp(host)) return fail(`'${raw}' is an IP address; use an ip or cidr rule`);
  if (!isHostname(host)) return fail(`'${raw}' is not a valid ${what} (e.g. example.com)`);
  return ok(host);
}

function wildcardRule(raw: string, action: ScopeAction): RuleValueResult {
  const v = raw.trim();
  if (!v.startsWith('*.')) return fail(`a wildcard starts with '*.', e.g. *.example.com`);
  const rest = v.slice(2);
  if (rest.includes('*')) return fail(`only one leading '*.' is allowed, e.g. *.example.com`);
  let base: string;
  try {
    base = normalizeHostname(rest);
  } catch (e) {
    return fail(e instanceof NormalizeError ? e.message : String(e));
  }
  // A bare TLD is valid syntax (an exclude may cover *.gov); an include on it is refused below, as a public suffix.
  const valid = isHostname(base) || /^[a-z]{2,63}$/.test(base);
  if (!valid || isPlainIp(base)) return fail(`'${raw}' is not a valid wildcard (e.g. *.example.com)`);
  if (action === 'include') {
    // Public Suffix List, private section included (bundled with tldts, no network): anyone can register names
    // under co.uk, com.eg or github.io, so *.co.uk would put strangers' machines in scope.
    const suffix = getPublicSuffix(base, { allowPrivateDomains: true });
    if (suffix === base) {
      return fail(
        `*.${base} is refused: ${base} is a public suffix, so names under it belong to many different owners. ` +
          `Add the registered domains you are allowed to test instead, e.g. *.example.${base}`,
      );
    }
  }
  return ok(`*.${base}`);
}

function ipRule(raw: string): RuleValueResult {
  const v = raw.trim().replace(/^\[(.*)\]$/, '$1');
  if (!isPlainIp(v)) return fail(`'${raw}' is not an IPv4/IPv6 address${v.includes('/') ? '; use a cidr rule' : ''}`);
  return ok(normalizeIp(v));
}

function cidrRule(raw: string, action: ScopeAction): RuleValueResult {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(raw.trim());
  const address = m?.[1] ?? '';
  if (!m || !isPlainIp(address)) return fail(`'${raw}' is not a CIDR range (e.g. 203.0.113.0/24 or 2001:db8::/32)`);
  let addr = ipaddr.parse(address);
  let prefix = Number(m[2]);
  if (prefix > (addr.kind() === 'ipv4' ? 32 : 128)) return fail(`prefix /${String(prefix)} is too long for ${address}`);

  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    // ::ffff:a.b.c.d/96+ is an IPv4 range; IPv4-mapped targets are normalized to IPv4, so store it as one.
    if (prefix < 96) return fail(`'${raw}' mixes IPv4-mapped and plain IPv6 addresses; use a /96 or longer prefix`);
    addr = addr.toIPv4Address();
    prefix -= 96;
  }
  const cidr = `${addr.toString()}/${String(prefix)}`;
  const network =
    addr instanceof ipaddr.IPv4 ? ipaddr.IPv4.networkAddressFromCIDR(cidr) : ipaddr.IPv6.networkAddressFromCIDR(cidr);
  const text = (a: ipaddr.IPv4 | ipaddr.IPv6) => (a instanceof ipaddr.IPv6 ? a.toRFC5952String() : a.toString());
  const canonical = `${text(network)}/${String(prefix)}`;
  if (text(network) !== text(addr)) return fail(`'${raw}' has host bits set; did you mean ${canonical}?`);

  const family = addr.kind() === 'ipv4' ? 'ipv4' : 'ipv6';
  const max = MAX_INCLUDE_PREFIX[family];
  if (action === 'include' && prefix < max) {
    return fail(
      `${canonical} is too broad to include: include ranges can be at most /${String(max)} for ` +
        `${family === 'ipv4' ? 'IPv4' : 'IPv6'}. Add narrower include rules for the ranges you are allowed to test ` +
        `(excludes can be any size)`,
    );
  }
  return ok(canonical);
}

/** Validates and canonicalizes a rule value (punycode, case, IPv6 compression, IPv4-mapped → IPv4). */
export function normalizeScopeRule(kind: ScopeKind, action: ScopeAction, value: string): RuleValueResult {
  if (value.trim() === '') return fail('value must not be empty');
  switch (kind) {
    case 'domain':
      return hostnameRule(value, 'domain');
    case 'wildcard':
      return wildcardRule(value, action);
    case 'ip':
      return ipRule(value);
    case 'cidr':
      return cidrRule(value, action);
  }
}

/** `include wildcard *.example.com (#3)`: how reasons name a rule. */
export function describeRule(rule: ScopeRuleInput): string {
  return `${rule.action} ${rule.kind} ${rule.value} (#${String(rule.id)})`;
}

// --- matching ---------------------------------------------------------------------------------------

type Address = ipaddr.IPv4 | ipaddr.IPv6;

type Matcher<R> =
  | { rule: R; on: 'host'; test: (host: string) => boolean }
  | { rule: R; on: 'ip'; test: (ip: Address) => boolean };

function matcher<R extends ScopeRuleInput>(rule: R): Matcher<R> {
  const normalized = normalizeScopeRule(rule.kind, rule.action, rule.value);
  // Rules are validated when they're added; a bad one here is a bug, not something to skip quietly.
  if (!normalized.ok) throw new Error(`invalid scope rule #${String(rule.id)}: ${normalized.error}`);
  const value = normalized.value;
  switch (rule.kind) {
    case 'domain':
      return { rule, on: 'host', test: (host) => host === value };
    case 'wildcard': {
      // Label-aligned suffix: *.example.com matches a.example.com and a.b.example.com, never example.com,
      // evilexample.com or example.com.evil.com.
      const suffix = value.slice(1);
      return { rule, on: 'host', test: (host) => host.endsWith(suffix) && host.length > suffix.length };
    }
    case 'ip': {
      const addr = ipaddr.parse(value);
      const text = addr.toNormalizedString();
      return { rule, on: 'ip', test: (ip) => ip.kind() === addr.kind() && ip.toNormalizedString() === text };
    }
    case 'cidr': {
      const range = ipaddr.parseCIDR(value);
      return { rule, on: 'ip', test: (ip) => ip.kind() === range[0].kind() && ip.match(range) };
    }
  }
}

/** What a targetable value points at: a hostname, or an IP. */
type Resolved = { host: string; ip?: never } | { ip: Address; host?: never };

function addressOf(ipText: string): Address {
  return ipaddr.parse(normalizeIp(ipText));
}

/** The host a value is judged by, plus a prefix for the reason when that isn't the value itself. */
function resolveTarget(type: TargetableType, value: string): { target: Resolved; via: string } {
  switch (type) {
    case 'domain':
    case 'subdomain': {
      const host = normalizeHostname(value);
      if (!isHostname(host)) throw new NormalizeError(`not a valid ${type}: '${value}'`);
      return { target: { host }, via: '' };
    }
    case 'ip':
      return { target: { ip: addressOf(value) }, via: '' };
    case 'port': {
      const ip = PORT_RE.exec(normalize('port', value))?.[1] ?? '';
      const addr = addressOf(ip);
      return { target: { ip: addr }, via: `judged by its IP ${normalizeIp(ip)}: ` };
    }
    case 'url': {
      const hostname = new URL(normalize('url', value)).hostname;
      const bare = hostname.replace(/^\[(.*)\]$/, '$1');
      if (isPlainIp(bare)) return { target: { ip: addressOf(bare) }, via: `judged by its host ${bare}: ` };
      if (!isHostname(hostname)) throw new NormalizeError(`URL host '${hostname}' is not a valid hostname`);
      return { target: { host: hostname }, via: `judged by its host ${hostname}: ` };
    }
  }
}

/**
 * The canonical text of a targetable value: what checkScope judged, so it's what a tool must be run against
 * (punycode hostnames, canonical IPs, normalized ports and URLs). Throws NormalizeError on an invalid value.
 */
export function canonicalTarget(type: TargetableType, value: string): string {
  if (type === 'domain' || type === 'subdomain') {
    resolveTarget(type, value);
    return normalizeHostname(value);
  }
  return type === 'ip' ? normalizeIp(value) : normalize(type, value);
}

export interface CompiledScope<R extends ScopeRuleInput = ScopeRuleInput> {
  check: (type: NodeType, value: string, mode: ScopeMode) => ScopeResult<R>;
}

/** Prepares the rules once, so checking every node of a graph is cheap. Throws on an invalid rule. */
export function compileScope<R extends ScopeRuleInput>(scope: Scope<R>): CompiledScope<R> {
  const matchers = scope.rules.map(matcher);
  const excludes = matchers.filter((m) => m.rule.action === 'exclude');
  const includes = matchers.filter((m) => m.rule.action === 'include');

  const find = (list: Matcher<R>[], target: Resolved): R | undefined =>
    list.find((m) =>
      m.on === 'host' ? target.host !== undefined && m.test(target.host) : target.ip !== undefined && m.test(target.ip),
    )?.rule;

  return {
    check(type, value, mode) {
      if (!isTargetable(type)) return { decision: 'n/a', reason: `a ${type} isn't something a tool is pointed at` };

      let resolved: { target: Resolved; via: string };
      try {
        resolved = resolveTarget(type, value);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { decision: 'out', reason: `can't check an invalid ${type} value: ${why}` };
      }
      const { target, via } = resolved;

      const excluded = find(excludes, target);
      if (excluded) return { decision: 'out', rule: excluded, reason: `${via}matches ${describeRule(excluded)}` };

      if (mode === 'active' && scope.passiveOnly) {
        return { decision: 'out', reason: `${via}passive-only mode is on, so no active check is allowed` };
      }

      const included = find(includes, target);
      if (included) return { decision: 'in', rule: included, reason: `${via}matches ${describeRule(included)}` };

      if (includes.length === 0) return { decision: 'out', reason: `${via}the scope has no include rules (default deny)` };
      if (target.ip !== undefined) {
        // Say why even when the name above it is in scope (a CDN address): only ip/cidr rules cover an IP.
        return {
          decision: 'out',
          reason: `${via}no ip or cidr rule includes it (default deny; domain rules never cover IP addresses)`,
        };
      }
      return { decision: 'out', reason: `${via}no domain or wildcard rule includes it (default deny)` };
    },
  };
}

/** Is this target in scope? Pure: `scope` holds the active rules and the passive-only setting. */
export function checkScope<R extends ScopeRuleInput>(
  type: NodeType,
  value: string,
  mode: ScopeMode,
  scope: Scope<R>,
): ScopeResult<R> {
  return compileScope(scope).check(type, value, mode);
}
