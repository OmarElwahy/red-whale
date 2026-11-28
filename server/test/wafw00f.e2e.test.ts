// End to end with real Docker (docs/architecture.md §11, lab/README.md, docs/phase-6c7-progress.md): wafw00f through
// the orchestrator against the local lab, ingest, and proof from the lab's access log of what it sent. Skipped unless
// Docker is reachable and both images are built (pnpm tools:build http; pnpm lab:up builds the lab image). It talks
// only to the local lab on the redwhale-tools network. Seconds: 2 to 7 requests per run.
//
//   /waf/   the lab's fake WAF (a 403 wafw00f's Shadow Daemon signature matches): technology shadow-daemon
//   /       no WAF: success, no findings (7 requests, the generic detection's too)
//   http:// the lab's 301 to elsewhere.redwhale.test: not followed
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
import { labLogSince, logMark } from './lab-log';

const runtime = new DockerRuntime();
const catalog = loadCatalog();
const network = toolsNetwork();
const ready =
  (await runtime.ping()).ok &&
  (await runtime.inspectImage(catalog.imageRef('http')).catch(() => null)) !== null &&
  (await runtime.inspectImage(labImage().ref).catch(() => null)) !== null;
const WORKSPACE = `e2e${randomUUID().replaceAll('-', '')}`;
const quiet: LabIo = { out: () => undefined, err: () => undefined };
// wafw00f's central attack: three random 8-letter parameters, the XSS string first (main.py centralAttack)
const ATTACK = /"GET \/(?:waf\/)?\?[a-z]{8}=%3Cscript%3Ealert%28%22XSS%22%29%3B%3C%2Fscript%3E&[a-z]{8}=UNION\+SELECT\+ALL\+FROM\+information_schema\+AND\+%22\+or\+SLEEP%285%29\+or\+%22&[a-z]{8}=\.\.%2F\.\.%2Fetc%2Fpasswd /;
// The only User-Agents wafw00f sends: its fixed browser one (lib/evillib.py def_headers), then requests' own once the
// generic detection drops it. With the address, they tell wafw00f's lines from those of another suite's container
// that had the same address a moment before (seen in a full run: 4 lines instead of 2).
const UAS = ['"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0"', '"python-requests/2.34.2"'];

let wasUp = false;

interface Run {
  db: ReturnType<typeof freshDb>;
  /** the lab's log lines from wafw00f's container (the address that sent the central attack, wafw00f's User-Agents) */
  log: string[];
  scan: { status: string; errors: string; tool_version: string; command: string };
}

async function wafw00f(url: string): Promise<Run> {
  const db = freshDb();
  db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
  ingestDocument(db, baseDoc({ target: LAB_HOST, command: 'manual seed', findings: [{ type: 'url', value: url }] }));
  addRule(db, { kind: 'domain', value: LAB_HOST, action: 'include' });
  addRule(db, { kind: 'ip', value: labIp(network), action: 'include' });
  setSettings(db, { passiveOnly: false });
  const orch = new Orchestrator({ db, runtime, catalog, network, finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }) });
  const target = nodeId('url', url);
  expect(orch.enqueue('wafw00f', target)).toMatchObject({ ok: false, code: 'confirm-required' });
  // The mark is a second early (docker logs --since is whole seconds) and the next container gets the address the
  // previous test's just freed: wait so the previous run's lines are older than the mark. (Another suite's container
  // can still free an address during the wait: the User-Agent filter below covers that.)
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const since = logMark();
  expect(orch.enqueue('wafw00f', target, { confirmActive: true })).toMatchObject({
    ok: true,
    jobs: [{ tool: 'wafw00f', mode: 'active', status: 'queued' }],
  });
  await orch.idle();
  const job = orch.get(1);
  expect(job, job?.error ?? '').toMatchObject({ status: 'succeeded', exitCode: 0 });

  // Other e2e suites may probe the lab at the same time: keep wafw00f's container only.
  const recent = (await labLogSince(runtime, since)).filter((l) => l.startsWith('host='));
  // no tool ever goes to the redirect's host, whatever container
  expect(recent.filter((l) => l.startsWith(`host=${LAB_REDIRECT_HOST} `))).toEqual([]);
  const addr = recent.find((l) => ATTACK.test(l))?.split(' ')[1];
  expect(addr, 'the central attack request in the lab log').toBeDefined();
  const scan = db.$client.prepare("SELECT status, errors, tool_version, command FROM scans WHERE tool = 'wafw00f'").get() as Run['scan'];
  expect(scan).toMatchObject({ status: 'success', errors: '[]', tool_version: '2.4.2' });
  for (const flag of ['-r', '--no-colors']) expect(scan.command.split(' '), flag).toContain(flag);
  expect(scan.command).not.toMatch(/ (-a|--findall|-p|--proxy) /);
  expect(await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE)).toEqual({ containers: [], volumes: [] });
  return { db, log: recent.filter((l) => l.split(' ')[1] === addr && UAS.some((ua) => l.endsWith(ua))), scan };
}

