import type { WsEvent } from '@redwhale/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BACKOFF,
  Coalescer,
  LiveSocket,
  backoffDelay,
  liveUrl,
  parseEvent,
  type LiveStatus,
  type SocketHandlers,
} from '../src/api/live';
import { queryKeys } from '../src/api/query';
import { REFRESH_DELAY_MS, connectLive } from '../src/api/useLiveUpdates';
import { FRESH_MS, initialLiveState, useLive } from '../src/state/live';
import { initialUiState, useUi } from '../src/state/ui';

/** Sockets the fake factory opened, newest last. The test drives their open/close/message by hand. */
function fakeSockets() {
  const opened: { url: string; handlers: SocketHandlers; closed: boolean }[] = [];
  const createSocket = vi.fn((url: string, handlers: SocketHandlers) => {
    const s = { url, handlers, closed: false };
    opened.push(s);
    return {
      close: () => {
        s.closed = true;
      },
    };
  });
  const last = () => {
    const s = opened.at(-1);
    if (!s) throw new Error('no socket opened');
    return s;
  };
  return { opened, createSocket, last };
}

const UPDATED: WsEvent = { type: 'graph.updated', nodeIds: ['n1', 'n2'], edgeIds: ['e1'] };
const INGESTED: WsEvent = { type: 'scan.ingested', scanId: 's1', tool: 'nmap' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const sockets = fakeSockets();
  const events: WsEvent[] = [];
  const statuses: LiveStatus[] = [];
  const onReconnect = vi.fn();
  const live = new LiveSocket({
    url: 'ws://127.0.0.1:5173/api/ws',
    createSocket: sockets.createSocket,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onReconnect,
  });
  live.start();
  return { live, sockets, events, statuses, onReconnect };
}

describe('LiveSocket', () => {
  test('connects, reports its status, and passes on valid events', () => {
    const { sockets, events, statuses, onReconnect } = setup();
    expect(sockets.last().url).toBe('ws://127.0.0.1:5173/api/ws');
    sockets.last().handlers.onOpen();
    sockets.last().handlers.onMessage(JSON.stringify(UPDATED));
    sockets.last().handlers.onMessage(JSON.stringify(INGESTED));
    expect(events).toEqual([UPDATED, INGESTED]);
    expect(statuses).toEqual(['connecting', 'open']);
    // The first connection isn't a reconnect: nothing was missed.
    expect(onReconnect).not.toHaveBeenCalled();
  });

  test('drops anything that is not a valid event', () => {
    const { sockets, events } = setup();
    sockets.last().handlers.onOpen();
    for (const bad of [
      'not json',
      '{"type":"graph.updated"}',
      JSON.stringify({ type: 'graph.deleted', nodeIds: [] }),
      JSON.stringify({ ...UPDATED, extra: 1 }),
      new ArrayBuffer(4),
    ]) {
      sockets.last().handlers.onMessage(bad);
    }
    expect(events).toEqual([]);
  });

  test('reconnects with exponential backoff, capped', () => {
    const { sockets, statuses } = setup();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const count = sockets.opened.length;
      sockets.last().handlers.onClose();
      const delay = backoffDelay(i);
      waits.push(delay);
      vi.advanceTimersByTime(delay - 1);
      expect(sockets.opened).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sockets.opened).toHaveLength(count + 1);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(statuses.slice(0, 3)).toEqual(['connecting', 'reconnecting', 'reconnecting']);
  });

  test('a good connection resets the backoff, and a reconnect asks for a full refresh', () => {
    const { sockets, statuses, onReconnect } = setup();
    sockets.last().handlers.onOpen();
    sockets.last().handlers.onClose();
    vi.advanceTimersByTime(BACKOFF.firstMs);
    sockets.last().handlers.onClose(); // the server is still down
    vi.advanceTimersByTime(backoffDelay(1));
    sockets.last().handlers.onOpen();
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe('open');
    // Dropped again: back to the first delay.
    sockets.last().handlers.onClose();
    const count = sockets.opened.length;
    vi.advanceTimersByTime(BACKOFF.firstMs);
    expect(sockets.opened).toHaveLength(count + 1);
  });

  test('a server that was down at first: the first open is a reconnect too (the views may have failed)', () => {
    const { sockets, onReconnect } = setup();
    sockets.last().handlers.onClose();
    vi.advanceTimersByTime(BACKOFF.firstMs);
    sockets.last().handlers.onOpen();
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  test('close() closes the socket and stops reconnecting', () => {
    const { live, sockets } = setup();
    sockets.last().handlers.onClose();
    live.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets.opened).toHaveLength(1);

    const again = setup();
    again.sockets.last().handlers.onOpen();
    again.live.close();
    expect(again.sockets.last().closed).toBe(true);
    again.sockets.last().handlers.onClose(); // the browser's close event after close()
    again.sockets.last().handlers.onMessage(JSON.stringify(UPDATED));
    vi.advanceTimersByTime(60_000);
    expect(again.sockets.opened).toHaveLength(1);
    expect(again.events).toEqual([]);
  });

  test('callbacks from a socket that was replaced are ignored', () => {
    const { sockets, events } = setup();
    const first = sockets.last();
    first.handlers.onClose();
    vi.advanceTimersByTime(BACKOFF.firstMs);
    first.handlers.onMessage(JSON.stringify(UPDATED));
    first.handlers.onClose();
    expect(events).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(sockets.opened).toHaveLength(2);
  });
});

