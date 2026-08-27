/**
 * A burn rate is a measurement, and a measurement has a moment.
 *
 * The bug these protect against: a Codex limit publishes its reading inside
 * transcript lines, so when nothing is running no reading arrives and
 * `observedAt` freezes. The assessor kept returning the last EWMA verbatim, so
 * a limit with no agents went on claiming a rate — and, through `exhaustion`,
 * a wall four days out — from a reading taken the previous night.
 */
import { describe, expect, it } from 'vitest';
import { LimitAssessor } from '../src/quota/assess.js';
import type { QuotaLimit } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3600_000;

const limit = (utilization: number, observedAt: number, windowMinutes = 10_080): QuotaLimit => ({
  backend: 'codex',
  key: windowMinutes === 10_080 ? '7d' : '5h',
  label: windowMinutes === 10_080 ? 'Codex · 7d' : 'Codex · 5h',
  windowMinutes,
  utilization,
  resetsAt: T0 + 6 * 24 * HOUR,
  severity: null,
  vendorActive: false,
  scope: null,
  source: 'reported',
  observedAt,
});

/** Feed readings that move, then stop feeding. Returns the assessor primed. */
function burning(): { a: LimitAssessor; rate: number } {
  const a = new LimitAssessor();
  let last = 0;
  // Ten minutes of steady spend at 6 %/h: one point per minute.
  for (let i = 0; i <= 10; i++) {
    const at = T0 + i * MIN;
    const r = a.assess([limit(i * 0.1, at)], at)[0]!;
    last = r.burn?.pctPerHour ?? 0;
  }
  return { a, rate: last };
}

describe('a limit that is being spent', () => {
  it('reports the rate it measured', () => {
    const { rate } = burning();
    expect(rate).toBeGreaterThan(3);
    expect(rate).toBeLessThan(9);
  });

  it('keeps it across a gap short enough to be one slow turn', () => {
    // Readings arrive whenever a turn ends. A two-minute silence is a long
    // turn, not an idle machine, and must not be read as a stop.
    const { a, rate } = burning();
    const at = T0 + 10 * MIN;
    const r = a.assess([limit(1.0, at)], at + 90_000)[0]!;
    expect(r.burn?.pctPerHour).toBeCloseTo(rate, 6);
  });
});

describe('a limit whose reading has stopped moving', () => {
  it('decays the rate rather than holding it', () => {
    const { a, rate } = burning();
    const frozen = T0 + 10 * MIN;
    // Same reading, ten minutes later on the wall clock.
    const r = a.assess([limit(1.0, frozen)], frozen + 10 * MIN)[0]!;
    const after = r.burn?.pctPerHour ?? 0;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(rate / 2);
  });

  it('decays at the smoothing half-life, past a two-minute grace', () => {
    const { a, rate } = burning();
    const frozen = T0 + 10 * MIN;
    // 2m grace + one 5m half-life still to run → exactly half.
    const r = a.assess([limit(1.0, frozen)], frozen + 7 * MIN)[0]!;
    expect(r.burn?.pctPerHour).toBeCloseTo(rate / 2, 4);
  });

  it('gives up on it entirely once it is below the reporting floor', () => {
    const { a } = burning();
    const frozen = T0 + 10 * MIN;
    const r = a.assess([limit(1.0, frozen)], frozen + 2 * HOUR)[0]!;
    expect(r.burn).toBeNull();
  });

  it('withdraws the exhaustion projection with it', () => {
    // This is the number the user actually saw: "projected out Thu 00:31 —
    // before reset", derived from a rate nothing had confirmed since the
    // previous night.
    const { a } = burning();
    const frozen = T0 + 10 * MIN;
    const fresh = a.assess([limit(1.0, frozen)], frozen)[0]!;
    expect(fresh.exhaustsAt).not.toBeNull();

    const stale = a.assess([limit(1.0, frozen)], frozen + 4 * HOUR)[0]!;
    expect(stale.exhaustsAt).toBeNull();
  });

  it('decays once per elapsed hour, not once per tick', () => {
    // The decay is written back into the track, so it must be incremental:
    // polling four times a minute must not age the estimate four times faster.
    const { a } = burning();
    const frozen = T0 + 10 * MIN;
    for (let i = 1; i <= 40; i++) a.assess([limit(1.0, frozen)], frozen + i * 15_000);
    const often = a.assess([limit(1.0, frozen)], frozen + 10 * MIN)[0]!.burn?.pctPerHour;

    const { a: b } = burning();
    const once = b.assess([limit(1.0, frozen)], frozen + 10 * MIN)[0]!.burn?.pctPerHour;

    expect(often).toBeCloseTo(once as number, 6);
  });
});

