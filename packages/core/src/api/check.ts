/**
 * The budget predicate — "may I start more work?"
 *
 * The question Adjent exists to answer for a script, reduced to a pure
 * function so the CLI does nothing but map the result onto an exit code
 * (docs/API.md § Exit codes). Nothing here reads a clock, a file or an
 * environment: pass the snapshot and the time in.
 *
 * Two decisions worth stating, because they are the difference between a gate
 * that protects you and one that quietly does not:
 *
 * 1. **All conditions must hold, on every limit in scope.** A predicate that
 *    passed when *any* limit had room would green-light work that the weekly
 *    limit cannot afford.
 * 2. **No data is not a pass.** With nothing to evaluate, the answer is "I
 *    cannot say", which the caller must be able to distinguish from "yes".
 */
import type { Snapshot, SnapshotLimit } from './snapshot.js';

export interface CheckOptions {
  /** Minimum share of the limit that must remain, in percent. */
  budgetPct?: number | null;
  /** Highest utilization that may be reported, in percent. */
  maxUtilizationPct?: number | null;
  /** Verdicts that are acceptable. */
  pace?: readonly string[] | null;
  /** Narrow to one backend. */
  backend?: string | null;
  /** Narrow to one limit key. Without it, only the binding limit is judged. */
  limitKey?: string | null;
  /** Reject a reading older than this, in ms. Only applied when given. */
  maxAgeMs?: number | null;
  /**
   * Whether the advisory gate is currently held.
   *
   * Passed in rather than read here, because this module reads no files — the
   * caller does the I/O and hands the answer over. A held gate fails the
   * predicate outright, regardless of how much quota is left: that is the
   * point of a gate, and a caller who wants to ignore it simply does not pass
   * it.
   */
  gateHeld?: boolean | null;
  /** Why the gate is held, for the restated predicate and the JSON. */
  gateReason?: string | null;
}

export type CheckFailure = 'budget' | 'max-utilization' | 'pace' | 'stale' | 'gate';

export interface CheckEvaluation {
  backend: string;
  key: string;
  label: string;
  utilization: number;
  /** How much of the limit is left, in percent — the number `--budget` tests. */
  remainingPct: number;
  verdict: string;
  /** How old the vendor's reading is, in ms, at the time of the check. */
  ageMs: number;
  ok: boolean;
  /** Every condition this limit failed, in the order they were tested. */
  failed: CheckFailure[];
}

export interface CheckResult {
  ok: boolean;
  /** Human-readable restatement of what was asked. */
  predicate: string;
  evaluated: CheckEvaluation[];
  /**
   * True when nothing could be judged — no limits, or a filter that matched
   * none. `ok` is false in that case, but for a different reason than a
   * failed condition, and the caller reports it differently.
   */
  noData: boolean;
  /** True when the advisory gate held, which fails the check on its own. */
  gateHeld?: boolean;
  /** Why it was held, when a reason was recorded. */
  gateReason?: string | null;
}

/** Which limits a check is about: the named one, or the binding one. */
export function limitsInScope(snapshot: Snapshot, opts: CheckOptions): SnapshotLimit[] {
  let limits = snapshot.limits;
  if (opts.backend) limits = limits.filter((l) => l.backend === opts.backend);
  if (opts.limitKey) return limits.filter((l) => l.key === opts.limitKey);
  // Unnarrowed, the question is about the limit that will stop you first.
  const binding = limits.filter((l) => l.bindingLimit);
  return binding.length > 0 ? binding : [];
}

/** Restate the request, so `--json` and the human line agree on what was asked. */
function describe(opts: CheckOptions): string {
  const parts: string[] = [];
  if (opts.budgetPct !== null && opts.budgetPct !== undefined) {
    parts.push(`at least ${opts.budgetPct}% of the limit remains`);
  }
  if (opts.maxUtilizationPct !== null && opts.maxUtilizationPct !== undefined) {
    parts.push(`utilization at most ${opts.maxUtilizationPct}%`);
  }
  if (opts.pace && opts.pace.length > 0) parts.push(`pace is ${opts.pace.join(' or ')}`);
  if (opts.maxAgeMs !== null && opts.maxAgeMs !== undefined) {
    parts.push(`the reading is under ${Math.round(opts.maxAgeMs / 60_000)}m old`);
  }
  const scope = opts.limitKey
    ? `limit ${opts.limitKey}`
    : opts.backend
      ? `the binding limit of ${opts.backend}`
      : 'the binding limit';
  // With no condition given, the question is simply "is there an answer".
  return parts.length === 0 ? `data exists for ${scope}` : `${parts.join(', and ')} — for ${scope}`;
}

export function check(snapshot: Snapshot, opts: CheckOptions, now: number): CheckResult {
  const scoped = limitsInScope(snapshot, opts);
  const predicate = describe(opts);

  // A held gate is a "no" before any limit is consulted, and it answers even
  // when there is no quota data at all — which is the case an orchestrator
  // most needs an answer in. Reported as `gateHeld` rather than folded into a
  // limit's `failed`, because it is not a property of any one limit.
  if (opts.gateHeld === true) {
    return {
      ok: false,
      predicate,
      evaluated: [],
      noData: false,
      gateHeld: true,
      gateReason: opts.gateReason ?? null,
    };
  }

  if (scoped.length === 0) {
    return { ok: false, predicate, evaluated: [], noData: true };
  }

  const evaluated = scoped.map((l): CheckEvaluation => {
    const remainingPct = 100 - l.utilization;
    const ageMs = Math.max(0, now - l.observedAt);
    const failed: CheckFailure[] = [];

    if (opts.budgetPct !== null && opts.budgetPct !== undefined && remainingPct < opts.budgetPct) {
      failed.push('budget');
    }
    if (
      opts.maxUtilizationPct !== null &&
      opts.maxUtilizationPct !== undefined &&
      l.utilization > opts.maxUtilizationPct
    ) {
      failed.push('max-utilization');
    }
    if (opts.pace && opts.pace.length > 0 && !opts.pace.includes(l.verdict)) {
      failed.push('pace');
    }
    // Staleness is only ever a failure when the caller asked about it: what
    // counts as too old is their business, not Adjent's.
    if (opts.maxAgeMs !== null && opts.maxAgeMs !== undefined && ageMs > opts.maxAgeMs) {
      failed.push('stale');
    }

    return {
      backend: l.backend,
      key: l.key,
      label: l.label,
      utilization: l.utilization,
      remainingPct,
      verdict: l.verdict,
      ageMs,
      ok: failed.length === 0,
      failed,
    };
  });

  return { ok: evaluated.every((e) => e.ok), predicate, evaluated, noData: false };
}

/** True when the only thing wrong is that a reading was too old. */
export const staleOnly = (r: CheckResult): boolean =>
  !r.ok &&
  !r.noData &&
  r.evaluated.some((e) => e.failed.length > 0) &&
  r.evaluated.every((e) => e.failed.every((f) => f === 'stale'));
