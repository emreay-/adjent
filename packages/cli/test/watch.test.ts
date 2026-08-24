/**
 * The JSONL event stream.
 *
 * The property that matters is what a consumer sees on the wire, so these
 * tests assert the exact line sequence — including, crucially, the lines that
 * are *not* written. A stream that republishes an unchanged tick every thirty
 * seconds makes every consumer diff it themselves, which is the work the
 * stream exists to avoid.
 *
 * Timer-free by construction: `WatchStream` is fed events and told the time.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { WatchStream, runWatchLoop, type WatchLoopDeps } from '../src/watch.js';
import type { Alarm, AppState } from '@adjent/core';

const T0 = 1_700_000_000_000;
const S = 1000;
const MACHINE = '11111111-2222-4333-8444-555555555555';

function state(over: Partial<AppState> = {}): AppState {
  return {
    generatedAt: T0,
    backends: [
      {
        id: 'claude',
        displayName: 'Claude Code',
        version: null,
        plan: null,
        rateLimitTier: null,
        health: 'ok',
        healthDetail: null,
      },
    ],
    agents: [
      {
        id: 'claude:a1',
        backend: 'claude',
        label: 'demo',
        projectPath: '/w/demo',
        gitBranch: null,
        model: 'model-x',
        effort: null,
        entrypoint: null,
        parentId: null,
        pid: 1,
        state: 'live',
        startedAt: T0,
        lastActivityAt: T0,
        totals: { input: 1, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
      },
    ],
    limits: [
      {
        limit: {
          backend: 'claude',
          key: '5h',
          label: 'Claude · 5h',
          windowMinutes: 300,
          utilization: 32,
          resetsAt: T0 + 3600_000,
          severity: null,
          vendorActive: false,
          scope: null,
          source: 'reported',
          observedAt: T0,
        },
        burn: null,
        verdict: 'on-pace',
        paceLinePct: null,
        exhaustsAt: null,
        binding: true,
        tokens: null,
      },
    ],
    agentBurns: [],
    epsilon: null,
    fitConfidence: 'low',
    ...over,
  };
}

const alarm = (id: string): Alarm => ({
  id,
  ruleId: 'r1',
  severity: 'warn',
  title: 'Ahead of pace',
  body: 'demo',
  firedAt: T0,
  backend: 'claude',
  limitKey: '5h',
  agentId: null,
});

interface Harness {
  stream: WatchStream;
  lines: () => Record<string, unknown>[];
  raw: () => string[];
}

function harness(heartbeatMs = 300 * S): Harness {
  const raw: string[] = [];
  const stream = new WatchStream((l) => raw.push(l), { machineId: MACHINE, heartbeatMs });
  return {
    stream,
    raw: () => raw,
    lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('the wire format', () => {
  it('writes one parseable object per line, never a fragment', () => {
    const h = harness();
    h.stream.state(state(), T0);
    h.stream.alarm(alarm('a1'), T0 + S);
    for (const line of h.raw()) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('versions every line, so a consumer never has to guess', () => {
    const h = harness();
    h.stream.state(state(), T0);
    h.stream.alarm(alarm('a1'), T0 + S);
    h.stream.error('claude', 'boom', T0 + 2 * S);
    expect(h.lines().map((l) => l['schemaVersion'])).toEqual([1, 1, 1]);
    expect(h.lines().map((l) => l['type'])).toEqual(['state', 'alarm', 'error']);
  });

  it('carries the documented snapshot inside a state line', () => {
    const h = harness();
    h.stream.state(state(), T0);
    const snap = h.lines()[0]!['snapshot'] as Record<string, unknown>;
    expect(snap['machineId']).toBe(MACHINE);
    expect(snap['schemaVersion']).toBe(1);
    expect((snap['limits'] as Record<string, unknown>[])[0]!['bindingLimit']).toBe(true);
  });
});

describe('silence is the hard part', () => {
  it('publishes the first tick, so a new consumer gets a baseline', () => {
    const h = harness();
    expect(h.stream.state(state(), T0)).toBe(true);
    expect(h.lines()[0]!['changed']).toBe(true);
  });

  it('says nothing when a tick changed nothing a consumer can act on', () => {
    const h = harness();
    h.stream.state(state(), T0);
    expect(h.stream.state(state(), T0 + 30 * S)).toBe(false);
    expect(h.stream.state(state(), T0 + 60 * S)).toBe(false);
    expect(h.raw()).toHaveLength(1);
  });

  it('publishes when utilization moves', () => {
    const h = harness();
    h.stream.state(state(), T0);
    const moved = state();
    moved.limits[0]!.limit.utilization = 33;
    expect(h.stream.state(moved, T0 + 30 * S)).toBe(true);
  });

  it('ignores drift too small to round to a point', () => {
    // 32.0 → 32.4 is not an event; republishing it would be churn.
    const h = harness();
    h.stream.state(state(), T0);
    const drifted = state();
    drifted.limits[0]!.limit.utilization = 32.4;
    expect(h.stream.state(drifted, T0 + 30 * S)).toBe(false);
  });

  it('publishes when the agent set changes', () => {
    const h = harness();
    h.stream.state(state(), T0);
    const gone = state({ agents: [] });
    expect(h.stream.state(gone, T0 + 30 * S)).toBe(true);
  });

  it('does not publish for an agent merely doing more of the same', () => {
    // Token totals climb constantly; they are not, by themselves, news.
    const h = harness();
    h.stream.state(state(), T0);
    const busier = state();
    busier.agents[0]!.totals.input = 999_999;
    expect(h.stream.state(busier, T0 + 30 * S)).toBe(false);
  });

  it('publishes when a backend stops being healthy', () => {
    const h = harness();
    h.stream.state(state(), T0);
    const sick = state();
    sick.backends[0]!.health = 'degraded';
    expect(h.stream.state(sick, T0 + 30 * S)).toBe(true);
  });

  it('heartbeats, so a quiet stream is distinguishable from a dead one', () => {
    const h = harness(300 * S);
    h.stream.state(state(), T0);
    expect(h.stream.state(state(), T0 + 299 * S)).toBe(false);
    expect(h.stream.state(state(), T0 + 300 * S)).toBe(true);
    // A heartbeat is flagged, so a consumer can skip it without diffing.
    expect(h.lines()[1]!['changed']).toBe(false);
  });

  it('restarts the heartbeat clock after a real change', () => {
    const h = harness(300 * S);
    h.stream.state(state(), T0);
    const moved = state();
    moved.limits[0]!.limit.utilization = 40;
    h.stream.state(moved, T0 + 100 * S);
    // The change reset the clock: 250s later is not yet due.
    expect(h.stream.state(moved, T0 + 350 * S)).toBe(false);
    expect(h.stream.state(moved, T0 + 400 * S)).toBe(true);
  });
});

describe('events that are always news', () => {
  it('publishes every alarm, including a repeat', () => {
    const h = harness();
    h.stream.alarm(alarm('a1'), T0);
    h.stream.alarm(alarm('a1'), T0 + S);
    expect(h.raw()).toHaveLength(2);
  });

  it('publishes an error without ending the stream', () => {
    const h = harness();
    h.stream.error('codex', 'format drift', T0);
    // A failed backend must not read as quiet, and must not stop the rest.
    expect(h.lines()[0]).toMatchObject({ type: 'error', backend: 'codex', detail: 'format drift' });
    expect(h.stream.state(state(), T0 + S)).toBe(true);
  });

  it('allows an error with no backend attached', () => {
    const h = harness();
    h.stream.error(null, 'tick failed', T0);
    expect(h.lines()[0]!['backend']).toBeNull();
  });
});

describe('the stream loop', () => {
  /** A sleep that never fires on its own — only a stop can end it. */
  const heldSleep = (): { sleep: WatchLoopDeps['sleep']; sleeping: () => boolean } => {
    let waiting = false;
    return {
      sleeping: () => waiting,
      sleep: (_ms, onWake) =>
        new Promise<void>((resolve) => {
          waiting = true;
          onWake(() => {
            waiting = false;
            resolve();
          });
        }),
    };
  };

  it('keeps streaming after a tick throws, rather than dying', async () => {
    const h = harness();
    let n = 0;
    const { sleep } = heldSleep();
    const loop = runWatchLoop({
      tick: async () => {
        n += 1;
        if (n === 1) throw new Error('transient read failure');
        return state();
      },
      stream: h.stream,
      intervalMs: 1,
      now: () => T0 + n * S,
      sleep,
    });
    // Let the first (failing) tick run, then release the sleep twice.
    await Promise.resolve();
    loop.stop();
    await loop.done;

    // A failed tick is reported as an error line, never as silence.
    expect(h.lines()[0]).toMatchObject({ type: 'error', backend: null });
    expect(h.lines()[0]!['detail']).toBe('transient read failure');
  });

  it('stops during the sleep, not after it', async () => {
    // The bug this guards: registering a SIGINT handler replaces Node's
    // default "die now", so a non-interruptible sleep makes Ctrl-C hang for a
    // whole interval — indistinguishable from a wedged process.
    const h = harness();
    const held = heldSleep();
    const loop = runWatchLoop({
      tick: async () => state(),
      stream: h.stream,
      // An interval no test would ever wait out.
      intervalMs: 60 * 60 * 1000,
      now: () => T0,
      sleep: held.sleep,
    });

    // Give the first tick a turn, so the loop reaches the sleep.
    await new Promise((r) => setTimeout(r, 5));
    expect(held.sleeping(), 'loop should be parked in the sleep').toBe(true);

    loop.stop();
    // Resolves promptly, without the hour elapsing.
    await loop.done;
    expect(held.sleeping()).toBe(false);
  });

  it('is idempotent about stopping', async () => {
    const h = harness();
    const held = heldSleep();
    const loop = runWatchLoop({
      tick: async () => state(),
      stream: h.stream,
      intervalMs: 60_000,
      now: () => T0,
      sleep: held.sleep,
    });
    await new Promise((r) => setTimeout(r, 5));
    loop.stop();
    loop.stop();
    await loop.done;
    expect(h.raw()).toHaveLength(1);
  });

  it('publishes the baseline before it can be stopped', async () => {
    const h = harness();
    const held = heldSleep();
    const loop = runWatchLoop({
      tick: async () => state(),
      stream: h.stream,
      intervalMs: 60_000,
      now: () => T0,
      sleep: held.sleep,
    });
    await new Promise((r) => setTimeout(r, 5));
    loop.stop();
    await loop.done;
    // A consumer attaching and immediately detaching still got one state line.
    expect(h.lines()[0]!['type']).toBe('state');
  });
});
