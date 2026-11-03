// A ContainerRuntime without Docker: containers follow a scripted behavior, and every call is recorded, so tests
// can assert that nothing was created for a refused job, that a timeout killed the container, and so on.
import type {
  CappedText,
  ContainerRuntime,
  ContainerSpec,
  FetchLimits,
  FetchedOutput,
  ImageInfo,
  LabeledResources,
  NetworkSpec,
  RuntimePing,
} from '../src/runner/runtime';

export interface FakeBehavior {
  /** Files the "tool" leaves in its output directory. */
  files?: Record<string, string | Buffer>;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Never exits on its own (until killed): for timeouts and cancels. */
  hang?: boolean;
  /** Exits after this many ms (real timers). Default: at once, after start. */
  delayMs?: number;
  /** start() throws this. */
  startError?: string;
}

interface FakeContainer {
  id: string;
  spec: ContainerSpec;
  behavior: FakeBehavior;
  state: 'created' | 'running' | 'exited';
  exitCode: number | null;
  exited: Promise<number>;
  exit: (code: number) => void;
}

export type FakeCall = { op: keyof ContainerRuntime; arg?: string };

export class FakeRuntime implements ContainerRuntime {
  readonly calls: FakeCall[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, Record<string, string>>();
  /** Images that "exist", by reference (repo:tag). */
  readonly images = new Map<string, ImageInfo>();
  reachable = true;
  /** Networks that "exist", by name. */
  readonly networks = new Map<string, NetworkSpec>();
  /** ensureNetwork() throws this (a subnet clash, say). */
  networkError: string | null = null;
  private next = 0;

  /** Decides each new container's behavior; defaults to an immediate clean exit with no files. */
  constructor(public behave: (spec: ContainerSpec) => FakeBehavior = () => ({})) {}

  addImage(ref: string, labels: Record<string, string> = {}): void {
    this.images.set(ref, { id: `sha256:${ref}`, tags: [ref], labels });
  }

  /** Every container ever created (in order), removed ones included. */
  readonly created: ContainerSpec[] = [];

  running(): number {
    return [...this.containers.values()].filter((c) => c.state === 'running').length;
  }

  private record(op: keyof ContainerRuntime, arg?: string): void {
    this.calls.push(arg === undefined ? { op } : { op, arg });
    if (!this.reachable && op !== 'ping') throw new Error('connect ENOENT //./pipe/docker_engine');
  }

  private get(id: string): FakeContainer {
    const c = this.containers.get(id);
    if (!c) throw new Error(`no such container: ${id}`);
    return c;
  }

  ping(): Promise<RuntimePing> {
    this.calls.push({ op: 'ping' });
    return Promise.resolve(this.reachable ? { ok: true, version: 'fake-27.0' } : { ok: false, error: 'Docker is not running' });
  }

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    this.record('inspectImage', ref);
    return Promise.resolve(this.images.get(ref) ?? null);
  }

  async listImages(label: string, value?: string): Promise<ImageInfo[]> {
    this.record('listImages', label);
    return Promise.resolve(
      [...this.images.values()].filter((i) => label in i.labels && (value === undefined || i.labels[label] === value)),
    );
  }

  async ensureNetwork(spec: NetworkSpec): Promise<void> {
    this.record('ensureNetwork', spec.name);
    if (this.networkError !== null) throw new Error(this.networkError);
    if (!this.networks.has(spec.name)) this.networks.set(spec.name, spec);
    return Promise.resolve();
  }

  async create(spec: ContainerSpec): Promise<string> {
    this.record('create', spec.name);
    // Like Docker: the container's network must exist.
    const network = spec.body.HostConfig.NetworkMode;
    if (!this.networks.has(network)) throw new Error(`network ${network} not found`);
    if (!this.images.has(spec.body.Image)) throw new Error(`No such image: ${spec.body.Image}`);
    this.volumes.set(spec.volume.Name, spec.volume.Labels);
    this.created.push(spec);
    this.next += 1;
    const id = `fake${String(this.next).padStart(8, '0')}`;
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const container: FakeContainer = { id, spec, behavior: this.behave(spec), state: 'created', exitCode: null, exited, exit };
    container.exit = (code) => {
      if (container.state === 'exited') return;
      container.state = 'exited';
      container.exitCode = code;
      exit(code);
    };
    this.containers.set(id, container);
    return Promise.resolve(id);
  }

  async start(id: string): Promise<void> {
    this.record('start', id);
    const c = this.get(id);
    if (c.behavior.startError !== undefined) throw new Error(c.behavior.startError);
    c.state = 'running';
    if (!c.behavior.hang) {
      const code = c.behavior.exitCode ?? 0;
      if (c.behavior.delayMs === undefined) queueMicrotask(() => { c.exit(code); });
      else setTimeout(() => { c.exit(code); }, c.behavior.delayMs);
    }
    return Promise.resolve();
  }

  async wait(id: string): Promise<{ exitCode: number }> {
    this.record('wait', id);
    return { exitCode: await this.get(id).exited };
  }

  async kill(id: string): Promise<void> {
    this.record('kill', id);
    const c = this.containers.get(id);
    if (c && c.state === 'running') c.exit(137);
    return Promise.resolve();
  }

  async logs(id: string, maxBytes: number): Promise<{ stdout: CappedText; stderr: CappedText }> {
    this.record('logs', id);
    const c = this.get(id);
    const cap = (s = ''): CappedText => {
      const buf = Buffer.from(s);
      return { text: buf.subarray(0, maxBytes).toString('utf8'), size: buf.length, truncated: buf.length > maxBytes };
    };
    return Promise.resolve({ stdout: cap(c.behavior.stdout), stderr: cap(c.behavior.stderr) });
  }

  async fetchOutput(id: string, _dir: string, limits: FetchLimits): Promise<FetchedOutput> {
    this.record('fetchOutput', id);
    const c = this.get(id);
    const out: FetchedOutput = { files: new Map(), skipped: [], overLimit: false };
    let total = 0;
    for (const [name, content] of Object.entries(c.behavior.files ?? {})) {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      const cap = limits.files[name];
      if (cap === undefined) {
        out.skipped.push({ name, size: buf.length });
        continue;
      }
      const keep = Math.min(buf.length, cap, Math.max(0, limits.maxTotalBytes - total));
      total += keep;
      if (total >= limits.maxTotalBytes && keep < buf.length) out.overLimit = true;
      out.files.set(name, { data: buf.subarray(0, keep), size: buf.length, truncated: keep < buf.length });
    }
    return Promise.resolve(out);
  }

  async removeContainer(id: string): Promise<void> {
    this.record('removeContainer', id);
    const c = this.containers.get(id);
    if (c) {
      c.exit(137);
      this.containers.delete(id);
    }
    return Promise.resolve();
  }

  async removeVolume(name: string): Promise<void> {
    this.record('removeVolume', name);
    this.volumes.delete(name);
    return Promise.resolve();
  }

  async listByLabel(label: string, value?: string): Promise<LabeledResources> {
    this.record('listByLabel', label);
    const match = (labels: Record<string, string>) => label in labels && (value === undefined || labels[label] === value);
    return Promise.resolve({
      containers: [...this.containers.values()]
        .filter((c) => match(c.spec.body.Labels))
        .map((c) => ({ id: c.id, name: c.spec.name, state: c.state, labels: c.spec.body.Labels })),
      volumes: [...this.volumes.entries()].filter(([, labels]) => match(labels)).map(([name, labels]) => ({ name, labels })),
    });
  }
}
