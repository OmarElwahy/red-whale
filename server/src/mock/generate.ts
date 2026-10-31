// Mock recon data (docs/architecture.md §9, Phase 3.1): contract-valid files for one fake target,
// reported by several fake tools that overlap, so ingest produces both discovered and corroborated nodes.
// Pure and seeded: the same options always produce byte-identical files.
import type { ContractFile, Finding, NodeType, Relation, ScopeAction, ScopeKind, Severity } from '@redwhale/shared';

export interface MockOptions {
  subdomains: number;
  seed: number;
  domain: string;
}

/** A scope rule a mock seeds after the wipe (through the same addRule as POST /api/scope/rules). */
export interface MockScopeRule {
  kind: ScopeKind;
  value: string;
  action: ScopeAction;
  note: string;
}

export const MOCK_DEFAULTS: MockOptions = { subdomains: 400, seed: 1337, domain: 'northwind.example' };
export const MAX_SUBDOMAINS = 20_000;

export interface MockFile {
  tool: string;
  doc: ContractFile;
}

/** mulberry32: small, fast, and good enough for fake data. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    chance: (p: number) => next() < p,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}
type Rng = ReturnType<typeof prng>;

const WORDS = [
  'www', 'api', 'app', 'auth', 'admin', 'beta', 'blog', 'cdn', 'chat', 'ci', 'cms', 'crm', 'dashboard', 'data',
  'db', 'demo', 'dev', 'docs', 'files', 'forum', 'ftp', 'git', 'grafana', 'help', 'hr', 'images', 'internal',
  'jenkins', 'jira', 'kibana', 'legacy', 'login', 'm', 'mail', 'media', 'metrics', 'mobile', 'monitor', 'mx',
  'my', 'news', 'ns1', 'ns2', 'office', 'old', 'partner', 'pay', 'portal', 'preprod', 'prometheus', 'qa',
  'remote', 'sandbox', 'search', 'secure', 'shop', 'smtp', 'sso', 'staging', 'static', 'status', 'store',
  'support', 'test', 'uat', 'upload', 'vpn', 'webmail', 'wiki',
] as const;
const ENVS = ['dev', 'staging', 'qa', 'uat', 'prod'] as const;
const REGIONS = ['eu', 'us', 'ap'] as const;
const SOURCES = ['crtsh', 'virustotal', 'alienvault', 'hackertarget', 'rapiddns', 'certspotter'] as const;

/** `count` distinct subdomain names: plain words first, then generated variants. */
function subdomainNames(rng: Rng, domain: string, count: number): string[] {
  const names = new Set<string>();
  for (const word of rng.shuffle(WORDS)) {
    if (names.size >= count) break;
    names.add(word);
  }
  let fallback = 0;
  while (names.size < count) {
    const word = rng.pick(WORDS);
    const k = String(1 + rng.int(9));
    const variants = [
      `${word}-${rng.pick(ENVS)}`,
      `${word}${k}`,
      `${word}-${rng.pick(REGIONS)}-${k}`,
      `${rng.pick(ENVS)}.${word}`,
      `${word}-${rng.pick(ENVS)}-${rng.pick(REGIONS)}${k}`,
    ];
    const name = rng.pick(variants);
    if (!names.has(name)) names.add(name);
    else if (rng.chance(0.05)) names.add(`${word}-${String(++fallback)}`);
  }
  return [...names].map((n) => `${n}.${domain}`);
}

/**
 * The large mock's scope: the domain and its subdomains in, admin excluded, and only the first 31 mock IPs in
 * (198.18.0.0/27; the default run uses ~80), so many in-scope subdomains resolve to an IP that is out of scope.
 */
export function largeScope(domain: string): MockScopeRule[] {
  return [
    { kind: 'domain', value: domain, action: 'include', note: 'Apex' },
    { kind: 'wildcard', value: `*.${domain}`, action: 'include', note: 'Every subdomain' },
    { kind: 'domain', value: `admin.${domain}`, action: 'exclude', note: 'Production admin panel: hands off' },
    { kind: 'cidr', value: '198.18.0.0/27', action: 'include', note: 'The client-owned hosting range' },
  ];
}

