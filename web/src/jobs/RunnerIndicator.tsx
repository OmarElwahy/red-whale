// Header chip (docs/architecture.md §12): is Docker reachable, and are the tool images built? Polled, and refetched
// at once when the server pushes runner.status.
import type { RunnerStatus } from '@redwhale/shared';
import { useRunnerStatus } from '@/api/runner';
import { cn } from '@/lib/utils';

export function runnerSummary(status: RunnerStatus | undefined, error: Error | null): { tone: 'ok' | 'warn' | 'down' | 'off'; label: string; title: string } {
  if (error) return { tone: 'off', label: 'runner off', title: `Tool runs are off on this server: ${error.message}` };
  if (!status) return { tone: 'off', label: 'Docker…', title: 'Asking the server about Docker…' };
  if (!status.docker.reachable) {
    return { tone: 'down', label: 'Docker off', title: `${status.docker.error ?? 'Docker is not reachable'}. Start Docker Desktop to run tools.` };
  }
  const notBuilt = status.images.filter((i) => i.status !== 'built');
  const jobs = `${String(status.running)} running, ${String(status.queued)} queued (at most ${String(status.maxConcurrent)} at once)`;
  if (notBuilt.length > 0) {
    const list = notBuilt.map((i) => `${i.group} (${i.status})`).join(', ');
    return { tone: 'warn', label: 'Docker', title: `Docker ${status.docker.version ?? ''}. Images not ready: ${list}. Run pnpm tools:build. ${jobs}` };
  }
  return { tone: 'ok', label: 'Docker', title: `Docker ${status.docker.version ?? ''}; tool images built. ${jobs}` };
}

const DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-400', down: 'bg-red-500', off: 'bg-slate-400' } as const;

export function RunnerIndicator() {
  const status = useRunnerStatus();
  const s = runnerSummary(status.data, status.error);
  return (
    <span className="text-muted-foreground mr-2 inline-flex items-center gap-1.5 text-xs" title={s.title} aria-label={`Runner: ${s.title}`}>
      <span className={cn('size-2 rounded-full', DOT[s.tone])} aria-hidden />
      {s.label}
      {status.data && status.data.running + status.data.queued > 0 && (
        <span className="tabular-nums">
          ({String(status.data.running)}
          {status.data.queued > 0 ? `+${String(status.data.queued)}` : ''})
        </span>
      )}
    </span>
  );
}
