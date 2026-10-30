// Search (`q`): typing updates the graph after a short pause; Enter searches right away and jumps to the
// first match (App selects and centers it once the graph for that query has loaded).
import { useEffect, useState } from 'react';
import { useUi } from '@/state/ui';
import { useView } from '@/state/view';

export const SEARCH_DEBOUNCE_MS = 300;

export function SearchBox() {
  const q = useView((s) => s.filters.q);
  const setQuery = useView((s) => s.setQuery);
  const requestJump = useUi((s) => s.requestJump);
  const [text, setText] = useState(q ?? '');

  // Follow changes made elsewhere (reset). Our own debounced writes already equal the text.
  const [synced, setSynced] = useState(q);
  if (q !== synced) {
    setSynced(q);
    if ((q ?? '') !== text.trim()) setText(q ?? '');
  }

  useEffect(() => {
    if (text.trim() === (q ?? '')) return;
    const timer = setTimeout(() => {
      setQuery(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, q, setQuery]);

  return (
    <div className="flex flex-col gap-1">
      <input
        type="search"
        aria-label="Search"
        placeholder="Search value or label…"
        className="border-input focus-visible:ring-ring h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          setQuery(text);
          requestJump();
        }}
      />
      <p className="text-muted-foreground text-[10px]">Enter jumps to the riskiest match.</p>
    </div>
  );
}
