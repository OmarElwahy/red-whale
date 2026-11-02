// The Jobs tab (docs/architecture.md §8, §11): every tool run, newest first, live over job.updated. Each row says
// what the run found ("+14 new, 6 updated"), can be cancelled while queued or running, opens its raw output, and
// jumps to the result (the target node, with that scan's provenance rows highlighted).
import type { Job, JobStatus } from '@redwhale/shared';
import { useEffect, useState } from 'react';
import { JOBS_PANEL_SIZE, outputUrl, useCancelJob, useJob, useJobs } from '@/api/runner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatTime } from '@/panel/format';

const STATUS_STYLE: Record<JobStatus, string> = {
  queued: 'bg-secondary text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  succeeded: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
  cancelled: 'bg-secondary text-muted-foreground',
  refused: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

/** 75 s → "1m 15s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

/** How long it ran (or has been running), or null if it never started. */
export function jobDuration(job: Job, now: number): string | null {
  if (job.startedAt === null) return null;
  const end = job.finishedAt === null ? now : Date.parse(job.finishedAt);
  return formatDuration(end - Date.parse(job.startedAt));
}

/** "+14 new, 6 updated", "nothing new", or null before a result was ingested. */
export function jobFindings(job: Job): string | null {
  if (job.nodesCreated === null || job.nodesUpdated === null) return null;
  if (job.nodesCreated === 0 && job.nodesUpdated === 0) return 'nothing new';
  return `+${String(job.nodesCreated)} new, ${String(job.nodesUpdated)} updated`;
}

const active = (job: Job) => job.status === 'queued' || job.status === 'running';

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [ticking]);
  return now;
}

const STREAMS = [
  ['raw', 'raw.txt (the tool’s output)'],
  ['stderr', 'stderr (script log)'],
  ['stdout', 'stdout'],
] as const;

