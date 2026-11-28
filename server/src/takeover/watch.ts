// The Takeover watch (TW-2, docs/architecture.md §11): one row per subdomain, built on read from the graph (nothing
// stored). Everything a row says comes from that subdomain's latest takeover-check scan, read through the per-scan
// provenance (observations, edge_observations): an older chain or an older registration never leaks into it.
import {
  TAKEOVER_EXPIRING_DAYS,
  TAKEOVER_TOOL,
  TAKEOVER_STATUSES,
  compileScope,
  normalize,
  type ScanStatus,
  type Severity,
  type TakeoverRegistration,
  type TakeoverStatus,
  type TakeoverWatchResponse,
  type TakeoverWatchRow,
} from '@redwhale/shared';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { edgeObservations, edges, jobs, nodes, observations, scans } from '../db/schema';
import { isExternal, takeoverOnlyNodeIds } from '../graph/store';
import { currentScope } from '../scope/store';

export { TAKEOVER_TOOL };

const DAY_MS = 86_400_000;
/** SQLite's bound-parameter limit is far above this; chunks keep each IN list modest. */
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function daysLeft(expiresAt: string | null, now: Date): number | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : Math.floor((at - now.getTime()) / DAY_MS);
}

const isExpiring = (r: TakeoverRegistration) =>
  r.registered === true && r.daysLeft !== null && r.daysLeft < TAKEOVER_EXPIRING_DAYS;

/** Lower is riskier: not registered, expiring (soonest first), unknown, fine (soonest expiry first). */
function riskRank(r: TakeoverRegistration): number {
  if (r.registered === false) return 0;
  if (isExpiring(r)) return 1;
  if (r.registered === null) return 2;
  return 3;
}

