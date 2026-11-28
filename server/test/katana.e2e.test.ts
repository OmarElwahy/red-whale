// End to end with real Docker (docs/architecture.md §11, lab/README.md): the lab's crawl site, the scope, a confirmed
// active katana run through the orchestrator, ingest, and proof from the lab's access log that katana stayed on the
// target's host and did not follow the http:// redirect. Skipped unless Docker is reachable and both images are built
// (pnpm tools:build urls; pnpm lab:up builds the lab image). It talks only to the local lab on the redwhale-tools
// network.
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
  (await runtime.inspectImage(catalog.imageRef('urls')).catch(() => null)) !== null &&
  (await runtime.inspectImage(labImage().ref).catch(() => null)) !== null;
const WORKSPACE = `e2e${randomUUID().replaceAll('-', '')}`;
const quiet: LabIo = { out: () => undefined, err: () => undefined };
const HOME = `https://${LAB_HOST}/`;
const at = (path: string) => `https://${LAB_HOST}${path}`;

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

describe.skipIf(!ready)('katana against the local lab (real Docker)', () => {
  test('a confirmed crawl is ingested as url --has_url--> url, on the target host only, without following the redirect', async () => {
    // 1–2. the url node (and an earlier "archive" sighting of one page, to show corroboration), the scope rules
    // lab:up prints, passive-only off
    const db = freshDb();
    db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
    ingestDocument(db, baseDoc({ target: LAB_HOST, command: 'manual seed', findings: [{ type: 'url', value: HOME }] }));
    ingestDocument(
      db,
      baseDoc({
        tool: 'gau',
        target: LAB_HOST,
        command: 'gau (stand-in)',
        findings: [{ type: 'url', value: at('/about.html'), parent: { type: 'subdomain', value: LAB_HOST }, relation: 'serves' }],
      }),
    );
    addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
    addRule(db, { kind: 'ip', value: labIp(network), action: 'include' });
    setSettings(db, { passiveOnly: false });
    const target = nodeId('url', HOME);

    const orch = new Orchestrator({ db, runtime, catalog, network, finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }) });
    expect(orch.enqueue('katana', target)).toMatchObject({ ok: false, code: 'confirm-required' });

    // 3. run it
    const logBefore = (await labLog()).length;
    const queued = orch.enqueue('katana', target, { confirmActive: true });
    expect(queued).toMatchObject({ ok: true, jobs: [{ tool: 'katana', mode: 'active', status: 'queued' }] });
    await orch.idle();
    const job = orch.get(1);
    expect(job, job?.error ?? '').toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(job?.argv).toEqual(expect.arrayContaining(['--target', HOME]));

    // 4. the crawl is in the graph, each url under the page it was found on
    const node = (value: string) =>
      db.$client.prepare("SELECT id, confidence FROM nodes WHERE type = 'url' AND value = ?").get(value) as
        | { id: string; confidence: string }
        | undefined;
    const edge = (from: string, to: string) =>
      db.$client
        .prepare("SELECT relation FROM edges WHERE source_id = ? AND target_id = ? AND relation = 'has_url'")
        .get(nodeId('url', from), nodeId('url', to)) as { relation: string } | undefined;
    // Stable across runs (katana's order and its regex finds vary): the home page's links, the script's endpoint,
    // the about page's PDF.
    for (const [from, to] of [
      [HOME, at('/about.html')],
      [HOME, at('/products.html')],
      [HOME, at('/static/app.js')],
      [HOME, at('/static/site.css')],
      [HOME, `http://${LAB_HOST}/`],
      [at('/static/app.js'), at('/api/v1/orders')],
      [at('/about.html'), at('/files/brochure.pdf')],
    ] as const) {
      expect(node(to), to).toBeDefined();
      expect(edge(from, to), `${from} -> ${to}`).toBeDefined();
    }
    // found by gau (stand-in) and katana: two tools
    expect(node(at('/about.html'))?.confidence).toBe('corroborated');
    expect(node(at('/products.html'))?.confidence).toBe('discovered');

    const data = (value: string) =>
      JSON.parse(
        (
          db.$client
            .prepare("SELECT o.data FROM observations o JOIN nodes n ON n.id = o.node_id WHERE n.value = ? AND o.tool = 'katana'")
            .get(value) as { data: string }
        ).data,
      ) as Record<string, unknown>;
    expect(data(`http://${LAB_HOST}/`)).toMatchObject({ status_code: 301, location: `https://${LAB_REDIRECT_HOST}/` });
    expect(data(at('/api/v1/orders'))).toMatchObject({ status_code: 200, tag: 'js', attribute: 'regex' });

    // 5. nothing of another host, and the access log agrees: only lab.redwhale.test was asked, the 301 was requested
    // and not followed, images and the known files (no -kf) were never fetched
    const all = db.$client.prepare('SELECT value FROM nodes').all() as { value: string }[];
    expect(all.filter((n) => n.value.includes(LAB_REDIRECT_HOST))).toEqual([]);
    const recent = (await labLog()).slice(logBefore).filter((l) => l.startsWith('host='));
    expect(recent.filter((l) => l.includes(`host=${LAB_REDIRECT_HOST}`))).toEqual([]); // no tool ever goes there
    // Other e2e suites may probe the lab at the same time: keep katana's container only (its address is the one that
    // fetched the script, which only a crawler finds).
    const addr = /^host=\S+ (\S+) "GET \/static\/app\.js /.exec(recent.find((l) => l.includes('"GET /static/app.js ')) ?? '')?.[1];
    expect(addr).toBeDefined();
    const log = recent.filter((l) => l.split(' ')[1] === addr);
    expect(log.length).toBeGreaterThanOrEqual(7);
    expect(log.filter((l) => !l.startsWith(`host=${LAB_HOST} `))).toEqual([]);
    expect(log.filter((l) => l.includes('"GET / HTTP/1.1" 301'))).toHaveLength(1);
    for (const path of ['/static/logo.png', '/robots.txt', '/sitemap.xml', '/contact.html']) {
      expect(log.filter((l) => l.includes(`"GET ${path} `)), path).toEqual([]);
    }
    expect(log.filter((l) => !l.includes('"GET '))).toEqual([]);

    expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
  });
}, 300_000);
