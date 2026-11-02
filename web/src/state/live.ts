// Live-update state (Zustand): the WebSocket's status, and the node IDs that recent `graph.updated` events named.
// The graph flashes nodes from that set when they first appear on the canvas.
import { create } from 'zustand';
import type { LiveStatus } from '@/api/live';

/** How long an updated node counts as new: long enough for the refetch to land on a slow machine. */
export const FRESH_MS = 15_000;

export interface LiveState {
  status: LiveStatus;
  /** IDs named by recent `graph.updated` events → when they stop counting as new (ms since epoch). */
  fresh: ReadonlyMap<string, number>;
  setStatus: (status: LiveStatus) => void;
  noteUpdated: (ids: readonly string[], now: number) => void;
  /** Forgets IDs whose time is up. */
  prune: (now: number) => void;
  /** Deleted nodes don't flash if a scan brings them back within the window: they're new then. */
  forget: (ids: readonly string[]) => void;
}

export const initialLiveState = { status: 'connecting', fresh: new Map() } satisfies Partial<LiveState>;

export const useLive = create<LiveState>()((set) => ({
  ...initialLiveState,

  setStatus: (status) => {
    set({ status });
  },
  noteUpdated: (ids, now) => {
    if (ids.length === 0) return;
    set((s) => {
      const fresh = new Map(s.fresh);
      for (const id of ids) fresh.set(id, now + FRESH_MS);
      return { fresh };
    });
  },
  forget: (ids) => {
    set((s) => {
      if (!ids.some((id) => s.fresh.has(id))) return s;
      const fresh = new Map(s.fresh);
      for (const id of ids) fresh.delete(id);
      return { fresh };
    });
  },
  prune: (now) => {
    set((s) => {
      const kept = [...s.fresh].filter(([, until]) => until > now);
      return kept.length === s.fresh.size ? s : { fresh: new Map(kept) };
    });
  },
}));
