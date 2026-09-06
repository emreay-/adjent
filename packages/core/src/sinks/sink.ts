/**
 * Sinks consume alarms (docs/ALARMS.md § Delivery). Routing by severity is a
 * table edit, not a rule change. The tray/toast sinks live in the desktop
 * shell; core ships console + webhook.
 */
import type { Alarm } from '../model/types.js';
import type { Routing } from '../rules/config.js';
import { withDeadline } from '../collect/deadline.js';

export interface Sink {
  id: string;
  deliver(alarm: Alarm): Promise<void>;
}

/**
 * Every sink id the product knows how to build, across both shells. Routing
 * tables are validated against this (rules/config.ts) so a typo is a
 * diagnostic rather than silence; `SinkRouter` reports the ones that are known
 * but not registered in *this* process. The two checks answer different
 * questions: "is this a sink?" and "is it wired up here?".
 */
export const KNOWN_SINK_IDS = ['console', 'webhook', 'tray', 'toast'] as const;
export type KnownSinkId = (typeof KNOWN_SINK_IDS)[number];

export class ConsoleSink implements Sink {
  readonly id = 'console';
  async deliver(a: Alarm): Promise<void> {
    const mark = a.severity === 'critical' ? '■' : a.severity === 'warn' ? '▲' : '·';
    // eslint-disable-next-line no-console
    console.log(`${mark} [${a.severity}] ${a.title}\n  ${a.body}`);
  }
}

export class WebhookSink implements Sink {
  readonly id = 'webhook';
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async deliver(a: Alarm): Promise<void> {
    try {
      await withDeadline(async (signal) => {
        const response = await this.fetchFn(this.url, {
          signal,
          redirect: 'error',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(a),
        });
        await response.body?.cancel();
      });
    } catch {
      /* a failing sink never breaks the loop */
    }
  }
}

export class SinkRouter {
  private readonly sinks = new Map<string, Sink>();
  /** Ids already reported unroutable, so a live loop warns once, not per tick. */
  private readonly reported = new Set<string>();
  /**
   * Called the first time a routed sink id has no registered sink. Optional so
   * the router stays usable in tests, but both shells pass one: an alarm that
   * silently goes nowhere is worse than no alarm, because the user believes
   * they are covered.
   */
  private onUnroutable?: (sinkId: string, severity: Alarm['severity']) => void;

  constructor(private routing: Routing) {}

  register(sink: Sink): void {
    this.sinks.set(sink.id, sink);
    // A sink registered late (a URL arriving from settings) clears its warning.
    this.reported.delete(sink.id);
  }

  /** Ids named by the current routing table that nothing has registered here. */
  unroutable(): string[] {
    const missing = new Set<string>();
    for (const ids of Object.values(this.routing)) {
      for (const id of ids) if (!this.sinks.has(id)) missing.add(id);
    }
    return [...missing];
  }

  setUnroutableReporter(fn: (sinkId: string, severity: Alarm['severity']) => void): void {
    this.onUnroutable = fn;
  }

  setRouting(routing: Routing): void {
    this.routing = routing;
    // A reload may have introduced a new bad id, or fixed an old one.
    this.reported.clear();
  }

  async route(alarms: Alarm[]): Promise<void> {
    for (const a of alarms) {
      for (const sinkId of this.routing[a.severity]) {
        const sink = this.sinks.get(sinkId);
        if (sink) {
          await sink.deliver(a).catch(() => {});
        } else if (!this.reported.has(sinkId)) {
          this.reported.add(sinkId);
          this.onUnroutable?.(sinkId, a.severity);
        }
      }
    }
  }
}
