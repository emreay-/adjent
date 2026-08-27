/**
 * Turn-shape metrics: what a looping worker looks like from the outside.
 *
 * Metadata only (CLAUDE.md hard rule 2). This never sees a message body, which
 * is both a constraint and the honest limit of the feature: a *semantic* loop
 * whose turns vary in size is invisible here, and the docs say so.
 *
 * Pure and ledger-shaped rather than state-shaped, so it can be unit-tested
 * against synthetic timelines — which is how the `anomaly` rule is specified.
 */
import type { AgentShape, UsageEvent } from '../model/types.js';

/** Total billable tokens on one turn. Thinking is already inside `output`. */
const turnTotal = (e: UsageEvent): number =>
  e.tokens.input + e.tokens.cacheWrite + e.tokens.cacheRead + e.tokens.output;

/**
 * Coefficient of variation — standard deviation over mean.
 *
 * Scale-free on purpose: "every turn is the same size" must mean the same
 * thing for a worker averaging 2k tokens and one averaging 200k, and a raw
 * standard deviation would not. Zero-mean returns 0, which reads as "perfectly
 * uniform" and is correct for a run of empty turns.
 */
function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Fraction of consecutive turn pairs whose `cacheRead` increased.
 *
 * Context accumulates as a session works, so a healthy worker's cache reads
 * climb and this trends towards 1. A worker re-sending the same prompt sits
 * flat, or sawtooths as the cache expires and refills. Fewer than two turns
 * has no pairs to compare, and 1 is the safe answer: it reads as "growing",
 * so the rule stays silent rather than firing on no evidence.
 */
function contextGrowth(events: UsageEvent[]): number {
  if (events.length < 2) return 1;
  let rose = 0;
  for (let i = 1; i < events.length; i++) {
    if ((events[i] as UsageEvent).tokens.cacheRead > (events[i - 1] as UsageEvent).tokens.cacheRead) rose++;
  }
  return rose / (events.length - 1);
}

/**
 * Partition key: one agent, or one subagent of it. Never rendered.
 *
 * Joined on NUL, written explicitly, because it is the one byte a file path
 * cannot contain — and `subId` is a relative path. Any printable separator
 * could appear inside a subId and merge two workers into one.
 */
const SEP = String.fromCharCode(0);
const workerKey = (e: UsageEvent): string => e.agentId + SEP + (e.subId ?? '');

/**
 * Group the window's events per worker and describe each one's shape.
 *
 * Events are assumed ordered by time, which `UsageLedger.slice` guarantees.
 * A worker with a single turn still gets a row: the rule's own `min_turns`
 * decides what is too few, not this function.
 */
export function agentShapes(events: UsageEvent[]): AgentShape[] {
  const byWorker = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const k = workerKey(e);
    const list = byWorker.get(k);
    if (list === undefined) byWorker.set(k, [e]);
    else list.push(e);
  }

  const out: AgentShape[] = [];
  for (const list of byWorker.values()) {
    const first = list[0] as UsageEvent;
    out.push({
      agentId: first.agentId,
      subId: first.subId ?? null,
      turns: list.length,
      cv: coefficientOfVariation(list.map(turnTotal)),
      growth: contextGrowth(list),
    });
  }
  return out;
}