/** A job's command, problems and the tail of each output, with links to the full text. */
function OutputDialog({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const detail = useJob(jobId);
  const [stream, setStream] = useState<(typeof STREAMS)[number][0]>('raw');
  const job = detail.data?.job;
  const text = detail.data?.tails[stream];
  return (
    <div role="dialog" aria-label={`Job ${String(jobId)} output`} className="bg-background absolute inset-2 z-10 flex flex-col gap-2 rounded-md border p-3 shadow-lg">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Job {jobId}</span>
        {job && <span className="text-muted-foreground">{job.tool} → {job.targetValue}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      {detail.error && <p className="text-xs text-red-400">Couldn't load the job: {detail.error.message}</p>}
      {job?.argv && (
        <p className="truncate font-mono text-xs" title={job.argv.join(' ')}>
          {job.argv.join(' ')}
        </p>
      )}
      {job?.error && <p className="text-xs text-amber-600 dark:text-amber-300">{job.error}</p>}
      {job?.issues && job.issues.length > 0 && (
        <ul aria-label="Validation issues" className="max-h-24 overflow-auto font-mono text-[11px] text-red-500">
          {job.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1" role="tablist">
        {STREAMS.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            role="tab"
            aria-selected={stream === key}
            variant={stream === key ? 'secondary' : 'ghost'}
            onClick={() => {
              setStream(key);
            }}
          >
            {label}
          </Button>
        ))}
        <a className="text-muted-foreground hover:text-foreground ml-auto text-xs underline" href={outputUrl(jobId, stream)} target="_blank" rel="noreferrer">
          open full {stream}
        </a>
      </div>
      <pre className="bg-muted/40 min-h-0 flex-1 overflow-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
        {text === undefined ? 'Loading…' : text === null ? `No ${stream} kept for this job.` : text === '' ? '(empty)' : text}
      </pre>
    </div>
  );
}

export interface JobsPanelProps {
  className?: string;
  /** The job's target node: select it and open the path to it. */
  onPickNode: (nodeId: string) => void;
  /** Show results: the target node, with this scan's provenance rows highlighted. */
  onShowResults: (job: Job) => void;
}

export function JobsPanel({ className, onPickNode, onShowResults }: JobsPanelProps) {
  const [page, setPage] = useState(1);
  const [outputOf, setOutputOf] = useState<number | null>(null);
  const jobs = useJobs(page);
  const cancel = useCancelJob();
  const now = useNow(jobs.data?.items.some((j) => j.status === 'running') ?? false);
  const pages = jobs.data ? Math.max(1, Math.ceil(jobs.data.total / JOBS_PANEL_SIZE)) : 1;

  return (
    <div className={cn('relative flex min-h-0 flex-col', className)}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-sm">
        <span className="font-medium">Jobs{jobs.data ? ` (${String(jobs.data.total)})` : ''}</span>
        <span className="text-muted-foreground text-xs">Right-click a domain → Run tool to start one.</span>
        {pages > 1 && (
          <span className="ml-auto flex items-center gap-1 text-xs">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); }}>
              Newer
            </Button>
            <span className="text-muted-foreground tabular-nums">
              {page} / {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => { setPage((p) => p + 1); }}>
              Older
            </Button>
          </span>
        )}
      </div>
      {jobs.error && <p className="px-3 py-2 text-xs text-red-400">Couldn't load the jobs: {jobs.error.message}</p>}
      {jobs.data?.total === 0 && <p className="text-muted-foreground px-3 py-2 text-xs">No tool has run yet.</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table aria-label="Jobs" className="w-full table-fixed text-left text-xs">
          <thead className="text-muted-foreground bg-background sticky top-0">
            <tr>
              <th className="w-12 px-3 py-1 font-medium">#</th>
              <th className="w-24 py-1 font-medium">Status</th>
              <th className="w-28 py-1 font-medium">Tool</th>
              <th className="py-1 font-medium">Target</th>
              <th className="w-36 py-1 font-medium">Started (UTC)</th>
              <th className="w-20 py-1 font-medium">Duration</th>
              <th className="w-40 py-1 font-medium">Found</th>
              <th className="w-64 py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {jobs.data?.items.map((job) => (
              <tr key={job.id} className="border-t align-top">
                <td className="text-muted-foreground px-3 py-1 tabular-nums">{job.id}</td>
                <td className="py-1">
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_STYLE[job.status])} title={job.error ?? undefined}>
                    {job.status}
                  </span>
                </td>
                <td className="py-1">{job.tool}</td>
                <td className="truncate py-1 pr-2">
                  <button type="button" className="hover:text-foreground font-mono hover:underline" title="Show this node" onClick={() => { onPickNode(job.nodeId); }}>
                    {job.targetValue}
                  </button>
                  {job.error && (
                    <span className="text-muted-foreground block truncate" title={job.error}>
                      {job.error}
                    </span>
                  )}
                </td>
                <td className="py-1 tabular-nums">{job.startedAt ? formatTime(job.startedAt) : formatTime(job.createdAt)}</td>
                <td className="py-1 tabular-nums">{jobDuration(job, now) ?? '–'}</td>
                <td className="py-1">{jobFindings(job) ?? '–'}</td>
                <td className="py-1 pr-3">
                  <span className="flex justify-end gap-1">
                    {active(job) && (
                      <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => { cancel.mutate(job.id); }}>
                        Cancel
                      </Button>
                    )}
                    {job.startedAt !== null && (
                      <Button size="sm" variant="ghost" onClick={() => { setOutputOf(job.id); }}>
                        Raw output
                      </Button>
                    )}
                    {job.scanId !== null && (
                      <Button size="sm" variant="ghost" onClick={() => { onShowResults(job); }}>
                        Show results
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cancel.error && <p className="px-3 py-1 text-xs text-red-400">Couldn't cancel: {cancel.error.message}</p>}
      {outputOf !== null && (
        <OutputDialog
          jobId={outputOf}
          onClose={() => {
            setOutputOf(null);
          }}
        />
      )}
    </div>
  );
}
