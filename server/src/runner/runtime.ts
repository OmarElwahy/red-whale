// What the orchestrator needs from a container engine. server/src/runner/docker.ts implements it with Docker's
// client library (the only file allowed to); tests use a fake (server/test/fakeRuntime.ts). Everything Docker-specific about a
// container is decided by spec.ts, as plain Engine API JSON, so the hardening is unit-tested without Docker.

/** One named volume per job, mounted at the tool's output directory (tmpfs is gone once a container exits). */
export interface VolumeSpec {
  Name: string;
  Labels: Record<string, string>;
}

/** The subset of the Engine API's container-create body we use. Built only by containerSpec() (spec.ts). */
export interface ContainerCreateBody {
  Image: string;
  Entrypoint: string[];
  Cmd: string[];
  User: string;
  Env: string[];
  WorkingDir: string;
  Labels: Record<string, string>;
  Tty: false;
  OpenStdin: false;
  HostConfig: {
    ReadonlyRootfs: true;
    CapDrop: ['ALL'];
    SecurityOpt: string[];
    Privileged: false;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    PidsLimit: number;
    Tmpfs: Record<string, string>;
    Mounts: { Type: 'volume'; Source: string; Target: string; ReadOnly: false }[];
    /** The tools network (network.ts), never the default bridge. */
    NetworkMode: 'redwhale-tools';
    Init: true;
    AutoRemove: false;
    RestartPolicy: { Name: 'no' };
    LogConfig: { Type: 'json-file'; Config: Record<string, string> };
  };
}

/** A user-defined bridge network (network.ts builds it). */
export interface NetworkSpec {
  name: string;
  /** IPv4 CIDR, canonical. */
  subnet: string;
  labels: Record<string, string>;
}

/** What inspecting a network tells us. */
export interface NetworkInfo {
  driver: string;
  internal: boolean;
  subnets: string[];
  labels: Record<string, string>;
}

export interface ContainerSpec {
  /** Container name, `redwhale-job-<id>`. */
  name: string;
  volume: VolumeSpec;
  body: ContainerCreateBody;
}

export type RuntimePing = { ok: true; version: string } | { ok: false; error: string };

export interface ImageInfo {
  id: string;
  tags: string[];
  labels: Record<string, string>;
}

/** A file fetched from the output directory. `size` is its real size; `data` stops at the cap. */
export interface FetchedFile {
  data: Buffer;
  size: number;
  truncated: boolean;
}

export interface FetchLimits {
  /** Byte cap per wanted file name; files not named here are skipped (but reported). */
  files: Record<string, number>;
  /** Stop reading the archive after this many bytes in all. */
  maxTotalBytes: number;
}

export interface FetchedOutput {
  files: Map<string, FetchedFile>;
  /** Files in the output directory we didn't keep, with their sizes (so a runaway tool is noticed). */
  skipped: { name: string; size: number }[];
  /** The archive went past maxTotalBytes; whatever wasn't read yet is missing. */
  overLimit: boolean;
}

export interface CappedText {
  text: string;
  /** Bytes the stream really had. */
  size: number;
  truncated: boolean;
}

export interface LabeledResources {
  containers: { id: string; name: string; state: string; labels: Record<string, string> }[];
  volumes: { name: string; labels: Record<string, string> }[];
}

export interface ContainerRuntime {
  ping(): Promise<RuntimePing>;
  /** null if there is no such image. */
  inspectImage(ref: string): Promise<ImageInfo | null>;
  /** Images carrying `label=value`. */
  listImages(label: string, value?: string): Promise<ImageInfo[]>;
  /**
   * Creates the network if it's missing; accepts an existing one only if it matches (ours, bridge, not internal, same
   * subnet). Throws NetworkError with a message the analyst can act on.
   */
  ensureNetwork(spec: NetworkSpec): Promise<void>;
  /** Creates the volume, then the container. Returns the container ID. */
  create(spec: ContainerSpec): Promise<string>;
  start(containerId: string): Promise<void>;
  /** Resolves with the exit code once the container stops (for any reason, a kill included). */
  wait(containerId: string): Promise<{ exitCode: number }>;
  /** SIGKILL. A container that already stopped is not an error. */
  kill(containerId: string): Promise<void>;
  logs(containerId: string, maxBytes: number): Promise<{ stdout: CappedText; stderr: CappedText }>;
  /** Reads the files of `dir` from a (stopped) container, enforcing the caps while reading. */
  fetchOutput(containerId: string, dir: string, limits: FetchLimits): Promise<FetchedOutput>;
  /** Removes the container (force). A missing container is not an error. */
  removeContainer(containerId: string): Promise<void>;
  /** A missing volume is not an error. */
  removeVolume(name: string): Promise<void>;
  /** Containers (running or not) and volumes carrying `label=value`. */
  listByLabel(label: string, value?: string): Promise<LabeledResources>;
}
