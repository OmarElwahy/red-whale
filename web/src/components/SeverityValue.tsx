// A severity as a colored dot + its name, with the graph's colors.
import type { Severity } from '@redwhale/shared';
import { SEVERITY_COLOR } from '@/graph/style';

export function SeverityValue({ severity }: { severity: Severity | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 capitalize">
      <span className="size-2.5 rounded-full" style={{ background: SEVERITY_COLOR[severity ?? 'none'] }} aria-hidden />
      {severity ?? 'none'}
    </span>
  );
}
