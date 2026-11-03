// Tool runs (docs/architecture.md §11): the tools, the runner's status, the jobs, and starting/cancelling runs.
// Every run is decided by the server (authorize() at queueing and again right before the container starts); what
// the UI shows as disabled is only advice.
import {
  jobConfirmRequiredResponseSchema,
  jobDetailResponseSchema,
  jobRefusedResponseSchema,
  jobsCreatedResponseSchema,
  jobsResponseSchema,
  runnerStatusSchema,
  toolsResponseSchema,
  type Job,
  type JobDetailResponse,
  type JobsResponse,
  type RunnerStatus,
  type ToolsResponse,
} from '@redwhale/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, getJson, sendJson, type Fetch } from './client';
import { queryKeys } from './query';

export const JOBS_PANEL_SIZE = 25;
/** The header and the run menu re-ask this often (Docker going away is also pushed as runner.status). */
const RUNNER_POLL_MS = 15_000;

export function useTools(): UseQueryResult<ToolsResponse> {
  return useQuery({
    queryKey: queryKeys.tools,
    queryFn: ({ signal }) => getJson('/api/tools', toolsResponseSchema, { signal }),
    retry: false,
  });
}

export function useRunnerStatus(): UseQueryResult<RunnerStatus> {
  return useQuery({
    queryKey: queryKeys.runnerStatus,
    queryFn: ({ signal }) => getJson('/api/runner/status', runnerStatusSchema, { signal }),
    refetchInterval: RUNNER_POLL_MS,
    retry: false,
  });
}

export function useJobs(page: number): UseQueryResult<JobsResponse> {
  return useQuery({
    queryKey: queryKeys.jobs(page),
    queryFn: ({ signal }) =>
      getJson(`/api/jobs?${new URLSearchParams({ page: String(page), pageSize: String(JOBS_PANEL_SIZE) }).toString()}`, jobsResponseSchema, {
        signal,
      }),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useJob(id: number | null): UseQueryResult<JobDetailResponse> {
  return useQuery({
    queryKey: queryKeys.job(id ?? -1),
    queryFn: ({ signal }) => getJson(`/api/jobs/${String(id)}`, jobDetailResponseSchema, { signal }),
    enabled: id !== null,
  });
}

/** A run the server refused (403): the scope reason, and the refused jobs it kept. */
export class RunRefused extends Error {
  constructor(
    message: string,
    readonly jobs: Job[],
  ) {
    super(message);
    this.name = 'RunRefused';
  }
}

/** The server wants the analyst's confirmation first (428): the run contacts the target. Nothing was stored. */
export class ConfirmRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmRequired';
  }
}

/** `confirmActive`: the analyst confirmed it in the active-run dialog (needed for any tool that isn't passive). */
export type RunRequest = ({ kind: 'tool'; tool: string; nodeId: string } | { kind: 'group'; group: string; nodeId: string }) & {
  confirmActive?: boolean;
};

/**
 * POST /api/jobs or /api/jobs/group. A 403 becomes RunRefused (with the reason), a 428 ConfirmRequired; other errors
 * stay ApiError.
 */
export async function startRun(req: RunRequest, options: { fetch?: Fetch } = {}): Promise<Job[]> {
  const doFetch = options.fetch ?? fetch;
  const confirm = req.confirmActive === true ? { confirmActive: true } : {};
  const [path, payload] =
    req.kind === 'tool'
      ? ['/api/jobs', { tool: req.tool, nodeId: req.nodeId, ...confirm }]
      : ['/api/jobs/group', { group: req.group, nodeId: req.nodeId, ...confirm }];
  const res = await doFetch(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 403) {
    const refused = jobRefusedResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (refused.success) throw new RunRefused(refused.data.error, refused.data.jobs);
  }
  if (res.status === 428) {
    const needed = jobConfirmRequiredResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (needed.success) throw new ConfirmRequired(needed.data.error);
  }
  if (!res.ok) {
    const body = z.object({ error: z.string() }).safeParse(await res.json().catch(() => undefined));
    throw new ApiError(res.status, body.success ? body.data.error : `${String(res.status)} ${res.statusText}`.trim());
  }
  return jobsCreatedResponseSchema.parse(await res.json()).jobs;
}

export function useStartRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (req: RunRequest) => startRun(req),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.runner }),
  });
}

export function useCancelJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => sendJson('POST', `/api/jobs/${String(id)}/cancel`, {}, jobDetailResponseSchema.pick({ job: true })),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.runner }),
  });
}

/** Where a job's full raw output is (opened in a new tab: plain text, capped at 5 MB). */
export function outputUrl(jobId: number, stream: 'stdout' | 'stderr' | 'raw'): string {
  return `/api/jobs/${String(jobId)}/output/${stream}`;
}
