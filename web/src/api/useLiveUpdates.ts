// WebSocket events → TanStack Query invalidation (docs/architecture.md §8). Every view (graph, expand pages,
// neighborhoods, table, highlights, stats, the open node) refetches if it's on screen; the graph wrapper then
// diffs the new elements in. Job and runner events (§12) refetch only the runner's queries.
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLive } from '@/state/live';
import { Coalescer, LiveSocket, liveUrl, type SocketFactory, type Timers } from './live';
import { queryKeys } from './query';

/** Events closer together than this cause one refetch. */
export const REFRESH_DELAY_MS = 200;
const PRUNE_EVERY_MS = 5_000;

export interface ConnectOptions {
  url: string;
  createSocket?: SocketFactory;
  timers?: Timers;
  now?: () => number;
}

/** Opens the live socket and wires it to the query cache and the live store. Returns a function that stops it. */
export function connectLive(client: QueryClient, options: ConnectOptions): () => void {
  const now = options.now ?? Date.now;
  const refresh = new Coalescer(
    () => {
      void client.invalidateQueries({ queryKey: queryKeys.all });
    },
    REFRESH_DELAY_MS,
    options.timers,
  );
  // Job progress refetches only the runner's queries (and the scope log: queueing logs a decision), never the graph:
  // a group run sends a dozen job.updated events, and the graph only changes when a result is ingested.
  const refreshRunner = new Coalescer(
    () => {
      void client.invalidateQueries({ queryKey: queryKeys.runner });
      void client.invalidateQueries({ queryKey: queryKeys.scopeLogAll });
    },
    REFRESH_DELAY_MS,
    options.timers,
  );
  const socket = new LiveSocket({
    url: options.url,
    createSocket: options.createSocket,
    timers: options.timers,
    onEvent: (event) => {
      if (event.type === 'job.updated' || event.type === 'runner.status') {
        refreshRunner.request();
        return;
      }
      if (event.type === 'graph.updated') useLive.getState().noteUpdated(event.nodeIds, now());
      refresh.request();
    },
    onStatus: (status) => {
      useLive.getState().setStatus(status);
    },
    // Events may have been missed while the connection was down: refetch everything now.
    onReconnect: () => {
      refresh.now();
    },
  });
  socket.start();
  return () => {
    socket.close();
    refresh.cancel();
    refreshRunner.cancel();
  };
}

export function useLiveUpdates(): void {
  const client = useQueryClient();
  useEffect(() => {
    const stop = connectLive(client, { url: liveUrl() });
    const prune = setInterval(() => {
      useLive.getState().prune(Date.now());
    }, PRUNE_EVERY_MS);
    return () => {
      stop();
      clearInterval(prune);
    };
  }, [client]);
}