describe('helpers', () => {
  test('liveUrl follows the page: ws on http, wss on https, same host (through the Vite proxy)', () => {
    expect(liveUrl({ protocol: 'http:', host: '127.0.0.1:5173' })).toBe('ws://127.0.0.1:5173/api/ws');
    expect(liveUrl({ protocol: 'https:', host: 'localhost:5173' })).toBe('wss://localhost:5173/api/ws');
  });

  test('parseEvent', () => {
    expect(parseEvent(JSON.stringify(INGESTED))).toEqual(INGESTED);
    expect(parseEvent('{')).toBeNull();
    expect(parseEvent(42)).toBeNull();
  });

  test('Coalescer: many requests, one flush after the delay; now() flushes at once', () => {
    const flush = vi.fn();
    const c = new Coalescer(flush, 200);
    c.request();
    vi.advanceTimersByTime(100);
    c.request();
    c.request();
    vi.advanceTimersByTime(99);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledOnce();
    c.request();
    c.now();
    expect(flush).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

describe('connectLive', () => {
  beforeEach(() => {
    useLive.setState(initialLiveState);
  });

  function connect() {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const sockets = fakeSockets();
    const stop = connectLive(client, { url: 'ws://x/api/ws', createSocket: sockets.createSocket, now: () => 1000 });
    return { invalidate, sockets, stop };
  }

  test('an ingest (two events) refetches every API query once, and remembers the updated node IDs', () => {
    const { invalidate, sockets } = connect();
    sockets.last().handlers.onOpen();
    expect(useLive.getState().status).toBe('open');
    sockets.last().handlers.onMessage(JSON.stringify(INGESTED));
    sockets.last().handlers.onMessage(JSON.stringify(UPDATED));
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.all });
    expect([...useLive.getState().fresh]).toEqual([
      ['n1', 1000 + FRESH_MS],
      ['n2', 1000 + FRESH_MS],
    ]);
  });

  test('graph.deleted: forgets the deleted nodes everywhere (selection, flash) and refetches everything', () => {
    useUi.setState(initialUiState);
    useUi.getState().select('n1');
    useLive.getState().noteUpdated(['n1', 'n3'], 1000);
    const { invalidate, sockets } = connect();
    sockets.last().handlers.onOpen();
    sockets.last().handlers.onMessage(JSON.stringify({ type: 'graph.deleted', nodeIds: ['n1'], edgeIds: ['e1'] }));
    expect(useUi.getState().selectedId).toBeNull();
    expect(useUi.getState().notice).toBe('What you had selected was deleted.');
    expect([...useLive.getState().fresh.keys()]).toEqual(['n3']);
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.all });
  });

  test('job and runner events refetch only the runner queries and the scope log, never the graph', () => {
    const { invalidate, sockets } = connect();
    sockets.last().handlers.onOpen();
    const job = {
      id: 1, tool: 'subfinder', group: 'subdomain', nodeId: 'n1', targetType: 'domain', targetValue: 'example.com',
      mode: 'passive', status: 'running', queuedScopeLogId: 1, scopeLogId: 2, argv: null, image: null, timeoutSec: 600,
      exitCode: null, error: null, issues: null, createdAt: '2026-11-02T10:00:00.000Z', startedAt: null, finishedAt: null,
      scanId: null, nodesCreated: null, nodesUpdated: null,
    };
    sockets.last().handlers.onMessage(JSON.stringify({ type: 'job.updated', job }));
    sockets.last().handlers.onMessage(JSON.stringify({ type: 'runner.status', reachable: false, error: 'Docker is not running' }));
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(invalidate.mock.calls.map(([arg]) => arg)).toEqual([{ queryKey: queryKeys.runner }, { queryKey: queryKeys.scopeLogAll }]);
    expect(useLive.getState().fresh.size).toBe(0);
  });

  test('after a reconnect everything is refetched at once', () => {
    const { invalidate, sockets } = connect();
    sockets.last().handlers.onOpen();
    sockets.last().handlers.onClose();
    expect(useLive.getState().status).toBe('reconnecting');
    vi.advanceTimersByTime(BACKOFF.firstMs);
    sockets.last().handlers.onOpen();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  test('stop() closes the socket and drops a pending refetch', () => {
    const { invalidate, sockets, stop } = connect();
    sockets.last().handlers.onOpen();
    sockets.last().handlers.onMessage(JSON.stringify(UPDATED));
    stop();
    vi.advanceTimersByTime(60_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(sockets.last().closed).toBe(true);
  });
});

describe('live store', () => {
  beforeEach(() => {
    useLive.setState(initialLiveState);
  });

  test('updated IDs stay fresh for FRESH_MS; a later event extends them', () => {
    const live = () => useLive.getState();
    live().noteUpdated(['a', 'b'], 0);
    live().noteUpdated(['b'], 5000);
    live().prune(FRESH_MS);
    expect([...live().fresh.keys()]).toEqual(['b']);
    live().prune(FRESH_MS + 5000);
    expect(live().fresh.size).toBe(0);
  });

  test('an event with no node IDs (a scan with no findings) changes nothing', () => {
    const before = useLive.getState().fresh;
    useLive.getState().noteUpdated([], 0);
    expect(useLive.getState().fresh).toBe(before);
  });
});