/** The i-th address in 198.18.0.0/15 (reserved for benchmarking; never a real host), skipping .0 and .255. */
function mockIp(i: number): string {
  const third = Math.floor(i / 254);
  return `198.${String(18 + Math.floor(third / 256))}.${String(third % 256)}.${String((i % 254) + 1)}`;
}

interface WebServer {
  nmap: string; // as nmap -sV reports it
  httpx: string; // as httpx -tech-detect reports it (different case; ingest merges them)
  product: string;
  version: string;
}
const WEB_SERVERS: readonly [number, WebServer][] = [
  [0.5, { nmap: 'nginx/1.18.0', httpx: 'Nginx/1.18.0', product: 'nginx', version: '1.18.0' }],
  [0.15, { nmap: 'Apache/2.4.49', httpx: 'Apache/2.4.49', product: 'Apache httpd', version: '2.4.49' }],
  [0.15, { nmap: 'Apache/2.4.58', httpx: 'Apache/2.4.58', product: 'Apache httpd', version: '2.4.58' }],
  [0.1, { nmap: 'Microsoft-IIS/10.0', httpx: 'Microsoft-IIS/10.0', product: 'Microsoft IIS httpd', version: '10.0' }],
  [0.1, { nmap: 'envoy', httpx: 'Envoy', product: 'envoy', version: '' }],
];
const VULNERABLE_APACHE = WEB_SERVERS[1]?.[1] as WebServer;

function weighted<T>(rng: Rng, items: readonly [number, T][]): T {
  let r = rng.next();
  for (const [w, item] of items) {
    if (r < w) return item;
    r -= w;
  }
  return (items.at(-1) as [number, T])[1];
}

const EXTRA_PORTS: readonly [port: number, p: number, service: string, tech: string | null][] = [
  [22, 0.3, 'ssh', null],
  [8080, 0.1, 'http-proxy', null],
  [8443, 0.08, 'https-alt', null],
  [3306, 0.05, 'mysql', 'MySQL/8.0.32'],
  [5432, 0.04, 'postgresql', 'PostgreSQL/14.9'],
  [6379, 0.04, 'redis', 'Redis/6.2.6'],
  [9200, 0.03, 'elasticsearch', 'Elasticsearch/7.10.2'],
];
const SSH_VERSIONS = ['OpenSSH/8.2p1', 'OpenSSH/9.6p1'] as const;
const FRAMEWORKS: readonly [string, number][] = [
  ['jQuery/3.5.1', 0.3],
  ['React', 0.2],
  ['PHP/7.4.3', 0.2],
  ['WordPress/5.8.1', 0.1],
];
const TITLES = ['Login', 'Dashboard', 'Welcome', '403 Forbidden', 'Index of /', 'API Gateway', 'Sign in', 'Home'];
const STATUS_CODES: readonly [number, number][] = [
  [0.55, 200], [0.15, 301], [0.1, 302], [0.08, 401], [0.07, 403], [0.05, 404],
];

interface Host {
  name: string;
  subfinder: boolean;
  amass: boolean;
  ips: number[];
}
interface IpInfo {
  value: string;
  ports: { port: number; service: string; tech: string | null }[];
  web: WebServer;
  nmap: boolean;
}

