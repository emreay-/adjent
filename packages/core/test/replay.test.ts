/**
 * Replay is the credibility layer: the difference between a threshold someone
 * picked and one someone checked. These tests are its spec (docs/ALARMS.md
 * § Testing).
 *
 * The property that matters most is not "does it fire" but **"does it ever
 * claim silence it did not earn"**. A replay that reports "no alarms" for a
 * rule it could not evaluate is worse than no replay at all, because the reader
 * draws a confident and wrong conclusion. That case has its own section.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { replayHistory } from '../src/rules/replay.js';
import type { HistorySample } from '../src/persist.js';
import type { Rule } from '../src/model/types.js';

const M = 60_000;
const H = 3600_000;
/** A round window boundary, so reconstructed resets land predictably. */
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % (5 * H));
const KEY = 'claude:session';

/** Utilization climbing linearly from `from` to `to` over `n` samples. */
const ramp = (n: number, from: number, to: number, stepMs = 5 * M, key = KEY): HistorySample[] =>
  Array.from({ length: n }, (_, i) => ({
    t: T0 + i * stepMs,
    w: key,
    u: from + ((to - from) * i) / Math.max(1, n - 1),
  }));

const paceRule = (over: Partial<Extract<Rule, { type: 'pace' }>> = {}): Rule => ({
  id: 'pace-any',
  type: 'pace',
  backend: 'any',
  limit: 'any',
  tolerancePp: 10,
  exhaustionLeadMin: 45,
  cooldownMin: 20,
  severity: 'warn',
  ...over,
});

const thresholdRule = (levels: number[]): Rule => ({
  id: 'steps',
  type: 'threshold',
  backend: 'any',
  limit: 'any',
  levels,
  severity: {},
});

const burnRule = (): Rule => ({
  id: 'runaway',
  type: 'agent_burn',
  windowMin: 10,
  relToMedian: 4,
  sharePct: 60,
  absPctPerHour: 8,
  cooldownMin: 15,
  severity: 'warn',
});

describe('what replay does not claim to know', () => {
  it('reports an agent rule as not evaluable, never as silent', () => {
    // The failure this whole design guards against: answering "no alarms" for
    // a rule history cannot possibly answer.
    const r = replayHistory(ramp(20, 0, 90), [burnRule()]);
    expect(r.alarms).toEqual([]);
    expect(r.notEvaluable).toHaveLength(1);
    expect(r.notEvaluable[0]).toMatchObject({ ruleId: 'runaway', type: 'agent_burn' });
    expect(r.notEvaluable[0]!.reason).toContain('per-agent');
    // And it is absent from byRule, so a zero there always means "ran, quiet".
    expect(r.byRule).not.toHaveProperty('runaway');
  });

  it('still runs the rules it can, alongside one it cannot', () => {
    const r = replayHistory(ramp(30, 0, 95, 5 * M), [paceRule(), burnRule()]);
    expect(r.notEvaluable.map((n) => n.ruleId)).toEqual(['runaway']);
    expect(Object.keys(r.byRule)).toEqual(['pace-any']);
  });

  it('zero-fills a rule that ran and stayed quiet, so silence is meaningful', () => {
    // Flat at 5%: nothing to say, but the rule was genuinely asked.
    const r = replayHistory(ramp(20, 5, 5), [paceRule()]);
    expect(r.byRule).toEqual({ 'pace-any': 0 });
    expect(r.notEvaluable).toEqual([]);
  });
});

describe('pace', () => {
  it('fires on a front-loaded limit', () => {
    // 0 → 80% in the first hour of a five-hour window: far ahead of the line.
    const r = replayHistory(ramp(13, 0, 80, 5 * M), [paceRule()]);
    expect(r.alarms.length).toBeGreaterThan(0);
    expect(r.alarms[0]!.alarm.ruleId).toBe('pace-any');
    // The sample that caused it is carried, so a caller can show its input.
    expect(r.alarms[0]!.sample.w).toBe(KEY);
    expect(r.alarms[0]!.sample.u).toBeGreaterThan(0);
  });

  it('stays silent on a limit tracking its pace line', () => {
    // Five hours, 0 → 100% linearly: exactly on pace the whole way.
    const r = replayHistory(ramp(61, 0, 100, 5 * M), [paceRule()]);
    expect(r.byRule['pace-any']).toBe(0);
  });

  it('stays silent on a limit that barely moves', () => {
    const r = replayHistory(ramp(40, 2, 4), [paceRule()]);
    expect(r.byRule['pace-any']).toBe(0);
  });

  it('honours the cooldown rather than firing every sample', () => {
    const samples = ramp(40, 0, 95, 5 * M);
    const often = replayHistory(samples, [paceRule({ cooldownMin: 5 })]);
    const rarely = replayHistory(samples, [paceRule({ cooldownMin: 120 })]);
    expect(rarely.byRule['pace-any']!).toBeLessThan(often.byRule['pace-any']!);
  });
});

