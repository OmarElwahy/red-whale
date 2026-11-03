// The job queue (docs/architecture.md §11). Jobs live in SQLite (so the queue survives restarts); at most
// `maxConcurrent` run at once. Every container start is preceded by a fresh authorize(): the decision taken when
// the job was queued is never reused. What happens after a container exits (fetch /out, ingest) is the `finish`
// hook (job.ts); this file owns the lifecycle: queue → re-check → create → start → wait/timeout/cancel → clean up.
import { compileScope, scopeModeFor } from '@redwhale/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs, nodes, runnerState } from '../db/schema';
import { authorize } from '../scope/authorize';
import { currentScope } from '../scope/store';
import type { GroupDef, ToolDef } from './defs';
import { toolsNetwork } from './network';
import type { ContainerRuntime, ContainerSpec, NetworkSpec, RuntimePing } from './runtime';
import { LABEL_JOB, LABEL_WORKSPACE, containerSpec } from './spec';

export type JobRow = typeof jobs.$inferSelect;

export const DEFAULT_MAX_CONCURRENT = 2;
export const RESTART_ERROR = 'server restarted while the job was running';

/** The tools and groups the server knows, and which image runs a group's tools. */
export interface ToolCatalog {
  tool(name: string): ToolDef | undefined;
  group(name: string): GroupDef | undefined;
  /** The image reference a group's containers run (repo:tag of the current build). */
  imageRef(group: string): string;
}

export interface ExitInfo {
  job: JobRow;
  def: ToolDef;
  containerId: string;
  exitCode: number;
  timedOut: boolean;
}

/** What the finish hook decides about a job whose container exited (not cancelled). */
export interface FinishResult {
  status: 'succeeded' | 'failed';
  error?: string | null;
  issues?: string[] | null;
  scanId?: string | null;
  nodesCreated?: number | null;
  nodesUpdated?: number | null;
}

export type FinishHook = (runtime: ContainerRuntime, info: ExitInfo) => Promise<FinishResult>;

/** Without ingest: the exit code decides. */
export const exitCodeOnly: FinishHook = (_runtime, { exitCode }) =>
  Promise.resolve(exitCode === 0 ? { status: 'succeeded' } : { status: 'failed', error: `exited with code ${String(exitCode)}` });

export interface OrchestratorOptions {
  db: Db;
  runtime: ContainerRuntime;
  catalog: ToolCatalog;
  maxConcurrent?: number;
  /** The network every job joins (default: the tools network, subnet from REDWHALE_NET_SUBNET). */
  network?: NetworkSpec;
  finish?: FinishHook;
  /** Every change to a job (for the job.updated WS event). */
  onJob?: (job: JobRow) => void;
  /** Docker became reachable or unreachable. */
  onRunnerChange?: (ping: RuntimePing) => void;
  /** The hard kill, per tool. Tests shorten it. */
  timeoutMs?: (def: ToolDef) => number;
  now?: () => Date;
}

export type EnqueueError =
  | { ok: false; code: 'unknown-tool' | 'unknown-group' | 'unknown-node' | 'wrong-type'; error: string }
  | { ok: false; code: 'refused'; error: string; jobs: JobRow[] };

export type EnqueueResult = { ok: true; jobs: JobRow[] } | EnqueueError;

export type CancelResult = { ok: true; job: JobRow } | { ok: false; code: 'unknown' | 'finished'; error: string };

interface Active {
  containerId: string | null;
  cancelled: boolean;
  done: Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Orchestrator {
  readonly db: Db;
  readonly runtime: ContainerRuntime;
  readonly catalog: ToolCatalog;
  readonly maxConcurrent: number;
  readonly workspaceId: string;
  readonly network: NetworkSpec;
  private readonly finish: FinishHook;
  private readonly onJob: (job: JobRow) => void;
  private readonly onRunnerChange: (ping: RuntimePing) => void;
  private readonly timeoutMs: (def: ToolDef) => number;
  private readonly now: () => Date;
  private readonly active = new Map<number, Active>();
  private lastPing: RuntimePing | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: OrchestratorOptions) {
    this.db = options.db;
    this.runtime = options.runtime;
    this.catalog = options.catalog;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.network = options.network ?? toolsNetwork();
    this.finish = options.finish ?? exitCodeOnly;
    this.onJob = options.onJob ?? (() => undefined);
    this.onRunnerChange = options.onRunnerChange ?? (() => undefined);
    this.timeoutMs = options.timeoutMs ?? ((def) => def.timeoutSec * 1000);
    this.now = options.now ?? (() => new Date());
    const state = this.db.select().from(runnerState).where(eq(runnerState.id, 1)).get();
    if (!state) throw new Error('runner_state row is missing (migration 0004_jobs)');
    this.workspaceId = state.workspaceId;
  }

