/**
 * The alarm engine (docs/ALARMS.md): evaluate(state, rules, memory, now) → Alarm[].
 * Pure — no I/O, no timers. FireLog carries hysteresis/cooldown/rearm state and
 * is mutated by evaluation (callers persist it).
 *
 * Copy follows docs/UI.md: what happened, then what it means.
 */
import type {
  AgentBurnRule,
  Alarm,
  AlarmAgentSnapshot,
  AlarmContext,
  AppState,
  FireLog,
  PaceRule,
  Rule,
  Severity,
  ThresholdRule,
  LimitAssessment,
} from '../model/types.js';

export function evaluate(state: AppState, rules: Rule[], memory: FireLog, now: number): Alarm[] {
  const out: Alarm[] = [];
  rearmOnReset(state, memory);
  for (const rule of rules) {
    switch (rule.type) {
      case 'pace':
        out.push(...evalPace(rule, state, memory, now));
        break;
      case 'threshold':
        out.push(...evalThreshold(rule, state, memory, now));
        break;
      case 'agent_burn':
        out.push(...evalAgentBurn(rule, state, memory, now));
        break;
    }
  }
  return out;
}

/** Threshold levels rearm when a window's resetsAt moves forward (docs/ALARMS.md). */
function rearmOnReset(state: AppState, memory: FireLog): void {
  for (const a of state.limits) {
    const key = wkey(a);
    const resetsAt = a.limit.resetsAt;
    if (resetsAt === null) continue;
    const prev = memory.lastResetsAt[key];
    if (prev !== undefined && resetsAt > prev + 60_000) {
      // Empty, not deleted: `undefined` must keep meaning "never observed".
      memory.firedLevels[key] = [];
      delete memory.paceLatched[key];
    }
    memory.lastResetsAt[key] = resetsAt;
  }
}

const wkey = (a: LimitAssessment): string => `${a.limit.backend}:${a.limit.key}`;

const MAX_CONTEXT_AGENTS = 4;

/** Snapshot the agents that were actually running, most expensive first. */
function agentSnapshots(state: AppState, only?: string): AlarmAgentSnapshot[] {
  const burnOf = new Map(state.agentBurns.map((b) => [b.agentId, b.pctPerHour]));
  const pool = state.agents.filter((a) => (only ? a.id === only : a.state !== 'ended'));
  return pool
    .map((a) => ({
      label: a.label,
      project: a.projectPath ? (a.projectPath.split(/[\\/]/).pop() ?? a.projectPath) : null,
      branch: a.gitBranch,
      model: a.model,
      effort: a.effort,
      pctPerHour: burnOf.get(a.id) ?? null,
      tokens: a.totals.input + a.totals.cacheWrite + a.totals.cacheRead + a.totals.output,
    }))
    .sort((x, y) => (y.pctPerHour ?? -1) - (x.pctPerHour ?? -1))
    .slice(0, MAX_CONTEXT_AGENTS);
}

function windowContext(state: AppState, a: LimitAssessment, only?: string): AlarmContext {
  const backend = state.backends.find((b) => b.id === a.limit.backend);
  return {
    limitLabel: a.limit.label,
    utilization: a.limit.utilization,
    burnPctPerHour: a.burn?.pctPerHour ?? null,
    paceLinePct: a.paceLinePct,
    resetsAt: a.limit.resetsAt,
    exhaustsAt: a.exhaustsAt,
    plan: backend?.plan ?? null,
    fitConfidence: state.fitConfidence,
    agents: agentSnapshots(state, only),
  };
}

const matches = (rule: PaceRule | ThresholdRule, a: LimitAssessment): boolean =>
  (rule.backend === 'any' || rule.backend === a.limit.backend) &&
  (rule.limit === 'any' || rule.limit === a.limit.key);

function cooldownOk(memory: FireLog, id: string, cooldownMin: number, now: number): boolean {
  const last = memory.lastFired[id];
  return last === undefined || now - last >= cooldownMin * 60_000;
}

