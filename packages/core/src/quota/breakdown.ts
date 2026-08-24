/**
 * The exact token split behind one limit — docs/UI.md tier 3, "click a limit →
 * that limit's history, token breakdown by model and kind".
 *
 * Counted straight from transcript events, so provenance is `exact`: this
 * module runs no fit and applies no price prior. It answers "what did I
 * actually spend inside this limit's window", never "what did that cost". The
 * vendor's utilization percentage remains the only authority on how full a
 * limit is; these tokens explain where it went, and the two are not expected
 * to agree numerically (GLOSSARY: the exchange rate is what relates them).
 */
import type { BackendId, Provenance, QuotaLimit, TokenKind } from '../model/types.js';
import { TOKEN_KINDS, type UsageLedger } from './ledger.js';

/** Which agent spent what, inside one model's share of a limit window. */
export interface BreakdownAgent {
  agentId: string;
  /** Sum across kinds — raw tokens, unweighted. */
  total: number;
  requests: number;
}

/** One model's consumption inside a limit window. */
export interface BreakdownRow {
  model: string;
  tokens: Record<TokenKind, number>;
  /** Sum across kinds — raw tokens, unweighted. */
  total: number;
  requests: number;
  /**
   * Who spent it, most first. Ids only: this module knows nothing about
   * labels or directories, which live on `Agent` and change independently.
   */
  agents: BreakdownAgent[];
}

export interface LimitBreakdown {
  /** `${backend}:${key}` — the same id `Monitor.historyFor` takes. */
  limitKey: string;
  backend: BackendId;
  /** The window actually summed, epoch ms. */
  from: number;
  to: number;
  /**
   * Model filter applied, when the vendor scopes the limit (e.g. a weekly
   * limit that only counts Opus). Matching is a case-insensitive substring
   * test against the model id, which is a heuristic: the vendor gives us a
   * display scope, not a model list. Null when the limit counts everything.
   */
  scope: string | null;
  /** Most tokens first. */
  rows: BreakdownRow[];
  totals: Record<TokenKind, number>;
  total: number;
  requests: number;
  /** How many usage events were summed — 0 means "nothing observed yet". */
  events: number;
  source: Provenance;
}

const zeroKinds = (): Record<TokenKind, number> => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
});

/**
 * Window start mirrors the chart's: anchored to the reset when the vendor
 * tells us one, else a trailing window ending now. Keeping the two in step
 * matters — the breakdown has to cover exactly the span the curve draws.
 */
export function limitWindow(limit: QuotaLimit, now: number): { from: number; to: number } {
  const span = limit.windowMinutes * 60_000;
  const from = limit.resetsAt !== null ? limit.resetsAt - span : now - span;
  return { from: Math.min(from, now), to: now };
}

export function limitBreakdown(ledger: UsageLedger, limit: QuotaLimit, now: number): LimitBreakdown {
  const { from, to } = limitWindow(limit, now);
  const scope = limit.scope;
  const needle = scope !== null ? scope.toLowerCase() : null;

  const byModel = new Map<string, BreakdownRow>();
  /** model → agentId → running total, folded into the rows at the end. */
  const byAgent = new Map<string, Map<string, BreakdownAgent>>();
  const totals = zeroKinds();
  let total = 0;
  let requests = 0;
  let events = 0;

  for (const e of ledger.slice(from, to)) {
    if (e.backend !== limit.backend) continue;
    if (needle !== null && !e.model.toLowerCase().includes(needle)) continue;
    let row = byModel.get(e.model);
    if (row === undefined) {
      row = { model: e.model, tokens: zeroKinds(), total: 0, requests: 0, agents: [] };
      byModel.set(e.model, row);
      byAgent.set(e.model, new Map());
    }
    let evTotal = 0;
    for (const k of TOKEN_KINDS) {
      const v = e.tokens[k];
      row.tokens[k] += v;
      row.total += v;
      totals[k] += v;
      total += v;
      evTotal += v;
    }
    row.requests += e.requests;
    requests += e.requests;
    events += 1;

    const agents = byAgent.get(e.model) as Map<string, BreakdownAgent>;
    const seen = agents.get(e.agentId);
    if (seen === undefined) {
      agents.set(e.agentId, { agentId: e.agentId, total: evTotal, requests: e.requests });
    } else {
      seen.total += evTotal;
      seen.requests += e.requests;
    }
  }

  for (const [model, agents] of byAgent) {
    const row = byModel.get(model);
    if (row !== undefined) row.agents = [...agents.values()].sort((a, b) => b.total - a.total);
  }

  return {
    limitKey: `${limit.backend}:${limit.key}`,
    backend: limit.backend,
    from,
    to,
    scope,
    rows: [...byModel.values()].sort((a, b) => b.total - a.total),
    totals,
    total,
    requests,
    events,
    source: 'exact',
  };
}
