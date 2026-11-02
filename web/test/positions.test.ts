import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { Position } from '../src/api/hooks';
import { PositionSaver, type SendLayout } from '../src/graph/positions';

type Call = { positions: Position[]; keepalive: boolean | undefined };

function recorder(fail: (n: number) => Error | undefined = () => undefined) {
  const calls: Call[] = [];
  const send: SendLayout = (positions, options) => {
    calls.push({ positions, keepalive: options.keepalive });
    const err = fail(calls.length);
    return err === undefined ? Promise.resolve({ updated: positions.length, skipped: [] }) : Promise.reject(err);
  };
  return { calls, send };
}

const at = (id: string, x: number, y = 0): Position => ({ id, x, y });

describe('PositionSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('drags close together are sent as one PUT after the pause', async () => {
    const { calls, send } = recorder();
    const saver = new PositionSaver(send, { delayMs: 500 });
    saver.queue([at('a', 1)]);
    await vi.advanceTimersByTimeAsync(300);
    saver.queue([at('b', 2)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(0); // the second drag restarted the timer
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([{ positions: [at('a', 1), at('b', 2)], keepalive: undefined }]);
  });

  test('dragging the same node again keeps only its last position', async () => {
    const { calls, send } = recorder();
    const saver = new PositionSaver(send);
    saver.queue([at('a', 1)]);
    saver.queue([at('a', 5, 6)]);
    await vi.runAllTimersAsync();
    expect(calls[0]?.positions).toEqual([at('a', 5, 6)]);
  });

  test('aggregate nodes are never sent (the server would reject the batch)', async () => {
    const { calls, send } = recorder();
    const saver = new PositionSaver(send);
    saver.queue([at('agg:0123456789abcdef:has_subdomain:subdomain', 1), at('a', 2)]);
    saver.queue([at('agg:root:ip', 3)]);
    await vi.runAllTimersAsync();
    expect(calls.map((c) => c.positions)).toEqual([[at('a', 2)]]);
  });

  test('only aggregates dragged: nothing is sent', async () => {
    const { calls, send } = recorder();
    new PositionSaver(send).queue([at('agg:root:ip', 3)]);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
  });

  test('a network or server error keeps the positions and retries', async () => {
    const onError = vi.fn();
    const onSaved = vi.fn();
    const { calls, send } = recorder((n) => (n === 1 ? new ApiError(503, 'unavailable') : undefined));
    const saver = new PositionSaver(send, { delayMs: 500, retryMs: 5000, onError, onSaved });
    saver.queue([at('a', 1)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledOnce();
    expect(saver.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map((c) => c.positions)).toEqual([[at('a', 1)], [at('a', 1)]]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(saver.pendingCount).toBe(0);
  });

  test('a newer drag made while the save failed wins over the failed batch', async () => {
    let reject: (e: unknown) => void = () => undefined;
    const calls: Position[][] = [];
    const send: SendLayout = (positions) => {
      calls.push(positions);
      if (calls.length === 1) return new Promise((_, r) => (reject = r));
      return Promise.resolve();
    };
    const saver = new PositionSaver(send, { retryMs: 1000 });
    const first = saver.flush(); // nothing pending: no request
    await first;
    saver.queue([at('a', 1)]);
    const sending = saver.flush();
    saver.queue([at('a', 9)]);
    reject(new TypeError('Failed to fetch'));
    await sending;
    await vi.runAllTimersAsync();
    expect(calls).toEqual([[at('a', 1)], [at('a', 9)]]);
  });

  test('a 4xx is reported and not retried: the batch itself is wrong', async () => {
    const onError = vi.fn();
    const { calls, send } = recorder(() => new ApiError(400, 'unknown node IDs; nothing was saved'));
    const saver = new PositionSaver(send, { onError });
    saver.queue([at('a', 1)]);
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(saver.pendingCount).toBe(0);
  });

  test('flush sends at once, with keepalive for page unload', async () => {
    const { calls, send } = recorder();
    const saver = new PositionSaver(send, { delayMs: 10_000 });
    saver.queue([at('a', 1)]);
    await saver.flush({ keepalive: true });
    expect(calls).toEqual([{ positions: [at('a', 1)], keepalive: true }]);
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1); // the debounce timer was cancelled
  });

  test('sends never overlap: a flush waits for the one in flight', async () => {
    let release: () => void = () => undefined;
    const calls: Position[][] = [];
    let inflight = 0;
    let maxInflight = 0;
    const send: SendLayout = async (positions) => {
      calls.push(positions);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      inflight--;
    };
    const saver = new PositionSaver(send);
    saver.queue([at('a', 1)]);
    const one = saver.flush();
    saver.queue([at('b', 2)]);
    const two = saver.flush();
    release();
    await Promise.all([one, two]);
    expect(calls).toEqual([[at('a', 1)], [at('b', 2)]]);
    expect(maxInflight).toBe(1);
  });

  test('after dispose nothing is scheduled', async () => {
    const { calls, send } = recorder();
    const saver = new PositionSaver(send);
    saver.dispose();
    saver.queue([at('a', 1)]);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
  });
});
