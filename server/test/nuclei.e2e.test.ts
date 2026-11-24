// End to end with real Docker (docs/architecture.md §11, lab/README.md, docs/phase-6c6-progress.md): nuclei through
// the orchestrator against the local lab, ingest, and proof from the lab's access log that nuclei stayed on the target
// (no other host, no out-of-band callback). Skipped unless Docker is reachable and both images are built
// (pnpm tools:build vuln; pnpm lab:up builds the lab image). It talks only to the local lab on the redwhale-tools
// network.
//
//   fast (always, with the images): the full tool, narrowed by the test-only --template-ids to the 4 templates that
//         fire on the lab (~25 requests, seconds); plus the template set run.py loads (no excluded tag, HTTP only).
//   slow (REDWHALE_E2E_SLOW=1): the real tool.json, every template (~11,000 requests at 5/s, ~40 min).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeId, type NodeType } from '@redwhale/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ingestDocument } from '../src/ingest/ingest';
import { Catalog, loadCatalog } from '../src/runner/catalog';
import { DockerRuntime } from '../src/runner/docker';
import { ingestFinish, jobDir } from '../src/runner/finish';
import { LABEL_LAB, LAB_HOST, LAB_REDIRECT_HOST, labDown, labImage, labIp, labUp, type LabIo } from '../src/runner/lab';
import { toolsNetwork } from '../src/runner/network';
import { Orchestrator } from '../src/runner/orchestrator';
import { LABEL_WORKSPACE } from '../src/runner/spec';
import { addRule, setSettings } from '../src/scope/store';
import { baseDoc, freshDb, tempDir } from './helpers';
import { labLogSince, logMark } from './lab-log';

const runtime = new DockerRuntime();
const catalog = loadCatalog();
const network = toolsNetwork();
const vulnImage = (await runtime.inspectImage(catalog.imageRef('vuln')).catch(() => null)) !== null;
const ready = (await runtime.ping()).ok && vulnImage && (await runtime.inspectImage(labImage().ref).catch(() => null)) !== null;
const SLOW = process.env.REDWHALE_E2E_SLOW === '1';
const WORKSPACE = `e2e${randomUUID().replaceAll('-', '')}`;
const quiet: LabIo = { out: () => undefined, err: () => undefined };
const HOME = `https://${LAB_HOST}/`;
const at = (path: string) => `https://${LAB_HOST}${path}`;
const EXCLUDED = ['intrusive', 'dos', 'fuzz', 'bruteforce', 'default-login', 'osint', 'ssrf', 'oast', 'proxy'];
const FAST_IDS = 'git-config,laravel-env,nginx-version,php-detect';
const FAKE_SECRET = 'fake-not-a-secret'; // in the lab's /.git/config remote URL

/** The repo catalog with nuclei narrowed to `ids` (the test-only --template-ids; nuclei ANDs it with the tags). */
function withTemplateIds(base: Catalog, ids: string): Catalog {
  return new Catalog(
    base.groups.map((g) =>
      g.def.name !== 'vuln'
        ? g
        : { ...g, tools: g.tools.map((t) => (t.name === 'nuclei' ? { ...t, argv: [...t.argv, '--template-ids', ids] } : t)) },
    ),
  );
}

let wasUp = false;

interface Scan {
  db: ReturnType<typeof freshDb>;
  jobsDir: string;
  log: string[];
  seconds: number;
}

