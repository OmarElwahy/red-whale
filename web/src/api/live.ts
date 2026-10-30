// Live updates over WS /api/ws (docs/architecture.md §6, §8). The socket reconnects on its own with exponential
// backoff; every message is checked with the shared schema, and anything else is dropped. No React here: the
// socket factory and timers are injectable, so reconnecting is tested without a server or real time.
import { wsEventSchema, type WsEvent } from '@redwhale/shared';

export type LiveStatus = 'connecting' | 'open' | 'reconnecting';

export const BACKOFF = { firstMs: 500, maxMs: 10_000 } as const;

/** Wait before reconnect attempt `n` (0-based): 0.5 s, 1 s, 2 s, … up to 10 s. */
export const backoffDelay = (attempt: number): number => Math.min(BACKOFF.maxMs, BACKOFF.firstMs * 2 ** attempt);

export interface SocketHandlers {
  onOpen: () => void;
  onClose: () => void;
  onMessage: (data: unknown) => void;
}
/** Opens a socket that reports to `handlers`. A failed connection reports a close, like the browser's. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => { close: () => void };

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface LiveSocketOptions {
  url: string;
  onEvent: (event: WsEvent) => void;
  onStatus?: (status: LiveStatus) => void;
  /** The connection came back after a drop (or after failing at first): events may have been missed. */
  onReconnect?: () => void;
  createSocket?: SocketFactory;
  timers?: Timers;
}

export const browserSocket: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = handlers.onOpen;
  ws.onclose = handlers.onClose;
  ws.onmessage = (e) => {
    handlers.onMessage(e.data);
  };
  return ws;
};

const browserTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** `ws://<this host>/api/ws`: through the Vite proxy in dev, so the API's Host/Origin checks still apply. */
export function liveUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
}

/** Parses one message; null for anything that isn't a valid event. */
export function parseEvent(data: unknown): WsEvent | null {
  if (typeof data !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = wsEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export class LiveSocket {
  private socket: { close: () => void } | null = null;
  private timer: unknown = null;
  private attempt = 0;
  /** A connection failed or dropped since the last open. */
  private dropped = false;
  private stopped = false;
  private readonly createSocket: SocketFactory;
  private readonly timers: Timers;

  constructor(private readonly options: LiveSocketOptions) {
    this.createSocket = options.createSocket ?? browserSocket;
    this.timers = options.timers ?? browserTimers;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Closes the socket for good: no more events, status changes or reconnects. */
  close(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private connect(): void {
    this.timer = null;
    this.options.onStatus?.(this.dropped ? 'reconnecting' : 'connecting');
    // Callbacks from a socket that was replaced or closed are ignored.
    let socket: { close: () => void } | null = null;
    const handlers: SocketHandlers = {
      onOpen: () => {
        if (this.socket !== socket) return;
        this.attempt = 0;
        this.options.onStatus?.('open');
        if (this.dropped) {
          this.dropped = false;
          this.options.onReconnect?.();
        }
      },
      onClose: () => {
        if (this.socket !== socket || this.stopped) return;
        this.socket = null;
        this.dropped = true;
        this.options.onStatus?.('reconnecting');
        this.timer = this.timers.setTimeout(() => {
          this.connect();
        }, backoffDelay(this.attempt++));
      },
      onMessage: (data) => {
        if (this.socket !== socket) return;
        const event = parseEvent(data);
        if (event) this.options.onEvent(event);
      },
    };
    socket = this.createSocket(this.options.url, handlers);
    this.socket = socket;
  }
}

/**
 * Collects requests and runs `flush` once, `delayMs` after the first one: an ingest sends two events, and a burst
 * of PATCHes many, but the views only need to refetch once.
 */
export class Coalescer {
  private timer: unknown = null;

  constructor(
    private readonly flush: () => void,
    private readonly delayMs: number,
    private readonly timers: Timers = browserTimers,
  ) {}

  request(): void {
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  /** Runs a pending flush now. */
  now(): void {
    this.cancel();
    this.flush();
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
