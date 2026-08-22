/**
 * Usage ledger: the exact token timeline. Answers c_k(a, b] — consumption of
 * bucket k in an interval — for the whole account and per agent, which is all
 * the fit and the per-agent burn need (docs/GLOSSARY.md § Notation).
 */
import type { TokenKind, UsageEvent } from '../model/types.js';

export const TOKEN_KINDS: readonly TokenKind[] = ['input', 'cacheWrite', 'cacheRead', 'output'];

/** ~14 days at heavy usage is well under 100k events; a ring buffer suffices. */
const MAX_EVENTS = 200_000;

export class UsageLedger {
  private events: UsageEvent[] = [];
  private sorted = true;

  add(evs: UsageEvent[]): void {
    if (evs.length === 0) return;
    this.events.push(...evs);
    this.sorted = false;
    if (this.events.length > MAX_EVENTS) {
      this.ensureSorted();
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
  }

  private ensureSorted(): void {
    if (!this.sorted) {
      this.events.sort((a, b) => a.ts - b.ts);
      this.sorted = true;
    }
  }

  /** All events with a < ts ≤ b, optionally restricted to one agent. */
  slice(a: number, b: number, agentId?: string): UsageEvent[] {
    this.ensureSorted();
    // Binary search for the window start, then linear to the end.
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.events[mid] as UsageEvent).ts <= a) lo = mid + 1;
      else hi = mid;
    }
    const out: UsageEvent[] = [];
    for (let i = lo; i < this.events.length; i++) {
      const e = this.events[i] as UsageEvent;
      if (e.ts > b) break;
      if (agentId === undefined || e.agentId === agentId) out.push(e);
    }
    return out;
  }

  /**
   * c_k(a, b] aggregated into bucket → amount, at a given resolution.
   * Resolution levels mirror the identifiability hierarchy (GLOSSARY):
   *   'blended'   — one column of price-weighted tokens
   *   'kind'      — one column per token kind (+ requests)
   *   'modelKind' — model × kind (+ requests)
   */
  consumption(
    a: number,
    b: number,
    level: FitLevel,
    prior: PriceRatioTable,
    agentId?: string,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const bump = (key: string, v: number) => {
      if (v !== 0) out.set(key, (out.get(key) ?? 0) + v);
    };
    for (const e of this.slice(a, b, agentId)) {
      if (level === 'blended') {
        bump('all', priorWeightedTotal(e, prior));
      } else if (level === 'kind') {
        for (const k of TOKEN_KINDS) bump(k, e.tokens[k]);
        bump('requests', e.requests);
      } else {
        for (const k of TOKEN_KINDS) bump(`${e.model}:${k}`, e.tokens[k]);
        bump('requests', e.requests);
      }
    }
    return out;
  }

  get size(): number {
    return this.events.length;
  }

  /** Snapshot for persistence (sorted, oldest first). */
  all(): UsageEvent[] {
    this.ensureSorted();
    return this.events;
  }

  /** Which requestIds are already held — restores dedup across a restart. */
  requestIds(): string[] {
    return this.events.map((e) => e.requestId);
  }

  lastEventTs(): number | null {
    this.ensureSorted();
    const last = this.events[this.events.length - 1];
    return last ? last.ts : null;
  }
}

export type FitLevel = 'blended' | 'kind' | 'modelKind';

/**
 * Published API price ratios (GLOSSARY: the prior — ratios only, never dollars).
 * Values are input-token equivalents; model multipliers approximate the
 * published cross-model spread. These are a starting guess the fit corrects.
 */
export interface PriceRatioTable {
  kind: Record<TokenKind, number>;
  /** model substring (lowercased) → multiplier vs the base model class */
  modelMultiplier: Array<[substr: string, mult: number]>;
  defaultModelMultiplier: number;
}

export const DEFAULT_PRICE_RATIOS: PriceRatioTable = {
  kind: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  modelMultiplier: [
    ['opus', 5],
    ['fable', 5],
    ['sonnet', 1],
    ['haiku', 0.2],
    ['gpt', 1],
  ],
  defaultModelMultiplier: 1,
};

export function modelMultiplier(model: string, table: PriceRatioTable): number {
  const m = model.toLowerCase();
  for (const [sub, mult] of table.modelMultiplier) if (m.includes(sub)) return mult;
  return table.defaultModelMultiplier;
}

export function priorWeightedTotal(e: UsageEvent, table: PriceRatioTable): number {
  const mm = modelMultiplier(e.model, table);
  let sum = 0;
  for (const k of TOKEN_KINDS) sum += e.tokens[k] * table.kind[k];
  return sum * mm;
}

/** Prior weight for a bucket id at a given level, before scaling by s0. */
export function priorDirection(bucket: string, level: FitLevel, table: PriceRatioTable): number {
  if (bucket === 'requests') return 0; // prior belief: no per-request charge (the fit may disagree)
  if (level === 'blended') return 1;
  if (level === 'kind') return table.kind[bucket as TokenKind] ?? 0;
  const i = bucket.lastIndexOf(':');
  const model = bucket.slice(0, i);
  const kind = bucket.slice(i + 1) as TokenKind;
  return (table.kind[kind] ?? 0) * modelMultiplier(model, table);
}