/** Seed the url node and a stand-in httpx sighting of nginx/1.30.6, allow the lab, run nuclei, return nuclei's log. */
async function scan(cat: Catalog): Promise<Scan> {
  const db = freshDb();
  db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
  ingestDocument(db, baseDoc({ target: LAB_HOST, command: 'manual seed', findings: [{ type: 'url', value: HOME }] }));
  ingestDocument(
    db,
    baseDoc({
      tool: 'httpx',
      target: LAB_HOST,
      command: 'httpx (stand-in)',
      findings: [{ type: 'technology', value: 'nginx/1.30.6', parent: { type: 'url', value: HOME }, relation: 'uses_technology' }],
    }),
  );
  addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
  addRule(db, { kind: 'ip', value: labIp(network), action: 'include' });
  setSettings(db, { passiveOnly: false });
  const target = nodeId('url', HOME);
  const jobsDir = join(tempDir(), 'jobs');
  const orch = new Orchestrator({ db, runtime, catalog: cat, network, finish: ingestFinish({ db, jobsDir }) });
  expect(orch.enqueue('nuclei', target)).toMatchObject({ ok: false, code: 'confirm-required' });

  const since = logMark();
  const started = Date.now();
  expect(orch.enqueue('nuclei', target, { confirmActive: true })).toMatchObject({
    ok: true,
    jobs: [{ tool: 'nuclei', mode: 'active', status: 'queued' }],
  });
  await orch.idle();
  const seconds = Math.round((Date.now() - started) / 1000);
  const job = orch.get(1);
  expect(job, job?.error ?? '').toMatchObject({ status: 'succeeded', exitCode: 0 });
  expect(job?.argv).toEqual(expect.arrayContaining(['--target', HOME]));

  // Other e2e suites may probe the lab at the same time: keep nuclei's container only (its address is the one that
  // fetched /.git/config, which only nuclei asks for).
  const recent = (await labLogSince(runtime, since)).filter((l) => l.startsWith('host='));
  const addr = /^host=\S+ (\S+) "GET \/\.git\/config /.exec(recent.find((l) => l.includes('"GET /.git/config ')) ?? '')?.[1];
  expect(addr).toBeDefined();
  // no tool ever goes to the redirect's host, whatever container
  expect(recent.filter((l) => l.startsWith(`host=${LAB_REDIRECT_HOST} `))).toEqual([]);
  return { db, jobsDir, log: recent.filter((l) => l.split(' ')[1] === addr), seconds };
}

const nodeRow = (s: Scan, type: string, value: string) =>
  s.db.$client.prepare('SELECT id, severity, confidence FROM nodes WHERE type = ? AND value = ?').get(type, value) as
    | { id: string; severity: string | null; confidence: string }
    | undefined;
const edge = (s: Scan, relation: string, from: [NodeType, string], to: [NodeType, string]) =>
  s.db.$client
    .prepare('SELECT relation FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?')
    .get(nodeId(from[0], from[1]), nodeId(to[0], to[1]), relation) as { relation: string } | undefined;
const nucleiData = (s: Scan, type: string, value: string) =>
  JSON.parse(
    (
      s.db.$client
        .prepare("SELECT o.data FROM observations o JOIN nodes n ON n.id = o.node_id WHERE n.type = ? AND n.value = ? AND o.tool = 'nuclei'")
        .get(type, value) as { data: string }
    ).data,
  ) as Record<string, unknown>;

