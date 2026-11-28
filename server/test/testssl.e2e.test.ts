// End to end with real Docker (docs/architecture.md §11, lab/README.md, docs/phase-6c7-progress.md): testssl.sh through
// the orchestrator against the local lab, ingest, and proof from the lab's access log that the only HTTP requests
// went to the lab. Skipped unless Docker is reachable and both images are built (pnpm tools:build tls; pnpm lab:up
// builds the lab image). It talks only to the local lab on the redwhale-tools network.
//
//   fast (always, with the images): the real tool, narrowed by the test-only --checks to protocols and server
//         defaults (~15 s): url target (port chain, certificate), port target (no cert_trust), a port without TLS
//   slow (REDWHALE_E2E_SLOW=1): the real tool.json, all four check sets (-p -s -S -U, ~1 min)
import { randomUUID, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { nodeId, type NodeType } from '@redwhale/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ingestDocument } from '../src/ingest/ingest';
import { Catalog, loadCatalog } from '../src/runner/catalog';
import { DockerRuntime } from '../src/runner/docker';
import { ingestFinish } from '../src/runner/finish';
import { LABEL_LAB, LAB_HOST, LAB_REDIRECT_HOST, labDown, labImage, labIp, labUp, type LabIo } from '../src/runner/lab';
import { toolsNetwork } from '../src/runner/network';
import { Orchestrator } from '../src/runner/orchestrator';
import { LABEL_WORKSPACE } from '../src/runner/spec';
import { addRule, setSettings } from '../src/scope/store';
import { baseDoc, freshDb, tempDir } from './helpers';
import { labContainerId, labLogSince, logMark } from './lab-log';

const runtime = new DockerRuntime();
const catalog = loadCatalog();
const network = toolsNetwork();
const ready =
  (await runtime.ping()).ok &&
  (await runtime.inspectImage(catalog.imageRef('tls')).catch(() => null)) !== null &&
  (await runtime.inspectImage(labImage().ref).catch(() => null)) !== null;
const SLOW = process.env.REDWHALE_E2E_SLOW === '1';
const WORKSPACE = `e2e${randomUUID().replaceAll('-', '')}`;
const quiet: LabIo = { out: () => undefined, err: () => undefined };
const HOME = `https://${LAB_HOST}/`;
const UA = '"TLS tester from https://testssl.sh/"'; // testssl's UA_STD, on its HTTP requests (service detection, BREACH)

/** The repo catalog with testssl narrowed to `checks` (the test-only --checks). */
function withChecks(base: Catalog, checks: string): Catalog {
  return new Catalog(
    base.groups.map((g) =>
      g.def.name !== 'tls'
        ? g
        : { ...g, tools: g.tools.map((t) => (t.name === 'testssl' ? { ...t, argv: [...t.argv, '--checks', checks] } : t)) },
    ),
  );
}

let wasUp = false;
let labFingerprint = '';

interface Run {
  db: ReturnType<typeof freshDb>;
  /** the lab's log lines carrying testssl's User-Agent */
  log: string[];
  scan: { status: string; errors: string; tool_version: string; command: string };
  seconds: number;
}

async function testssl(cat: Catalog, type: NodeType, value: string): Promise<Run> {
  const db = freshDb();
  db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
  const seed = type === 'url' ? { type, value } : { type, value, parent: { type: 'ip' as const, value: labIp(network) }, relation: 'has_port' as const };
  ingestDocument(db, baseDoc({ target: LAB_HOST, command: 'manual seed', findings: [seed] }));
  addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
  addRule(db, { kind: 'ip', value: labIp(network), action: 'include' });
  setSettings(db, { passiveOnly: false });
  const orch = new Orchestrator({ db, runtime, catalog: cat, network, finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }) });
  const target = nodeId(type, value);
  expect(orch.enqueue('testssl', target)).toMatchObject({ ok: false, code: 'confirm-required' });
  await new Promise((resolve) => setTimeout(resolve, 2100)); // the previous run's lines older than the mark
  const since = logMark();
  const started = Date.now();
  expect(orch.enqueue('testssl', target, { confirmActive: true })).toMatchObject({
    ok: true,
    jobs: [{ tool: 'testssl', mode: 'active', status: 'queued' }],
  });
  await orch.idle();
  const seconds = Math.round((Date.now() - started) / 1000);
  const job = orch.get(1);
  expect(job, job?.error ?? '').toMatchObject({ exitCode: 0 });
  expect(job?.argv).toEqual(expect.arrayContaining(['--target', value, '--target-type', type]));

  const recent = (await labLogSince(runtime, since)).filter((l) => l.startsWith('host='));
  // no tool ever goes to the redirect's host (also a SAN of the lab's certificate), whatever container
  expect(recent.filter((l) => l.startsWith(`host=${LAB_REDIRECT_HOST} `))).toEqual([]);
  const scan = db.$client.prepare("SELECT status, errors, tool_version, command FROM scans WHERE tool = 'testssl'").get() as Run['scan'];
  const argv = scan.command.split(' ');
  expect(argv[argv.indexOf('--nodns') + 1]).toBe('min');
  expect(argv[argv.indexOf('--ip') + 1]).toBe('one');
  for (const flag of ['-h', '--headers', '--phone-out', '-t', '--starttls', '-c', '-e']) expect(argv, flag).not.toContain(flag);
  expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
  return { db, log: recent.filter((l) => l.endsWith(UA)), scan, seconds };
}

