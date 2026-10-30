// The highlights view (docs/architecture.md §8): every node the analyst tagged `interesting`, with its notes,
// from GET /api/highlights. Not filtered by the graph: it's the analyst's own list. Clicking one picks the node,
// like a table row.
import type { Highlight } from '@redwhale/shared';
import { NotesMarkdown } from '@/components/NotesMarkdown';
import { SeverityValue } from '@/components/SeverityValue';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface HighlightsViewProps {
  items: Highlight[] | undefined;
  error: Error | null;
  selectedId: string | null;
  /** Is the node on the canvas? */
  isShown: (id: string) => boolean;
  onPick: (id: string) => void;
  className?: string;
}

export function HighlightsView({ items, error, selectedId, isShown, onPick, className }: HighlightsViewProps) {
  if (error) {
    return <p className={cn('p-4 text-sm text-red-400', className)}>Couldn't load the highlights: {error.message}</p>;
  }
  if (!items) return <p className={cn('text-muted-foreground p-4 text-sm', className)}>loading…</p>;
  if (items.length === 0) {
    return (
      <p className={cn('text-muted-foreground p-4 text-sm', className)}>
        Nothing is tagged interesting yet. Tag a node from its panel and it shows up here, with its notes.
      </p>
    );
  }
  return (
    <ul
      aria-label="Highlights"
      className={cn('grid content-start gap-2 overflow-auto p-3 md:grid-cols-2 xl:grid-cols-3', className)}
    >
      {items.map((h) => {
        const selected = h.id === selectedId;
        const shown = isShown(h.id);
        return (
          <li key={h.id}>
            <article
              aria-label={h.label}
              aria-current={selected || undefined}
              className={cn(
                'bg-card flex h-full flex-col gap-2 rounded-lg border p-3 text-xs',
                selected && 'ring-ring ring-2',
              )}
            >
              <header className="flex items-start gap-2">
                <Badge variant="secondary" className="capitalize">
                  {h.type}
                </Badge>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left text-sm font-semibold break-words hover:underline"
                  title={shown ? 'Select and center on the graph' : 'Select (it is hidden inside a group on the graph)'}
                  onClick={() => {
                    onPick(h.id);
                  }}
                >
                  {h.label}
                </button>
                <span title="Worst severity at or below this node">
                  <SeverityValue severity={h.effectiveSeverity} />
                </span>
              </header>
              {h.value !== h.label && <p className="text-muted-foreground font-mono break-all">{h.value}</p>}
              {!shown && <p className="text-muted-foreground">Not on the graph right now.</p>}
              <div className={cn('markdown text-sm', h.notes === '' && 'text-muted-foreground')}>
                {h.notes === '' ? 'No notes.' : <NotesMarkdown>{h.notes}</NotesMarkdown>}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
