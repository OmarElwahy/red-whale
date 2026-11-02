// "Delete…" on a node, "Delete group…" on a group: permanent, after a preview of what each choice removes.
// A group's members are the ones the current filters keep (every page, not only what's drawn).
import { TYPE_PLURAL, type DeletePreview, type DeleteResponse, type DeletionMode, type GraphFilters, type Job } from '@redwhale/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { editKeys, useDeleteNode, useDeletePreview } from '@/api/edit';
import { graphSearchParams } from '@/api/query';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TypeIcon } from './TypeIcon';

export interface DeleteDialogProps {
  /** A node ID or a group ID. */
  id: string;
  /** The view's filters: they decide a group's members. */
  filters: GraphFilters;
  onDeleted: (result: DeleteResponse) => void;
  onClose: () => void;
}

const n = (count: number, one: string, many = `${one}s`) => `${String(count)} ${count === 1 ? one : many}`;

function jobLine(j: Job): string {
  return `${j.tool} on ${j.targetValue} (job ${String(j.id)})`;
}

/** The sentence under each choice. */
function describe(preview: DeletePreview, mode: DeletionMode): string {
  const c = preview[mode];
  const parts = [`${n(c.nodes, 'node')} and ${n(c.edges, 'edge')} removed.`];
  if (c.orphans > 0) parts.push(`${n(c.orphans, 'node')} left without a parent become${c.orphans === 1 ? 's' : ''} a root.`);
  if (c.keptShared > 0) parts.push(`${n(c.keptShared, 'shared node')} below stay${c.keptShared === 1 ? 's' : ''}: also under another node.`);
  return parts.join(' ');
}

export function DeleteDialog({ id, filters, onDeleted, onClose }: DeleteDialogProps) {
  const titleId = useId();
  const client = useQueryClient();
  const preview = useDeletePreview(id, filters);
  const del = useDeleteNode();
  const [mode, setMode] = useState<DeletionMode>('node');
  /** Why the last attempt didn't go through (a 409: job running, or the graph changed). */
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const data = preview.data;
  const target = data?.target;
  const isGroup = target?.kind === 'group';
  const chosen = data?.[mode];
  const running = chosen?.runningJobs ?? [];

  const confirm = () => {
    if (!data || !chosen) return;
    setConflict(null);
    setError(null);
    del.mutate(
      { id, mode, filters, expect: chosen.nodes, cancelJobs: running.length > 0 },
      {
        onSuccess: (outcome) => {
          if (outcome.ok) {
            onDeleted(outcome.result);
            return;
          }
          // Show what's true now and ask again.
          const params = id.startsWith('agg:') ? graphSearchParams(filters).toString() : '';
          client.setQueryData(editKeys.preview(id, params), outcome.preview);
          setConflict(outcome.reason === 'changed' ? 'The graph changed since this opened. Check the new counts and confirm again.' : outcome.error);
        },
        onError: (e) => {
          setError(e.message);
        },
      },
    );
  };

  const choices: { mode: DeletionMode; label: string }[] = isGroup
    ? [
        { mode: 'node', label: 'Delete the members only' },
        { mode: 'subtree', label: 'Delete the members with everything below' },
      ]
    : [
        { mode: 'node', label: 'Delete this node only' },
        { mode: 'subtree', label: 'Delete with everything below' },
      ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="bg-background flex w-full max-w-md flex-col gap-3 rounded-lg border p-4 shadow-xl">
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
          {target && <TypeIcon type={target.type} />}
          <span className="min-w-0 truncate">{target ? `${isGroup ? 'Delete group' : 'Delete'}: ${target.label}` : 'Delete'}</span>
        </h2>

        {preview.isPending && <p className="text-muted-foreground text-sm">Counting what would be removed…</p>}
        {preview.error && <p className="text-sm text-red-600 dark:text-red-400">{preview.error.message}</p>}

        {data && target && (
          <>
            {isGroup && (
              <p className="text-sm">
                Delete {n(target.members, target.type, TYPE_PLURAL[target.type])}.
                {target.hiddenByFilters > 0 &&
                  ` ${String(target.hiddenByFilters)} more ${target.hiddenByFilters === 1 ? 'is' : 'are'} hidden by your filters and will be kept.`}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">What to delete</legend>
              {choices.map((c) => (
                <label
                  key={c.mode}
                  className={cn('flex cursor-pointer gap-2 rounded-md border p-2 text-sm', mode === c.mode && 'border-red-500/60 bg-red-500/5')}
                >
                  <input
                    type="radio"
                    name={`${titleId}-mode`}
                    value={c.mode}
                    checked={mode === c.mode}
                    onChange={() => {
                      setMode(c.mode);
                      setConflict(null);
                    }}
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{c.label}</span>
                    <span className="text-muted-foreground text-xs">{describe(data, c.mode)}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {running.length > 0 && (
              <div role="status" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
                <p className="font-medium">A tool is running on {running.length === 1 ? 'a node' : 'nodes'} being deleted:</p>
                <ul className="list-disc pl-4">
                  {running.map((j) => (
                    <li key={j.id}>{jobLine(j)}</li>
                  ))}
                </ul>
                <p>Deleting cancels {running.length === 1 ? 'it' : 'them'} first; nothing {running.length === 1 ? 'it' : 'they'} found is kept.</p>
              </div>
            )}
            {chosen && chosen.queuedJobs > 0 && (
              <p className="text-muted-foreground text-xs">{n(chosen.queuedJobs, 'queued job')} on these nodes will be cancelled.</p>
            )}

            <p className="text-xs font-medium text-red-600 dark:text-red-400">
              This can&apos;t be undone: the nodes, their edges and their provenance are removed. Tools may find them again
              later; they would come back as new nodes. Scans and jobs are kept.
            </p>
          </>
        )}

        {conflict && (
          <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
            {conflict}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-red-600 text-white hover:bg-red-700"
            disabled={!chosen || del.isPending}
            onClick={confirm}
          >
            {del.isPending
              ? 'Deleting…'
              : running.length > 0
                ? 'Cancel job and delete'
                : chosen
                  ? `Delete ${n(chosen.nodes, 'node')}`
                  : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  );
}
