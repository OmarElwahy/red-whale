// End to end with real Docker (docs/architecture.md §11, lab/README.md): nmap (active, confirmed) against the local
// lab through the orchestrator and ingest, then httpx, and the corroboration that follows on the nginx technology
// (httpx + nmap spell it the same way: nginx/1.30.6). Skipped unless Docker is reachable and the images are built
// (pnpm tools:build http, ports; pnpm lab:up builds the lab image).
// It talks only to the local lab on the redwhale-tools network (and Docker's own DNS).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { edgeId, nodeId } from '@redwhale/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ingestDocument } from '../src/ingest/ingest';
import { edgeDetail } from '../src/routes/edges';
import { loadCatalog } from '../src/runner/catalog';
import { DockerRuntime } from '../src/runner/docker';
import { ingestFinish } from '../src/runner/finish';
import { LABEL_LAB, LAB_HOST, LAB_PORTS, labDown, labImage, labIp, labUp, type LabIo } from '../src/runner/lab';
import { toolsNetwork } from '../src/runner/network';
import { Orchestrator } from '../src/runner/orchestrator';
import { LABEL_WORKSPACE } from '../src/runner/spec';
import { addRule, setSettings } from '../src/scope/store';
import { baseDoc, freshDb, tempDir } from './helpers';

const runtime = new DockerRuntime();
const catalog = loadCatalog();
const network = toolsNetwork();
const imagesBuilt = async (): Promise<boolean> => {
  for (const ref of [...['http', 'ports'].map((g) => catalog.imageRef(g)), labImage().ref]) {
    if ((await runtime.inspectImage(ref).catch(() => null)) === null) return false;
  }
  return true;
};
const ready = (await runtime.ping()).ok && (await imagesBuilt());
const WORKSPACE = `e2e${randomUUID().replaceAll('-', '')}`;
const quiet: LabIo = { out: () => undefined, err: () => undefined };

/** Was the lab already running before this test (the analyst's)? Then it is left running. */
let wasUp = false;

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

describe.skipIf(!ready)('nmap and httpx against the local lab (real Docker)', () => {
  test('nmap needs confirmation, names the services, and httpx corroborates the nginx technology', async () => {
    // 1. the nodes (the ip for nmap, the name for httpx), the scope rules lab:up prints, passive-only off
    const db = freshDb();
    db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
    const ip = labIp(network);
    ingestDocument(
      db,
      baseDoc({
        target: ip,
        command: 'manual seed',
        findings: [
          { type: 'ip', value: ip },
          { type: 'subdomain', value: LAB_HOST },
        ],
      }),
    );
    addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
    addRule(db, { kind: 'ip', value: ip, action: 'include' });
    setSettings(db, { passiveOnly: false });
    const ipNode = nodeId('ip', ip);
    const host = nodeId('subdomain', LAB_HOST);

    const orch = new Orchestrator({ db, runtime, catalog, network, finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }) });
    const run = async (tool: string, nodeIdValue: string) => {
      const queued = orch.enqueue(tool, nodeIdValue, { confirmActive: true });
      expect(queued, JSON.stringify(queued)).toMatchObject({ ok: true, jobs: [{ tool, status: 'queued' }] });
      await orch.idle();
      const id = queued.ok ? queued.jobs[0]?.id : undefined;
      const job = id === undefined ? undefined : orch.get(id);
      expect(job, job?.error ?? '').toMatchObject({ status: 'succeeded', exitCode: 0 });
      return job;
    };
    const node = (id: string) =>
      db.$client.prepare('SELECT confidence, data FROM nodes WHERE id = ?').get(id) as { confidence: string; data: string | null } | undefined;
    const dataOf = (id: string): unknown => JSON.parse(node(id)?.data ?? '{}');
    const toolsOf = (id: string) =>
      (db.$client.prepare("SELECT DISTINCT tool FROM observations WHERE node_id = ? AND role = 'finding' ORDER BY tool").all(id) as { tool: string }[]).map(
        (r) => r.tool,
      );
    const commandsOf = (tool: string) =>
      (db.$client.prepare('SELECT command FROM scans WHERE tool = ? ORDER BY rowid').all(tool) as { command: string }[]).map((r) => r.command);

    // 2. nmap is active: refused without the confirmation (no job), then run confirmed, with the ip's type
    expect(orch.enqueue('nmap', ipNode)).toMatchObject({ ok: false, code: 'confirm-required' });
    const nmap = await run('nmap', ipNode);
    expect(nmap).toMatchObject({ mode: 'active' });
    expect(nmap?.argv).toEqual(expect.arrayContaining(['--target', ip, '--target-type', 'ip']));
    const [ipCommand = ''] = commandsOf('nmap');
    expect(ipCommand).toContain(' -sT -Pn -n -sV --unprivileged ');
    expect(ipCommand).toContain(' --top-ports 100 -oX - ');
    for (const never of [' -sC', ' --script', ' -O', ' -A', ' -sU']) expect(ipCommand).not.toContain(never);

    // 3. the ports, the SSH banner's service, the technologies
    const port = (p: number) => nodeId('port', `${ip}:${String(p)}/tcp`);
    for (const p of LAB_PORTS) {
      expect(edgeDetail(db, edgeId(ipNode, 'has_port', port(p)))?.observations.map((o) => o.tool), `port ${String(p)}`).toEqual(['nmap']);
    }
    expect(dataOf(port(22))).toMatchObject({ protocol: 'tcp', service: 'ssh', product: 'OpenSSH', version: '9.6p1' });
    expect(dataOf(port(443))).toMatchObject({ service: 'http', product: 'nginx', version: '1.30.6', tunnel: 'ssl' });
    const nginx = nodeId('technology', 'nginx/1.30.6');
    const openssh = nodeId('technology', 'openssh/9.6p1');
    expect(node(nginx)).toMatchObject({ confidence: 'discovered' });
    expect(node(openssh)).toMatchObject({ confidence: 'discovered' });
    for (const p of [80, 443, 8080]) expect(edgeDetail(db, edgeId(port(p), 'uses_technology', nginx))?.edge).toBeDefined();
    expect(edgeDetail(db, edgeId(port(22), 'uses_technology', openssh))?.edge).toBeDefined();

    // 4. a port target: only that port, typed as a port by the server
    const onPort = await run('nmap', port(22));
    expect(onPort?.argv).toEqual(expect.arrayContaining(['--target', `${ip}:22/tcp`, '--target-type', 'port']));
    expect(commandsOf('nmap')[1]).toContain(` -p 22 -oX - ${ip}`);

    // 5. httpx on the name: nginx/1.30.6 is one node, seen by two tools
    await run('httpx', host);
    expect(toolsOf(nginx)).toEqual(['httpx', 'nmap']);
    expect(node(nginx)).toMatchObject({ confidence: 'corroborated' });
    expect(toolsOf(openssh)).toEqual(['nmap']);

    // nothing of the jobs is left behind
    expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
  });
}, 300_000);