const nodeRow = (r: Run, type: string, value: string) =>
  r.db.$client.prepare('SELECT id, severity FROM nodes WHERE type = ? AND value = ?').get(type, value) as
    | { id: string; severity: string | null }
    | undefined;
const edge = (r: Run, relation: string, from: [NodeType, string], to: [NodeType, string]) =>
  r.db.$client
    .prepare('SELECT relation FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?')
    .get(nodeId(from[0], from[1]), nodeId(to[0], to[1]), relation) as { relation: string } | undefined;
const certData = (r: Run, value: string) =>
  JSON.parse(
    (
      r.db.$client
        .prepare("SELECT o.data FROM observations o JOIN nodes n ON n.id = o.node_id WHERE n.type = 'certificate' AND n.value = ? AND o.tool = 'testssl'")
        .get(value) as { data: string }
    ).data,
  ) as Record<string, unknown>;
const vulns = (r: Run) =>
  Object.fromEntries(
    (r.db.$client.prepare("SELECT value, severity FROM nodes WHERE type = 'vulnerability'").all() as { value: string; severity: string }[]).map(
      (v) => [v.value, v.severity],
    ),
  );

/** The url target's chain and certificate, as both scans must show them. */
function expectUrlChain(r: Run): void {
  const ip = labIp(network);
  const port = `${ip}:443/tcp`;
  expect(r.scan).toMatchObject({ status: 'success', errors: '[]', tool_version: '3.2.5' });
  expect(edge(r, 'has_port', ['ip', ip], ['port', port])).toBeDefined();
  expect(edge(r, 'serves', ['port', port], ['url', HOME])).toBeDefined();
  expect(edge(r, 'has_certificate', ['port', port], ['certificate', labFingerprint])).toBeDefined();
  expect(certData(r, labFingerprint)).toMatchObject({
    subject: LAB_HOST,
    sans: [LAB_HOST, LAB_REDIRECT_HOST],
    issuer: LAB_HOST,
    trusted: false,
    ip,
  });
  expect(vulns(r)).toMatchObject({ cert_chain_of_trust: 'critical', cert_extlifeSpan: 'medium', cert_revocation: 'high' });
  expect(edge(r, 'has_vulnerability', ['url', HOME], ['vulnerability', 'cert_chain_of_trust'])).toBeDefined();
  // testssl's HTTP requests all went to the lab by its name (service detection; BREACH in the full run)
  expect(r.log.length).toBeGreaterThan(0);
  expect(r.log.every((l) => l.startsWith(`host=${LAB_HOST} `) && l.includes('"GET / HTTP/1.1"'))).toBe(true);
}

