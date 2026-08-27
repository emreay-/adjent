/**
 * Window assessment: measured burn rate (EWMA), pace line, verdict, projected
 * exhaustion, and binding-limit selection with hysteresis.
 * All of this works from vendor-reported utilization alone — no weights, no
 * tokens, no fit (docs/GLOSSARY.md § Window burn rate; docs/UI.md § hero).
 */
import type { BurnRate, QuotaLimit, Verdict, LimitAssessment } from '../model/types.js';

/** α from a half-life (GLOSSARY § smoothing): α = 1 − 2^(−Δt/T½). */
const HALF_LIFE_MS = 5 * 60_000;
/** Lookback h for the raw rate. */
const LOOKBACK_MS = 15 * 60_000;
/** Pace tolerance for the verdict (matches default pace rule). */
const PACE_TOLERANCE_PP = 10;
/**
 * How long a reading may stand still before the rate it implied stops being
 * evidence about the present.
 *
 * A vendor reading arriving late is normal — Codex publishes its rate limits
 * inside transcript lines, so a long turn produces no reading for minutes at a
 * time. Below the grace, nothing is inferred from the silence.
 */
const BURN_GRACE_MS = 2 * 60_000;
/**
 * Below this the rate is not worth reporting, and reporting it costs more than
 * it says: a projection built on 0.03 %/h names a date months out and reads as
 * a fact. Matches the floor the panel and the CLI already display at.
 */
const BURN_FLOOR_PCT_PER_HOUR = 0.05;
/** A challenger window must win this many consecutive polls to take the hero slot. */
const HYSTERESIS_POLLS = 3;

interface LimitTrack {
  samples: Array<{ at: number; utilization: number }>;
  ewma: number | null;
  ewmaAt: number | null;
  lastResetsAt: number | null;
}

export class LimitAssessor {
  private readonly tracks = new Map<string, LimitTrack>();
  private bindingKey: string | null = null;
  private challenger: { key: string; polls: number } | null = null;

  /** Serialize burn tracks + binding choice so a restart keeps its bearings. */
  toJSON(): unknown {
    return {
      tracks: [...this.tracks.entries()],
      bindingKey: this.bindingKey,
    };
  }