/** What wafw00f reported (without the url: named only as the parent, which ingest records but doesn't count). */
const wafw00fNodes = (r: Run) =>
  r.db.$client
    .prepare("SELECT n.type, n.value, o.data FROM observations o JOIN nodes n ON n.id = o.node_id WHERE o.tool = 'wafw00f' AND n.type != 'url'")
    .all() as { type: string; value: string; data: string }[];

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

describe.skipIf(!ready)('wafw00f against the local lab (real Docker)', () => {
  test("/waf/: the lab's fake WAF is named (Shadow Daemon's signature), in 2 requests", async () => {
    const url = `https://${LAB_HOST}/waf/`;
    const r = await wafw00f(url);
    expect(wafw00fNodes(r)).toEqual([{ type: 'technology', value: 'shadow-daemon', data: JSON.stringify({ waf: true, manufacturer: 'Zecure' }) }]);
    const edge = r.db.$client
      .prepare("SELECT relation FROM edges WHERE source_id = ? AND target_id = ? AND relation = 'uses_technology'")
      .get(nodeId('url', url), nodeId('technology', 'shadow-daemon'));
    expect(edge).toBeDefined();
    // a normal GET (200), then the central attack (the lab's 403); first match wins, so no generic detection
    expect(r.log).toHaveLength(2);
    expect(r.log.every((l) => l.startsWith(`host=${LAB_HOST} `) && l.includes('"GET /waf/'))).toBe(true);
    expect(r.log.map((l) => l.split('"')[2]?.trim().split(' ')[0])).toEqual(['200', '403']);
  }, 60_000);

  test('/: no WAF is a success with no findings; 7 requests, all to the URL, one with a script User-Agent', async () => {
    const r = await wafw00f(`https://${LAB_HOST}/`);
    expect(wafw00fNodes(r)).toEqual([]);
    expect(r.log).toHaveLength(7);
    expect(r.log.every((l) => l.startsWith(`host=${LAB_HOST} `) && /"GET \/(\?[^ ]*)? HTTP/.test(l))).toBe(true);
    expect(r.log.filter((l) => l.endsWith('"python-requests/2.34.2"'))).toHaveLength(4); // no browser UA after the 3rd
    expect(r.log.filter((l) => l.includes('SLEEP%285%29'))).toHaveLength(2); // central attack + the SQLi alone
  }, 60_000);

  test('http://: the 301 to another host is not followed', async () => {
    const r = await wafw00f(`http://${LAB_HOST}/`);
    expect(wafw00fNodes(r)).toEqual([]);
    expect(r.log.length).toBeGreaterThan(0);
    expect(r.log.every((l) => l.startsWith(`host=${LAB_HOST} `) && l.includes('" 301 '))).toBe(true);
  }, 60_000);
});
