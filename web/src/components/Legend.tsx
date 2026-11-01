// What the icons, colors and borders mean. Built from the same tables as the stylesheet (graph/style.ts) and the
// icon map (graph/icons.ts), so the legend can't drift from the canvas. Opened from the header.
import { CONFIDENCE_LEVELS, NODE_TYPES } from '@redwhale/shared';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { badgeImage, glyphImage } from '@/graph/icons';
import {
  AGGREGATE_BORDER,
  COLORS,
  CONFIDENCE_BORDER,
  IGNORED_OPACITY,
  MUTED_OPACITY,
  OUT_OF_SCOPE_HATCH,
  SEARCH_PATH_OPACITY,
  SEVERITY_COLOR,
  SEVERITY_KEYS,
  ICON_SCALE,
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
  /** The out-of-scope stripes, as style.ts draws them. */
  hatch?: boolean;
  opacity?: number;
  size?: number;
  /** An icon (data URI) in the middle, as the canvas draws it. */
  icon?: string;
  /** A risk badge (data URI) over the top-right corner. */
  badge?: string;
}

function Swatch({
  shape = 'ellipse',
  fill = SEVERITY_COLOR.none,
  borderStyle = 'solid',
  borderWidth = 1.5,
  ring = false,
  hatch = false,
  opacity = 1,
  size = 18,
  icon,
  badge,
}: SwatchProps) {
  const d = SHAPE_PATHS[shape];
  // useId() may contain characters that break a url(#…) reference.
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // The node's 24-unit image tile, mapped onto the 2-unit shape box.
  const unit = 2 / 24;
  return (
    <svg viewBox="-1.6 -1.6 3.2 3.2" width={size} height={size} className="shrink-0" aria-hidden opacity={opacity}>
      {ring && (
        <path d={d} transform="scale(1.45)" fill="none" stroke={COLORS.interesting} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      )}
      {hatch && (
        <defs>
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width={OUT_OF_SCOPE_HATCH.spacing * unit * Math.SQRT2}
            height={OUT_OF_SCOPE_HATCH.spacing * unit * Math.SQRT2}
            patternTransform="rotate(45)"
          >
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={OUT_OF_SCOPE_HATCH.spacing * unit * Math.SQRT2}
              stroke={OUT_OF_SCOPE_HATCH.color}
              strokeOpacity={OUT_OF_SCOPE_HATCH.opacity}
              strokeWidth={OUT_OF_SCOPE_HATCH.width * unit}
            />
          </pattern>
        </defs>
      )}
      <path
        d={d}
        fill={fill}
        stroke={COLORS.border}
        strokeWidth={borderStyle === 'double' ? 1 : borderWidth}
        strokeDasharray={borderStyle === 'dashed' ? '3 2' : undefined}
        vectorEffect="non-scaling-stroke"
      />
      {hatch && <path d={d} fill={`url(#${hatchId})`} />}
      {borderStyle === 'double' && (
        <path d={d} transform="scale(0.7)" fill="none" stroke={COLORS.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )}
      {icon !== undefined && (
        <image href={icon} x={-ICON_SCALE} y={-ICON_SCALE} width={2 * ICON_SCALE} height={2 * ICON_SCALE} />
      )}
      {badge !== undefined && <image href={badge} x={0.45} y={-1.55} width={1.1} height={1.1} />}
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

export function Legend({ className, onClose }: { className?: string; onClose: () => void }) {
  return (
    <Card aria-label="Legend" className={cn('w-72 gap-3 py-3 text-xs shadow-lg', className)}>
      <CardHeader className="flex flex-row items-center justify-between px-3">
        <CardTitle className="text-sm">Legend</CardTitle>
        <Button size="sm" variant="ghost" aria-label="Close legend" onClick={onClose}>
          ✕
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-3">
        <Section title="Type (icon)">
          {NODE_TYPES.map((t) => (
            <Row key={t} swatch={<Swatch icon={glyphImage(t, 'none')} size={26} />}>
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
          <Row
            swatch={<Swatch borderStyle={AGGREGATE_BORDER.style} icon={glyphImage('subdomain', 'none')} size={24} />}
          >
            group (double-click)
          </Row>
          <Row
            swatch={
              <Swatch
                borderStyle={AGGREGATE_BORDER.style}
                fill={SEVERITY_COLOR.critical}
                icon={glyphImage('ip', 'critical')}
                badge={badgeImage(2, 'critical')}
                size={24}
              />
            }
          >
            high/critical below
          </Row>
          <Row swatch={<Swatch shape="round-rectangle" fill={COLORS.more} borderStyle="dashed" borderWidth={1} />}>
            +N more (load)
          </Row>
          <Row swatch={<Swatch ring />}>interesting</Row>
          <Row swatch={<Swatch hatch fill={SEVERITY_COLOR.high} />}>out of scope</Row>
          <Row swatch={<Swatch opacity={IGNORED_OPACITY} />}>ignored</Row>
          <Row swatch={<Swatch opacity={SEARCH_PATH_OPACITY} />}>search path</Row>
          <Row swatch={<Swatch opacity={MUTED_OPACITY} />}>muted (low-risk)</Row>
        </Section>
      </CardContent>
    </Card>
  );
}
