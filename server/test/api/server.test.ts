import { wsEventSchema, type WsEvent } from '@redwhale/shared';
import { describe, expect, test, vi } from 'vitest';
import { listenOptions } from '../../src/listen';
import { exampleDoc } from '../helpers';
import { HOST, error, idOf, ingestExamples, testApi } from './helpers';

describe('localhost only', () => {
  test('binds to 127.0.0.1:4100 by default; only the port can change', () => {
    expect(listenOptions({})).toEqual({ host: '127.0.0.1', port: 4100 });
    expect(listenOptions({ REDWHALE_PORT: '5000' })).toEqual({ host: '127.0.0.1', port: 5000 });
    expect(() => listenOptions({ REDWHALE_PORT: 'abc' })).toThrow('is not a port');
  });

  test.each(['127.0.0.1:4100', 'localhost:4100', 'localhost:5173', '127.0.0.1:5173'])('Host %s is accepted', async (host) => {
    const api = await testApi();
    expect((await api.request({ method: 'GET', url: '/api/stats', headers: { host } })).statusCode).toBe(200);
  });

  test.each(['evil.test', 'evil.test:4100', '127.0.0.1:9999', '192.168.1.5:4100'])(
    'Host %s → 403 (DNS rebinding)',
    async (host) => {
      const api = await testApi();
      error(await api.request({ method: 'GET', url: '/api/stats', headers: { host } }), 403, 'is not allowed');
    },
  );

  test('a foreign Origin → 403; our UI origin is fine', async () => {
    const api = await testApi();
    const foreign = await api.request({ method: 'POST', url: '/api/ingest', payload: exampleDoc('nmap'), headers: { origin: 'https://evil.test' } });
    error(foreign, 403, "origin 'https://evil.test' is not allowed");
    const ours = await api.request({ method: 'GET', url: '/api/stats', headers: { origin: 'http://localhost:5173' } });
    expect(ours.statusCode).toBe(200);
  });

  test('a port the app was built for is accepted', async () => {
    const api = await testApi({ port: 5000 });
    expect((await api.request({ method: 'GET', url: '/api/stats', headers: { host: 'localhost:5000' } })).statusCode).toBe(200);
    error(await api.request({ method: 'GET', url: '/api/stats', headers: { host: HOST } }), 403);
  });
});

test('unknown route → 404 JSON', async () => {
  const api = await testApi();
  error(await api.get('/api/nope'), 404, 'no route GET /api/nope');
});

describe('WS /api/ws', () => {
  async function connect() {
    const api = await testApi();
    const events: WsEvent[] = [];
    const socket = await api.app.injectWS('/api/ws', { headers: { host: HOST } });
    socket.on('message', (data: Buffer) => {
      events.push(wsEventSchema.parse(JSON.parse(data.toString())));
    });
    return { api, events, socket };
  }

  test('an ingest sends scan.ingested, then graph.updated with the touched IDs', async () => {
    const { api, events, socket } = await connect();
    const res = await api.send('POST', '/api/ingest', exampleDoc('nmap'));
    const { scanId, nodeIds } = res.json<{ scanId: string; nodeIds: string[] }>();
    await vi.waitFor(() => {
      expect(events).toHaveLength(2);
    });
    expect(events[0]).toEqual({ type: 'scan.ingested', scanId, tool: 'nmap' });
    expect(events[1]).toMatchObject({ type: 'graph.updated', nodeIds });
    socket.terminate();
  });

  test('a duplicate ingest sends nothing', async () => {
    const { api, events, socket } = await connect();
    await api.send('POST', '/api/ingest', exampleDoc('nmap'));
    await vi.waitFor(() => {
      expect(events).toHaveLength(2);
    });
    await api.send('POST', '/api/ingest', exampleDoc('nmap'));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(2);
    socket.terminate();
  });

  test('a PATCH sends graph.updated for that node', async () => {
    const { api, events, socket } = await connect();
    ingestExamples(api.db);
    const id = idOf(api.db, 'api.example.com');
    await api.send('PATCH', `/api/nodes/${id}`, { tag: 'checked' });
    await vi.waitFor(() => {
      expect(events).toEqual([{ type: 'graph.updated', nodeIds: [id], edgeIds: [] }]);
    });
    socket.terminate();
  });

  test('a foreign Origin cannot open the socket', async () => {
    const api = await testApi();
    await expect(api.app.injectWS('/api/ws', { headers: { host: HOST, origin: 'https://evil.test' } })).rejects.toThrow();
  });
});
