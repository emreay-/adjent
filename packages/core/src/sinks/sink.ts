/**
 * Sinks consume alarms (docs/ALARMS.md § Delivery). Routing by severity is a
 * table edit, not a rule change. The tray/toast sinks live in the desktop
 * shell; core ships console + webhook.
 */
import type { Alarm } from '../model/types.js';
import type { Routing } from '../rules/config.js';

export interface Sink {
  id: string;
  deliver(alarm: Alarm): Promise<void>;
}

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
      await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      });
    } catch {
      /* a failing sink never breaks the loop */
    }
  }
}

export class SinkRouter {
  private readonly sinks = new Map<string, Sink>();
  constructor(private routing: Routing) {}

  register(sink: Sink): void {
    this.sinks.set(sink.id, sink);
  }

  setRouting(routing: Routing): void {
    this.routing = routing;
  }

  async route(alarms: Alarm[]): Promise<void> {
    for (const a of alarms) {
      for (const sinkId of this.routing[a.severity]) {
        const sink = this.sinks.get(sinkId);
        if (sink) await sink.deliver(a).catch(() => {});
      }
    }
  }
}