  // --- reading ---------------------------------------------------------------------------------------

  get(id: number): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  /** The last Docker ping (null before the first). */
  get runner(): RuntimePing | null {
    return this.lastPing;
  }

  counts(): { running: number; queued: number } {
    const rows = this.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(inArray(jobs.status, ['running', 'queued']))
      .all();
    return {
      running: rows.filter((r) => r.status === 'running').length,
      queued: rows.filter((r) => r.status === 'queued').length,
    };
  }

  private update(id: number, patch: Partial<JobRow>): JobRow {
    const [row] = this.db.update(jobs).set(patch).where(eq(jobs.id, id)).returning().all();
    if (!row) throw new Error(`job ${String(id)} vanished`);
    this.onJob(row);
    return row;
  }

  // --- queueing --------------------------------------------------------------------------------------

  /** Queues one tool against one node. authorize() decides (and logs) now; it decides again before the start. */
  enqueue(toolName: string, nodeId: string): EnqueueResult {
    const def = this.catalog.tool(toolName);
    if (!def) return { ok: false, code: 'unknown-tool', error: `unknown tool '${toolName}'` };
    return this.enqueueTools([def], nodeId);
  }

  /** Queues every tool of a group that accepts the node's type, one job each (each with its own decision). */
  enqueueGroup(groupName: string, nodeId: string): EnqueueResult {
    const group = this.catalog.group(groupName);
    if (!group) return { ok: false, code: 'unknown-group', error: `unknown tool group '${groupName}'` };
    const defs = group.tools.flatMap((name) => this.catalog.tool(name) ?? []);
    return this.enqueueTools(defs, nodeId);
  }

  private enqueueTools(defs: readonly ToolDef[], nodeId: string): EnqueueResult {
    const node = this.db.select({ id: nodes.id, type: nodes.type, value: nodes.value }).from(nodes).where(eq(nodes.id, nodeId)).get();
    if (!node) return { ok: false, code: 'unknown-node', error: `unknown node '${nodeId}'` };
    const fitting = defs.filter((d) => (d.accepts as readonly string[]).includes(node.type));
    if (fitting.length === 0) {
      const names = defs.map((d) => d.name).join(', ');
      return { ok: false, code: 'wrong-type', error: `${names} can't be run against a ${node.type}` };
    }

    const created: JobRow[] = [];
    for (const def of fitting) {
      const decision = authorize(this.db, { type: node.type, value: node.value }, scopeModeFor(def.mode));
      const row = this.db
        .insert(jobs)
        .values({
          tool: def.name,
          toolGroup: def.group,
          nodeId: node.id,
          targetType: node.type,
          targetValue: node.value,
          mode: def.mode,
          status: decision.ok ? 'queued' : 'refused',
          queuedScopeLogId: decision.ok ? decision.target.logId : decision.logId,
          timeoutSec: def.timeoutSec,
          createdAt: this.now().toISOString(),
          ...(decision.ok ? {} : { error: `out of scope: ${decision.reason}`, finishedAt: this.now().toISOString() }),
        })
        .returning()
        .get();
      this.onJob(row);
      created.push(row);
    }
    this.pump();
    if (created.every((j) => j.status === 'refused')) {
      return { ok: false, code: 'refused', error: created[0]?.error ?? 'out of scope', jobs: created };
    }
    return { ok: true, jobs: created };
  }

  // --- cancelling ------------------------------------------------------------------------------------

  cancel(id: number): CancelResult {
    const job = this.get(id);
    if (!job) return { ok: false, code: 'unknown', error: `unknown job ${String(id)}` };
    if (job.status === 'queued') {
      return { ok: true, job: this.update(id, { status: 'cancelled', error: 'cancelled before it started', finishedAt: this.now().toISOString() }) };
    }
    const active = this.active.get(id);
    if (job.status === 'running' && active) {
      active.cancelled = true;
      if (active.containerId !== null) void this.runtime.kill(active.containerId).catch(() => undefined);
      return { ok: true, job };
    }
    return { ok: false, code: 'finished', error: `job ${String(id)} is already ${job.status}` };
  }

