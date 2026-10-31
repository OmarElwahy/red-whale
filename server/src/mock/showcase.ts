// The small showcase mock (`pnpm mock`): one hand-written target, `showcase.example`, small enough to read on
// the canvas, that still covers every node type, relation, severity (none → critical), confidence and tag.
// It also has the shapes the UI must handle: an IP shared by two subdomains, an IPv6 address, a node only
// ever named as a parent (source_count 0), and exactly one aggregate (a JS file with just over AGG_THRESHOLD
// endpoints, one of them risky enough to stay visible). The big generator is `generate.ts` (`pnpm mock:large`).
//
// Everything goes through the normal ingest path. The only direct writes are the analyst's annotations
// (`verified`, tags, notes), which use the PATCH route's own `updateNode`, and the scope (SHOWCASE_SCOPE),
// added with the POST route's own `addRule`.
import { createHash } from 'node:crypto';
import type { ContractFile, Finding, NodePatch, NodeType, Relation, Severity } from '@redwhale/shared';
import { AGG_THRESHOLD } from '../graph/aggregate';
import type { MockFile, MockScopeRule } from './generate';

export const SHOWCASE_DOMAIN = 'showcase.example';
const D = SHOWCASE_DOMAIN;

type Ref = { type: NodeType; value: string };
const ref = (type: NodeType, value: string): Ref => ({ type, value });

function finding(
  type: NodeType,
  value: string,
  parent: Ref | null,
  relation: Relation | null,
  extra: { severity?: Severity; data?: Record<string, unknown> } = {},
): Finding {
  return {
    type,
    value,
    ...(parent && relation ? { parent, relation } : {}),
    ...(extra.severity ? { severity: extra.severity } : {}),
    ...(extra.data ? { data: extra.data } : {}),
  };
}

function scan(tool: string, version: string, command: string, start: string, end: string, findings: Finding[]): MockFile {
  const doc: ContractFile = {
    contract_version: 1,
    tool,
    tool_version: version,
    target: D,
    command,
    started_at: `2026-10-30T${start}Z`,
    finished_at: `2026-10-30T${end}Z`,
    status: 'success',
    errors: [],
    findings,
  };
  return { tool, doc };
}

/** A stable fake SHA-256 fingerprint (lowercase hex, as the contract wants). */
const fingerprint = (name: string) => createHash('sha256').update(`showcase-cert:${name}`).digest('hex');

// --- the target -------------------------------------------------------------------------------------------
const domain = ref('domain', D);
const sub = (name: string) => ref('subdomain', `${name}.${D}`);
const www = sub('www');
const api = sub('api');
const app = sub('app');
const mail = sub('mail');
const dev = sub('dev');
const vpn = sub('vpn');
/** Named only as the parent of an IP (dnsx); no tool ever reports it, so it has source_count 0. */
const legacy = sub('legacy');

const ip = (value: string) => ref('ip', value);
const ipWww = ip('198.18.0.10');
/** Shared: both api and app resolve to it. */
const ipShared = ip('198.18.0.20');
const ipMail = ip('198.18.0.30');
const ipMail6 = ip('2001:db8::25');
const ipDev = ip('198.18.0.40');
const ipVpn = ip('198.18.0.50');
const ipLegacy = ip('198.18.0.99');

const port = (host: Ref, n: number) =>
  ref('port', `${host.value.includes(':') ? `[${host.value}]` : host.value}:${String(n)}/tcp`);
const pWww443 = port(ipWww, 443);
const pWww80 = port(ipWww, 80);
const pShared443 = port(ipShared, 443);
const pShared22 = port(ipShared, 22);
const pMail25 = port(ipMail, 25);
const pMail6_25 = port(ipMail6, 25);
const pDev443 = port(ipDev, 443);
const pDevRedis = port(ipDev, 6379);
const pVpn443 = port(ipVpn, 443);

const PORTS: readonly [Ref, Ref][] = [
  [ipWww, pWww443], [ipWww, pWww80], [ipShared, pShared443], [ipShared, pShared22], [ipMail, pMail25],
  [ipMail6, pMail6_25], [ipDev, pDev443], [ipDev, pDevRedis], [ipVpn, pVpn443],
];

