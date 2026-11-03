// The ONE file that talks to Docker (docs/architecture.md §10, §11; enforced by eslint.config.js and
// server/test/guard.test.ts). It implements ContainerRuntime with dockerode and adds nothing of its own: what a
// container looks like (user, limits, mounts, labels) is decided by spec.ts and passed through unchanged.
//
// Connection: the platform default (Windows: the named pipe //./pipe/docker_engine of Docker Desktop), or
// DOCKER_HOST. Never a TCP socket we open ourselves.
import { Readable } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import type {
  CappedText,
  ContainerRuntime,
  ContainerSpec,
  FetchLimits,
  FetchedFile,
  FetchedOutput,
  ImageInfo,
  LabeledResources,
  NetworkInfo,
  NetworkSpec,
  RuntimePing,
  ServiceSpec,
  BuildOptions,
} from './runtime';
import { NetworkError, existingNetworkProblem, networkCreateError } from './network';

/** HTTP status of a Docker Engine error, if it is one. */
function statusOf(e: unknown): number | null {
  return typeof e === 'object' && e !== null && 'statusCode' in e && typeof e.statusCode === 'number' ? e.statusCode : null;
}

/** Runs `op`, treating "no such thing" (404) and "already in that state" (304, 409) as done. */
async function idempotent(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (e) {
    const status = statusOf(e);
    if (status === 404 || status === 304 || status === 409) return;
    throw e;
  }
}

const labelFilter = (label: string, value?: string) => JSON.stringify({ label: [value === undefined ? label : `${label}=${value}`] });

/** Splits Docker's multiplexed log stream (8-byte frame headers) into stdout and stderr, each capped. */
export function demuxLogs(buffer: Buffer, maxBytes: number): { stdout: CappedText; stderr: CappedText } {
  const parts = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  const kept = { stdout: 0, stderr: 0 };
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset] === 2 ? 'stderr' : 'stdout';
    const length = buffer.readUInt32BE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
    sizes[stream] += chunk.length;
    const room = maxBytes - kept[stream];
    if (room > 0) {
      parts[stream].push(chunk.subarray(0, room));
      kept[stream] += Math.min(room, chunk.length);
    }
  }
  const text = (s: 'stdout' | 'stderr'): CappedText => ({
    text: Buffer.concat(parts[s]).toString('utf8'),
    size: sizes[s],
    truncated: sizes[s] > kept[s],
  });
  return { stdout: text('stdout'), stderr: text('stderr') };
}

/**
 * Reads a `getArchive` tar of `dir`: keeps the files named in `limits.files` (top level only, each up to its cap),
 * reports the others with their real sizes, and stops reading after `maxTotalBytes`.
 */
export async function readOutputArchive(archive: NodeJS.ReadableStream, limits: FetchLimits): Promise<FetchedOutput> {
  const out: FetchedOutput = { files: new Map(), skipped: [], overLimit: false };
  const extract = tar.extract();
  const source = archive instanceof Readable ? archive : Readable.from(archive);
  let total = 0;

  return new Promise<FetchedOutput>((resolve, reject) => {
    const finish = () => {
      resolve(out);
    };
    source.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limits.maxTotalBytes && !out.overLimit) {
        out.overLimit = true;
        source.unpipe(extract);
        source.destroy();
        extract.destroy();
        finish();
      }
    });
    source.on('error', (e) => {
      if (!out.overLimit) reject(e);
    });
    extract.on('entry', (header, stream, next) => {
      // getArchive('/out') names entries "out/", "out/raw.txt", …: keep only files directly inside.
      const parts = header.name.split('/').filter(Boolean);
      const name = parts.length === 2 ? (parts[1] ?? '') : '';
      const size = header.size;
      const cap = header.type === 'file' && name !== '' ? limits.files[name] : undefined;
      if (cap === undefined) {
        if (header.type === 'file' || header.type === 'symlink') out.skipped.push({ name: parts.slice(1).join('/'), size });
        stream.on('end', next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let kept = 0;
      stream.on('data', (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) return;
        const room = cap - kept;
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          kept += Math.min(room, chunk.length);
        }
      });
      stream.on('end', () => {
        const file: FetchedFile = { data: Buffer.concat(chunks), size, truncated: size > kept };
        out.files.set(name, file);
        next();
      });
    });
    extract.on('finish', finish);
    extract.on('error', (e) => {
      if (!out.overLimit) reject(e);
    });
    source.pipe(extract);
  });
}

/** How long a Docker health check may take before Docker counts as not responding. */
export const PING_TIMEOUT_MS = 5000;

export type { BuildOptions } from './runtime';

export class DockerRuntime implements ContainerRuntime {
  private readonly docker: Docker;

  constructor(options?: Docker.DockerOptions) {
    this.docker = new Docker(options);
  }

