/**
 * `fmtWhen` — a moment said the way a person would.
 *
 * The bug this exists for: a 7-day limit reporting "runs out at 05:29" reads
 * as five hours away when it is five days away. Anything outside today has to
 * name its day, and "tomorrow" has to mean the next calendar day rather than
 * the next 24 hours, or a 23:50 → 00:10 pair reads as the same evening.
 *
 * Dates are built with the local-time constructor on purpose: the formatter
 * works in local calendar days, so the assertions must too.
 */
import { describe, expect, it } from 'vitest';
import { calendarDaysBetween, fmtWhen } from '../src/rules/evaluate.js';

const at = (y: number, m: number, d: number, hh: number, mm: number): number =>
  new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

describe('calendarDaysBetween', () => {
  it('counts calendar days, not 24-hour chunks', () => {
    // Ten minutes apart, but a day boundary sits between them.
    expect(calendarDaysBetween(at(2026, 8, 24, 23, 50), at(2026, 8, 25, 0, 10))).toBe(1);
    // Twenty-three hours apart, same calendar day.
    expect(calendarDaysBetween(at(2026, 8, 24, 0, 30), at(2026, 8, 24, 23, 30))).toBe(0);
  });

  it('is signed', () => {
    expect(calendarDaysBetween(at(2026, 8, 24, 12, 0), at(2026, 8, 22, 12, 0))).toBe(-2);
  });
});

describe('fmtWhen', () => {
  const now = at(2026, 8, 24, 17, 8); // a Monday

  it('says just the clock inside today', () => {
    expect(fmtWhen(at(2026, 8, 24, 5, 29), now)).toBe('05:29');
    expect(fmtWhen(at(2026, 8, 24, 23, 59), now)).toBe('23:59');
  });

  it('names tomorrow and yesterday', () => {
    expect(fmtWhen(at(2026, 8, 25, 5, 29), now)).toBe('tomorrow 05:29');
    expect(fmtWhen(at(2026, 8, 23, 22, 0), now)).toBe('yesterday 22:00');
  });

  it('uses the weekday inside the coming week', () => {
    // Two to six days out: the weekday alone is unambiguous.
    const s = fmtWhen(at(2026, 8, 28, 5, 29), now);
    expect(s).toMatch(/^\w{3}.* 05:29$/);
    expect(s).not.toContain('tomorrow');
    expect(s).toContain('05:29');
  });

  it('dates anything a week or more away', () => {
    // This is the case the alarm screenshot got wrong: a 7d limit's exhaustion.
    const s = fmtWhen(at(2026, 8, 31, 5, 29), now);
    expect(s).toContain('05:29');
    expect(s).toContain(',');
    expect(s.length).toBeGreaterThan('05:29'.length + 4);
  });

  it('never returns a bare clock for anything outside today', () => {
    for (const days of [1, 2, 5, 7, 30, -1, -9]) {
      const t = at(2026, 8, 24 + days, 5, 29);
      expect(fmtWhen(t, now), `${days} days out`).not.toBe('05:29');
    }
  });
});