const url = (value: string) => ref('url', value);
const uWww = url(`https://www.${D}/`);
const uWwwHttp = url('http://198.18.0.10/');
const uApi = url(`https://api.${D}/`);
const uApp = url(`https://app.${D}/`);
const uDev = url(`https://dev.${D}/`);
const uDevGit = url(`https://dev.${D}/.git/config`);
const uVpn = url(`https://vpn.${D}/remote/login`);
const uAppJs = url(`https://app.${D}/static/app.js`);

/** Endpoints katana pulls out of app.js: just over AGG_THRESHOLD, so they fold into the one aggregate. */
const ENDPOINT_WORDS = [
  'users', 'users/me', 'orders', 'orders/history', 'cart', 'checkout', 'payments', 'invoices', 'products',
  'products/search', 'reviews', 'wishlist', 'coupons', 'shipping', 'addresses', 'notifications', 'messages',
  'settings', 'profile', 'avatar', 'sessions', 'tokens/refresh', 'password/reset', 'feature-flags', 'health',
  'metrics', 'i18n', 'uploads', 'exports', 'webhooks', 'support/tickets', 'analytics',
];
/** The one endpoint with a finding (medium): it stays visible next to the aggregate. */
const uExport = url(`https://app.${D}/api/v1/admin/export`);
function endpoints(): Ref[] {
  const quiet = AGG_THRESHOLD + 2;
  const names = Array.from({ length: quiet }, (_, i) => ENDPOINT_WORDS[i] ?? `route-${String(i)}`);
  return [...names.map((w) => url(`https://app.${D}/api/v1/${w}`)), uExport];
}

const tech = (value: string) => ref('technology', value);
const nginx = 'nginx/1.18.0';
const apache = 'Apache/2.4.49';
const fortios = 'FortiOS/6.4.0';

const vuln = (value: string) => ref('vulnerability', value);
const cveApache = vuln('CVE-2021-41773');
const cveFortinet = vuln('CVE-2018-13379');
const redisNoAuth = vuln('redis-default-logins');
const headers = vuln('http-missing-security-headers');

const admin = ref('email', `admin@${D}`);
const jane = ref('email', `jane.doe@${D}`);
const secret = ref('secret', 'AWS access key in /static/app.js');

