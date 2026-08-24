/**
 * The budget predicate.
 *
 * This is the function a CI step will gate on, so its failure modes matter more
 * than its happy path. The two that would be silently dangerous:
 *
 * - passing when *any* limit has room, rather than all of them, would
 *   green-light work the weekly limit cannot afford;
 * - passing when there is nothing to judge would open the gate at exactly the
 *   moment Adjent had stopped seeing data.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { check, limitsInScope, staleOnly } from '../src/api/check.js';
import type { Snapshot, SnapshotLimit } from '../src/api/snapshot.js';

const T0 = 1_700_000_000_000;
const M = 60_000;

function limit(over: Partial<SnapshotLimit> = {}): SnapshotLimit {
  return {
    backend: 'claude',
    key: '5h',
    label: 'Claude · 5h',
    windowMinutes: 300,
    utilization: 40,
    resetsAt: T0 + 3 * 3600_000,
    severity: null,
    scope: null,
    bindingLimit: true,
    verdict: 'on-pace',
    paceLinePct: 40,
    exhaustsAt: null,
    burnPctPerHour: 2,
    tokens: null,
    observedAt: T0,
    provenance: { utilization: 'reported' },
    ...over,
  };
}

const snap = (limits: SnapshotLimit[]): Snapshot => ({
  schemaVersion: 1,
  machineId: 'test',
  generatedAt: T0,
  backends: [],
  limits,
  agents: [],
  epsilon: null,
  fitConfidence: 'low',
  provenance: {},
});

describe('scope', () => {
  it('judges the binding limit when nothing narrows it', () => {
    const s = snap([limit({ key: 'a', bindingLimit: false }), limit({ key: 'b', bindingLimit: true })]);
    expect(limitsInScope(s, {}).map((l) => l.key)).toEqual(['b']);
  });

  it('judges the named limit instead, binding or not', () => {
    const s = snap([limit({ key: 'a', bindingLimit: false }), limit({ key: 'b' })]);
    expect(limitsInScope(s, { limitKey: 'a' }).map((l) => l.key)).toEqual(['a']);
  });

  it('narrows by backend', () => {
    const s = snap([limit({ backend: 'claude' }), limit({ backend: 'codex', key: 'c' })]);
    expect(limitsInScope(s, { backend: 'codex', limitKey: 'c' }).map((l) => l.backend)).toEqual(['codex']);
  });

  it('matches nothing when a filter names something absent', () => {
    expect(limitsInScope(snap([limit()]), { limitKey: 'nope' })).toEqual([]);
  });
});

describe('check', () => {
  it('reads --budget as "this much must remain"', () => {
    // 40% used leaves 60%, so a demand for 20% passes and one for 70% does not.
    expect(check(snap([limit()]), { budgetPct: 20 }, T0).ok).toBe(true);
    expect(check(snap([limit()]), { budgetPct: 70 }, T0).ok).toBe(false);
  });

  it('treats the boundary as satisfied', () => {
    // Exactly 60% left against a demand for 60% is enough — "at least".
    expect(check(snap([limit({ utilization: 40 })]), { budgetPct: 60 }, T0).ok).toBe(true);
  });

  it('fails a fresh limit only when asked for everything', () => {
    // The acceptance case: 100% budget on a used limit, and on an unused one.
    expect(check(snap([limit({ utilization: 1 })]), { budgetPct: 100 }, T0).ok).toBe(false);
    expect(check(snap([limit({ utilization: 0 })]), { budgetPct: 100 }, T0).ok).toBe(true);
  });

  it('applies --max-utilization independently of budget', () => {
    const r = check(snap([limit({ utilization: 90 })]), { maxUtilizationPct: 80 }, T0);
    expect(r.ok).toBe(false);
    expect(r.evaluated[0]!.failed).toEqual(['max-utilization']);
  });

  it('applies --pace as a set of acceptable verdicts', () => {
    expect(check(snap([limit({ verdict: 'ahead' })]), { pace: ['on-pace'] }, T0).ok).toBe(false);
    expect(check(snap([limit({ verdict: 'ahead' })]), { pace: ['on-pace', 'ahead'] }, T0).ok).toBe(true);
  });

  it('requires every condition to hold, and reports each failure', () => {
    const r = check(
      snap([limit({ utilization: 95, verdict: 'over' })]),
      { budgetPct: 50, maxUtilizationPct: 80, pace: ['on-pace'] },
      T0,
    );
    expect(r.ok).toBe(false);
    expect(r.evaluated[0]!.failed).toEqual(['budget', 'max-utilization', 'pace']);
  });

  it('requires the predicate to hold on every limit in scope, not merely one', () => {
    // The dangerous case: plenty of room on the 5h limit, none on the weekly.
    const s = snap([
      limit({ key: '5h', backend: 'claude', utilization: 10 }),
      limit({ key: '7d', backend: 'claude', utilization: 99, bindingLimit: false }),
    ]);
    expect(check(s, { budgetPct: 50, backend: 'claude', limitKey: undefined }, T0).ok).toBe(true);
    // Widening scope to both must flip the answer.
    const both = { ...s, limits: s.limits.map((l) => ({ ...l, bindingLimit: true })) };
    const r = check(both, { budgetPct: 50 }, T0);
    expect(r.ok).toBe(false);
    expect(r.evaluated).toHaveLength(2);
  });

  it('does not pass when there is nothing to judge', () => {
    const r = check(snap([]), { budgetPct: 20 }, T0);
    expect(r.ok).toBe(false);
    expect(r.noData).toBe(true);
    expect(r.evaluated).toEqual([]);
  });

  it('with no conditions, asks only whether an answer exists', () => {
    expect(check(snap([limit({ utilization: 99 })]), {}, T0).ok).toBe(true);
    expect(check(snap([]), {}, T0).noData).toBe(true);
  });

  it('ignores staleness unless --max-age was given', () => {
    const old = snap([limit({ observedAt: T0 - 60 * M })]);
    expect(check(old, { budgetPct: 20 }, T0).ok).toBe(true);
    expect(check(old, { budgetPct: 20, maxAgeMs: 10 * M }, T0).ok).toBe(false);
  });

  it('reports age from the reading, not the snapshot', () => {
    const r = check(snap([limit({ observedAt: T0 - 30 * M })]), {}, T0);
    expect(r.evaluated[0]!.ageMs).toBe(30 * M);
  });

  it('distinguishes stale-only from stale-and-also-broke', () => {
    const stale = check(snap([limit({ observedAt: T0 - 60 * M })]), { maxAgeMs: 10 * M }, T0);
    expect(staleOnly(stale)).toBe(true);

    const both = check(
      snap([limit({ utilization: 99, observedAt: T0 - 60 * M })]),
      { budgetPct: 50, maxAgeMs: 10 * M },
      T0,
    );
    // Staleness must not mask the real failure.
    expect(staleOnly(both)).toBe(false);
    expect(both.evaluated[0]!.failed).toEqual(['budget', 'stale']);
  });

  it('never calls a passing or empty result stale-only', () => {
    expect(staleOnly(check(snap([limit()]), {}, T0))).toBe(false);
    expect(staleOnly(check(snap([]), {}, T0))).toBe(false);
  });

  it('restates the question it answered', () => {
    const r = check(snap([limit()]), { budgetPct: 20, pace: ['on-pace'] }, T0);
    expect(r.predicate).toContain('at least 20%');
    expect(r.predicate).toContain('on-pace');
    expect(r.predicate).toContain('binding limit');
  });
});
