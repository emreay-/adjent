/**
 * The exchange-rate fit (docs/GLOSSARY.md, "The model, derived").
 *
 *   Δu_n ≈ Σ_k w_k · (in_{n,k} − out_{n,k})        one row per poll
 *   ŵ = argmin_{w≥0} ‖Xw − Δu‖² + λ‖w − w₀‖²      NNLS + prior
 *   λ_N = λ₀ / (1 + N/N₀)                          data takes over from pricing
 *
 * Solved by cyclic coordinate descent with the non-negativity clamp — closed
 * form per coordinate, no dependencies. The hierarchy (blended → kind →
 * model×kind) is handled by fitting each level and reporting the finest one
 * whose residual is acceptable; blended is always identifiable.
 */
import type { QuotaWindow } from '../model/types.js';
import {
  DEFAULT_PRICE_RATIOS,
  priorDirection,
  type FitLevel,
  type PriceRatioTable,
  UsageLedger,
} from './ledger.js';

export interface FitRow {
  /** Δu for this poll interval, in percentage points. */
  du: number;
  /** bucket id → net flow x_{n,k} = in − out. */
  x: Map<string, number>;
}

export interface FitResult {
  level: FitLevel;
  /** bucket id → ŵ (percent per unit). */
  weights: Map<string, number>;
  /** RMS of the fit residual e_n over the retained rows. */
  rmse: number;
  sampleCount: number;
  confidence: 'low' | 'medium' | 'high';
}

const MAX_ROWS = 2000;
const LAMBDA0 = 25;
const N0 = 60;
const CD_ITERS = 60;

export class ExchangeRateFit {
  private rowsByLevel: Record<FitLevel, FitRow[]> = { blended: [], kind: [], modelKind: [] };
  /** s0: percent per prior-weighted token — the bootstrap scale (GLOSSARY § Cold start). */
  private s0: number | null = null;
  private lastPoll: { utilization: number; at: number } | null = null;
  private readonly prior: PriceRatioTable;

  constructor(prior: PriceRatioTable = DEFAULT_PRICE_RATIOS) {
    this.prior = prior;
  }

  /** Feed one utilization poll of one window; builds one row per level. */
  observePoll(w: QuotaWindow, ledger: UsageLedger): void {
    const at = w.observedAt;
    const prev = this.lastPoll;
    this.lastPoll = { utilization: w.utilization, at };
    if (!prev || at <= prev.at) return;

    const du = w.utilization - prev.utilization;
    // A reset between polls makes du meaningless for the fit — skip the row.
    if (du < -30) return;

    const windowMs = w.windowMinutes * 60_000;
    for (const level of ['blended', 'kind', 'modelKind'] as const) {
      const inflow = ledger.consumption(prev.at, at, level, this.prior);
      const outflow = ledger.consumption(prev.at - windowMs, at - windowMs, level, this.prior);
      const x = new Map<string, number>();
      for (const [k, v] of inflow) x.set(k, v);
      for (const [k, v] of outflow) x.set(k, (x.get(k) ?? 0) - v);
      let any = false;
      for (const v of x.values()) if (v !== 0) any = true;
      if (!any && du === 0) continue; // empty row teaches nothing
      const rows = this.rowsByLevel[level];
      rows.push({ du, x });
      if (rows.length > MAX_ROWS) rows.shift();
    }

    // Bootstrap s0 from the first usable observation: s0 = Δu / (pᵀ x).
    if (this.s0 === null) {
      const blended = this.rowsByLevel.blended[this.rowsByLevel.blended.length - 1];
      const px = blended?.x.get('all') ?? 0;
      if (blended && px > 0 && blended.du > 0) this.s0 = blended.du / px;
    }
  }

  /** Invalidate on plan change: ratios survive, the scale does not. */
  rebootstrap(): void {
    this.rowsByLevel = { blended: [], kind: [], modelKind: [] };
    this.s0 = null;
    this.lastPoll = null;
  }

  get bootstrapped(): boolean {
    return this.s0 !== null;
  }

