// Pure: a tool definition + a ScopedTarget → the exact container to create (docs/architecture.md §11).
// The hardening lives here, as plain Engine API JSON, so every option is unit-tested without Docker.
import { assertScoped, type ScopedTarget } from '../scope/authorize';
import { TARGET_PLACEHOLDER, type ToolDef } from './defs';
import type { ContainerSpec } from './runtime';

export const LABEL_JOB = 'redwhale.job';
export const LABEL_WORKSPACE = 'redwhale.workspace';
export const LABEL_TOOL = 'redwhale.tool';

/** Every tool container runs as this user (the images create it and give it /out). */
export const TOOL_USER = '10001:10001';

export interface ResourceLimits {
  memoryBytes: number;
  /** CPUs × 1e9. */
  nanoCpus: number;
  pidsLimit: number;
  tmpSizeMb: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  tmpSizeMb: 256,
};

/** The script's own timeout is this much shorter than the hard kill, so it can still write a partial result. */
export const SCRIPT_TIMEOUT_MARGIN_SEC = 30;

export class ArgumentInjection extends Error {
  override name = 'ArgumentInjection';
}

/**
 * A target value as one argv item. Values are already normalized, but a value starting with "-" would be read as
 * an option by the tool (argument injection), so it's refused here too, as is anything with whitespace or control
 * characters, which no normalized target has.
 */
export function safeArgValue(value: string): string {
  if (value.length === 0) throw new ArgumentInjection('empty target value');
  if (value.startsWith('-')) throw new ArgumentInjection(`target value starts with "-" (would be read as an option): ${JSON.stringify(value)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new ArgumentInjection(`target value contains whitespace or control characters: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The command as run: the template with the scoped target's value as the single `{target}` item. */
export function buildArgv(def: ToolDef, target: ScopedTarget): string[] {
  assertScoped(target);
  if (!def.accepts.includes(target.type)) throw new ArgumentInjection(`${def.name} does not accept ${target.type} targets`);
  if (def.argv.filter((a) => a === TARGET_PLACEHOLDER).length !== 1) {
    throw new ArgumentInjection(`the argv template must have "${TARGET_PLACEHOLDER}" exactly once`);
  }
  const value = safeArgValue(target.value);
  return def.argv.map((item) => (item === TARGET_PLACEHOLDER ? value : item));
}

/** Container and volume name. The workspace prefix keeps two workspaces' job 12 apart. */
export function resourceName(workspaceId: string, jobId: string): string {
  return `redwhale-${workspaceId.slice(0, 8)}-job-${jobId}`;
}

export interface SpecInput {
  def: ToolDef;
  target: ScopedTarget;
  image: string;
  jobId: string;
  workspaceId: string;
  limits?: ResourceLimits;
}

/** The container for one job. Throws (ScopeViolation, ArgumentInjection) before anything is created. */
export function containerSpec({ def, target, image, jobId, workspaceId, limits = DEFAULT_LIMITS }: SpecInput): ContainerSpec {
  const argv = buildArgv(def, target);
  const [program = '', ...args] = argv;
  const labels = { [LABEL_JOB]: jobId, [LABEL_WORKSPACE]: workspaceId, [LABEL_TOOL]: def.name };
  const volume = resourceName(workspaceId, jobId);
  return {
    name: volume,
    volume: { Name: volume, Labels: labels },
    body: {
      Image: image,
      // Entrypoint + Cmd replace whatever the image declares: the argv runs exactly as built, no shell.
      Entrypoint: [program],
      Cmd: args,
      User: TOOL_USER,
      Env: [
        'HOME=/tmp',
        'PYTHONDONTWRITEBYTECODE=1',
        `REDWHALE_TOOL_TIMEOUT=${String(Math.max(5, def.timeoutSec - SCRIPT_TIMEOUT_MARGIN_SEC))}`,
      ],
      WorkingDir: '/tmp',
      Labels: labels,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        Memory: limits.memoryBytes,
        MemorySwap: limits.memoryBytes, // = Memory: no swap on top
        NanoCpus: limits.nanoCpus,
        PidsLimit: limits.pidsLimit,
        Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${String(limits.tmpSizeMb)}m` },
        Mounts: [{ Type: 'volume', Source: volume, Target: def.outputDir, ReadOnly: false }],
        NetworkMode: 'bridge',
        Init: true,
        AutoRemove: false, // the runner fetches /out after exit, then removes it
        RestartPolicy: { Name: 'no' },
        // Docker's own copy of stdout/stderr is capped too, so a chatty tool can't fill the disk.
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
      },
    },
  };
}
