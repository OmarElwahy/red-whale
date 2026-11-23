// Automatic takeover checks (TW-2, docs/architecture.md §11). The scheduler queues the passive takeover-check on
// in-scope subdomains not checked in the last 24 h. It never runs anything itself: every job goes through
// Orchestrator.enqueue(), so authorize() decides (and logs) at queueing and again at the start, as for a manual run.
// Auto jobs never crowd out the analyst's: at most `maxQueued` are queued at once, and pump() starts manual jobs first.
import { FINISHED_JOB_STATUSES, compileScope, scopeModeFor, type WsEvent } from '@redwhale/shared';
import { and, count, eq, gte, inArray, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs, nodes } from '../db/schema';
import type { JobRow, Orchestrator } from '../runner/orchestrator';
import { currentScope, getSettings } from '../scope/store';
import { TAKEOVER_TOOL, latestScans } from './watch';

export const AUTO_MAX_QUEUED_ENV = 'REDWHALE_AUTO_MAX_QUEUED';
export const DEFAULT_AUTO_MAX_QUEUED = 10;
/** A subdomain is due again this long after its last check (or its last auto attempt, failed ones included). */
export const RECHECK_MS = 24 * 60 * 60 * 1000;
/** The error of queued auto jobs cancelled because the setting was turned off (they don't count as attempts). */
export const AUTO_OFF_ERROR = 'auto takeover checks were turned off';

/** REDWHALE_AUTO_MAX_QUEUED as a positive integer, or the default. */
export function autoMaxQueued(env: string | undefined): number {
  const n = Number(env ?? DEFAULT_AUTO_MAX_QUEUED);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_AUTO_MAX_QUEUED;
}

export interface SchedulerOptions {
  db: Db;
  orchestrator: Orchestrator;
  maxQueued?: number;
  /** How often the scheduler looks again by itself (default 24 h). */
  intervalMs?: number;
  now?: () => Date;
}

export interface DueSubdomain {
  id: string;
  value: string;
  /** Its latest takeover-check scan's finished_at (null: never checked). */
  lastCheck: string | null;
}

export class TakeoverScheduler {
  readonly maxQueued: number;
  private readonly db: Db;
  private readonly orchestrator: Orchestrator;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.orchestrator = options.orchestrator;
    this.maxQueued = Math.max(1, options.maxQueued ?? DEFAULT_AUTO_MAX_QUEUED);
    this.intervalMs = options.intervalMs ?? RECHECK_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** From here on, events and the timer lead to ticks; the first one runs now (server start). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      this.poke();
    }, this.intervalMs);
    this.timer.unref();
    this.poke();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Asks for a tick. Ticks never overlap: asked during one, exactly one more runs after it. */
  poke(): void {
    if (!this.started) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop();
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.tick();
      } catch {
        // Docker trouble and the like: the next event or the timer tries again.
      }
    } while (this.wantsAnother());
    this.running = null;
  }

  /** A poke arrived during the tick (a method: the compiler would assume `again` is still false). */
  private wantsAnother(): boolean {
    return this.again && this.started;
  }

  /** Resolves once no tick is running or asked for (tests). */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * What the app's events mean here: the graph changed (an ingest may have added subdomains), an auto job finished
   * (room to refill), Docker came back, or the scope or settings changed.
   */
  onEvent(event: WsEvent): void {
    switch (event.type) {
      case 'graph.updated':
      case 'scope.changed':
        this.poke();
        return;
      case 'job.updated':
        if (event.job.trigger === 'auto' && FINISHED_JOB_STATUSES.includes(event.job.status)) this.poke();
        return;
      case 'runner.status':
        if (event.reachable) this.poke();
        return;
      default:
        return;
    }
  }

  /** In-scope subdomains with no check, auto attempt or open job in the last 24 h: never checked first, then oldest. */
  due(): DueSubdomain[] {
    const def = this.orchestrator.catalog.tool(TAKEOVER_TOOL);
    if (!def) return [];
    const cutoff = new Date(this.now().getTime() - RECHECK_MS).toISOString();
    // Not logged: nothing runs on this answer; enqueue() asks authorize() for each job it queues.
    const scope = compileScope(currentScope(this.db));
    const mode = scopeModeFor(def.mode);
    const latest = latestScans(this.db);
    const blocked = new Set(
      this.db
        .select({ nodeId: jobs.nodeId, status: jobs.status, error: jobs.error })
        .from(jobs)
        .where(
          and(
            eq(jobs.tool, TAKEOVER_TOOL),
            isNotNull(jobs.nodeId),
            or(
              inArray(jobs.status, ['queued', 'running']),
              and(eq(jobs.trigger, 'auto'), gte(jobs.createdAt, cutoff)),
            ),
          ),
        )
        .all()
        // Auto jobs cancelled by turning the setting off weren't attempts: turning it back on queues them again.
        .filter((j) => !(j.status === 'cancelled' && j.error === AUTO_OFF_ERROR))
        .flatMap((j) => j.nodeId ?? []),
    );
    return this.db
      .select({ id: nodes.id, value: nodes.value })
      .from(nodes)
      .where(eq(nodes.type, 'subdomain'))
      .all()
      .map((n) => ({ ...n, lastCheck: latest.get(n.value)?.finishedAt ?? null }))
      .filter(
        (n) =>
          !blocked.has(n.id) &&
          (n.lastCheck === null || n.lastCheck < cutoff) &&
          scope.check('subdomain', n.value, mode).decision === 'in',
      )
      .sort(
        (a, b) =>
          (a.lastCheck === null ? 0 : 1) - (b.lastCheck === null ? 0 : 1) ||
          (a.lastCheck ?? '').localeCompare(b.lastCheck ?? '') ||
          a.value.localeCompare(b.value),
      );
  }

  /**
   * One round: with the setting on, Docker reachable and the takeover-check image built, queues due subdomains
   * until `maxQueued` auto jobs are queued. With the setting off, the queued auto jobs are cancelled instead.
   */
  async tick(): Promise<JobRow[]> {
    const orch = this.orchestrator;
    if (!getSettings(this.db).autoTakeoverChecks) {
      orch.cancelQueued('auto', AUTO_OFF_ERROR);
      return [];
    }
    const def = orch.catalog.tool(TAKEOVER_TOOL);
    if (!def) return [];
    // Like a manual run: no job row and no scope decision while Docker or the image isn't there.
    const ping = orch.runner ?? (await orch.checkRunner());
    if (!ping.ok) return [];
    if ((await orch.runtime.inspectImage(orch.catalog.imageRef(def.group))) === null) return [];
    if (!getSettings(this.db).autoTakeoverChecks) return []; // turned off while we waited

    const queued =
      this.db
        .select({ n: count() })
        .from(jobs)
        .where(and(eq(jobs.status, 'queued'), eq(jobs.trigger, 'auto')))
        .get()?.n ?? 0;
    const room = this.maxQueued - queued;
    if (room <= 0) return [];
    const created: JobRow[] = [];
    for (const sub of this.due().slice(0, room)) {
      const result = orch.enqueue(TAKEOVER_TOOL, sub.id, { trigger: 'auto' });
      if (result.ok || result.code === 'refused') created.push(...result.jobs);
    }
    return created;
  }
}