type VulnSpec = { id: string; severity: Severity; template: string; name: string };
const LOG4SHELL: VulnSpec = { id: 'CVE-2021-44228', severity: 'critical', template: 'CVE-2021-44228', name: 'Apache Log4j RCE' };
const APACHE_TRAVERSAL: VulnSpec = {
  id: 'CVE-2021-41773', severity: 'high', template: 'CVE-2021-41773', name: 'Apache 2.4.49 path traversal',
};
const GIT_CONFIG: VulnSpec = { id: 'git-config-exposure', severity: 'medium', template: 'git-config', name: 'Exposed .git/config' };
const EXTRA_URL_VULNS: readonly VulnSpec[] = [
  { id: 'http-missing-security-headers', severity: 'info', template: 'http-missing-security-headers', name: 'Missing security headers' },
  { id: 'grafana-detect', severity: 'info', template: 'grafana-detect', name: 'Grafana panel detected' },
  { id: 'cookies-without-secure', severity: 'low', template: 'cookies-without-secure', name: 'Cookie without Secure flag' },
  { id: 'CVE-2023-44487', severity: 'medium', template: 'CVE-2023-44487', name: 'HTTP/2 Rapid Reset' },
  { id: 'cors-misconfig', severity: 'medium', template: 'cors-misconfig', name: 'Permissive CORS policy' },
  { id: 'CVE-2017-5638', severity: 'critical', template: 'CVE-2017-5638', name: 'Apache Struts RCE' },
  { id: 'open-redirect', severity: 'low', template: 'open-redirect', name: 'Open redirect' },
];

function finding(
  type: NodeType,
  value: string,
  parent: { type: NodeType; value: string } | null,
  relation: Relation | null,
  extra: { severity?: Severity; data?: Record<string, unknown> } = {},
): Finding {
  return {
    type,
    value,
    ...(parent && relation ? { parent, relation } : {}),
    ...(extra.severity ? { severity: extra.severity } : {}),
    ...(extra.data && Object.keys(extra.data).length > 0 ? { data: extra.data } : {}),
  };
}

function scanFile(
  domain: string,
  tool: string,
  version: string,
  command: string,
  [start, end]: [string, string],
  findings: Finding[],
): MockFile {
  return {
    tool,
    doc: {
      contract_version: 1,
      tool,
      tool_version: version,
      target: domain,
      command,
      started_at: `2026-10-29T${start}Z`,
      finished_at: `2026-10-29T${end}Z`,
      status: 'success',
      errors: [],
      findings,
    },
  };
}

