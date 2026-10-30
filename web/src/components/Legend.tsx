// What the shapes, colors and borders mean. Built from the same tables as the stylesheet (graph/style.ts).
import { CONFIDENCE_LEVELS, NODE_TYPES } from '@redwhale/shared';
import { useState, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AGGREGATE_BORDER,
  COLORS,
  CONFIDENCE_BORDER,
  IGNORED_OPACITY,
  MUTED_OPACITY,
  SEARCH_PATH_OPACITY,
  SEVERITY_COLOR,
  SEVERITY_KEYS,
  SHAPE_BY_TYPE,
  SHAPE_PATHS,
  type Shape,
} from '@/graph/style';
import { cn } from '@/lib/utils';

interface SwatchProps {
  shape?: Shape;
  fill?: string;
  borderStyle?: 'solid' | 'dashed' | 'double';
  borderWidth?: number;
  ring?: boolean;
  opacity?: number;
  size?: number;
}

function Swatch({
  shape = 'ellipse',
  fill = SEVERITY_COLOR.none,
  borderStyle = 'solid',
  borderWidth = 1.5,
  ring = false,
  opacity = 1,
  size = 18,
}: SwatchProps) {
  const d = SHAPE_PATHS[shape];
  return (
    <svg viewBox="-1.6 -1.6 3.2 3.2" width={size} height={size} className="shrink-0" aria-hidden opacity={opacity}>
      {ring && (
        <path d={d} transform="scale(1.45)" fill="none" stroke={COLORS.interesting} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      )}
      <path
        d={d}
        fill={fill}
        stroke={COLORS.border}
        strokeWidth={borderStyle === 'double' ? 1 : borderWidth}
        strokeDasharray={borderStyle === 'dashed' ? '3 2' : undefined}
        vectorEffect="non-scaling-stroke"
      />
      {borderStyle === 'double' && (
        <path d={d} transform="scale(0.7)" fill="none" stroke={COLORS.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

function Row({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {swatch}
      <span className="capitalize">{children}</span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-1.5 text-[10px] font-semibold tracking-wider uppercase">{title}</h3>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">{children}</ul>
    </section>
  );
}

const CONFIDENCE_HINT = { discovered: '1 tool', corroborated: '2+ tools', verified: 'analyst' } as const;

export function Legend({ className }: { className?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <Card className={cn('w-72 gap-3 py-3 text-xs shadow-lg', className)}>
      <CardHeader className="px-3">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          <CardTitle className="text-sm">Legend</CardTitle>
          <span className="text-muted-foreground">{open ? 'hide' : 'show'}</span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3 px-3">
          <Section title="Type (shape)">
            {NODE_TYPES.map((t) => (
              <Row key={t} swatch={<Swatch shape={SHAPE_BY_TYPE[t]} />}>
                {t}
              </Row>
            ))}
          </Section>
          <Section title="Severity (fill)">
            {SEVERITY_KEYS.map((s) => (
              <Row key={s} swatch={<Swatch fill={SEVERITY_COLOR[s]} />}>
                {s}
              </Row>
            ))}
          </Section>
          <Section title="Confidence (border)">
            {CONFIDENCE_LEVELS.map((c) => (
              <Row
                key={c}
                swatch={<Swatch borderStyle={CONFIDENCE_BORDER[c].style} borderWidth={CONFIDENCE_BORDER[c].width} />}
              >
                {c} <span className="text-muted-foreground normal-case">({CONFIDENCE_HINT[c]})</span>
              </Row>
            ))}
          </Section>
          <Section title="Markers">
            <Row swatch={<Swatch borderStyle={AGGREGATE_BORDER.style} size={22} />}>group (count)</Row>
            <Row swatch={<Swatch ring />}>interesting</Row>
            <Row swatch={<Swatch opacity={IGNORED_OPACITY} />}>ignored</Row>
            <Row swatch={<Swatch opacity={SEARCH_PATH_OPACITY} />}>search path</Row>
            <Row swatch={<Swatch opacity={MUTED_OPACITY} />}>muted (low-risk)</Row>
          </Section>
        </CardContent>
      )}
    </Card>
  );
}
