// The real Docker runner (docs/architecture.md §12). Runs only when Docker is reachable and the subdomain image is
// built (pnpm tools:build subdomain); skipped otherwise. Uses short python3 -c programs in that image instead of the
// tools, so it never touches the network.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nodeId } from '@redwhale/shared';
import { afterAll, describe, expect, test } from 'vitest';
import { ingestDocument } from '../src/ingest/ingest';
import { loadCatalog } from '../src/runner/catalog';
import { toolDefSchema, type ToolDef } from '../src/runner/defs';
import { DockerRuntime } from '../src/runner/docker';
import { ingestFinish } from '../src/runner/finish';
import { Orchestrator, type ToolCatalog } from '../src/runner/orchestrator';
import { LABEL_WORKSPACE, containerSpec } from '../src/runner/spec';
import { authorize } from '../src/scope/authorize';
import { addRule } from '../src/scope/store';
import { baseDoc, freshDb, tempDir } from './helpers';

const runtime = new DockerRuntime();
const IMAGE = loadCatalog().imageRef('subdomain');
const ready = (await runtime.ping()).ok && (await runtime.inspectImage(IMAGE).catch(() => null)) !== null;
const WORKSPACE = `itest${randomUUID().replaceAll('-', '')}`;

/** A tool whose program is `python3 -c <code> <target>` (the code may not contain braces: tool.json forbids them). */
function pyTool(name: string, code: string, timeoutSec = 60): ToolDef {
  return toolDefSchema.parse({
    name, group: 'subdomain', label: name, mode: 'passive', accepts: ['domain'],
    argv: ['python3', '-c', code, '{target}'], timeoutSec, external: [], outputDir: '/out',
  });
}

const WRITE_RESULT = [
  'import sys, json, os',
  't = sys.argv[1]',
  'f = [dict(type="subdomain", value="itest." + t, parent=dict(type="domain", value=t), relation="has_subdomain")]',
  'doc = dict(contract_version=1, tool="itest", target=t, command="itest " + t, started_at="2026-11-02T10:00:00Z",',
  '  finished_at="2026-11-02T10:00:01Z", status="success", errors=[], findings=f)',
  'json.dump(doc, open("/out/result.json", "w"))',
  'open("/out/raw.txt", "w").write("raw for " + t)',
  'open("/out/big.bin", "wb").write(os.urandom(1000))',
  'print("to stdout"); print("to stderr", file=sys.stderr)',
].join('\n');

/** id, user, read-only root, caps, mounts… as Docker reports them. */
function inspect(id: string): Record<string, unknown> {
  const r = spawnSync('docker', ['inspect', id], { encoding: 'utf8' });
  const [info] = JSON.parse(r.stdout) as Record<string, unknown>[];
  if (!info) throw new Error(`docker inspect ${id}: ${r.stderr}`);
  return info;
}

function setup() {
  const db = freshDb();
  ingestDocument(db, baseDoc({ findings: [{ type: 'domain', value: 'example.com' }] }));
  addRule(db, { kind: 'domain', value: 'example.com', action: 'include' });
  db.$client.prepare('UPDATE runner_state SET workspace_id = ?').run(WORKSPACE);
  return db;
}

afterAll(async () => {
  if (!ready) return;
  const left = await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE);
  for (const c of left.containers) await runtime.removeContainer(c.id);
  for (const v of left.volumes) await runtime.removeVolume(v.name);
});

describe.skipIf(!ready)('real Docker', () => {
  test('a container is hardened as specified, /out is readable after exit, logs and caps work, and nothing is left', async () => {
    const db = setup();
    const auth = authorize(db, { type: 'domain', value: 'example.com' }, 'passive');
    if (!auth.ok) throw new Error(auth.reason);
    const spec = containerSpec({ def: pyTool('itest', WRITE_RESULT), target: auth.target, image: IMAGE, jobId: '1', workspaceId: WORKSPACE });
    const id = await runtime.create(spec);

    const info = inspect(id) as { Config: { User: string; Labels: Record<string, string> }; HostConfig: Record<string, unknown>; Mounts: { Type: string; Name?: string; Destination: string }[] };
    expect(info.Config.User).toBe('10001:10001');
    expect(info.Config.Labels['redwhale.job']).toBe('1');
    expect(info.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 1024 ** 3,
      NanoCpus: 1e9,
      PidsLimit: 256,
      Privileged: false,
      NetworkMode: 'bridge',
    });
    expect(info.HostConfig.Binds ?? null).toBeNull();
    expect(info.Mounts).toEqual([expect.objectContaining({ Type: 'volume', Name: spec.volume.Name, Destination: '/out' })]);

    await runtime.start(id);
    expect(await runtime.wait(id)).toEqual({ exitCode: 0 });
    const out = await runtime.fetchOutput(id, '/out', { files: { 'result.json': 1 << 20, 'raw.txt': 5 }, maxTotalBytes: 1 << 20 });
    expect(JSON.parse(out.files.get('result.json')?.data.toString() ?? 'null')).toMatchObject({ target: 'example.com' });
    expect(out.files.get('raw.txt')).toMatchObject({ size: 'raw for example.com'.length, truncated: true });
    expect(out.files.get('raw.txt')?.data.toString()).toBe('raw f');
    expect(out.skipped).toEqual([{ name: 'big.bin', size: 1000 }]);
    const logs = await runtime.logs(id, 1000);
    expect(logs.stdout.text).toBe('to stdout\n');
    expect(logs.stderr.text).toBe('to stderr\n');

    expect((await runtime.listByLabel('redwhale.job', '1')).containers.some((c) => c.id === id)).toBe(true);
    await runtime.removeContainer(id);
    await runtime.removeVolume(spec.volume.Name);
    const left = await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE);
    expect(left.containers.filter((c) => c.id === id)).toEqual([]);
    expect(left.volumes.filter((v) => v.name === spec.volume.Name)).toEqual([]);
  });

  test('through the orchestrator: ingested and linked; a timeout kills the container; nothing is left behind', async () => {
    const db = setup();
    const defs = [pyTool('itest', WRITE_RESULT), pyTool('sleeper', 'import time; time.sleep(120)')];
    const catalog: ToolCatalog = {
      tool: (n) => defs.find((d) => d.name === n),
      group: () => ({ name: 'subdomain', label: 'subdomain enumeration', image: 'redwhale-tools/subdomain', tools: defs.map((d) => d.name) }),
      imageRef: () => IMAGE,
    };
    const orch = new Orchestrator({
      db,
      runtime,
      catalog,
      finish: ingestFinish({ db, jobsDir: join(tempDir(), 'jobs') }),
      timeoutMs: (def) => (def.name === 'sleeper' ? 3000 : 60_000),
    });
    const domain = nodeId('domain', 'example.com');
    orch.enqueue('itest', domain);
    orch.enqueue('sleeper', domain);
    await orch.idle();
    expect(orch.get(1)).toMatchObject({ status: 'succeeded', exitCode: 0, nodesCreated: 1 });
    expect(orch.get(1)?.scanId).toBeTruthy();
    expect(orch.get(2)).toMatchObject({ status: 'failed', exitCode: 137 });
    expect(orch.get(2)?.error).toMatch(/^timed out after 60 s/);
    const left = await runtime.listByLabel(LABEL_WORKSPACE, WORKSPACE);
    expect(left).toEqual({ containers: [], volumes: [] });
  });
}, 120_000);