  static fromJSON(raw: unknown): LimitAssessor {
    const a = new LimitAssessor();
    if (typeof raw !== 'object' || raw === null) return a;
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o['tracks'])) {
      for (const entry of o['tracks'] as unknown[]) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const t = entry[1] as Partial<LimitTrack> | undefined;
        if (!t || typeof t !== 'object') continue;
        a.tracks.set(entry[0], {
          samples: Array.isArray(t.samples) ? (t.samples as LimitTrack['samples']) : [],
          ewma: typeof t.ewma === 'number' ? t.ewma : null,
          ewmaAt: typeof t.ewmaAt === 'number' ? t.ewmaAt : null,
          lastResetsAt: typeof t.lastResetsAt === 'number' ? t.lastResetsAt : null,
        });
      }
    }
    if (typeof o['bindingKey'] === 'string') a.bindingKey = o['bindingKey'];
    return a;
  }

  /** Feed the latest reading of every window; returns full assessments. */
  assess(limits: QuotaLimit[], now: number): LimitAssessment[] {
    const out: LimitAssessment[] = [];
    for (const w of limits) {
      const burn = this.updateBurn(w, now);
      const paceLinePct = paceLine(w, now);
      const verdict = verdictFor(w, burn, paceLinePct);
      const exhaustsAt = exhaustion(w, burn, now);
      out.push({ limit: w, burn, verdict, paceLinePct, exhaustsAt, binding: false });
    }
    this.selectBinding(out, now);
    return out;
  }

  /**
   * The measured rate for one limit, aged.
   *
   * A rate is a measurement, and a measurement has a moment. The EWMA is
   * advanced by observations, so a limit whose readings stop arriving used to
   * keep whatever rate it last had — for ever. That is how a Codex 7-day limit
   * with nothing running went on claiming +2.8 %/h and projecting a wall four
   * days out, from a reading taken the previous night.
   *
   * Standing still is not an absence of evidence; it is evidence. Adjent reads
   * the same files the spend is written to, so a frozen reading and no spend
   * are the same event: had anything been running, the reading would have
   * moved. The estimate is therefore decayed toward zero on the wall clock at
   * the smoothing half-life — exactly what a stream of unchanged readings
   * would have done to it — and dropped once it falls below the floor.
   *
   * The one thing this cannot see is another machine spending the same account.
   * Neither could the frozen figure, which claimed to.
   */
  private updateBurn(w: QuotaLimit, now: number): BurnRate | null {
    const key = `${w.backend}:${w.key}`;
    const t = this.tracks.get(key) ?? { samples: [], ewma: null, ewmaAt: null, lastResetsAt: null };
    this.tracks.set(key, t);

    // Rollover detection: resetsAt moved forward → the drop is real; reset the
    // EWMA rather than smoothing through it (GLOSSary § smoothing).
    if (t.lastResetsAt !== null && w.resetsAt !== null && w.resetsAt > t.lastResetsAt + 60_000) {
      t.samples = [];
      t.ewma = null;
      t.ewmaAt = null;
    }
    t.lastResetsAt = w.resetsAt ?? t.lastResetsAt;

    const last = t.samples[t.samples.length - 1];
    if (last && w.observedAt <= last.at) return this.aged(t, now);
    t.samples.push({ at: w.observedAt, utilization: w.utilization });
    const horizon = w.observedAt - 2 * LOOKBACK_MS;
    while (t.samples.length > 2 && (t.samples[0] as { at: number }).at < horizon) t.samples.shift();

    // Raw rate over ~the lookback: r = (u(t) − u(t−h)) / h.
    const ref = t.samples[0] as { at: number; utilization: number };
    const dtMs = w.observedAt - ref.at;
    if (dtMs <= 0) return this.aged(t, now);
    const raw = ((w.utilization - ref.utilization) / dtMs) * 3600_000;

    const alpha = t.ewmaAt === null ? 1 : 1 - Math.pow(2, -(w.observedAt - t.ewmaAt) / HALF_LIFE_MS);
    t.ewma = t.ewma === null ? raw : alpha * raw + (1 - alpha) * t.ewma;
    t.ewmaAt = w.observedAt;
    return this.aged(t, now);
  }

  /**
   * The stored estimate, decayed for however long the reading has stood still,
   * and null once it no longer says anything.
   *
   * The decay is written back: it is a real update to the estimate, not a
   * presentation trick, and the next genuine sample must continue from it
   * rather than from a rate the limit had hours ago.
   */
  private aged(t: LimitTrack, now: number): BurnRate | null {
    if (t.ewma === null || t.ewmaAt === null) return null;
    const stillMs = now - t.ewmaAt - BURN_GRACE_MS;
    if (stillMs > 0) {
      t.ewma *= Math.pow(2, -stillMs / HALF_LIFE_MS);
      t.ewmaAt = now - BURN_GRACE_MS;
    }
    if (Math.abs(t.ewma) < BURN_FLOOR_PCT_PER_HOUR) return null;
    return { pctPerHour: t.ewma, updatedAt: t.ewmaAt };
  }

  /**
   * Binding-limit selection (docs/UI.md § Choosing the binding limit):
   *  1. vendor is_active wins outright;
   *  2. else smallest time-to-exhaustion among windows exhausting before reset;
   *  3. else highest utilization.
   * With 3-poll hysteresis; immediate switch on rollover (claim vanishes).
   */
  private selectBinding(assessments: LimitAssessment[], now: number): void {
    if (assessments.length === 0) return;
    const keyOf = (a: LimitAssessment) => `${a.limit.backend}:${a.limit.key}`;

    let winner: LimitAssessment | null = assessments.find((a) => a.limit.vendorActive) ?? null;
    if (!winner) {
      const exhausting = assessments.filter(
        (a) => a.exhaustsAt !== null && a.limit.resetsAt !== null && a.exhaustsAt < a.limit.resetsAt,
      );
      if (exhausting.length > 0) {
        winner = exhausting.reduce((best, a) => ((a.exhaustsAt as number) < (best.exhaustsAt as number) ? a : best));
      } else {
        winner = assessments.reduce((best, a) => (a.limit.utilization > best.limit.utilization ? a : best));
      }
    }

    const winnerKey = keyOf(winner);
    const currentStillPresent = assessments.some((a) => keyOf(a) === this.bindingKey);
    if (this.bindingKey === null || !currentStillPresent) {
      // First selection, or the incumbent's window vanished/reset → immediate.
      this.bindingKey = winnerKey;
      this.challenger = null;
    } else if (winnerKey !== this.bindingKey) {
      if (this.challenger?.key === winnerKey) this.challenger.polls += 1;
      else this.challenger = { key: winnerKey, polls: 1 };
      if (this.challenger.polls >= HYSTERESIS_POLLS || winner.limit.vendorActive) {
        this.bindingKey = winnerKey;
        this.challenger = null;
      }
    } else {
      this.challenger = null;
    }

    for (const a of assessments) if (keyOf(a) === this.bindingKey) a.binding = true;
    void now;
  }
}