  /**
   * Cancels these jobs and waits until each running one has really stopped (container killed, row final), at most
   * `timeoutMs`. Used by "Cancel job and delete": nothing a cancelled run produced is ingested.
   */
  async cancelAndWait(ids: readonly number[], timeoutMs = 30_000): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      this.cancel(id);
      const active = this.active.get(id);
      if (active) waits.push(active.done);
    }
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(waits).then(() => undefined), timeout]);
    clearTimeout(timer);
  }

  /**
   * After any scope change: queued jobs whose target is now out of scope are cancelled. Not logged (nothing runs
   * on it); a job that stays queued gets a fresh, logged authorize() at its start anyway.
   */
  onScopeChanged(): JobRow[] {
    const queued = this.db.select().from(jobs).where(eq(jobs.status, 'queued')).all();
    if (queued.length === 0) return [];
    const scope = compileScope(currentScope(this.db));
    const cancelled: JobRow[] = [];
    for (const job of queued) {
      const result = scope.check(job.targetType, job.targetValue, scopeModeFor(job.mode));
      if (result.decision === 'in') continue;
      cancelled.push(
        this.update(job.id, { status: 'cancelled', error: `scope changed: ${result.reason}`, finishedAt: this.now().toISOString() }),
      );
    }
    return cancelled;
  }

  // --- running ---------------------------------------------------------------------------------------

  /** Starts queued jobs, oldest first, while there is room and Docker is reachable. */
  pump(): void {
    if (this.stopped || this.lastPing?.ok === false) return;
    while (this.active.size < this.maxConcurrent) {
      const busy = [...this.active.keys()];
      const next = this.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, 'queued'))
        .orderBy(asc(jobs.id))
        .all()
        .find((j) => !busy.includes(j.id));
      if (!next) return;
      this.startJob(next);
    }
  }

  /** The synchronous part: re-authorize and build the container spec, or refuse/fail the job right here. */
  private startJob(job: JobRow): void {
    const now = () => this.now().toISOString();
    const def = this.catalog.tool(job.tool);
    if (!def) {
      this.update(job.id, { status: 'failed', error: `tool '${job.tool}' is no longer defined`, finishedAt: now() });
      return;
    }
    // Right before the start, never earlier: the scope may have changed since the job was queued.
    const decision = authorize(this.db, { type: job.targetType, value: job.targetValue }, scopeModeFor(def.mode));
    if (!decision.ok) {
      this.update(job.id, {
        status: 'refused',
        scopeLogId: decision.logId,
        error: `out of scope at start: ${decision.reason}`,
        finishedAt: now(),
      });
      return;
    }
    let spec: ContainerSpec;
    const image = this.catalog.imageRef(def.group);
    try {
      spec = containerSpec({ def, target: decision.target, image, jobId: String(job.id), workspaceId: this.workspaceId });
    } catch (e) {
      this.update(job.id, { status: 'failed', scopeLogId: decision.target.logId, error: message(e), finishedAt: now() });
      return;
    }
    const running = this.update(job.id, {
      status: 'running',
      scopeLogId: decision.target.logId,
      argv: [...spec.body.Entrypoint, ...spec.body.Cmd],
      image,
      startedAt: now(),
    });
    const active: Active = { containerId: null, cancelled: false, done: Promise.resolve() };
    this.active.set(job.id, active);
    active.done = this.execute(running, def, spec, active);
  }

  /** The asynchronous part: the container's whole life. Always ends with the job finished and the container gone. */
  private async execute(job: JobRow, def: ToolDef, spec: ContainerSpec, active: Active): Promise<void> {
    let outcome: FinishResult | { status: 'cancelled'; error: string };
    let exitCode: number | null = null;
    // cancel() flips it while we wait; a function so the compiler doesn't assume it stays false.
    const cancelled = () => active.cancelled;
    try {
      // Every job joins the tools network; it's created on first use (and after someone removed it).
      await this.runtime.ensureNetwork(this.network);
      const containerId = await this.runtime.create(spec);
      active.containerId = containerId;
      this.update(job.id, { containerId });
      if (cancelled()) {
        outcome = { status: 'cancelled', error: 'cancelled by the analyst' };
      } else {
        await this.runtime.start(containerId);
        const clock = { timedOut: false };
        const timer = setTimeout(() => {
          clock.timedOut = true;
          void this.runtime.kill(containerId).catch(() => undefined);
        }, this.timeoutMs(def));
        try {
          exitCode = (await this.runtime.wait(containerId)).exitCode;
        } finally {
          clearTimeout(timer);
        }
        if (cancelled()) {
          outcome = { status: 'cancelled', error: 'cancelled by the analyst' };
        } else {
          const { timedOut } = clock;
          const finished = await this.finish(this.runtime, { job, def, containerId, exitCode, timedOut });
          outcome = timedOut
            ? {
                ...finished,
                status: 'failed',
                error: [`timed out after ${String(def.timeoutSec)} s; the container was killed`, finished.error]
                  .filter(Boolean)
                  .join('; '),
              }
            : finished;
        }
      }
    } catch (e) {
      outcome = { status: 'failed', error: message(e) };
    }
    // Stopped (shutting down): leave the row `running` and the container alone; the next start's recover() fails the
    // job and removes what's left, exactly as after a crash.
    if (this.stopped) return;
    // Whatever happened: the container and its volume go (the orphan cleanup catches what fails here).
    if (active.containerId !== null) await this.runtime.removeContainer(active.containerId).catch(() => undefined);
    await this.runtime.removeVolume(spec.volume.Name).catch(() => undefined);
    this.active.delete(job.id);
    const { status, ...rest } = outcome;
    try {
      this.update(job.id, { ...rest, status, exitCode, finishedAt: this.now().toISOString() });
    } catch {
      // The row is gone (the mock wiped the workspace meanwhile): nothing left to record.
    }
    this.pump();
  }

  /** Resolves when nothing is running (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.active.size > 0 && !this.stopped) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  // --- restarts, orphans, Docker coming and going ------------------------------------------------------

  /**
   * On server start: jobs left `running` by the last process fail, this workspace's labeled containers and volumes
   * are killed and removed, and the queue resumes (each job is re-authorized when it starts).
   */
  async recover(): Promise<void> {
    const stale = this.db.select().from(jobs).where(eq(jobs.status, 'running')).all();
    for (const job of stale) {
      this.update(job.id, { status: 'failed', error: RESTART_ERROR, finishedAt: this.now().toISOString() });
    }
    await this.checkRunner();
  }

  /** Kills and removes this workspace's containers and volumes that no job of this process is using. */
  async cleanupOrphans(): Promise<{ containers: number; volumes: number }> {
    const found = await this.runtime.listByLabel(LABEL_WORKSPACE, this.workspaceId);
    const ours = (labels: Record<string, string>) => this.active.has(Number(labels[LABEL_JOB]));
    let containers = 0;
    for (const c of found.containers) {
      if (ours(c.labels)) continue;
      await this.runtime.kill(c.id).catch(() => undefined);
      await this.runtime.removeContainer(c.id).catch(() => undefined);
      containers += 1;
    }
    let volumes = 0;
    for (const v of found.volumes) {
      if (ours(v.labels)) continue;
      await this.runtime.removeVolume(v.name).catch(() => undefined);
      volumes += 1;
    }
    return { containers, volumes };
  }

  /** Pings Docker. On a change it reports it; coming back (or the first ping) cleans up orphans and resumes the queue. */
  async checkRunner(): Promise<RuntimePing> {
    const ping = await this.runtime.ping();
    const before = this.lastPing;
    this.lastPing = ping;
    const changed = before === null || before.ok !== ping.ok;
    if (changed) this.onRunnerChange(ping);
    if (ping.ok && (before === null || !before.ok)) {
      await this.cleanupOrphans().catch(() => undefined);
      this.pump();
    }
    return ping;
  }

  startMonitor(intervalMs = 5000): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => void this.checkRunner().catch(() => undefined), intervalMs);
    this.monitor.unref();
  }

  /**
   * Stops the monitor, starting jobs and recording them: running containers are left as they are, and the next
   * start's recover() fails those jobs and removes the containers (the same path as after a crash).
   */
  stop(): void {
    this.stopped = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  /** Jobs that are queued or running, oldest first (for status). */
  pending(): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']))
      .orderBy(asc(jobs.id))
      .all();
  }
}