/** One file per fake tool, in ingest order. Pure: always the same bytes. */
export function generateShowcase(): MockFile[] {
  const subdomains = [www, api, app, mail, dev, vpn];
  return [
    scan('subfinder', '2.6.6', `subfinder -d ${D} -oJ -silent`, '09:00:00', '09:01:05', [
      finding('domain', D, null, null),
      ...subdomains.map((s) => finding('subdomain', s.value, domain, 'has_subdomain', { data: { source: 'crtsh' } })),
    ]),
    // Corroborates three subdomains: they become `corroborated`, the rest stay `discovered`.
    scan('amass', '4.2.0', `amass enum -passive -d ${D} -json amass.json`, '09:00:00', '09:04:30', [
      ...[www, api, app].map((s) =>
        finding('subdomain', s.value, domain, 'has_subdomain', { data: { sources: ['alienvault', 'crtsh'] } }),
      ),
    ]),
    scan('dnsx', '1.2.1', 'dnsx -l subdomains.txt -a -aaaa -resp -json', '09:05:00', '09:05:20', [
      finding('ip', ipWww.value, domain, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipWww.value, www, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipShared.value, api, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipShared.value, app, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipMail.value, mail, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipMail6.value, mail, 'resolves_to', { data: { record: 'AAAA' } }),
      finding('ip', ipDev.value, dev, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipVpn.value, vpn, 'resolves_to', { data: { record: 'A' } }),
      finding('ip', ipLegacy.value, legacy, 'resolves_to', { data: { record: 'A', note: 'stale DNS record' } }),
    ]),
    scan('naabu', '2.3.1', 'naabu -list ips.txt -top-ports 100 -json', '09:06:00', '09:08:00', [
      ...PORTS.map(([host, p]) => finding('port', p.value, host, 'has_port')),
    ]),
    scan('nmap', '7.95', 'nmap -sV --script vulners -iL ips.txt -oX nmap.xml', '09:08:30', '09:20:00', [
      finding('port', pWww443.value, ipWww, 'has_port', { data: { service: 'https', product: 'nginx' } }),
      finding('technology', nginx, pWww443, 'uses_technology'),
      finding('port', pShared443.value, ipShared, 'has_port', { data: { service: 'https', product: 'Apache httpd' } }),
      finding('technology', apache, pShared443, 'uses_technology'),
      finding('vulnerability', cveApache.value, tech(apache), 'has_vulnerability', {
        severity: 'high',
        data: { script: 'vulners', cvss: 7.5 },
      }),
      finding('port', pShared22.value, ipShared, 'has_port', { data: { service: 'ssh' } }),
      finding('technology', 'OpenSSH/8.2p1', pShared22, 'uses_technology'),
      finding('port', pDevRedis.value, ipDev, 'has_port', { data: { service: 'redis' } }),
      finding('technology', 'Redis/6.2.6', pDevRedis, 'uses_technology'),
      finding('port', pVpn443.value, ipVpn, 'has_port', { data: { service: 'https', product: 'FortiGate' } }),
      finding('technology', fortios, pVpn443, 'uses_technology'),
    ]),
    scan('tlsx', '1.1.7', 'tlsx -l hosts.txt -json -hash sha256', '09:09:00', '09:09:40', [
      finding('certificate', fingerprint('www'), pWww443, 'has_certificate', {
        data: { subject_cn: `www.${D}`, issuer: 'Showcase Test CA', not_after: '2027-03-01T00:00:00Z' },
      }),
      finding('certificate', fingerprint('vpn'), vpn, 'has_certificate', {
        data: { subject_cn: `vpn.${D}`, issuer: 'self-signed', self_signed: true },
      }),
    ]),
    scan('httpx', '1.6.9', 'httpx -l hosts.txt -sc -title -tech-detect -json', '09:10:00', '09:12:00', [
      finding('url', uWww.value, www, 'serves', { data: { status_code: 200, title: 'Showcase' } }),
      finding('technology', 'Nginx/1.18.0', uWww, 'uses_technology'),
      finding('url', uWwwHttp.value, pWww80, 'serves', { data: { status_code: 301, location: uWww.value } }),
      finding('url', uApi.value, api, 'serves', { data: { status_code: 404, title: 'Not Found' } }),
      finding('technology', apache, uApi, 'uses_technology'),
      finding('url', uApp.value, app, 'serves', { data: { status_code: 200, title: 'Showcase App' } }),
      finding('technology', 'React', uApp, 'uses_technology'),
      finding('url', uDev.value, dev, 'serves', { data: { status_code: 403, title: '403 Forbidden' } }),
      finding('url', uVpn.value, vpn, 'serves', { data: { status_code: 200, title: 'FortiGate SSL VPN' } }),
    ]),
    scan('katana', '1.1.0', `katana -u https://app.${D}/ -jc -d 3 -json`, '09:12:30', '09:14:00', [
      finding('url', uAppJs.value, uApp, 'has_url', { data: { source: 'script', size: 482_113 } }),
      ...endpoints().map((e) => finding('url', e.value, uAppJs, 'has_url', { data: { source: 'js-endpoint' } })),
    ]),
    scan('trufflehog', '3.82.0', 'trufflehog filesystem js/ --json', '09:14:30', '09:15:00', [
      finding('secret', secret.value, uAppJs, 'has_secret', {
        severity: 'high',
        data: { detector: 'AWS', preview: 'AKIA****WXYZ', verified: false },
      }),
    ]),
    scan('nuclei', '3.3.5', 'nuclei -l urls.txt -jsonl', '09:15:00', '09:30:00', [
      finding('vulnerability', headers.value, uWww, 'has_vulnerability', {
        severity: 'info',
        data: { template_id: 'http-missing-security-headers', name: 'Missing security headers' },
      }),
      finding('vulnerability', 'cookies-without-secure', uApp, 'has_vulnerability', {
        severity: 'low',
        data: { template_id: 'cookies-without-secure', name: 'Cookie without Secure flag' },
      }),
      finding('url', uDevGit.value, dev, 'serves', { data: { status_code: 200 } }),
      finding('vulnerability', 'git-config-exposure', uDevGit, 'has_vulnerability', {
        severity: 'medium',
        data: { template_id: 'git-config', name: 'Exposed .git/config' },
      }),
      finding('vulnerability', 'idor-export', uExport, 'has_vulnerability', {
        severity: 'medium',
        data: { name: 'Export endpoint without authorization check' },
      }),
      // Also reported by nmap (on the technology): one node, two parents, corroborated.
      finding('vulnerability', cveApache.value, uApi, 'has_vulnerability', {
        severity: 'high',
        data: { template_id: 'CVE-2021-41773', name: 'Apache 2.4.49 path traversal' },
      }),
      finding('vulnerability', redisNoAuth.value, pDevRedis, 'has_vulnerability', {
        severity: 'high',
        data: { template_id: 'redis-default-logins', name: 'Redis without authentication' },
      }),
      finding('vulnerability', cveFortinet.value, uVpn, 'has_vulnerability', {
        severity: 'critical',
        data: { template_id: 'CVE-2018-13379', name: 'FortiOS SSL VPN path traversal' },
      }),
    ]),
    scan('theharvester', '4.6.0', `theHarvester -d ${D} -b all -f harvest.json`, '09:20:00', '09:24:00', [
      finding('email', admin.value, domain, 'has_email', { data: { source: 'hunter' } }),
      finding('email', jane.value, uWww, 'has_email', { data: { source: 'page' } }),
    ]),
    scan('h8mail', '2.5.6', 'h8mail -t emails.txt -j h8mail.json', '09:25:00', '09:26:00', [
      finding('leak', 'Collection1-2019', admin, 'found_in_leak', { severity: 'medium', data: { fields: ['password'] } }),
      finding('leak', 'LinkedIn-2016', jane, 'found_in_leak', { severity: 'low', data: { fields: ['email'] } }),
    ]),
  ];
}