describe('threshold', () => {
  it('announces each level once as utilization climbs past it', () => {
    const r = replayHistory(ramp(40, 0, 95, 5 * M), [thresholdRule([25, 50, 80])]);
    expect(r.byRule['steps']).toBeGreaterThan(0);
    // A level is announced once, not on every sample above it.
    expect(r.byRule['steps']).toBeLessThanOrEqual(3);
  });

  it('rearms after a reset partway through the file', () => {
    // Climb to 90, drop to 5 (the window rolled over), climb again.
    const first = ramp(20, 0, 90, 5 * M);
    const after = ramp(20, 5, 90, 5 * M).map((s) => ({ ...s, t: s.t + 6 * H }));
    const once = replayHistory(first, [thresholdRule([80])]);
    const twice = replayHistory([...first, ...after], [thresholdRule([80])]);
    // The same level must be able to fire again in the new window.
    expect(twice.byRule['steps']!).toBeGreaterThan(once.byRule['steps']!);
  });

  it('says nothing when the limit never reaches a level', () => {
    const r = replayHistory(ramp(20, 0, 20, 5 * M), [thresholdRule([50, 80])]);
    expect(r.byRule['steps']).toBe(0);
  });
});

describe('the shape of the answer', () => {
  it('replays in timestamp order regardless of input order', () => {
    // Cooldowns and rearming only mean anything if events arrive as they
    // happened, so shuffled input must not change the result.
    const samples = ramp(30, 0, 95, 5 * M);
    const shuffled = [...samples].reverse();
    const a = replayHistory(samples, [paceRule()]);
    const b = replayHistory(shuffled, [paceRule()]);
    expect(b.byRule).toEqual(a.byRule);
    expect(b.alarms.map((x) => x.alarm.firedAt)).toEqual(a.alarms.map((x) => x.alarm.firedAt));
  });

  it('reports the span it covered', () => {
    const samples = ramp(10, 0, 50, 5 * M);
    const r = replayHistory(samples, [paceRule()]);
    expect(r.samples).toBe(10);
    expect(r.from).toBe(T0);
    expect(r.to).toBe(T0 + 9 * 5 * M);
  });

  it('reports the longest quiet stretch between alarms', () => {
    const r = replayHistory(ramp(60, 0, 99, 5 * M), [paceRule({ cooldownMin: 30 })]);
    if (r.alarms.length > 1) {
      // A rule that fires every four minutes is noise; this is the number that
      // tells you which kind you have.
      expect(r.longestSilenceMs).toBeGreaterThan(0);
    } else {
      expect(r.longestSilenceMs).toBeNull();
    }
  });

  it('handles an empty history without inventing anything', () => {
    const r = replayHistory([], [paceRule()]);
    expect(r).toMatchObject({ alarms: [], samples: 0, from: null, to: null, longestSilenceMs: null });
    expect(r.byRule).toEqual({ 'pace-any': 0 });
  });

  it('is pure: replaying twice gives the same answer', () => {
    const samples = ramp(30, 0, 95, 5 * M);
    const a = replayHistory(samples, [paceRule()]);
    const b = replayHistory(samples, [paceRule()]);
    expect(b.alarms.map((x) => x.alarm.id)).toEqual(a.alarms.map((x) => x.alarm.id));
    // And the input is untouched.
    expect(samples[0]!.t).toBe(T0);
  });

  it('takes the window length per limit, since history never recorded it', () => {
    const samples = ramp(30, 0, 95, 30 * M, 'claude:weekly_all');
    const asWeekly = replayHistory(samples, [paceRule()], {
      windowMinutes: { 'claude:weekly_all': 10_080 },
    });
    const asFiveHour = replayHistory(samples, [paceRule()], { defaultWindowMinutes: 300 });
    // The same samples judged against different windows are different stories:
    // burning 95% of a week in 15 hours is alarming, of five hours is not.
    expect(asWeekly.byRule['pace-any']).not.toBe(asFiveHour.byRule['pace-any']);
  });

  it('keeps limits apart when the file interleaves them', () => {
    const a = ramp(20, 0, 95, 5 * M, 'claude:session');
    const b = ramp(20, 1, 3, 5 * M, 'claude:weekly_all');
    const r = replayHistory([...a, ...b], [paceRule()]);
    // Only the climbing limit should be responsible for any alarm.
    for (const x of r.alarms) expect(x.sample.w).toBe('claude:session');
  });
});
