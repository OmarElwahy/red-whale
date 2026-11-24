// The local lab's access log for the e2e suites (lab/README.md): every line nginx wrote since a moment, read with
// `docker logs --since`. Not runtime.logs(): it keeps the FIRST maxBytes of the whole log, and a full nuclei scan
// alone writes ~2.3 MB, so a long-running lab's new lines fell past the cap (6C-6: httpx and katana e2e saw none).
import { spawnSync } from 'node:child_process';
import type { DockerRuntime } from '../src/runner/docker';
import { LABEL_LAB } from '../src/runner/lab';

export async function labContainerId(runtime: DockerRuntime): Promise<string> {
  const found = (await runtime.listByLabel(LABEL_LAB)).containers.find((c) => c.state === 'running');
  if (!found) throw new Error('the lab is not running');
  return found.id;
}

/** A `since` for labLogSince: one second ago (docker logs --since has whole-second precision). */
export const logMark = (): string => new Date(Date.now() - 1000).toISOString();

/** The lab's log lines (stdout: nginx's access log and the port-22 banner log) since `since`, empty ones dropped. */
export async function labLogSince(runtime: DockerRuntime, since: string): Promise<string[]> {
  const r = spawnSync('docker', ['logs', '--since', since, await labContainerId(runtime)], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`docker logs: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}