describe('a limit that starts moving again', () => {
  /**
   * On a 5-hour limit, whose 15-minute lookback does not span the idle hour.
   * The subject here is EWMA continuity after decay, which is independent of
   * the window; the lookback scaling that W10.1 added is exercised below.
   */
  it('picks the new rate up from the decayed one, not the old one', () => {
    const a = new LimitAssessor();
    const W = 300;
    let rate = 0;
    for (let i = 0; i <= 10; i++) {
      const at = T0 + i * MIN;
      rate = a.assess([limit(i * 0.1, at, W)], at)[0]!.burn?.pctPerHour ?? 0;
    }
    expect(rate).toBeGreaterThan(3);

    const frozen = T0 + 10 * MIN;
    // An hour idle: the old rate is gone.
    expect(a.assess([limit(1.0, frozen, W)], frozen + HOUR)[0]!.burn).toBeNull();

    // Then spend again, at roughly the same pace as before.
    let seen: number | null = null;
    for (let i = 1; i <= 10; i++) {
      const at = frozen + HOUR + i * MIN;
      const r = a.assess([limit(1.0 + i * 0.1, at, W)], at)[0]!;
      seen = r.burn?.pctPerHour ?? null;
    }
    expect(seen).not.toBeNull();
    expect(seen as number).toBeGreaterThan(rate / 2);
  });
});

/**
 * W10.1, reported 2026-08-27: "the current burn rate was not shown on the
 * binding limit (showing a dash), while the 5h limit was showing it".
 *
 * The lookback is now proportional to the limit's own window, because a fixed
 * 15-minute baseline cannot measure a limit that takes a week to fill.
 */
describe('a slow limit still has a measurable rate', () => {
  /**
   * Vendors report utilization in whole points — `{"seven_day": {"utilization":
   * 46.0}}` (docs/DATA-SOURCES.md) — and that quantisation is the whole bug.
   * A 7-day limit filling at ~0.6 %/h holds the same integer for over an hour,
   * so a 15-minute lookback sees no change at all in most windows and one
   * meaningless spike in the window where the integer ticks over. Feeding
   * continuous floats here would measure the rate perfectly and prove nothing.
   */
  function steady(windowMinutes: number, pctPerHour: number, forMinutes: number) {
    const a = new LimitAssessor();
    let last: number | null = null;
    for (let i = 0; i <= forMinutes; i++) {
      const at = T0 + i * MIN;
      const util = Math.floor((pctPerHour * i) / 60);
      last = a.assess([limit(util, at, windowMinutes)], at)[0]!.burn?.pctPerHour ?? null;
    }
    return last;
  }

  it('reports a rate for a 7-day limit that a 15-minute lookback would miss', () => {
    // Twelve hours of steady 0.6 %/h: the reported integer ticks over roughly
    // every 100 minutes, so a 15-minute lookback is blind between ticks.
    const seen = steady(10_080, 0.6, 720);
    expect(seen).not.toBeNull();
    expect(seen as number).toBeGreaterThan(0.3);
    expect(seen as number).toBeLessThan(1.2);
  });

  it('keeps reporting while the integer sits still — the reported dash', () => {
    // The exact symptom: between ticks of the reported integer, a 15-minute
    // lookback sees zero change, the EWMA decays below the floor, and the
    // binding limit renders a dash while a faster limit beside it shows a
    // number. A lookback that spans several ticks does not have this problem.
    const a = new LimitAssessor();
    let at = T0;
    let util = 0;
    // Twelve hours at ~0.6 %/h, reported as whole points.
    for (let i = 0; i <= 720; i++) {
      at = T0 + i * MIN;
      util = Math.floor((0.6 * i) / 60);
      a.assess([limit(util, at, 10_080)], at);
    }
    // Now sit on a plateau. At ~0.6 %/h the reported integer stands still for
    // about a hundred minutes, and the estimate decays ~13% per minute of
    // apparent stillness — so well before the next tick there is nothing left.
    let seen: number | null = null;
    for (let i = 1; i <= 100; i++) {
      const t = at + i * MIN;
      seen = a.assess([limit(util, t, 10_080)], t)[0]!.burn?.pctPerHour ?? null;
    }
    expect(seen).not.toBeNull();
    expect(seen as number).toBeGreaterThan(0.2);
  });

  it('leaves the 5-hour case exactly as it was', () => {
    // 300 minutes / 20 = the old 15-minute constant, so this path is unchanged.
    const seen = steady(300, 6, 60);
    expect(seen).not.toBeNull();
    expect(seen as number).toBeGreaterThan(3);
  });

  it('still says nothing about a genuinely flat limit', () => {
    const seen = steady(10_080, 0, 720);
    expect(seen).toBeNull();
  });
});
