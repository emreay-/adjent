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

const limit = (utilization: number, observedAt: number): QuotaLimit => ({
  backend: 'codex',
  key: '7d',
  label: 'Codex · 7d',
  windowMinutes: 10_080,
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
  it('picks the new rate up from the decayed one, not the old one', () => {
    const { a, rate } = burning();
    const frozen = T0 + 10 * MIN;
    // An hour idle: the old rate is gone.
    expect(a.assess([limit(1.0, frozen)], frozen + HOUR)[0]!.burn).toBeNull();

    // Then spend again, at roughly the same pace as before.
    let seen: number | null = null;
    for (let i = 1; i <= 10; i++) {
      const at = frozen + HOUR + i * MIN;
      const r = a.assess([limit(1.0 + i * 0.1, at)], at)[0]!;
      seen = r.burn?.pctPerHour ?? null;
    }
    expect(seen).not.toBeNull();
    expect(seen as number).toBeGreaterThan(rate / 2);
  });
});
