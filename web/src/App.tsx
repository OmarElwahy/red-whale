import { useMemo, type ReactNode } from 'react';
import { ApiError, ResponseShapeError } from '@/api/client';
import { useGraph } from '@/api/hooks';
import { Legend } from '@/components/Legend';
import { Badge } from '@/components/ui/badge';
import { CytoscapeGraph } from '@/graph/CytoscapeGraph';
import { toElements } from '@/graph/elements';

function ErrorPanel({ error }: { error: Error }) {
  const issues = error instanceof ApiError || error instanceof ResponseShapeError ? error.issues : [];
  return (
    <div className="m-auto max-w-xl rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm">
      <p className="font-semibold text-red-300">Couldn't load the graph: {error.message}</p>
      {issues.length > 0 && (
        <ul className="mt-2 list-disc pl-5 font-mono text-xs text-red-200">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-3">
        Is the API running? Start both with <code className="font-mono">pnpm dev</code>.
      </p>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground m-auto text-sm">{children}</div>;
}

export function App() {
  const graph = useGraph();
  const elements = useMemo(() => (graph.data ? toElements(graph.data) : []), [graph.data]);
  const shown = graph.data?.nodes.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="text-sm font-bold tracking-[0.2em] text-red-500">RED WHALE</h1>
        {graph.data && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {shown} of {graph.data.totals.nodes} nodes shown · {graph.data.totals.edges} edges
          </span>
        )}
        {graph.data?.truncated && (
          <Badge variant="destructive" title={`aggregated at threshold ${String(graph.data.threshold)}`}>
            truncated
          </Badge>
        )}
        {graph.isFetching && <span className="text-muted-foreground text-xs">loading…</span>}
      </header>
      <main className="relative flex min-h-0 flex-1">
        {graph.error ? (
          <ErrorPanel error={graph.error} />
        ) : graph.data && graph.data.totals.nodes === 0 ? (
          <Message>
            The workspace is empty. Load some data with <code className="font-mono">pnpm mock</code> or{' '}
            <code className="font-mono">pnpm ingest &lt;file.json&gt;</code>.
          </Message>
        ) : (
          <CytoscapeGraph elements={elements} className="absolute inset-0" />
        )}
        <Legend className="absolute bottom-4 left-4" />
      </main>
    </div>
  );
}
