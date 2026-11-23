// Pushes events to every connected browser (WS /api/ws).
import type { WebSocket } from '@fastify/websocket';
import type { WsEvent } from '@redwhale/shared';

export class Broadcaster {
  private readonly sockets = new Set<WebSocket>();
  private readonly listeners = new Set<(event: WsEvent) => void>();

  /** Server-side listeners get every event too (the takeover watch's scheduler reacts to them). */
  listen(listener: (event: WsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  send(event: WsEvent): void {
    const text = JSON.stringify(event);
    for (const socket of this.sockets) if (socket.readyState === socket.OPEN) socket.send(text);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not stop the broadcast (or the request that caused it).
      }
    }
  }
}
