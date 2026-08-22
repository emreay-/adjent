/**
 * Alarm engine spec (docs/ALARMS.md § Testing): synthetic timelines with
 * expected fire/no-fire. These tests ARE the spec. All values synthetic.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/rules/evaluate.js';
import { emptyFireLog } from '../src/model/types.js';
import type {
  AgentBurnRule,
  AppState,
  PaceRule,
  QuotaWindow,
  ThresholdRule,
  WindowAssessment,
} from '../src/model/types.js';

const H = 3600_000;
const T0 = 1_700_000_000_000; // arbitrary synthetic epoch

function win(partial: Partial<QuotaWindow>): QuotaWindow {
  return {
    backend: 'claude',
    key: '5h',
    label: 'Claude · 5h',
    windowMinutes: 300,
    utilization: 0,
    resetsAt: T0 + 5 * H,
    severity: null,
    vendorActive: false,
    scope: null,
    source: 'reported',
    observedAt: T0,
    ...partial,
  };
}

function assess(w: QuotaWindow, now: number, burnPctPerHour: number | null): WindowAssessment {
  const windowMs = w.windowMinutes * 60_000;
  const start = (w.resetsAt ?? now) - windowMs;
  const paceLinePct = Math.min(100, Math.max(0, ((now - start) / windowMs) * 100));
  const burn = burnPctPerHour === null ? null : { pctPerHour: burnPctPerHour, updatedAt: now };
  const exhaustsAt = burn && burn.pctPerHour > 0 ? now + ((100 - w.utilization) / burn.pctPerHour) * H : null;
  return { window: w, burn, verdict: 'on-pace', paceLinePct, exhaustsAt, binding: true };
}

function state(windows: WindowAssessment[], burns: AppState['agentBurns'] = []): AppState {
  return {
    generatedAt: T0,
    backends: [],
    agents: [
      { id: 'claude:a1', backend: 'claude', label: 'proj-one', projectPath: null, gitBranch: null, model: 'model-x', effort: 'high', entrypoint: null, parentId: null, pid: null, state: 'live', startedAt: T0, lastActivityAt: T0, totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 } },
      { id: 'claude:a2', backend: 'claude', label: 'proj-two', projectPath: null, gitBranch: null, model: 'model-x', effort: null, entrypoint: null, parentId: null, pid: null, state: 'live', startedAt: T0, lastActivityAt: T0, totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 } },
      { id: 'claude:a3', backend: 'claude', label: 'proj-three', projectPath: null, gitBranch: null, model: 'model-x', effort: null, entrypoint: null, parentId: null, pid: null, state: 'live', startedAt: T0, lastActivityAt: T0, totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 } },
    ],
    windows,
    agentBurns: burns,
    epsilon: null,
    fitConfidence: 'high',
  };
}

const paceRule: PaceRule = { id: 'pace', type: 'pace', backend: 'any', window: 'any', tolerancePp: 10, exhaustionLeadMin: 45, cooldownMin: 20, severity: 'warn' };
const thresholdRule: ThresholdRule = { id: 'steps', type: 'threshold', backend: 'any', window: 'any', levels: [25, 50, 80, 95], severity: { 80: 'warn', 95: 'critical' } };
const burnRule: AgentBurnRule = { id: 'runaway', type: 'agent_burn', windowMin: 10, relToMedian: 4, sharePct: 60, absPctPerHour: 8, cooldownMin: 15, severity: 'warn' };

describe('pace rule', () => {
  it('stays silent through a steady on-pace window', () => {
    const log = emptyFireLog();
    // hour-by-hour, utilization tracks the pace line exactly
    for (let h = 0; h <= 4; h++) {
      const now = T0 + h * H;
      const w = win({ utilization: h * 20, observedAt: now, resetsAt: T0 + 5 * H });
      const a = { ...assess(w, now, 20), exhaustsAt: null }; // exactly on pace → exhausts at reset, not early
      const alarms = evaluate(state([a]), [paceRule], log, now);
      expect(alarms, `hour ${h}`).toHaveLength(0);
    }
  });

  it('fires on a front-loaded window at minute 40', () => {
    const log = emptyFireLog();
    const now = T0 + (40 / 60) * H; // 40 min in ⇒ pace line ≈ 13%
    const w = win({ utilization: 45, observedAt: now });
    const alarms = evaluate(state([assess(w, now, 50)]), [paceRule], log, now);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.title).toContain('Ahead of pace');
    expect(alarms[0]!.body).toMatch(/45% with/);
  });

  it('does not re-fire while latched above the line (hysteresis)', () => {
    const log = emptyFireLog();
    const now = T0 + H;
    const w = win({ utilization: 60, observedAt: now });
    // exhaustsAt null → isolate the above-pace path
    const first = evaluate(state([{ ...assess(w, now, 0), exhaustsAt: null, burn: { pctPerHour: 30, updatedAt: now } }]), [paceRule], log, now);
    expect(first).toHaveLength(1);
    // 25 min later (cooldown passed) but still above the line and still latched:
    const later = now + 25 * 60_000;
    const w2 = win({ utilization: 62, observedAt: later });
    const second = evaluate(state([{ ...assess(w2, later, 0), exhaustsAt: null, burn: { pctPerHour: 30, updatedAt: later } }]), [paceRule], log, later);
    expect(second).toHaveLength(0);
  });
});

describe('threshold rule', () => {
  it('fires each level once, not on oscillation', () => {
    const log = emptyFireLog();
    const seq = [45, 52, 49, 51, 53]; // crosses 50, then oscillates around it
    let fired = 0;
    for (const [i, u] of seq.entries()) {
      const now = T0 + i * 60_000;
      const w = win({ utilization: u, observedAt: now });
      fired += evaluate(state([assess(w, now, 5)]), [thresholdRule], log, now).length;
    }
    expect(fired).toBe(2); // 25 and 50, each exactly once
  });

  it('rearms after a window reset', () => {
    const log = emptyFireLog();
    let now = T0 + H;
    let w = win({ utilization: 85, observedAt: now, resetsAt: T0 + 5 * H });
    const first = evaluate(state([assess(w, now, 5)]), [thresholdRule], log, now);
    expect(first.map((a) => a.id).some((id) => id.endsWith(':80'))).toBe(true);

    // window rolls over: resetsAt jumps forward, utilization drops
    now = T0 + 6 * H;
    w = win({ utilization: 5, observedAt: now, resetsAt: T0 + 10 * H });
    expect(evaluate(state([assess(w, now, 5)]), [thresholdRule], log, now)).toHaveLength(0);

    // climbs to 80 again in the fresh window → fresh alarms
    now = T0 + 7 * H;
    w = win({ utilization: 82, observedAt: now, resetsAt: T0 + 10 * H });
    const again = evaluate(state([assess(w, now, 5)]), [thresholdRule], log, now);
    expect(again.map((a) => a.id).some((id) => id.endsWith(':80'))).toBe(true);
  });

  it('severity mapping is honored', () => {
    const log = emptyFireLog();
    const now = T0 + H;
    const w = win({ utilization: 96, observedAt: now });
    const alarms = evaluate(state([assess(w, now, 5)]), [thresholdRule], log, now);
    const at95 = alarms.find((a) => a.id.endsWith(':95'));
    expect(at95?.severity).toBe('critical');
  });
});

describe('agent_burn rule', () => {
  it('a lone looping agent trips the absolute floor, not the median test', () => {
    const log = emptyFireLog();
    const alarms = evaluate(
      state([], [{ agentId: 'claude:a1', pctPerHour: 12, confidence: 'high' }]),
      [burnRule],
      log,
      T0,
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.body).toContain('12.0%/h');
  });

  it('a runaway relative to peers trips the median test', () => {
    const log = emptyFireLog();
    const alarms = evaluate(
      state([], [
        { agentId: 'claude:a1', pctPerHour: 5, confidence: 'high' },
        { agentId: 'claude:a2', pctPerHour: 1, confidence: 'high' },
        { agentId: 'claude:a3', pctPerHour: 1.1, confidence: 'high' },
      ]),
      [burnRule],
      log,
      T0,
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.agentId).toBe('claude:a1');
  });

  it('quiet balanced agents stay silent', () => {
    const log = emptyFireLog();
    const alarms = evaluate(
      state([], [
        { agentId: 'claude:a1', pctPerHour: 2, confidence: 'high' },
        { agentId: 'claude:a2', pctPerHour: 1.8, confidence: 'high' },
        { agentId: 'claude:a3', pctPerHour: 2.2, confidence: 'high' },
      ]),
      [burnRule],
      log,
      T0,
    );
    expect(alarms).toHaveLength(0);
  });

  it('cooldown suppresses immediate re-fire', () => {
    const log = emptyFireLog();
    const burns = [{ agentId: 'claude:a1', pctPerHour: 12, confidence: 'high' as const }];
    expect(evaluate(state([], burns), [burnRule], log, T0)).toHaveLength(1);
    expect(evaluate(state([], burns), [burnRule], log, T0 + 5 * 60_000)).toHaveLength(0);
    expect(evaluate(state([], burns), [burnRule], log, T0 + 20 * 60_000)).toHaveLength(1);
  });
});
