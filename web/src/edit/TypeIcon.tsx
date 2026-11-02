// A node type's icon as the canvas draws it (white glyph on the no-severity fill), for menus and dialogs.
import type { NodeType } from '@redwhale/shared';
import { glyphImage } from '@/graph/icons';
import { SEVERITY_COLOR } from '@/graph/style';
import { cn } from '@/lib/utils';

export function TypeIcon({ type, className }: { type: NodeType; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full', className)}
      style={{ backgroundColor: SEVERITY_COLOR.none }}
    >
      <img src={glyphImage(type, 'none')} alt="" className="size-3.5" />
    </span>
  );
}