/** What both scans must show in the graph and the database. */
async function expectCommonFindings(s: Scan): Promise<void> {
  for (const path of ['/.git/config', '/.env']) {
    expect(nodeRow(s, 'url', at(path)), path).toBeDefined();
    expect(edge(s, 'has_url', ['url', HOME], ['url', at(path)]), path).toBeDefined();
  }
  expect(nodeRow(s, 'vulnerability', 'git-config')?.severity).toBe('medium');
  expect(edge(s, 'has_vulnerability', ['url', at('/.git/config')], ['vulnerability', 'git-config'])).toBeDefined();
  expect(nodeRow(s, 'vulnerability', 'laravel-env')?.severity).toBe('high');
  expect(edge(s, 'has_vulnerability', ['url', at('/.env')], ['vulnerability', 'laravel-env'])).toBeDefined();
  for (const tech of ['nginx/1.30.6', 'php/8.3.12']) {
    expect(edge(s, 'uses_technology', ['url', HOME], ['technology', tech]), tech).toBeDefined();
  }
  // nginx/1.30.6: httpx (stand-in) and nuclei; php/8.3.12: nuclei only. tech-detect's bare names are dropped.
  expect(nodeRow(s, 'technology', 'nginx/1.30.6')?.confidence).toBe('corroborated');
  expect(nodeRow(s, 'technology', 'php/8.3.12')?.confidence).toBe('discovered');
  expect(nodeRow(s, 'technology', 'nginx')).toBeUndefined();

  // the lab's fake credential is masked everywhere in the database; raw.txt (the evidence) keeps nuclei's output
  expect(nucleiData(s, 'vulnerability', 'git-config')).toMatchObject({ extracted: ['redw****cret'], matched_at: at('/.git/config') });
  for (const sql of ['SELECT data AS t FROM observations', 'SELECT data AS t FROM nodes', 'SELECT raw AS t FROM scans']) {
    const rows = s.db.$client.prepare(sql).all() as { t: string | null }[];
    expect(rows.filter((r) => (r.t ?? '').includes(FAKE_SECRET)), sql).toEqual([]);
  }
  expect(readFileSync(join(jobDir(s.jobsDir, 1), 'raw.txt'), 'utf8')).toContain(FAKE_SECRET);

  // the command: no OAST, no redirects, no update check, every excluded tag; a clean, complete scan
  const scanRow = s.db.$client.prepare("SELECT command, status, errors, tool_version FROM scans WHERE tool = 'nuclei'").get() as {
    command: string;
    status: string;
    errors: string;
    tool_version: string;
  };
  const argv = scanRow.command.split(' ');
  for (const flag of ['-ni', '-dr', '-duc', '-or']) expect(argv, flag).toContain(flag);
  expect(argv[argv.indexOf('-etags') + 1]?.split(',').sort()).toEqual([...EXCLUDED].sort());
  expect(argv[argv.indexOf('-eid') + 1]?.split(',')).toContain('hpe-autopass-panel');
  expect(argv[argv.indexOf('-u') + 1]).toBe(`https://${LAB_HOST}`);
  expect(scanRow).toMatchObject({ status: 'success', errors: '[]', tool_version: '3.11.1' });

  // no vulnerability or technology nuclei reported carries an excluded tag
  const tags = (s.db.$client.prepare("SELECT data FROM observations WHERE tool = 'nuclei'").all() as { data: string }[]).flatMap(
    (r) => ((JSON.parse(r.data) as { tags?: string[] }).tags ?? []),
  );
  expect(tags.filter((t) => EXCLUDED.includes(t))).toEqual([]);

  // the access log: nothing of the redirect's host
  expect(s.log.filter((l) => l.includes(LAB_REDIRECT_HOST))).toEqual([]);
  expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
}

beforeAll(async () => {
  if (!ready) return;
  wasUp = (await runtime.listByLabel(LABEL_LAB)).containers.some((c) => c.state === 'running');
  expect(await labUp(runtime, network, quiet)).toBe(0);
});

afterAll(async () => {
  if (!ready) return;
  const left = await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE);
  for (const c of left.containers) await runtime.removeContainer(c.id);
  for (const v of left.volumes) await runtime.removeVolume(v.name);
  if (!wasUp) await labDown(runtime, quiet);
});

