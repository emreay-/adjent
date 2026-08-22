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
      const burn = this.updateBurn(w);
      const paceLinePct = paceLine(w, now);
      const verdict = verdictFor(w, burn, paceLinePct);
      const exhaustsAt = exhaustion(w, burn, now);
      out.push({ limit: w, burn, verdict, paceLinePct, exhaustsAt, binding: false });
    }
    this.selectBinding(out, now);
    return out;
  }

  private updateBurn(w: QuotaLimit): BurnRate | null {
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
    if (last && w.observedAt <= last.at) {
      return t.ewma !== null && t.ewmaAt !== null ? { pctPerHour: t.ewma, updatedAt: t.ewmaAt } : null;
    }
    t.samples.push({ at: w.observedAt, utilization: w.utilization });
    const horizon = w.observedAt - 2 * LOOKBACK_MS;
    while (t.samples.length > 2 && (t.samples[0] as { at: number }).at < horizon) t.samples.shift();

    // Raw rate over ~the lookback: r = (u(t) − u(t−h)) / h.
    const ref = t.samples[0] as { at: number; utilization: number };
    const dtMs = w.observedAt - ref.at;
    if (dtMs <= 0) return t.ewma !== null && t.ewmaAt !== null ? { pctPerHour: t.ewma, updatedAt: t.ewmaAt } : null;
    const raw = ((w.utilization - ref.utilization) / dtMs) * 3600_000;

    const alpha = t.ewmaAt === null ? 1 : 1 - Math.pow(2, -(w.observedAt - t.ewmaAt) / HALF_LIFE_MS);
    t.ewma = t.ewma === null ? raw : alpha * raw + (1 - alpha) * t.ewma;
    t.ewmaAt = w.observedAt;
    return { pctPerHour: t.ewma, updatedAt: w.observedAt };
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