function byRisk(a: TakeoverRegistration, b: TakeoverRegistration): number {
  return (
    riskRank(a) - riskRank(b) ||
    (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
    a.domain.localeCompare(b.domain)
  );
}

export interface LatestScan {
  id: string;
  status: ScanStatus;
  finishedAt: string;
  ingestedAt: string;
}

interface ScanFacts {
  /** nodeId → value, for every node the scan observed. */
  values: Map<string, string>;
  /** nodeId → that observation's data. */
  data: Map<string, Record<string, unknown>>;
  /** cname_to edges the scan reported: source → target. */
  cname: Map<string, string>;
  registrations: Omit<TakeoverRegistration, 'daysLeft'>[];
  vulnerabilities: { nodeId: string; label: string; severity: Severity | null }[];
}

/** The latest takeover-check scan per (normalized) target. */
export function latestScans(db: Db): Map<string, LatestScan> {
  const rows = db
    .select({ id: scans.id, target: scans.target, status: scans.status, finishedAt: scans.finishedAt, ingestedAt: scans.ingestedAt })
    .from(scans)
    .where(eq(scans.tool, TAKEOVER_TOOL))
    .all();
  const latest = new Map<string, LatestScan>();
  for (const { target, ...scan } of rows) {
    let key: string;
    try {
      key = normalize('subdomain', target);
    } catch {
      continue; // Not a hostname: nothing in the watch can be its subdomain.
    }
    const prev = latest.get(key);
    if (!prev || scan.finishedAt > prev.finishedAt || (scan.finishedAt === prev.finishedAt && scan.ingestedAt > prev.ingestedAt)) {
      latest.set(key, scan);
    }
  }
  return latest;
}

function scanFacts(db: Db, scanIds: readonly string[]): Map<string, ScanFacts> {
  const facts = new Map<string, ScanFacts>();
  const get = (id: string): ScanFacts => {
    let f = facts.get(id);
    if (!f) {
      f = { values: new Map(), data: new Map(), cname: new Map(), registrations: [], vulnerabilities: [] };
      facts.set(id, f);
    }
    return f;
  };
  for (const ids of chunks(scanIds)) {
    const obs = db
      .select({
        scanId: observations.scanId,
        role: observations.role,
        severity: observations.severity,
        data: observations.data,
        nodeId: nodes.id,
        type: nodes.type,
        value: nodes.value,
        label: nodes.label,
        tag: nodes.tag,
      })
      .from(observations)
      .innerJoin(nodes, eq(nodes.id, observations.nodeId))
      .where(inArray(observations.scanId, ids))
      .orderBy(asc(nodes.value))
      .all();
    for (const o of obs) {
      const f = get(o.scanId);
      f.values.set(o.nodeId, o.value);
      f.data.set(o.nodeId, o.data);
      if (o.role !== 'finding') continue;
      if (o.type === 'domain' && 'registered' in o.data) {
        const r = o.data.registered;
        f.registrations.push({
          nodeId: o.nodeId,
          domain: o.value,
          registered: typeof r === 'boolean' ? r : null,
          expiresAt: str(o.data.expires_at),
          source: str(o.data.source),
          reason: str(o.data.reason),
        });
      }
      if (o.type === 'vulnerability' && o.tag !== 'ignored') {
        f.vulnerabilities.push({ nodeId: o.nodeId, label: o.label, severity: o.severity });
      }
    }
    const links = db
      .select({ scanId: edgeObservations.scanId, sourceId: edges.sourceId, targetId: edges.targetId })
      .from(edgeObservations)
      .innerJoin(edges, eq(edges.id, edgeObservations.edgeId))
      .where(and(inArray(edgeObservations.scanId, ids), eq(edges.relation, 'cname_to')))
      .all();
    for (const l of links) get(l.scanId).cname.set(l.sourceId, l.targetId);
  }
  return facts;
}

interface JobFacts {
  pending: boolean;
  /** The latest finished (succeeded or failed) job. */
  last: { id: number; status: string; error: string | null; finishedAt: string } | null;
}

function jobFacts(db: Db): Map<string, JobFacts> {
  const rows = db
    .select({ id: jobs.id, nodeId: jobs.nodeId, status: jobs.status, error: jobs.error, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(eq(jobs.tool, TAKEOVER_TOOL), isNotNull(jobs.nodeId)))
    .orderBy(asc(jobs.id))
    .all();
  const out = new Map<string, JobFacts>();
  for (const j of rows) {
    if (j.nodeId === null) continue;
    const f = out.get(j.nodeId) ?? { pending: false, last: null };
    if (j.status === 'queued' || j.status === 'running') f.pending = true;
    if ((j.status === 'succeeded' || j.status === 'failed') && j.finishedAt !== null) {
      f.last = { id: j.id, status: j.status, error: j.error, finishedAt: j.finishedAt };
    }
    out.set(j.nodeId, f);
  }
  return out;
}

/**
 * Every subdomain's row, in display order. External names (out of scope, known only from takeover-check: the third
 * parties of CNAME chains) are left out unless `showExternal`, like in the graph.
 */
export function takeoverWatchRows(db: Db, now: Date, { showExternal = false }: { showExternal?: boolean } = {}): TakeoverWatchRow[] {
  const all = db
    .select({ id: nodes.id, value: nodes.value })
    .from(nodes)
    .where(eq(nodes.type, 'subdomain'))
    .orderBy(asc(nodes.value))
    .all();
  const scope = compileScope(currentScope(db));
  const takeoverOnly = showExternal ? null : takeoverOnlyNodeIds(db);
  const decided = all.map((s) => ({ ...s, decision: scope.check('subdomain', s.value, 'passive').decision }));
  const subs = takeoverOnly
    ? decided.filter((s) => !isExternal({ id: s.id, inScope: s.decision }, takeoverOnly))
    : decided;
  const latest = latestScans(db);
  const facts = scanFacts(db, [...new Set(subs.flatMap((s) => latest.get(s.value)?.id ?? []))]);
  const jobsBy = jobFacts(db);

  const rows = subs.map((sub): TakeoverWatchRow => {
    const inScope = sub.decision === 'in';
    const scan = latest.get(sub.value) ?? null;
    const f = scan ? facts.get(scan.id) : undefined;
    const job = jobsBy.get(sub.id);
    const failed = job?.last?.status === 'failed' && (scan === null || job.last.finishedAt >= scan.ingestedAt) ? job.last : null;
    const base = {
      nodeId: sub.id,
      subdomain: sub.value,
      inScope,
      lastCheck: scan ? { scanId: scan.id, at: scan.finishedAt, status: scan.status } : null,
      lastFailure: failed ? { jobId: failed.id, at: failed.finishedAt, error: failed.error ?? 'failed' } : null,
      pending: job?.pending ?? false,
    };
    if (!scan) {
      return {
        ...base,
        status: inScope ? 'not-checked' : 'out-of-scope',
        chain: [],
        chainEnd: null,
        service: null,
        registration: null,
        registrations: [],
        vulnerabilities: [],
      };
    }

    // The chain as this scan reported it (a loop stops at the first repeat).
    const chain: string[] = [];
    const seen = new Set([sub.id]);
    let at = sub.id;
    for (let next = f?.cname.get(at); next !== undefined && !seen.has(next); next = f?.cname.get(at)) {
      seen.add(next);
      chain.push(f?.values.get(next) ?? next);
      at = next;
    }
    const registrations = (f?.registrations ?? []).map((r) => ({ ...r, daysLeft: daysLeft(r.expiresAt, now) })).sort(byRisk);
    const vulnerabilities = f?.vulnerabilities ?? [];

    let status: TakeoverStatus;
    if (vulnerabilities.length > 0) status = 'takeable';
    else if (registrations.some(isExpiring)) status = 'expiring';
    else if (scan.status !== 'success' || registrations.length === 0 || registrations.some((r) => r.registered === null)) {
      status = 'unknown';
    } else status = 'ok';

    return {
      ...base,
      status,
      chain,
      chainEnd: chain.at(-1) ?? sub.value,
      service: str(f?.data.get(at)?.service),
      registration: registrations[0] ?? null,
      registrations,
      vulnerabilities,
    };
  });

  const rank = (s: TakeoverStatus) => TAKEOVER_STATUSES.indexOf(s);
  // Within each status, the least time left first (the weakest link's days; rows without a date after), then by name.
  const days = (r: TakeoverWatchRow) => r.registration?.daysLeft ?? null;
  const byDays = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);
  return rows.sort(
    (a, b) => rank(a.status) - rank(b.status) || byDays(days(a), days(b)) || a.subdomain.localeCompare(b.subdomain),
  );
}

export function takeoverWatch(
  db: Db,
  { page, pageSize, now, showExternal = false }: { page: number; pageSize: number; now: Date; showExternal?: boolean },
): TakeoverWatchResponse {
  const rows = takeoverWatchRows(db, now, { showExternal });
  const counts = Object.fromEntries(TAKEOVER_STATUSES.map((s) => [s, 0])) as Record<TakeoverStatus, number>;
  for (const r of rows) counts[r.status] += 1;
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: rows.length,
    counts,
    now: now.toISOString(),
  };
}
