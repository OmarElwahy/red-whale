// Pushes events to every connected browser (WS /api/ws).
import type { WebSocket } from '@fastify/websocket';
import type { WsEvent } from '@redwhale/shared';

export class Broadcaster {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  send(event: WsEvent): void {
    const text = JSON.stringify(event);
    for (const socket of this.sockets) if (socket.readyState === socket.OPEN) socket.send(text);
  }
}