beforeAll(async () => {
  if (!ready) return;
  wasUp = (await runtime.listByLabel(LABEL_LAB)).containers.some((c) => c.state === 'running');
  expect(await labUp(runtime, network, quiet)).toBe(0);
  // the lab's certificate is made when its image is built: read it, don't hard-code its fingerprint
  const pem = spawnSync('docker', ['exec', await labContainerId(runtime), 'cat', '/etc/nginx/lab/cert.pem'], { encoding: 'utf8' });
  expect(pem.status, pem.stderr).toBe(0);
  labFingerprint = new X509Certificate(pem.stdout).fingerprint256.replaceAll(':', '').toLowerCase();
});

afterAll(async () => {
  if (!ready) return;
  const left = await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE);
  for (const c of left.containers) await runtime.removeContainer(c.id);
  for (const v of left.volumes) await runtime.removeVolume(v.name);
  if (!wasUp) await labDown(runtime, quiet);
});

describe.skipIf(!ready)('testssl against the local lab (real Docker)', () => {
  const fast = withChecks(catalog, 'protocols,defaults');

  test('fast: url target: ip → port → certificate (the lab’s, untrusted, both SANs), serves the url; vulns under it', async () => {
    const r = await testssl(fast, 'url', HOME);
    const argv = r.scan.command.split(' ');
    expect(argv).toEqual(expect.arrayContaining(['-p', '-S']));
    expect(argv).not.toContain('-U');
    expectUrlChain(r);
  }, 120_000);

  test('fast: port target: certificate under the port, no SNI, no cert_trust', async () => {
    const port = `${labIp(network)}:443/tcp`;
    const r = await testssl(fast, 'port', port);
    expect(r.scan).toMatchObject({ status: 'success', errors: '[]' });
    expect(edge(r, 'has_certificate', ['port', port], ['certificate', labFingerprint])).toBeDefined();
    expect(edge(r, 'has_vulnerability', ['port', port], ['vulnerability', 'cert_chain_of_trust'])).toBeDefined();
    expect(nodeRow(r, 'vulnerability', 'cert_trust')).toBeUndefined();
    expect(r.log.every((l) => l.startsWith(`host=${labIp(network)} `))).toBe(true);
  }, 120_000);

  test('fast: a port without TLS fails with the reason, nothing ingested but the scan', async () => {
    const port = `${labIp(network)}:8080/tcp`;
    const r = await testssl(fast, 'port', port);
    expect(r.scan).toMatchObject({ status: 'failed', errors: JSON.stringify([`no TLS service on ${labIp(network)}:8080`]) });
    expect(r.db.$client.prepare("SELECT COUNT(*) AS n FROM observations WHERE tool = 'testssl'").get()).toEqual({ n: 0 });
  }, 120_000);

  test.skipIf(!SLOW)('slow (REDWHALE_E2E_SLOW=1): the real tool.json, -p -s -S -U', async () => {
    const r = await testssl(catalog, 'url', HOME);
    const argv = r.scan.command.split(' ');
    expect(argv).toEqual(expect.arrayContaining(['-p', '-s', '-S', '-U']));
    expect(argv).not.toContain('--checks');
    expectUrlChain(r);
    expect(vulns(r)).toEqual({
      cipherlist_OBSOLETED: 'low',
      cert_chain_of_trust: 'critical',
      cert_extlifeSpan: 'medium',
      cert_revocation: 'high',
      'CVE-2013-0169': 'low',
    });
    console.log(`[testssl slow e2e] ${String(r.seconds)} s, ${String(r.log.length)} HTTP requests from testssl in the lab log`);
  }, 900_000);
});
