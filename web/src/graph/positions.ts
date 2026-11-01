// Saves dragged node positions (docs/architecture.md §8): drags are collected, then sent as one PUT /api/layout
// after a short pause. Groups and "more" nodes aren't stored nodes, so their positions are never sent (the server would
// reject the whole batch for an unknown ID).
import { ApiError } from '@/api/client';
import type { Position } from '@/api/hooks';

export type SendLayout = (positions: Position[], options: { keepalive?: boolean }) => Promise<unknown>;

export interface PositionSaverOptions {
  /** Pause after the last drag before saving. */
  delayMs?: number;
  /** Wait before retrying after a network or server error. */
  retryMs?: number;
  onError?: (error: unknown) => void;
  onSaved?: () => void;
}

/** Groups and "more" nodes are drawn by the server's view, not stored: they have no position to save. */
export const isAggregateId = (id: string): boolean => id.startsWith('agg:') || id.startsWith('more:');

export class PositionSaver {
  private pending = new Map<string, Position>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  private disposed = false;
  private readonly delayMs: number;
  private readonly retryMs: number;

  constructor(
    private readonly send: SendLayout,
    private readonly options: PositionSaverOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 500;
    this.retryMs = options.retryMs ?? 5000;
  }

  /** Remembers the positions and (re)starts the timer. A later position of the same node replaces the earlier. */
  queue(positions: readonly Position[]): void {
    let added = false;
    for (const p of positions) {
      if (isAggregateId(p.id)) continue;
      this.pending.set(p.id, { id: p.id, x: p.x, y: p.y });
      added = true;
    }
    if (added) this.schedule(this.delayMs);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Sends whatever is pending now. Sends never overlap, so an older batch can't overwrite a newer one. */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inflight) await this.inflight;
    if (this.pending.size === 0) return;

    const batch = new Map(this.pending);
    this.pending.clear();
    const sending = this.send([...batch.values()], options).then(
      () => {
        this.options.onSaved?.();
      },
      (error: unknown) => {
        this.options.onError?.(error);
        // A 4xx means the batch itself is wrong (e.g. an unknown node): retrying won't help.
        if (error instanceof ApiError && error.status < 500) return;
        for (const [id, p] of batch) if (!this.pending.has(id)) this.pending.set(id, p);
        this.schedule(this.retryMs);
      },
    );
    this.inflight = sending;
    await sending;
    if (this.inflight === sending) this.inflight = undefined;
  }

  /** Stops the timers. Call flush first to keep pending positions. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, ms);
  }
}
