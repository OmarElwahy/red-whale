// End to end with real Docker (docs/architecture.md §11, lab/README.md): dnsx (passive), httpx and naabu (active,
// confirmed) against the local lab through the orchestrator and ingest, and the corroboration that follows: dnsx +
// httpx on the name's address, httpx + naabu on ports 80/443, naabu alone on 8080. Skipped unless Docker is reachable
// and the images are built (pnpm tools:build dns, http, ports; pnpm lab:up builds the lab image).
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
  for (const ref of [...['dns', 'http', 'ports'].map((g) => catalog.imageRef(g)), labImage().ref]) {
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

describe.skipIf(!ready)('dnsx, httpx and naabu against the local lab (real Docker)', () => {
  test('dnsx resolves, naabu needs confirmation, and two tools on one edge make it corroborated', async () => {
    // 1. the node, the scope rules lab:up prints, passive-only off
    const db = freshDb();
    db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
    ingestDocument(db, baseDoc({ target: LAB_HOST, command: 'manual seed', findings: [{ type: 'subdomain', value: LAB_HOST }] }));
    addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
    addRule(db, { kind: 'ip', value: labIp(network), action: 'include' });
    setSettings(db, { passiveOnly: false });
    const host = nodeId('subdomain', LAB_HOST);
    const ip = labIp(network);
    const ipNode = nodeId('ip', ip);

    const orch = new Orchestrator({ db, runtime, catalog, network, finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }) });
    const run = async (tool: string, nodeIdValue: string, confirmActive?: boolean) => {
      const queued = orch.enqueue(tool, nodeIdValue, confirmActive === undefined ? undefined : { confirmActive });
      expect(queued, JSON.stringify(queued)).toMatchObject({ ok: true, jobs: [{ tool, status: 'queued' }] });
      await orch.idle();
      const id = queued.ok ? queued.jobs[0]?.id : undefined;
      const job = id === undefined ? undefined : orch.get(id);
      expect(job, job?.error ?? '').toMatchObject({ status: 'succeeded', exitCode: 0 });
      return job;
    };
    const edge = (source: string, relation: 'resolves_to' | 'has_port', target: string) => edgeDetail(db, edgeId(source, relation, target))?.edge;

    // 2. dnsx is passive: no confirmation; the ip and resolves_to come from it alone
    const dnsx = await run('dnsx', host);
    expect(dnsx).toMatchObject({ mode: 'passive' });
    expect(dnsx?.argv).toEqual(expect.arrayContaining(['--target', LAB_HOST, '--target-type', 'subdomain']));
    expect(edge(host, 'resolves_to', ipNode)).toMatchObject({ confidence: 'discovered', sourceCount: 1 });
    // dnsx never reports its target: the seeded subdomain is still seen by the seed's tool only
    const toolsOf = (id: string) =>
      (db.$client.prepare("SELECT DISTINCT tool FROM observations WHERE node_id = ? AND role = 'finding' ORDER BY tool").all(id) as { tool: string }[]).map(
        (r) => r.tool,
      );
    const seeded = toolsOf(host);
    expect(seeded).toHaveLength(1);
    expect(seeded).not.toContain('dnsx');

    // 3. httpx, confirmed
    await run('httpx', host, true);

    // 4. naabu on the ip: refused without the confirmation (no job), then run confirmed
    expect(orch.enqueue('naabu', ipNode)).toMatchObject({ ok: false, code: 'confirm-required' });
    const naabu = await run('naabu', ipNode, true);
    expect(naabu).toMatchObject({ mode: 'active' });
    expect(naabu?.argv).toEqual(expect.arrayContaining(['--target', ip]));

    // 5. the graph
    const port = (p: number) => nodeId('port', `${ip}:${p}/tcp`);
    for (const p of LAB_PORTS) {
      expect(db.$client.prepare('SELECT 1 FROM nodes WHERE id = ?').get(port(p)), `port ${p}`).toBeDefined();
    }
    expect(edge(ipNode, 'has_port', port(80))).toMatchObject({ confidence: 'corroborated', sourceCount: 2 });
    expect(edge(ipNode, 'has_port', port(443))).toMatchObject({ confidence: 'corroborated', sourceCount: 2 });
    expect(edge(ipNode, 'has_port', port(8080))).toMatchObject({ confidence: 'discovered', sourceCount: 1 });
    expect(edgeDetail(db, edgeId(ipNode, 'has_port', port(8080)))?.observations.map((o) => o.tool)).toEqual(['naabu']);
    expect(edge(host, 'resolves_to', ipNode)).toMatchObject({ confidence: 'corroborated', sourceCount: 2 });
    expect(toolsOf(ipNode)).toEqual(['dnsx', 'httpx']);
    expect(toolsOf(host)).toEqual(seeded);

    // nothing of the jobs is left behind
    expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
  });
}, 300_000);
