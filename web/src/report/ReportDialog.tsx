// "Create report…" on a vulnerability, secret or leak node (docs/architecture.md §8): the server's draft in
// editable Markdown with a live preview; Download .md, Download .html, Save as PDF… (print dialog), Copy. Edits live only here: nothing is saved,
// so closing or resetting with edits asks first. Live updates never touch the editor; "Reset to fresh draft" refetches.
import { nodeReportSchema, type NodeReport } from '@redwhale/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useDeferredValue, useEffect, useId, useState } from 'react';
import { getJson } from '@/api/client';
import { Button } from '@/components/ui/button';
import { downloadBlob } from '@/graph/export';
import { reportFileStem, reportFilename } from './file';
import { printHtml } from './print';
import { ReportMarkdown, reportHtml } from './render';

export interface ReportDialogProps {
  nodeId: string;
  onClose: () => void;
  /** The clock for file names (tests). */
  now?: () => Date;
  /** Opens the print dialog on an HTML page (tests replace it). */
  print?: (html: string) => void;
}

/** Outside `['api', …]`, so a live update's invalidation doesn't refetch the draft under the analyst. */
export const reportKey = (id: string) => ['report', id] as const;

/** The page title: the first `# ` heading as plain text (backslash escapes undone), else the server's title. */
export function titleOf(markdown: string, fallback: string): string {
  const heading = /^# +(.+?) *#* *$/m.exec(markdown)?.[1];
  const plain = heading?.replace(/\\([!-/:-@[-`{-~])/g, '$1').trim();
  return plain === undefined || plain === '' ? fallback : plain;
}

type Pending = 'close' | 'reset' | null;

export function ReportDialog({ nodeId, onClose, now = () => new Date(), print = printHtml }: ReportDialogProps) {
  const titleId = useId();
  const report = useQuery({
    queryKey: reportKey(nodeId),
    queryFn: ({ signal }) => getJson(`/api/nodes/${encodeURIComponent(nodeId)}/report`, nodeReportSchema, { signal }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  /** The draft the editor started from; null until it loads. */
  const [draft, setDraft] = useState<NodeReport | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [status, setStatus] = useState<string | null>(null);
  const preview = useDeferredValue(text);

  const load = useCallback((r: NodeReport) => {
    setDraft(r);
    setText(r.markdown);
    setPending(null);
  }, []);

  // The first draft only (set while rendering, React's pattern for state from props): a later refetch must not
  // overwrite the analyst's text.
  if (draft === null && report.data) {
    setDraft(report.data);
    setText(report.data.markdown);
  }

  const dirty = draft !== null && text !== draft.markdown;

  const reset = () => {
    setStatus(null);
    void report.refetch().then((r) => {
      if (r.data) {
        load(r.data);
        setStatus('Fresh draft loaded.');
      } else {
        setPending(null);
      }
    });
  };

  const requestClose = useCallback(() => {
    if (dirty) setPending('close');
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [requestClose]);

  const downloadMd = () => {
    if (!draft) return;
    downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), reportFilename(draft.label, 'md', now()));
    setStatus('Downloaded the Markdown.');
  };
  const downloadHtml = () => {
    if (!draft) return;
    const html = reportHtml(text, titleOf(text, draft.title));
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), reportFilename(draft.label, 'html', now()));
    setStatus('Downloaded the HTML. Open it and print to PDF if you need one.');
  };
  const savePdf = () => {
    if (!draft) return;
    // The title is the file name Chrome and Edge suggest for the PDF.
    print(reportHtml(text, reportFileStem(draft.label, now())));
    setStatus('In the print dialog, pick "Save as PDF" as the destination.');
  };
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setStatus('Copied the Markdown.');
      },
      (e: unknown) => {
        setStatus(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };

  const ready = draft !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-background flex h-full max-h-[56rem] w-full max-w-6xl flex-col gap-3 rounded-lg border p-3 shadow-xl sm:p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
            Report{draft ? `: ${draft.label}` : ''}
          </h2>
          <Button size="sm" variant="outline" disabled={!ready} onClick={downloadMd}>
            Download .md
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={downloadHtml}>
            Download .html
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} title="Opens the print dialog: pick Save as PDF" onClick={savePdf}>
            Save as PDF…
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={copy}>
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!ready || report.isFetching}
            onClick={() => {
              if (dirty) setPending('reset');
              else reset();
            }}
          >
            Reset to fresh draft
          </Button>
          <Button size="sm" variant="ghost" aria-label="Close report" onClick={requestClose}>
            ✕
          </Button>
        </div>

        {pending !== null && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
            <span className="flex-1">
              {pending === 'close'
                ? "Your edits aren't saved anywhere. Close anyway?"
                : 'A fresh draft replaces your edits. Reset anyway?'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPending(null);
              }}
            >
              Keep editing
            </Button>
            <Button size="sm" onClick={pending === 'close' ? onClose : reset}>
              {pending === 'close' ? 'Close anyway' : 'Reset anyway'}
            </Button>
          </div>
        )}
        {status !== null && (
          <p role="status" className="text-muted-foreground text-xs">
            {status}
          </p>
        )}

        {report.error && !ready && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Couldn't build the report: {report.error.message}
          </p>
        )}
        {!report.error && !ready && <p className="text-muted-foreground text-sm">Drafting the report…</p>}

        {ready && (
          <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 md:grid-cols-2 md:grid-rows-1">
            <textarea
              aria-label="Report Markdown"
              spellCheck
              className="bg-muted/30 min-h-0 w-full resize-none rounded-md border p-2 font-mono text-xs leading-relaxed"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setStatus(null);
              }}
            />
            <section aria-label="Preview" className="markdown min-h-0 overflow-auto rounded-md border p-3 text-sm [overflow-wrap:anywhere]">
              <ReportMarkdown>{preview}</ReportMarkdown>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