describe.skipIf(!vulnImage)('the nuclei template set (real Docker, no network)', () => {
  test('run.py loads only HTTP templates that talk to the URL alone: no excluded tag, port or host; the ignore list holds', () => {
    // server/test/nuclei_template_set.py, run in the image with no network (see its docstring)
    const r = spawnSync(
      'docker',
      ['run', '--rm', '-i', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--user', '10001:10001', catalog.imageRef('vuln'), 'python3', '-I', '-'],
      { input: readFileSync(join(import.meta.dirname, 'nuclei_template_set.py'), 'utf8'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    expect(r.status, r.stderr).toBe(0);
    const set = JSON.parse(r.stdout) as {
      count: number;
      excludedTags: string[];
      excludedIds: string[];
      withExcludedTag: string[];
      excludedIdLoaded: string[];
      sidePort: string[];
      outsideHost: Record<string, string[]>;
      notHttp: string[];
      ignoreListed: number;
      ignoredButLoaded: string[];
    };
    expect([...set.excludedTags].sort()).toEqual([...EXCLUDED].sort());
    expect(set.excludedIds.length).toBe(23);
    expect(set.count).toBeGreaterThan(6000);
    expect(set.count).toBeLessThan(7000);
    expect(set.withExcludedTag).toEqual([]);
    expect(set.excludedIdLoaded).toEqual([]);
    // A template that connects to another port of the host ({{Hostname}}:<port>) or another host (@Host:, a literal
    // URL): add its ID to run.py SIDE_PORT_IDS / OUTSIDE_HOST_IDS. nuclei talks only to the URL.
    expect(set.sidePort).toEqual([]);
    expect(set.outsideHost).toEqual({});
    expect(set.notHttp).toEqual([]);
    expect(set.ignoreListed).toBeGreaterThan(0);
    expect(set.ignoredButLoaded).toEqual([]);
  }, 120_000);
});

describe.skipIf(!ready)('nuclei against the local lab (real Docker)', () => {
  test('fast: the lab templates find the fake exposures and the tech, on the target host only, no out-of-band host', async () => {
    const s = await scan(withTemplateIds(catalog, FAST_IDS));
    expect(s.db.$client.prepare("SELECT command FROM scans WHERE tool = 'nuclei'").get()).toMatchObject({
      command: expect.stringContaining(`-id ${FAST_IDS}`) as unknown,
    });
    await expectCommonFindings(s);
    // the 4 templates: /, /.git/config and laravel-env's 22 .env paths; all GET, all with the lab's own Host
    expect(s.log.length).toBeGreaterThanOrEqual(20);
    expect(s.log.length).toBeLessThan(40);
    expect(s.log.filter((l) => !l.startsWith(`host=${LAB_HOST} `))).toEqual([]);
    expect(s.log.filter((l) => !l.includes('"GET '))).toEqual([]);
    // none of the 4 names an out-of-band host (the full set's open-redirect checks do, in a parameter: harmless with -dr)
    expect(s.log.filter((l) => /oast\.(pro|live|site|online|fun|me)|interactsh\.com|\{\{interactsh-url\}\}/.test(l))).toEqual([]);
  }, 300_000);

  test.skipIf(!SLOW)('slow (REDWHALE_E2E_SLOW=1): the full template set at 5 requests a second', async () => {
    const s = await scan(catalog);
    expect(s.db.$client.prepare("SELECT command FROM scans WHERE tool = 'nuclei'").get()).toMatchObject({
      command: expect.not.stringContaining(' -id ') as unknown,
    });
    await expectCommonFindings(s);
    for (const value of ['generic-env', 'http-missing-security-headers', 'waf-detect']) {
      expect(nodeRow(s, 'vulnerability', value), value).toBeDefined();
    }
    expect((nucleiData(s, 'vulnerability', 'http-missing-security-headers').matcher as string[]).length).toBe(10);
    // -ni: templates that need an interactsh URL send nothing (CVE-2014-3206, CVE-2017-5983's paths)
    expect(s.log.filter((l) => l.includes('/backupmgt/') || l.includes('/plugins/servlet/jwd/amf'))).toEqual([]);
    // Every request went to the lab (this log is the lab's). A few carry another name in the Host header: Host-header
    // open-redirect and 403-bypass checks (docs/phase-6c6-progress.md); nginx logs a malformed request as "_".
    const hosts = new Set(s.log.map((l) => l.split(' ')[0]?.slice('host='.length) ?? ''));
    const allowed = (h: string) =>
      [LAB_HOST, '_', 'localhost', 'interact.sh'].includes(h) || /^[a-z0-9]{20,}\.(tld|com|invalid)$/.test(h);
    expect([...hosts].filter((h) => !allowed(h))).toEqual([]);
    expect(s.log.length).toBeGreaterThan(9000);

    const vulns = s.db.$client
      .prepare("SELECT n.value, n.severity FROM nodes n JOIN observations o ON o.node_id = n.id WHERE o.tool = 'nuclei' AND n.type IN ('vulnerability', 'technology') ORDER BY n.value")
      .all();
    console.log(
      `[nuclei slow e2e] ${String(s.seconds)} s, ${String(s.log.length)} requests, hosts ${JSON.stringify([...hosts])}, findings ${JSON.stringify(vulns)}`,
    );
  }, 3_700_000);
});
