// /api/tools, /api/jobs, /api/runner (docs/architecture.md §6, §11). Every run goes through the orchestrator,
// which calls authorize() when the job is queued and again right before its container starts.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIRM_REQUIRED,
  JOB_OUTPUT_STREAMS,
  groupJobCreateSchema,
  jobCreateSchema,
  jobsQuerySchema,
  type ImageStatus,
  type JobConfirmRequiredResponse,
  type Job,
  type RunnerStatus,
  type ToolInfo,
} from '@redwhale/shared';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { jobs, nodes, scopeLog } from '../db/schema';
import { HttpError, notFound, parseInput } from '../http';
import { imageStatus, type Catalog } from '../runner/catalog';
import type { ToolDef } from '../runner/defs';
import { OUTPUT_STREAMS, jobDir } from '../runner/finish';
import type { EnqueueResult, JobRow, Orchestrator } from '../runner/orchestrator';
import type { RouteContext } from './context';

/** How much of each output GET /jobs/:id returns. */
export const TAIL_BYTES = 4096;

export function jobDto(row: JobRow): Job {
  return {
    id: row.id,
    tool: row.tool,
    group: row.toolGroup,
    nodeId: row.nodeId,
    targetType: row.targetType,
    targetValue: row.targetValue,
    mode: row.mode,
    status: row.status,
    queuedScopeLogId: row.queuedScopeLogId,
    scopeLogId: row.scopeLogId,
    argv: row.argv,
    image: row.image,
    timeoutSec: row.timeoutSec,
    exitCode: row.exitCode,
    error: row.error,
    issues: row.issues,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    scanId: row.scanId,
    nodesCreated: row.nodesCreated,
    nodesUpdated: row.nodesUpdated,
  };
}

export function toolDto(def: ToolDef): ToolInfo {
  return {
    name: def.name,
    group: def.group,
    label: def.label,
    description: def.description ?? null,
    mode: def.mode,
    accepts: def.accepts,
    external: def.external,
    contacts: def.contacts ?? null,
    timeoutSec: def.timeoutSec,
  };
}