  /**
   * Fit every level; return the finest whose relative residual is acceptable.
   * (GLOSSARY: "reports the finest weights whose uncertainty is acceptable,
   * falling back one level where the data is collinear.")
   */
  fit(): FitResult | null {
    if (this.s0 === null) return null;
    let best: FitResult | null = null;
    for (const level of ['blended', 'kind', 'modelKind'] as const) {
      const r = this.fitLevel(level);
      if (!r) continue;
      if (level === 'blended') best = r; // always a valid floor
      else if (best && r.rmse <= best.rmse * 1.05) best = r; // finer must not be worse
    }
    return best;
  }

  fitLevel(level: FitLevel): FitResult | null {
    if (this.s0 === null) return null;
    const rows = this.rowsByLevel[level];
    if (rows.length === 0) return null;

    // Collect bucket ids.
    const ids: string[] = [];
    const index = new Map<string, number>();
    for (const r of rows)
      for (const k of r.x.keys())
        if (!index.has(k)) {
          index.set(k, ids.length);
          ids.push(k);
        }
    const m = ids.length;
    const n = rows.length;
    if (m === 0) return null;

    // Dense X (n×m), y (n), prior w0 (m).
    const X: Float64Array[] = rows.map((r) => {
      const row = new Float64Array(m);
      for (const [k, v] of r.x) row[index.get(k) as number] = v;
      return row;
    });
    const y = Float64Array.from(rows, (r) => r.du);
    const w0 = new Float64Array(m);
    for (let j = 0; j < m; j++) w0[j] = this.s0 * priorDirection(ids[j] as string, level, this.prior);

    const lambda = LAMBDA0 / (1 + n / N0);
    // Precompute column norms and scale λ to the data magnitude so the two
    // terms are commensurate regardless of token volumes.
    const colNorm = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += (X[i] as Float64Array)[j]! ** 2;
      colNorm[j] = s;
    }
    const meanColNorm = colNorm.reduce((a, b) => a + b, 0) / Math.max(1, m) || 1;
    const lam = lambda * meanColNorm * 1e-4;

    // Cyclic coordinate descent on ½‖Xw−y‖² + ½λ‖w−w0‖², clamped at 0.
    const w = Float64Array.from(w0);
    const resid = new Float64Array(n); // r = y − Xw
    for (let i = 0; i < n; i++) {
      let s = y[i] as number;
      for (let j = 0; j < m; j++) s -= (X[i] as Float64Array)[j]! * (w[j] as number);
      resid[i] = s;
    }
    for (let iter = 0; iter < CD_ITERS; iter++) {
      for (let j = 0; j < m; j++) {
        const denom = (colNorm[j] as number) + lam;
        if (denom === 0) continue;
        let num = lam * (w0[j] as number);
        for (let i = 0; i < n; i++) num += (X[i] as Float64Array)[j]! * ((resid[i] as number) + (X[i] as Float64Array)[j]! * (w[j] as number));
        const next = Math.max(0, num / denom);
        const delta = next - (w[j] as number);
        if (delta !== 0) {
          for (let i = 0; i < n; i++) resid[i] = (resid[i] as number) - (X[i] as Float64Array)[j]! * delta;
          w[j] = next;
        }
      }
    }

    let sse = 0;
    for (let i = 0; i < n; i++) sse += (resid[i] as number) ** 2;
    const rmse = Math.sqrt(sse / n);

    const weights = new Map<string, number>();
    for (let j = 0; j < m; j++) weights.set(ids[j] as string, w[j] as number);

    const confidence: FitResult['confidence'] = n < 10 ? 'low' : rmse < 1 && n >= 30 ? 'high' : 'medium';
    return { level, weights, rmse, sampleCount: n, confidence };
  }

  /**
   * Price an interval of one agent's consumption through the fitted weights →
   * percentage points (GLOSSARY: per-agent burn, numerator of r_a).
   */
  priceAgentConsumption(
    ledger: UsageLedger,
    agentId: string,
    a: number,
    b: number,
    result: FitResult,
  ): number {
    const cons = ledger.consumption(a, b, result.level, this.prior, agentId);
    let pct = 0;
    for (const [k, v] of cons) pct += (result.weights.get(k) ?? 0) * v;
    return pct;
  }
}
