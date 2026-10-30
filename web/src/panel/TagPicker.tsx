// interesting / checked / ignored. Clicking the active tag clears it.
import { TAGS, type Tag } from '@redwhale/shared';
import { Button } from '@/components/ui/button';

const HINT: Record<Tag, string> = {
  interesting: 'Keep it visible and highlighted',
  checked: 'Looked at it',
  ignored: 'Fade it out',
};

export interface TagPickerProps {
  value: Tag | null;
  onChange: (tag: Tag | null) => void;
  disabled?: boolean;
}

export function TagPicker({ value, onChange, disabled }: TagPickerProps) {
  return (
    <div role="group" aria-label="Tag" className="flex gap-1.5">
      {TAGS.map((tag) => {
        const active = value === tag;
        return (
          <Button
            key={tag}
            size="sm"
            variant={active ? 'default' : 'outline'}
            aria-pressed={active}
            title={active ? 'Click again to clear' : HINT[tag]}
            disabled={disabled}
            className="capitalize"
            onClick={() => {
              onChange(active ? null : tag);
            }}
          >
            {tag}
          </Button>
        );
      })}
    </div>
  );
}