  /**
   * A hung Docker Desktop accepts the connection and never answers; without the time limit every route that checks
   * Docker (and the Run tool menu waiting on them) would hang with it.
   */
  async ping(timeoutMs = PING_TIMEOUT_MS): Promise<RuntimePing> {
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Docker is not responding (no answer in ${String(timeoutMs / 1000)} s); restart Docker Desktop`));
      }, timeoutMs);
    });
    try {
      const version = await Promise.race([this.docker.ping().then(() => this.docker.version()), hung]);
      return { ok: true, version: version.Version };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, error: /ENOENT|ECONNREFUSED|pipe/i.test(error) ? `Docker is not running (${error})` : error };
    } finally {
      clearTimeout(timer);
    }
  }

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    try {
      const image = await this.docker.getImage(ref).inspect();
      // Labels is null on an image without any, whatever the types say.
      return { id: image.Id, tags: image.RepoTags, labels: { ...image.Config.Labels } };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async listImages(label: string, value?: string): Promise<ImageInfo[]> {
    const images = await this.docker.listImages({ filters: labelFilter(label, value) });
    return images.map((i) => ({ id: i.Id, tags: i.RepoTags ?? [], labels: i.Labels }));
  }

  private async inspectNetwork(name: string): Promise<NetworkInfo | null> {
    try {
      const n = (await this.docker.getNetwork(name).inspect()) as {
        Driver?: string;
        Internal?: boolean;
        IPAM?: { Config?: { Subnet?: string; IPRange?: string }[] | null } | null;
        Labels?: Record<string, string> | null;
      };
      return {
        driver: n.Driver ?? '',
        internal: n.Internal === true,
        pools: (n.IPAM?.Config ?? []).flatMap((c) => (c.Subnet ? [{ subnet: c.Subnet, ipRange: c.IPRange ?? null }] : [])),
        labels: { ...n.Labels },
      };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async ensureNetwork(spec: NetworkSpec): Promise<void> {
    const check = (found: NetworkInfo) => {
      const problem = existingNetworkProblem(spec, found);
      if (problem) throw new NetworkError(problem);
    };
    const found = await this.inspectNetwork(spec.name);
    if (found) {
      check(found);
      return;
    }
    try {
      await this.docker.createNetwork({
        Name: spec.name,
        Driver: 'bridge',
        Internal: false,
        CheckDuplicate: true,
        Labels: spec.labels,
        IPAM: { Driver: 'default', Config: [{ Subnet: spec.subnet, IPRange: spec.ipRange }] },
      });
    } catch (e) {
      // Two jobs starting at once: the other one created it first.
      const raced = statusOf(e) === 409 ? await this.inspectNetwork(spec.name) : null;
      if (raced) {
        check(raced);
        return;
      }
      throw new NetworkError(networkCreateError(spec, e instanceof Error ? e.message : String(e)));
    }
  }

  async create(spec: ContainerSpec): Promise<string> {
    await this.docker.createVolume({ Name: spec.volume.Name, Labels: spec.volume.Labels });
    const container = await this.docker.createContainer({ name: spec.name, ...spec.body });
    return container.id;
  }

  async createService(spec: ServiceSpec): Promise<string> {
    const container = await this.docker.createContainer({ name: spec.name, ...spec.body });
    return container.id;
  }

  async start(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
  }

  async wait(containerId: string): Promise<{ exitCode: number }> {
    const result = (await this.docker.getContainer(containerId).wait()) as { StatusCode: number };
    return { exitCode: result.StatusCode };
  }

  async kill(containerId: string): Promise<void> {
    await idempotent(() => this.docker.getContainer(containerId).kill({ signal: 'SIGKILL' }));
  }

  async logs(containerId: string, maxBytes: number): Promise<{ stdout: CappedText; stderr: CappedText }> {
    const buffer = await this.docker.getContainer(containerId).logs({ stdout: true, stderr: true, follow: false });
    return demuxLogs(buffer, maxBytes);
  }

  async fetchOutput(containerId: string, dir: string, limits: FetchLimits): Promise<FetchedOutput> {
    const archive = await this.docker.getContainer(containerId).getArchive({ path: dir });
    return readOutputArchive(archive, limits);
  }

  async removeContainer(containerId: string): Promise<void> {
    await idempotent(() => this.docker.getContainer(containerId).remove({ force: true, v: true }));
  }

  async removeVolume(name: string): Promise<void> {
    await idempotent(() => this.docker.getVolume(name).remove());
  }

  async listByLabel(label: string, value?: string): Promise<LabeledResources> {
    const filters = labelFilter(label, value);
    const [containers, volumes] = await Promise.all([
      this.docker.listContainers({ all: true, filters }),
      this.docker.listVolumes({ filters }),
    ]);
    return {
      containers: containers.map((c) => ({ id: c.Id, name: (c.Names[0] ?? '').replace(/^\//, ''), state: c.State, labels: c.Labels })),
      // Both can be null in the Engine's answer, whatever the types say.
      volumes: (Array.isArray(volumes.Volumes) ? volumes.Volumes : []).map((v) => ({ name: v.Name, labels: { ...v.Labels } })),
    };
  }

  /** Builds an image from exactly `files` of `context` (pnpm tools:build). Rejects with the build's error. */
  async build(options: BuildOptions): Promise<void> {
    const stream = await this.docker.buildImage(
      { context: options.context, src: options.files },
      { t: options.tag, dockerfile: options.dockerfile, labels: options.labels, rm: true, forcerm: true, pull: false },
    );
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null, output: { error?: string; errorDetail?: { message?: string } }[]) => {
          const failed = err ?? output.find((o) => o.error !== undefined);
          if (failed) reject(new Error(failed instanceof Error ? failed.message : (failed.errorDetail?.message ?? failed.error)));
          else resolve();
        },
        (event: { stream?: string; status?: string }) => {
          const line = (event.stream ?? event.status ?? '').trimEnd();
          if (line) options.onLog?.(line);
        },
      );
    });
  }
}
