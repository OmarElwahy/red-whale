// `prefers-reduced-motion`: no momentum, no wheel easing, no animated layouts or camera moves. Read at the
// moment of each motion, so changing the OS setting applies without a reload.
const query: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

export const prefersReducedMotion = (): boolean => query?.matches ?? false;

/** Animation length to use: 0 when the analyst asked for reduced motion. */
export const motionMs = (ms: number): number => (prefersReducedMotion() ? 0 : ms);
