// Tool runs (docs/architecture.md §11): what the API and the UI share about tools and jobs.

/** How hard a tool touches its target. Scope checks `passive` as passive and the other two as active. */
export const TOOL_MODES = ['passive', 'active', 'intrusive'] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

/** The scope mode a tool's runs are authorized under. */
export function scopeModeFor(mode: ToolMode): 'passive' | 'active' {
  return mode === 'passive' ? 'passive' : 'active';
}

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job in one of these never changes again. */
export const FINISHED_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled', 'refused'];
