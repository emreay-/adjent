/**
 * Exchange-rate fit and assessment tests. Synthetic ground truth: we invent
 * true weights, generate consumption + utilization from them, and check the
 * fit recovers usable rates. All values synthetic (CLAUDE.md hygiene rule).
 */
import { describe, expect, it } from 'vitest';
import { UsageLedger } from '../src/quota/ledger.js';
import { ExchangeRateFit } from '../src/quota/fit.js';
import { LimitAssessor, exhaustion, paceLine } from '../src/quota/assess.js';
import type { QuotaLimit, UsageEvent } from '../src/model/types.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** Synthetic truth: percent per token, by kind (blended across one model). */
const TRUE_W = { input: 1e-5, cacheWrite: 1.25e-5, cacheRead: 1e-6, output: 5e-5 };

function ev(ts: number, agentId: string, t: Partial<UsageEvent['tokens']>, model = 'model-x'): UsageEvent {
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, ...t };
  return { ts, backend: 'claude', agentId, model, effort: null, tokens, requests: 1, requestId: `r:${agentId}:${ts}` };
}

const costOf = (e: UsageEvent): number =>
  e.tokens.input * TRUE_W.input +
  e.tokens.cacheWrite * TRUE_W.cacheWrite +
  e.tokens.cacheRead * TRUE_W.cacheRead +
  e.tokens.output * TRUE_W.output;

function quotaWindow(utilization: number, observedAt: number): QuotaLimit {
  return {
    backend: 'claude',
    key: '5h',
    label: 'Claude · 5h',
    windowMinutes: 300,
    utilization,
    resetsAt: T0 + 300 * MIN,
    severity: null,
    vendorActive: false,
    scope: null,
    source: 'reported',
    observedAt,
  };
}

describe('ExchangeRateFit', () => {
  it('bootstraps s0 from the first usable observation and prices agents', () => {
    const ledger = new UsageLedger();
    const fit = new ExchangeRateFit();

    // Simulate 2h: two agents with distinct mixes, poll every 5 minutes.
    let u = 0;
    fit.observePoll(quotaWindow(0, T0), ledger);
    for (let m = 5; m <= 120; m += 5) {
      const ts = T0 + m * MIN;
      const events = [
        ev(ts - MIN, 'claude:heavy', { cacheRead: 2_000_000, output: 30_000 }),
        ev(ts - 2 * MIN, 'claude:light', { input: 5_000, output: 2_000 }),
      ];
      ledger.add(events);
      u += events.reduce((s, e) => s + costOf(e), 0);
      fit.observePoll(quotaWindow(u, ts), ledger);
    }
    expect(fit.bootstrapped).toBe(true);
    const result = fit.fit();
    expect(result).not.toBeNull();
    expect(result!.sampleCount).toBeGreaterThan(10);

    // Priced burn over the last 10 minutes should be near the true cost.
    const heavyTrue = costOf(ev(0, 'x', { cacheRead: 2_000_000, output: 30_000 })) * 2; // two events in the lookback
    const heavyFit = fit.priceAgentConsumption(ledger, 'claude:heavy', T0 + 110 * MIN, T0 + 120 * MIN, result!);
    expect(heavyFit).toBeGreaterThan(heavyTrue * 0.5);
    expect(heavyFit).toBeLessThan(heavyTrue * 2.0);

    // And the heavy agent must price well above the light one.
    const lightFit = fit.priceAgentConsumption(ledger, 'claude:light', T0 + 110 * MIN, T0 + 120 * MIN, result!);
    expect(heavyFit).toBeGreaterThan(lightFit * 5);
  });

  it('skips reset rows and can rebootstrap', () => {
    const ledger = new UsageLedger();
    const fit = new ExchangeRateFit();
    fit.observePoll(quotaWindow(80, T0), ledger);
    // reset: utilization collapses — must not produce a poisonous row
    fit.observePoll(quotaWindow(2, T0 + 5 * MIN), ledger);
    expect(fit.bootstrapped).toBe(false); // nothing usable yet
    fit.rebootstrap();
    expect(fit.fit()).toBeNull();
  });
});

describe('LimitAssessor', () => {
  it('computes a stable burn rate from steady polls and resets on rollover', () => {
    const assessor = new LimitAssessor();
    // 20%/h steady climb, polls every 5 min
    let last: ReturnType<LimitAssessor['assess']> = [];
    for (let m = 0; m <= 60; m += 5) {
      const u = (20 / 60) * m;
      last = assessor.assess([quotaWindow(u, T0 + m * MIN)], T0 + m * MIN);
    }
    const burn = last[0]!.burn;
    expect(burn).not.toBeNull();
    expect(burn!.pctPerHour).toBeGreaterThan(15);
    expect(burn!.pctPerHour).toBeLessThan(25);

    // rollover: resetsAt jumps forward, utilization drops → EWMA restarts
    const rolled: QuotaLimit = { ...quotaWindow(1, T0 + 65 * MIN), resetsAt: T0 + 600 * MIN };
    const after = assessor.assess([rolled], T0 + 65 * MIN);
    expect(after[0]!.burn === null || Math.abs(after[0]!.burn.pctPerHour) < 15).toBe(true);
  });

  it('binding selection: earliest exhaustion beats highest utilization, with hysteresis', () => {
    const assessor = new LimitAssessor();
    const mkShort = (u: number, at: number): QuotaLimit => quotaWindow(u, at);
    const mkWeekly = (u: number, at: number): QuotaLimit => ({
      ...quotaWindow(u, at),
      key: '7d',
      label: 'Claude · 7d',
      windowMinutes: 10_080,
      resetsAt: T0 + 6 * 24 * 60 * MIN,
    });

    // Weekly sits at 84% but burns slowly; short window climbs fast.
    let result: ReturnType<LimitAssessor['assess']> = [];
    for (let m = 0; m <= 60; m += 5) {
      const at = T0 + m * MIN;
      result = assessor.assess([mkWeekly(84 + m * 0.01, at), mkShort(30 + m, at)], at);
    }
    const binding = result.find((a) => a.binding);
    expect(binding?.limit.key).toBe('5h'); // exhausting before reset → binds despite lower %
  });

  it('vendor is_active wins outright', () => {
    const assessor = new LimitAssessor();
    const scoped: QuotaLimit = {
      ...quotaWindow(60, T0),
      key: 'weekly_scoped:model-x',
      label: 'Claude · 7d · Model X',
      windowMinutes: 10_080,
      vendorActive: true,
    };
    const result = assessor.assess([quotaWindow(90, T0), scoped], T0);
    expect(result.find((a) => a.binding)?.limit.key).toBe('weekly_scoped:model-x');
  });
});

describe('pace helpers', () => {
  it('pace line at 40% two hours into a five-hour window', () => {
    const w = quotaWindow(50, T0 + 120 * MIN);
    expect(paceLine(w, T0 + 120 * MIN)).toBeCloseTo(40, 5);
  });

  it('exhaustion is null at zero burn (never ∞ in the UI)', () => {
    const w = quotaWindow(50, T0);
    expect(exhaustion(w, { pctPerHour: 0, updatedAt: T0 }, T0)).toBeNull();
    expect(exhaustion(w, null, T0)).toBeNull();
  });
});
