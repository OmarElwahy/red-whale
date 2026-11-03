// End to end with real Docker (docs/architecture.md §11, lab/README.md): the lab, the scope, a confirmed active run
// of httpx through the orchestrator, ingest, and proof that the lab's redirect was not followed. Skipped unless
// Docker is reachable and both images are built (pnpm tools:build http; pnpm lab:up builds the lab image).
// It talks only to the local lab on the redwhale-tools network.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nodeId } from '@redwhale/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ingestDocument } from '../src/ingest/ingest';
import { loadCatalog } from '../src/runner/catalog';
import { DockerRuntime } from '../src/runner/docker';
import { ingestFinish } from '../src/runner/finish';
import { LABEL_LAB, LAB_HOST, LAB_REDIRECT_HOST, labDown, labImage, labIp, labUp, type LabIo } from '../src/runner/lab';
import { toolsNetwork } from '../src/runner/network';
import { Orchestrator } from '../src/runner/orchestrator';
import { LABEL_WORKSPACE } from '../src/runner/spec';
import { addRule, setSettings } from '../src/scope/store';
import { baseDoc, freshDb, tempDir } from './helpers';

const runtime = new DockerRuntime();
const catalog = loadCatalog();
const network = toolsNetwork();
const ready =
  (await runtime.ping()).ok &&
  (await runtime.inspectImage(catalog.imageRef('http')).catch(() => null)) !== null &&
  (await runtime.inspectImage(labImage().ref).catch(() => null)) !== null;
const WORKSPACE = `e2e${randomUUID().replaceAll('-', '')}`;
const quiet: LabIo = { out: () => undefined, err: () => undefined };

/** Was the lab already running before this test (the analyst's)? Then it is left running. */
let wasUp = false;

async function labContainerId(): Promise<string> {
  const found = (await runtime.listByLabel(LABEL_LAB)).containers.find((c) => c.state === 'running');
  if (!found) throw new Error('the lab is not running');
  return found.id;
}

async function labLog(): Promise<string[]> {
  const { stdout } = await runtime.logs(await labContainerId(), 4 * 1024 * 1024);
  return stdout.text.split('\n').filter(Boolean);
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

describe.skipIf(!ready)('httpx against the local lab (real Docker)', () => {
  test('a confirmed active run is ingested as ip → port → url → technology, and the redirect is not followed', async () => {
    // 1–2. the node, the scope rules lab:up prints, passive-only off
    const db = freshDb();
    db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
    ingestDocument(db, baseDoc({ target: LAB_HOST, command: 'manual seed', findings: [{ type: 'subdomain', value: LAB_HOST }] }));
    addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
    addRule(db, { kind: 'ip', value: labIp(network), action: 'include' });
    setSettings(db, { passiveOnly: false });
    const target = nodeId('subdomain', LAB_HOST);

    const orch = new Orchestrator({ db, runtime, catalog, network, finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }) });
    // Without the confirmation nothing is queued.
    expect(orch.enqueue('httpx', target)).toMatchObject({ ok: false, code: 'confirm-required' });

    // 3. run it
    const logBefore = (await labLog()).length;
    const queued = orch.enqueue('httpx', target, { confirmActive: true });
    expect(queued).toMatchObject({ ok: true, jobs: [{ tool: 'httpx', mode: 'active', status: 'queued' }] });
    await orch.idle();
    const job = orch.get(1);
    expect(job, job?.error ?? '').toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(job?.argv).toEqual(expect.arrayContaining(['--target', LAB_HOST, '--target-type', 'subdomain']));

    // 4. the chain is in the graph
    const ip = labIp(network);
    const node = (type: string, value: string) =>
      db.$client.prepare('SELECT id FROM nodes WHERE type = ? AND value = ?').get(type, value) as { id: string } | undefined;
    for (const [type, value] of [
      ['ip', ip],
      ['port', `${ip}:80/tcp`],
      ['port', `${ip}:443/tcp`],
      ['url', `http://${LAB_HOST}/`],
      ['url', `https://${LAB_HOST}/`],
      ['technology', 'nginx/1.30.6'],
      ['technology', 'php/8.3.12'],
    ] as const) {
      expect(node(type, value), `${type} ${value}`).toBeDefined();
    }
    const data = (url: string) =>
      JSON.parse(
        (db.$client.prepare("SELECT o.data FROM observations o JOIN nodes n ON n.id = o.node_id WHERE n.value = ? AND o.tool = 'httpx'").get(url) as { data: string })
          .data,
      ) as Record<string, unknown>;
    expect(data(`http://${LAB_HOST}/`)).toMatchObject({ status_code: 301, location: `https://${LAB_REDIRECT_HOST}/` });
    expect(data(`https://${LAB_HOST}/`)).toMatchObject({ status_code: 200, title: 'Northwind Lab', webserver: 'nginx/1.30.6' });

    // …and the redirect target is neither a finding nor contacted
    const all = db.$client.prepare('SELECT value FROM nodes').all() as { value: string }[];
    expect(all.filter((n) => n.value.includes(LAB_REDIRECT_HOST))).toEqual([]);
    const log = (await labLog()).slice(logBefore);
    expect(log.filter((l) => l.startsWith(`host=${LAB_HOST} `)).length).toBeGreaterThanOrEqual(2);
    expect(log.filter((l) => l.includes(`host=${LAB_REDIRECT_HOST}`))).toEqual([]);

    // nothing of the job is left behind
    expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
  });
}, 180_000);