/**
 * The engagement's scope, so the graph shows every decision: the apex and every subdomain in, one subdomain
 * excluded (dev), a CIDR and two single IPs in, and IPs that in-scope subdomains resolve to but that are NOT in
 * scope (198.18.0.20, the CDN edge api and app share; vpn's 198.18.0.50), so "a domain doesn't grant its IPs"
 * is visible. passiveOnly stays at its default (on).
 */
export const SHOWCASE_SCOPE: readonly MockScopeRule[] = [
  { kind: 'domain', value: D, action: 'include', note: 'Apex, per the engagement letter' },
  { kind: 'wildcard', value: `*.${D}`, action: 'include', note: 'Every subdomain the client owns' },
  {
    kind: 'domain',
    value: dev.value,
    action: 'exclude',
    note: 'Run by a contractor; not covered by the letter',
  },
  { kind: 'cidr', value: '198.18.0.0/28', action: 'include', note: 'Web hosting range (www)' },
  { kind: 'ip', value: ipMail.value, action: 'include', note: 'Mail server' },
  { kind: 'ip', value: ipMail6.value, action: 'include', note: 'Mail server, IPv6' },
];

/** The analyst's annotations, applied after ingest with the PATCH route's `updateNode`. */
export const SHOWCASE_ANNOTATIONS: readonly (Ref & { patch: NodePatch })[] = [
  {
    ...cveFortinet,
    patch: {
      confidence: 'verified',
      tag: 'interesting',
      notes:
        '**Confirmed** by hand: the SSL VPN portal leaks session files.\n\n- Patch FortiOS to 6.4.1+\n' +
        '- Rotate VPN credentials',
    },
  },
  {
    ...secret,
    patch: { tag: 'interesting', notes: 'Key prefix matches the **prod** account. Check CloudTrail before reporting.' },
  },
  { ...www, patch: { tag: 'checked' } },
  { ...headers, patch: { tag: 'ignored', notes: 'Out of scope for this engagement.' } },
];
