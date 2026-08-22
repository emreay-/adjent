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
  AppState,
  FireLog,
  PaceRule,
  Rule,
  Severity,
  ThresholdRule,
  WindowAssessment,
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
  for (const a of state.windows) {
    const key = wkey(a);
    const resetsAt = a.window.resetsAt;
    if (resetsAt === null) continue;
    const prev = memory.lastResetsAt[key];
    if (prev !== undefined && resetsAt > prev + 60_000) {
      delete memory.firedLevels[key];
      delete memory.paceLatched[key];
    }
    memory.lastResetsAt[key] = resetsAt;
  }
}

const wkey = (a: WindowAssessment): string => `${a.window.backend}:${a.window.key}`;

const matches = (rule: PaceRule | ThresholdRule, a: WindowAssessment): boolean =>
  (rule.backend === 'any' || rule.backend === a.window.backend) &&
  (rule.window === 'any' || rule.window === a.window.key);

function cooldownOk(memory: FireLog, id: string, cooldownMin: number, now: number): boolean {
  const last = memory.lastFired[id];
  return last === undefined || now - last >= cooldownMin * 60_000;
}

// ---------------------------------------------------------------------------
function evalPace(rule: PaceRule, state: AppState, memory: FireLog, now: number): Alarm[] {
  const out: Alarm[] = [];
  for (const a of state.windows) {
    if (!matches(rule, a)) continue;
    const disc = `${rule.id}:${wkey(a)}`;
    const u = a.window.utilization;
    const pace = a.paceLinePct;
    if (pace === null) continue;

    const above = u > pace + rule.tolerancePp;
    // Hysteresis: clear only once back under pace + tolerance/2.
    const latched = memory.paceLatched[disc] === true;
    if (latched && u < pace + rule.tolerancePp / 2) memory.paceLatched[disc] = false;

    const early =
      a.exhaustsAt !== null &&
      a.window.resetsAt !== null &&
      a.window.resetsAt - a.exhaustsAt >= rule.exhaustionLeadMin * 60_000;

    if ((above && !latched) || early) {
      if (!cooldownOk(memory, disc, rule.cooldownMin, now)) continue;
      memory.lastFired[disc] = now;
      if (above) memory.paceLatched[disc] = true;
      const resetIn = a.window.resetsAt !== null ? fmtDur(a.window.resetsAt - now) : 'unknown';
      const meaning =
        a.exhaustsAt !== null && a.window.resetsAt !== null && a.exhaustsAt < a.window.resetsAt
          ? `At this rate the window runs out at ${fmtTime(a.exhaustsAt)}.`
          : `The pace line is at ${pace.toFixed(0)}%.`;
      out.push({
        id: disc,
        ruleId: rule.id,
        severity: rule.severity,
        title: `Ahead of pace — ${a.window.label}`,
        body: `${a.window.label} at ${u.toFixed(0)}% with ${resetIn} left. ${meaning}`,
        firedAt: now,
        backend: a.window.backend,
        windowKey: a.window.key,
        agentId: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
function evalThreshold(rule: ThresholdRule, state: AppState, memory: FireLog, now: number): Alarm[] {
  const out: Alarm[] = [];
  for (const a of state.windows) {
    if (!matches(rule, a)) continue;
    const key = wkey(a);
    const fired = (memory.firedLevels[key] ??= []);
    for (const level of rule.levels) {
      if (a.window.utilization < level || fired.includes(level)) continue;
      fired.push(level); // edge-triggered: once per level per window occupancy
      const severity: Severity = rule.severity[level] ?? 'info';
      const resetIn = a.window.resetsAt !== null ? fmtDur(a.window.resetsAt - now) : 'unknown';
      out.push({
        id: `${rule.id}:${key}:${level}`,
        ruleId: rule.id,
        severity,
        title: `${a.window.label} crossed ${level}%`,
        body: `${a.window.label} is at ${a.window.utilization.toFixed(0)}% with ${resetIn} until reset.`,
        firedAt: now,
        backend: a.window.backend,
        windowKey: a.window.key,
        agentId: null,
      });
    }
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
      windowKey: null,
      agentId: b.agentId,
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
