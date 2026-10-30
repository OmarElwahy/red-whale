// Markdown notes: edit / preview, saved explicitly (button or Ctrl+Enter) rather than on every keystroke,
// since each save is a PATCH that the server broadcasts.
import { useState } from 'react';
import { NotesMarkdown } from '@/components/NotesMarkdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface NotesEditorProps {
  notes: string;
  onSave: (notes: string) => Promise<unknown>;
  saving: boolean;
  error: Error | null;
}

export function NotesEditor({ notes, onSave, saving, error }: NotesEditorProps) {
  /** null = not edited, so the saved notes are shown (and follow updates from the server). */
  const [draft, setDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const text = draft ?? notes;
  const dirty = draft !== null && draft !== notes;

  const save = () => {
    if (!dirty || saving) return;
    const saved = draft;
    // Keep anything typed while the save was in flight.
    onSave(saved).then(
      () => {
        setDraft((d) => (d === saved ? null : d));
      },
      () => undefined,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {(['edit', 'preview'] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={tab === t ? 'secondary' : 'ghost'}
            aria-pressed={tab === t}
            className="capitalize"
            onClick={() => {
              setTab(t);
            }}
          >
            {t}
          </Button>
        ))}
        {dirty && <span className="ml-auto text-xs text-amber-400">unsaved</span>}
      </div>
      {tab === 'edit' ? (
        <textarea
          aria-label="Notes"
          className="bg-background min-h-32 w-full resize-y rounded-md border p-2 font-mono text-xs"
          placeholder="Markdown notes…"
          value={text}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
      ) : (
        <div className={cn('markdown min-h-32 rounded-md border p-2 text-sm', text === '' && 'text-muted-foreground')}>
          {text === '' ? (
            'No notes.'
          ) : (
            <NotesMarkdown>{text}</NotesMarkdown>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save notes'}
        </Button>
        <span className="text-muted-foreground text-xs">Ctrl+Enter</span>
        {error && <span className="text-xs text-red-400">Not saved: {error.message}</span>}
      </div>
    </div>
  );
}