/** The last `bytes` of a file, marked if cut; null if there is no file. */
function tail(path: string, bytes = TAIL_BYTES): string | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size <= bytes) return readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, size - bytes);
    return `…${buf.toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

const idParams = z.strictObject({ id: z.coerce.number().int().min(1) });
const outputParams = idParams.extend({ stream: z.enum(JOB_OUTPUT_STREAMS) });

export interface RunnerContext {
  orchestrator: Orchestrator;
  catalog: Catalog;
  jobsDir: string;
}

export function jobRoutes({ app, db }: RouteContext, runner: RunnerContext | null): void {
  const need = (): RunnerContext => {
    if (!runner) throw new HttpError(503, 'the tool runner is not enabled on this server');
    return runner;
  };

  async function imageStatuses(r: RunnerContext): Promise<Map<string, ImageStatus>> {
    const reachable = r.orchestrator.runner?.ok ?? (await r.orchestrator.checkRunner()).ok;
    const entries = await Promise.all(
      r.catalog.groups.map(async (g) => [g.def.name, reachable ? await imageStatus(r.orchestrator.runtime, g) : 'unknown'] as const),
    );
    return new Map(entries);
  }

  app.get('/api/tools', async () => {
    const r = need();
    const statuses = await imageStatuses(r);
    return {
      groups: r.catalog.groups.map((g) => ({
        name: g.def.name,
        label: g.def.label,
        image: g.imageRef,
        imageStatus: statuses.get(g.def.name) ?? 'unknown',
        tools: g.tools.map((t) => t.name),
      })),
      tools: r.catalog.tools().map(toolDto),
    };
  });

  app.get('/api/runner/status', async (): Promise<RunnerStatus> => {
    const r = need();
    const ping = await r.orchestrator.checkRunner();
    const statuses = await imageStatuses(r);
    return {
      docker: ping.ok ? { reachable: true, version: ping.version, error: null } : { reachable: false, version: null, error: ping.error },
      images: r.catalog.groups.map((g) => ({ group: g.def.name, image: g.imageRef, status: statuses.get(g.def.name) ?? 'unknown' })),
      ...r.orchestrator.counts(),
      maxConcurrent: r.orchestrator.maxConcurrent,
    };
  });

  /** Before anything is queued (or a scope decision logged): the tool, the node, Docker and the image must be there. */
  async function preflight(r: RunnerContext, defs: ToolDef[], nodeId: string): Promise<void> {
    const node = db.select({ type: nodes.type }).from(nodes).where(eq(nodes.id, nodeId)).get();
    if (!node) throw notFound(`node ${nodeId}`);
    if (!defs.some((d) => (d.accepts as readonly string[]).includes(node.type))) {
      throw new HttpError(400, `${defs.map((d) => d.name).join(', ')} can't be run against a ${node.type}`);
    }
    const ping = await r.orchestrator.checkRunner();
    if (!ping.ok) throw new HttpError(503, ping.error);
    for (const group of new Set(defs.map((d) => d.group))) {
      const info = r.catalog.info(group);
      if (!info) throw new HttpError(500, `tool group '${group}' is not loaded`);
      const status = await imageStatus(r.orchestrator.runtime, info);
      if (status !== 'built') {
        const why = status === 'outdated' ? 'is out of date (the scripts changed since it was built)' : 'is not built';
        throw new HttpError(409, `the image for '${group}' ${why}: run pnpm tools:build ${group}`);
      }
    }
  }

  function respond(reply: FastifyReply, result: EnqueueResult) {
    if (result.ok) return reply.code(201).send({ jobs: result.jobs.map(jobDto) });
    if (result.code === 'refused') {
      const logId = result.jobs[0]?.queuedScopeLogId ?? -1;
      const decision = db.select({ decision: scopeLog.decision }).from(scopeLog).where(eq(scopeLog.id, logId)).get()?.decision ?? 'out';
      return reply.code(403).send({ error: result.error, decision, jobs: result.jobs.map(jobDto) });
    }
    if (result.code === 'confirm-required') {
      const answer: JobConfirmRequiredResponse = { error: result.error, reason: CONFIRM_REQUIRED };
      return reply.code(428).send(answer);
    }
    const status = result.code === 'wrong-type' ? 400 : 404;
    throw new HttpError(status, result.error);
  }

  app.post('/api/jobs', async (req, reply) => {
    const r = need();
    const body = parseInput(jobCreateSchema, req.body);
    const def = r.catalog.tool(body.tool);
    if (!def) throw notFound(`tool '${body.tool}'`);
    await preflight(r, [def], body.nodeId);
    return respond(reply, r.orchestrator.enqueue(body.tool, body.nodeId, { confirmActive: body.confirmActive }));
  });

  app.post('/api/jobs/group', async (req, reply) => {
    const r = need();
    const body = parseInput(groupJobCreateSchema, req.body);
    const info = r.catalog.info(body.group);
    if (!info) throw notFound(`tool group '${body.group}'`);
    await preflight(r, info.tools, body.nodeId);
    return respond(reply, r.orchestrator.enqueueGroup(body.group, body.nodeId, { confirmActive: body.confirmActive }));
  });

  app.get('/api/jobs', (req) => {
    need();
    const q = parseInput(jobsQuerySchema, req.query);
    const where: SQL[] = [];
    if (q.status) where.push(inArray(jobs.status, q.status));
    if (q.nodeId) where.push(eq(jobs.nodeId, q.nodeId));
    const filter = where.length > 0 ? and(...where) : undefined;
    const total = db.select({ n: count() }).from(jobs).where(filter).get()?.n ?? 0;
    const rows = db
      .select()
      .from(jobs)
      .where(filter)
      .orderBy(desc(jobs.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .all();
    return { items: rows.map(jobDto), page: q.page, pageSize: q.pageSize, total };
  });

  app.get('/api/jobs/:id', (req) => {
    const r = need();
    const { id } = parseInput(idParams, req.params);
    const row = r.orchestrator.get(id);
    if (!row) throw notFound(`job ${String(id)}`);
    const dir = jobDir(r.jobsDir, id);
    return {
      job: jobDto(row),
      tails: {
        stdout: tail(join(dir, OUTPUT_STREAMS.stdout)),
        stderr: tail(join(dir, OUTPUT_STREAMS.stderr)),
        raw: tail(join(dir, OUTPUT_STREAMS.raw)),
      },
    };
  });

  app.get('/api/jobs/:id/output/:stream', (req, reply) => {
    const r = need();
    const { id, stream } = parseInput(outputParams, req.params);
    if (!r.orchestrator.get(id)) throw notFound(`job ${String(id)}`);
    const path = join(jobDir(r.jobsDir, id), OUTPUT_STREAMS[stream]);
    if (!existsSync(path)) throw notFound(`${stream} output of job ${String(id)}`);
    return reply
      .type('text/plain; charset=utf-8')
      .header('content-disposition', `inline; filename="job-${String(id)}-${stream}.txt"`)
      .header('x-content-type-options', 'nosniff')
      .send(readFileSync(path));
  });

  app.post('/api/jobs/:id/cancel', (req) => {
    const r = need();
    const { id } = parseInput(idParams, req.params);
    const result = r.orchestrator.cancel(id);
    if (result.ok) return { job: jobDto(result.job) };
    throw new HttpError(result.code === 'unknown' ? 404 : 409, result.error);
  });
}