/**
 * Order limits by how soon they can stop you — the same question the binding
 * choice answers, so the collapsed list reads as a ranking that continues from
 * the hero rather than an unrelated order.
 *
 * A limit can only stop you if it runs out before it resets, so those come
 * first, soonest-exhausting at the top. Nothing else is at risk, so the rest
 * fall back to how full they are (docs/UI.md § Choosing the binding limit),
 * and finally to which resets soonest. Without that last step the order of two
 * limits equally full and equally safe was whatever the input happened to be —
 * stable only by accident, and liable to swap between ticks with nothing about
 * either limit having changed.
 *
 * The nearest reset ranks first because it is the next thing that will change
 * the picture. Note this is the one step where "urgent" is arguable: a limit
 * resetting within the hour will clear itself, while an equally full one that
 * resets tomorrow has all day to become a wall. Both readings are defensible
 * and the spec (improvement plan W3.2) asks for nearest-first, so that is what
 * this does; it only ever decides ties between limits already equal on risk
 * and fullness.
 */
export function compareUrgency(a: LimitAssessment, b: LimitAssessment): number {
  const risky = (x: LimitAssessment): boolean =>
    x.exhaustsAt !== null && x.limit.resetsAt !== null && x.exhaustsAt < x.limit.resetsAt;
  const ra = risky(a);
  const rb = risky(b);
  if (ra !== rb) return ra ? -1 : 1;
  if (ra && rb) return (a.exhaustsAt as number) - (b.exhaustsAt as number);
  if (a.limit.utilization !== b.limit.utilization) return b.limit.utilization - a.limit.utilization;
  // A null reset is unknown, not imminent: it sorts last rather than first.
  const resetA = a.limit.resetsAt;
  const resetB = b.limit.resetsAt;
  if (resetA === resetB) return 0;
  if (resetA === null) return 1;
  if (resetB === null) return -1;
  return resetA - resetB;
}

/** Elapsed fraction of the window × 100 — where the pace line sits (GLOSSARY). */
export function paceLine(w: QuotaLimit, now: number): number | null {
  if (w.resetsAt === null || w.windowMinutes <= 0) return null;
  const windowMs = w.windowMinutes * 60_000;
  const start = w.resetsAt - windowMs;
  const e = (now - start) / windowMs;
  return Math.min(100, Math.max(0, e * 100));
}

export function verdictFor(w: QuotaLimit, burn: BurnRate | null, paceLinePct: number | null): Verdict {
  if (w.utilization >= 100) return 'over';
  if (burn === null || Math.abs(burn.pctPerHour) < 0.01) return w.utilization === 0 ? 'idle' : 'on-pace';
  if (paceLinePct === null) return 'on-pace';
  return w.utilization > paceLinePct + PACE_TOLERANCE_PP ? 'ahead' : 'on-pace';
}

/** T = now + (100 − u)/r, null when burn ≤ 0 (never renders as ∞ — docs/UI.md). */
export function exhaustion(w: QuotaLimit, burn: BurnRate | null, now: number): number | null {
  if (burn === null || burn.pctPerHour <= 0) return null;
  const hoursLeft = (100 - w.utilization) / burn.pctPerHour;
  return now + hoursLeft * 3600_000;
}
