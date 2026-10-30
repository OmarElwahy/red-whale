// The right-click menu, drawn by React over the canvas at the click position.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { MenuAction, MenuItem } from './items';

export interface ContextMenuProps {
  x: number;
  y: number;
  title: string;
  items: readonly MenuItem[];
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, title, items, onAction, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside its container.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !(parent instanceof HTMLElement)) return;
    setPos({
      left: Math.max(4, Math.min(x, parent.clientWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, parent.clientHeight - el.offsetHeight - 4)),
    });
  }, [x, y]);

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
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.hint}
          className={cn(
            'flex w-full rounded-sm px-2 py-1.5 text-left',
            item.disabled ? 'text-muted-foreground cursor-not-allowed' : 'hover:bg-accent',
          )}
          onClick={() => {
            onAction(item.action);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