// ---------------------------------------------------------------------------
function evalPace(rule: PaceRule, state: AppState, memory: FireLog, now: number): Alarm[] {
  const out: Alarm[] = [];
  for (const a of state.limits) {
    if (!matches(rule, a)) continue;
    const disc = `${rule.id}:${wkey(a)}`;
    const u = a.limit.utilization;
    const pace = a.paceLinePct;
    if (pace === null) continue;

    const above = u > pace + rule.tolerancePp;
    // Hysteresis: clear only once back under pace + tolerance/2.
    const latched = memory.paceLatched[disc] === true;
    if (latched && u < pace + rule.tolerancePp / 2) memory.paceLatched[disc] = false;

    const early =
      a.exhaustsAt !== null &&
      a.limit.resetsAt !== null &&
      a.limit.resetsAt - a.exhaustsAt >= rule.exhaustionLeadMin * 60_000;

    if ((above && !latched) || early) {
      if (!cooldownOk(memory, disc, rule.cooldownMin, now)) continue;
      memory.lastFired[disc] = now;
      if (above) memory.paceLatched[disc] = true;
      const resetIn = a.limit.resetsAt !== null ? fmtDur(a.limit.resetsAt - now) : 'unknown';
      const meaning =
        a.exhaustsAt !== null && a.limit.resetsAt !== null && a.exhaustsAt < a.limit.resetsAt
          ? `At this rate the window runs out at ${fmtTime(a.exhaustsAt)}.`
          : `The pace line is at ${pace.toFixed(0)}%.`;
      out.push({
        id: disc,
        ruleId: rule.id,
        severity: rule.severity,
        title: `Ahead of pace — ${a.limit.label}`,
        body: `${a.limit.label} at ${u.toFixed(0)}% with ${resetIn} left. ${meaning}`,
        firedAt: now,
        backend: a.limit.backend,
        limitKey: a.limit.key,
        agentId: null,
        context: windowContext(state, a),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
function evalThreshold(rule: ThresholdRule, state: AppState, memory: FireLog, now: number): Alarm[] {
  const out: Alarm[] = [];
  for (const a of state.limits) {
    if (!matches(rule, a)) continue;
    const key = wkey(a);
    // `undefined` means this window has never been observed. Distinguishing
    // that from an empty array is what stops a first sight at 100% announcing
    // every level below it.
    const firstSight = memory.firedLevels[key] === undefined;
    const fired = (memory.firedLevels[key] ??= []);

    const crossed = rule.levels.filter((l) => a.limit.utilization >= l && !fired.includes(l));
    if (crossed.length === 0) continue;
    fired.push(...crossed); // arm every crossed level, announce at most one

    // Only the highest level is informative: 95% already implies 25/50/80, and
    // it carries the most severe routing. Announcing the rest is noise.
    const level = Math.max(...crossed);
    const severity: Severity = rule.severity[level] ?? 'info';
    const resetIn = a.limit.resetsAt !== null ? fmtDur(a.limit.resetsAt - now) : 'unknown';
    const u = a.limit.utilization;

    if (firstSight) {
      // We joined mid-window: nothing "crossed" while we were watching, so
      // saying so would be false. Stay silent unless the state is bad enough
      // that silence is worse, and then say what is true — "already at".
      if (severity === 'info') continue;
      out.push({
        id: `${rule.id}:${key}:already`,
        ruleId: rule.id,
        severity,
        title: `${a.limit.label} is already at ${u.toFixed(0)}%`,
        body: `Adjent started with this window past ${level}%. ${resetIn} until reset.`,
        firedAt: now,
        backend: a.limit.backend,
        limitKey: a.limit.key,
        agentId: null,
        context: windowContext(state, a),
      });
      continue;
    }

    out.push({
      id: `${rule.id}:${key}:${level}`,
      ruleId: rule.id,
      severity,
      title: `${a.limit.label} crossed ${level}%`,
      body: `${a.limit.label} is at ${u.toFixed(0)}% with ${resetIn} until reset.`,
      firedAt: now,
      backend: a.limit.backend,
      limitKey: a.limit.key,
      agentId: null,
      context: windowContext(state, a),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
function evalAgentBurn(rule: AgentBurnRule, state: AppState, memory: FireLog, now: number): Alarm[] {
  const out: Alarm[] = [];
  const burns = state.agentBurns.filter((b) => b.pctPerHour > 0);
  if (burns.length === 0) return out;
  const rates = burns.map((b) => b.pctPerHour).sort((a, b) => a - b);
  const median = rates[rates.length >> 1] as number;
  const total = rates.reduce((a, b) => a + b, 0);

  for (const b of burns) {
    const relTrip = burns.length >= 2 && median > 0 && b.pctPerHour > rule.relToMedian * median;
    const shareTrip = total > 0 && burns.length >= 2 && (b.pctPerHour / total) * 100 > rule.sharePct;
    // The absolute floor exists because a lone looping agent has no peers
    // to look abnormal against (docs/ALARMS.md).
    const absTrip = b.pctPerHour > rule.absPctPerHour;
    if (!relTrip && !shareTrip && !absTrip) continue;

    const disc = `${rule.id}:${b.agentId}`;
    if (!cooldownOk(memory, disc, rule.cooldownMin, now)) continue;
    memory.lastFired[disc] = now;

    const agent = state.agents.find((a) => a.id === b.agentId);
    const label = agent?.label ?? b.agentId;
    const reason = absTrip
      ? `burning ≈${b.pctPerHour.toFixed(1)}%/h of the window`
      : shareTrip
        ? `≈${(((b.pctPerHour / total) * 100) | 0)}% of all current burn`
        : `≈${(b.pctPerHour / median).toFixed(1)}× the median agent`;
    out.push({
      id: disc,
      ruleId: rule.id,
      severity: rule.severity,
      title: `Runaway agent — ${label}`,
      body: `${label} is ${reason}${agent?.model ? ` on ${agent.model}` : ''}${agent?.effort ? ` · ${agent.effort}` : ''}.`,
      firedAt: now,
      backend: agent?.backend ?? null,
      limitKey: null,
      agentId: b.agentId,
      // Scope the snapshot to the offending agent, plus the binding window's
      // state so the alarm still says how much room was left.
      context: {
        ...(state.limits.find((w) => w.binding)
          ? windowContext(state, state.limits.find((w) => w.binding) as LimitAssessment, b.agentId)
          : {
              limitLabel: null,
              utilization: null,
              burnPctPerHour: null,
              paceLinePct: null,
              resetsAt: null,
              exhaustsAt: null,
              plan: null,
              fitConfidence: state.fitConfidence,
              agents: agentSnapshots(state, b.agentId),
            }),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
export function fmtDur(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export function fmtTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