/** Generates one file per fake tool, in the order they should be ingested. */
export function generateMock(options: MockOptions): MockFile[] {
  const { subdomains: count, seed, domain } = options;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SUBDOMAINS) {
    throw new RangeError(`subdomains must be an integer from 1 to ${String(MAX_SUBDOMAINS)}`);
  }
  const rng = prng(seed);
  const root = { type: 'domain', value: domain } as const;

  // --- the "real" target -------------------------------------------------------------------------
  const poolSize = Math.max(3, Math.ceil(count / 5));
  const ips = new Map<number, IpInfo>();
  const ipInfo = (i: number): IpInfo => {
    let info = ips.get(i);
    if (!info) {
      const ports: IpInfo['ports'] = [];
      if (rng.chance(0.9)) ports.push({ port: 443, service: 'https', tech: null });
      if (rng.chance(0.8)) ports.push({ port: 80, service: 'http', tech: null });
      for (const [port, p, service, tech] of EXTRA_PORTS) {
        if (rng.chance(p)) ports.push({ port, service, tech: port === 22 ? rng.pick(SSH_VERSIONS) : tech });
      }
      if (ports.length === 0) ports.push({ port: 443, service: 'https', tech: null });
      info = { value: mockIp(i), ports, web: weighted(rng, WEB_SERVERS), nmap: rng.chance(0.6) };
      ips.set(i, info);
    }
    return info;
  };

  const hosts: Host[] = subdomainNames(rng, domain, count).map((name) => {
    const r = rng.next();
    const host: Host = { name, subfinder: r < 0.85, amass: r >= 0.45, ips: [] };
    if (rng.chance(0.65)) {
      host.ips.push(rng.int(poolSize));
      if (rng.chance(0.1)) host.ips.push(rng.int(poolSize));
      host.ips = [...new Set(host.ips)];
    }
    return host;
  });
  for (const h of hosts) for (const i of h.ips) ipInfo(i);

  // The first host is the anchor: seen by both enumerators, live, and running the vulnerable Apache on 443,
  // so even `--subdomains 1` produces corroboration and the guaranteed medium/high/critical findings.
  const anchor = hosts[0] as Host;
  anchor.subfinder = anchor.amass = true;
  if (anchor.ips.length === 0) anchor.ips.push(rng.int(poolSize));
  const anchorIp = ipInfo(anchor.ips[0] as number);
  anchorIp.web = VULNERABLE_APACHE;
  anchorIp.nmap = true;
  if (!anchorIp.ports.some((p) => p.port === 443)) anchorIp.ports.unshift({ port: 443, service: 'https', tech: null });

  const portValue = (ip: IpInfo, port: number) => `${ip.value}:${String(port)}/tcp`;
  const usedIps = [...ips.keys()].sort((a, b) => a - b).map((i) => ips.get(i) as IpInfo);

  // --- subfinder / amass ------------------------------------------------------------------------
  const subfinder = [finding('domain', domain, null, null)];
  const amass: Finding[] = [];
  for (const h of hosts) {
    if (h.subfinder) {
      subfinder.push(finding('subdomain', h.name, root, 'has_subdomain', { data: { source: rng.pick(SOURCES) } }));
    }
    if (h.amass) {
      const sources = rng.shuffle(SOURCES).slice(0, 1 + rng.int(3)).sort();
      amass.push(finding('subdomain', h.name, root, 'has_subdomain', { data: { sources } }));
    }
  }

  // --- dnsx: the domain and the live subdomains resolve -----------------------------------------
  const dnsx: Finding[] = [
    finding('ip', anchorIp.value, root, 'resolves_to', { data: { record: 'A', ttl: 300 } }),
  ];
  for (const h of hosts) {
    for (const i of h.ips) {
      const ip = ips.get(i) as IpInfo;
      const data = { record: 'A', ttl: rng.pick([60, 300, 3600]) };
      dnsx.push(finding('ip', ip.value, { type: 'subdomain', value: h.name }, 'resolves_to', { data }));
    }
  }

  // --- naabu: every port; nmap: a rescan of most IPs, with service detection --------------------
  const naabu: Finding[] = [];
  const nmap: Finding[] = [];
  for (const ip of usedIps) {
    for (const p of ip.ports) {
      const port = portValue(ip, p.port);
      naabu.push(finding('port', port, { type: 'ip', value: ip.value }, 'has_port'));
      if (!ip.nmap) continue;

      const web = ['http', 'https', 'http-proxy', 'https-alt'].includes(p.service);
      const tech = web ? ip.web.nmap : p.tech;
      const product = web ? ip.web.product : tech?.split('/')[0];
      const version = web ? ip.web.version : tech?.split('/')[1];
      nmap.push(
        finding('port', port, { type: 'ip', value: ip.value }, 'has_port', {
          data: { state: 'open', service: p.service, ...(product ? { product } : {}), ...(version ? { version } : {}) },
        }),
      );
      if (tech) nmap.push(finding('technology', tech, { type: 'port', value: port }, 'uses_technology'));
      if (web && ip.web === VULNERABLE_APACHE) {
        nmap.push(
          finding('vulnerability', APACHE_TRAVERSAL.id, { type: 'port', value: port }, 'has_vulnerability', {
            severity: APACHE_TRAVERSAL.severity,
            data: { script: 'vulners', cvss: 7.5 },
          }),
        );
      }
    }
  }

  // --- httpx: live web hosts ----------------------------------------------------------------------
  const httpx: Finding[] = [];
  interface LiveUrl {
    url: string;
    host: string;
    parent: { type: 'subdomain' | 'domain'; value: string };
    web: WebServer;
  }
  const live: LiveUrl[] = [];
  const probe = (parent: LiveUrl['parent'], ip: IpInfo) => {
    const has = (port: number) => ip.ports.some((p) => p.port === port);
    const urls = [
      ...(has(443) ? [`https://${parent.value}/`] : has(80) ? [`http://${parent.value}/`] : []),
      ...(has(8443) && rng.chance(0.5) ? [`https://${parent.value}:8443/`] : []),
    ];
    for (const url of urls) {
      httpx.push(
        finding('url', url, parent, 'serves', {
          data: {
            status_code: weighted(rng, STATUS_CODES),
            title: rng.pick(TITLES),
            content_length: 200 + rng.int(40_000),
            webserver: ip.web.httpx,
          },
        }),
      );
      httpx.push(finding('technology', ip.web.httpx, { type: 'url', value: url }, 'uses_technology'));
      for (const [tech, p] of FRAMEWORKS) {
        if (rng.chance(p)) httpx.push(finding('technology', tech, { type: 'url', value: url }, 'uses_technology'));
      }
      live.push({ url, host: parent.value, parent, web: ip.web });
    }
  };
  for (const h of hosts) {
    const first = h.ips[0];
    if (first !== undefined) probe({ type: 'subdomain', value: h.name }, ips.get(first) as IpInfo);
  }
  probe(root, anchorIp);

  // --- nuclei: a few vulnerabilities, always at least one medium, high and critical --------------
  const nuclei: Finding[] = [];
  const reported = new Set<string>();
  const report = (spec: VulnSpec, target: LiveUrl, matched = target.url) => {
    const key = `${spec.id}|${matched}`;
    if (reported.has(key)) return false;
    reported.add(key);
    nuclei.push(
      finding('vulnerability', spec.id, { type: 'url', value: matched }, 'has_vulnerability', {
        severity: spec.severity,
        data: { template_id: spec.template, name: spec.name, matched_at: matched },
      }),
    );
    return true;
  };
  for (const u of live) if (u.web === VULNERABLE_APACHE && u.url.startsWith('https://')) report(APACHE_TRAVERSAL, u);
  report(LOG4SHELL, rng.pick(live));
  const gitHost = rng.pick(live.filter((u) => u.parent.type === 'subdomain'));
  const gitUrl = `https://${gitHost.host}/.git/config`;
  nuclei.push(finding('url', gitUrl, gitHost.parent, 'serves', { data: { status_code: 200 } }));
  report(GIT_CONFIG, gitHost, gitUrl);

  const extras = Math.max(0, Math.round(count / 50) - 3);
  for (let n = 0, tries = 0; n < extras && tries < extras * 10; tries++) {
    if (report(rng.pick(EXTRA_URL_VULNS), rng.pick(live))) n++;
  }
  // Exposed Redis is reported on the port itself.
  for (const ip of usedIps) {
    if (ip.ports.some((p) => p.port === 6379) && rng.chance(0.5)) {
      nuclei.push(
        finding('vulnerability', 'redis-default-logins', { type: 'port', value: portValue(ip, 6379) }, 'has_vulnerability', {
          severity: 'high',
          data: { template_id: 'redis-default-logins', name: 'Redis without authentication' },
        }),
      );
    }
  }

  return [
    scanFile(domain, 'subfinder', '2.6.6', `subfinder -d ${domain} -oJ -silent`, ['09:00:00', '09:01:12'], subfinder),
    scanFile(domain, 'amass', '4.2.0', `amass enum -passive -d ${domain} -json amass.json`, ['09:00:00', '09:06:40'], amass),
    scanFile(domain, 'dnsx', '1.2.1', 'dnsx -l subdomains.txt -a -resp -json', ['09:07:00', '09:07:45'], dnsx),
    scanFile(domain, 'naabu', '2.3.1', 'naabu -list ips.txt -top-ports 100 -json', ['09:08:00', '09:12:00'], naabu),
    scanFile(domain, 'nmap', '7.95', 'nmap -sV --script vulners -iL ips.txt -oX nmap.xml', ['09:12:30', '09:30:00'], nmap),
    scanFile(domain, 'httpx', '1.6.9', 'httpx -l subdomains.txt -sc -title -tech-detect -json', ['09:12:30', '09:15:10'], httpx),
    scanFile(domain, 'nuclei', '3.3.5', 'nuclei -l urls.txt -jsonl -severity info,low,medium,high,critical', ['09:16:00', '09:40:00'], nuclei),
  ];
}

/** The exact text written to disk (and hashed by ingest). */
export function mockFileText(file: MockFile): string {
  return `${JSON.stringify(file.doc, null, 2)}\n`;
}
