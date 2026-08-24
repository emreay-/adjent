/**
 * The event stream: `adjent watch --json` as JSONL.
 *
 * One JSON object per line, flushed as it happens, never batched — a consumer
 * reading with `while read -r line` must be able to act on the first event
 * without waiting for a second.
 *
 * The design problem is *silence*. Ticking every 30 seconds and emitting each
 * tick would produce a line a minute per machine whether or not anything
 * happened, which turns a fleet's stream into noise a consumer has to diff
 * itself. So a `state` line is emitted only when something a consumer could act
 * on has changed — or on a heartbeat, so that a long quiet period is
 * distinguishable from a dead process.
 *
 * This class is deliberately timer-free: it is fed events and told the time.
 * The loop that owns the clock lives in main.ts, and the decisions live here
 * where they can be tested without waiting.
 */
import { SCHEMA_VERSION, toSnapshot, type Alarm, type AppState } from '@adjent/core';

export interface WatchOptions {
  machineId: string;
  /** Emit a state line at least this often, even when nothing changed. */
  heartbeatMs: number;
}

/** What a consumer can act on. Anything else is churn and stays off the wire. */
interface Signature {
  /** limit key → utilization, rounded: sub-point drift is not an event. */
  limits: string;
  /** The set of live agent ids. */
  agents: string;
  /** backend id → health. */
  health: string;
}

function signature(state: AppState): Signature {
  return {
    limits: state.limits
      .map((a) => `${a.limit.backend}:${a.limit.key}=${Math.round(a.limit.utilization)}`)
      .sort()
      .join(','),
    agents: state.agents
      .filter((a) => a.state !== 'ended')
      .map((a) => a.id)
      .sort()
      .join(','),
    health: state.backends
      .map((b) => `${b.id}=${b.health}`)
      .sort()
      .join(','),
  };
}

const same = (a: Signature, b: Signature): boolean =>
  a.limits === b.limits && a.agents === b.agents && a.health === b.health;

export class WatchStream {
  private last: Signature | null = null;
  private lastEmitAt = 0;

  constructor(
    private readonly emit: (line: string) => void,
    private readonly opts: WatchOptions,
  ) {}

  private write(body: Record<string, unknown>): void {
    this.emit(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...body }));
  }

  /**
   * Offer a tick. Returns true when it was published.
   *
   * The first tick always publishes: a consumer that has just attached needs a
   * baseline before a change can mean anything.
   */
  state(state: AppState, now: number): boolean {
    const sig = signature(state);
    const changed = this.last === null || !same(this.last, sig);
    const due = now - this.lastEmitAt >= this.opts.heartbeatMs;
    if (!changed && !due) return false;

    this.last = sig;
    this.lastEmitAt = now;
    this.write({
      type: 'state',
      at: now,
      // `changed` lets a consumer skip heartbeats cheaply without diffing.
      changed,
      snapshot: toSnapshot(state, { machineId: this.opts.machineId }),
    });
    return true;
  }

  /** Alarms are always published: an alarm is by definition an event. */
  alarm(alarm: Alarm, now: number): void {
    this.write({ type: 'alarm', at: now, alarm });
  }

  /**
   * A backend failing is news, and it must not be mistaken for quiet. Errors
   * never suppress the stream — degrade one provider, never the app.
   */
  error(backend: string | null, detail: string, now: number): void {
    this.write({ type: 'error', at: now, backend, detail });
  }
}

/** Everything the loop needs, injected so a test can drive it without waiting. */
export interface WatchLoopDeps {
  tick: () => Promise<AppState>;
  stream: WatchStream;
  intervalMs: number;
  now: () => number;
  /** Resolves after `ms`, or early when the loop is asked to stop. */
  sleep: (ms: number, onWake: (fn: () => void) => void) => Promise<void>;
}

/**
 * The stream loop, as a function of its dependencies.
 *
 * Split out of main.ts because the interesting behaviour is all in the edges —
 * a tick that throws must not end the stream, and a stop must be honoured
 * during the sleep rather than after it. Neither is testable while the loop
 * owns a real clock and a real signal handler.
 *
 * Returns a `stop` handle alongside the promise: the caller wires it to SIGINT.
 */
export function runWatchLoop(deps: WatchLoopDeps): { done: Promise<void>; stop: () => void } {
  let stopping = false;
  let wake: (() => void) | null = null;

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // Registering a signal handler replaces Node's default "die now", so the
    // sleep has to be interruptible too — otherwise Ctrl-C on a five-minute
    // interval hangs for up to five minutes and reads as a wedged process.
    wake?.();
  };

  const done = (async () => {
    while (!stopping) {
      try {
        deps.stream.state(await deps.tick(), deps.now());
      } catch (e) {
        // One bad tick must not end the stream: report it and keep going.
        deps.stream.error(null, e instanceof Error ? e.message : String(e), deps.now());
      }
      if (stopping) break;
      await deps.sleep(deps.intervalMs, (fn) => {
        wake = fn;
      });
      wake = null;
    }
  })();

  return { done, stop };
}

/** The real sleep: a timer that can be cancelled from outside. */
export const realSleep = (ms: number, onWake: (fn: () => void) => void): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    onWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
