// The right-click menu, drawn by React over the canvas at the click position.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { MenuBadge, MenuItem } from './items';

export interface ContextMenuProps {
  x: number;
  y: number;
  title: string;
  items: readonly MenuItem[];
  /** A leaf item was clicked (an item with a submenu opens it instead). */
  onAction: (item: MenuItem) => void;
  onClose: () => void;
}

const BADGE_TONES: Record<MenuBadge['tone'], string> = {
  passive: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  active: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  intrusive: 'bg-red-500/15 text-red-700 dark:text-red-300',
  external: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
};

export function ContextMenu({ x, y, title, items, onAction, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  /** The open submenu (Run tool ▸), if any. */
  const [sub, setSub] = useState<MenuItem | null>(null);
  const shown = sub?.submenu ?? items;

  // Keep the menu inside its container.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !(parent instanceof HTMLElement)) return;
    setPos({
      left: Math.max(4, Math.min(x, parent.clientWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, parent.clientHeight - el.offsetHeight - 4)),
    });
  }, [x, y, sub]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('wheel', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('wheel', onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={title}
      className="bg-popover text-popover-foreground absolute z-20 min-w-52 rounded-md border p-1 text-sm shadow-lg"
      style={pos}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div className="text-muted-foreground max-w-72 truncate px-2 py-1 text-xs" title={title}>
        {title}
      </div>
      {sub && (
        <button
          type="button"
          role="menuitem"
          className="hover:bg-accent text-muted-foreground flex w-full rounded-sm px-2 py-1.5 text-left"
          onClick={() => {
            setSub(null);
          }}
        >
          ‹ {sub.label}
        </button>
      )}
      {shown.map((item) => (
        <button
          key={`${item.action}:${item.name ?? ''}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.hint}
          aria-haspopup={item.submenu ? 'menu' : undefined}
          className={cn(
            'flex w-full flex-col rounded-sm px-2 py-1.5 text-left',
            item.disabled ? 'text-muted-foreground cursor-not-allowed' : 'hover:bg-accent',
          )}
          onClick={() => {
            if (item.submenu) setSub(item);
            else onAction(item);
          }}
        >
          <span className="flex w-full items-center gap-1.5">
            <span className="truncate">{item.label}</span>
            {item.badges?.map((b) => (
              <span key={b.text} className={cn('rounded px-1 text-[10px] leading-4 font-medium', BADGE_TONES[b.tone])}>
                {b.text}
              </span>
            ))}
            {item.submenu && <span className="ml-auto pl-3">▸</span>}
          </span>
          {sub && item.disabled && item.hint && <span className="max-w-72 text-[11px] leading-tight">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
