import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from '../src/collect/deadline.js';
import { WebhookSink, SinkRouter } from '../src/sinks/sink.js';
import type { Alarm } from '../src/model/types.js';

afterEach(() => { vi.useRealTimers(); });

describe('network deadlines', () => {
  it('cancels I/O even if an operation never settles', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = withDeadline((s) => {
      signal = s;
      return new Promise(() => {});
    });
    const result = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the deadline on success and on failure', async () => {
    vi.useFakeTimers();
    expect(await withDeadline(async () => 42)).toBe(42);
    await expect(withDeadline(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stalled webhook cannot prevent the next sink from receiving an alarm', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const router = new SinkRouter({ info: [], warn: ['webhook', 'toast'], critical: [] });
    router.register(new WebhookSink('https://example.invalid/alarms', fetchFn));
    const deliver = vi.fn(async () => {});
    router.register({ id: 'toast', deliver });
    const alarm = { severity: 'warn', title: 'Synthetic alarm' } as Alarm;
    const pending = router.route([alarm]);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(deliver).toHaveBeenCalledWith(alarm);
  });
});
