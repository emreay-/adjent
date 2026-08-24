/**
 * Replay: prove a rule against history before it has to fire.
 *
 * Authoring an alarm is guesswork until you can ask "would this have fired last
 * Tuesday, and how often?". That is the credibility layer — the difference
 * between a threshold someone picked and one someone checked.
 *
 * Pure by construction: samples in, alarms out. The caller reads the file.
 *
 * **The honesty problem this design exists to avoid.** History records vendor
 * utilization over time — nothing about agents. So `agent_burn`, and any future
 * rule needing per-agent data, cannot be evaluated from history at all. A
 * replay that quietly answered "no alarms" for such a rule would be actively
 * misleading: the reader would conclude the rule is calm when in fact it was
 * never asked. Those rules are reported as **not evaluable**, by name and with
 * the reason, and are excluded from the run rather than run against a lie.
 */
import type { Alarm, AppState, LimitAssessment, QuotaLimit, Rule } from '../model/types.js';
import type { HistorySample } from '../persist.js';
import { emptyFireLog } from '../model/types.js';
import { evaluate } from './evaluate.js';
import { paceLine, verdictFor, exhaustion } from '../quota/assess.js';

export interface ReplayOptions {
  /**
   * Window length per limit key, in minutes. History does not record it, and
   * `resetsAt` cannot be reconstructed without it. Unlisted keys fall back to
   * `defaultWindowMinutes`.
   */
  windowMinutes?: Record<string, number>;
  /** Used for limit keys not named above. */
  defaultWindowMinutes?: number;
}

/** A rule that history cannot answer for, and why. */
export interface NotEvaluable {
  ruleId: string;
  type: string;
  reason: string;
}

export interface ReplayedAlarm {
  alarm: Alarm;
  /** The sample that produced it, so a caller can show the input. */
  sample: HistorySample;
}

export interface ReplayResult {
  alarms: ReplayedAlarm[];
  /** ruleId → number of times it fired. Zero-filled for rules that were run. */
  byRule: Record<string, number>;
  /** Rules excluded from the run, with the reason. Never silently dropped. */
  notEvaluable: NotEvaluable[];
  /** How many samples were replayed, and the span they cover. */
  samples: number;
  from: number | null;
  to: number | null;
  /** Longest gap between consecutive alarms, in ms — the "quiet stretch". */
  longestSilenceMs: number | null;
}

/** Rule types that need data history does not carry. */
const NEEDS_AGENTS = new Set(['agent_burn', 'anomaly']);

const DEFAULT_WINDOW_MINUTES = 300;

/** `claude:session` → the label a person would recognise. */
function labelFor(key: string): string {
  const [backend, ...rest] = key.split(':');
  const tail = rest.join(':') || backend || key;
  const vendor = backend === 'codex' ? 'Codex' : 'Claude';
  return `${vendor} · ${tail}`;
}

const backendOf = (key: string): 'claude' | 'codex' => (key.startsWith('codex') ? 'codex' : 'claude');

/**
 * Rebuild the state one sample implies.
 *
 * `resetsAt` is reconstructed by rounding the sample's time up to the next
 * window boundary. It is a reconstruction, not a record — history never stored
 * it — which is why `windowMinutes` is a caller-supplied option rather than a
 * guess buried in here.
 */
function stateAt(
  sample: HistorySample,
  windowMinutes: number,
  track: Map<string, { at: number; u: number }>,
): AppState {
  const windowMs = windowMinutes * 60_000;
  const resetsAt = Math.ceil(sample.t / windowMs) * windowMs;

  const limit: QuotaLimit = {
    backend: backendOf(sample.w),
    key: sample.w.split(':').slice(1).join(':') || sample.w,
    label: labelFor(sample.w),
    windowMinutes,
    utilization: sample.u,
    resetsAt,
    severity: null,
    vendorActive: false,
    scope: null,
    source: 'reported',
    observedAt: sample.t,
  };

  // Burn between consecutive samples of the same limit, in points per hour —
  // the same quantity the live assessor measures, computed the same way.
  const prev = track.get(sample.w);
  const dt = prev ? sample.t - prev.at : 0;
  const burn =
    prev && dt > 0 ? { pctPerHour: ((sample.u - prev.u) / dt) * 3600_000, updatedAt: sample.t } : null;
  track.set(sample.w, { at: sample.t, u: sample.u });

  const pace = paceLine(limit, sample.t);
  const assessment: LimitAssessment = {
    limit,
    burn,
    verdict: verdictFor(limit, burn, pace),
    paceLinePct: pace,
    exhaustsAt: exhaustion(limit, burn, sample.t),
    binding: true,
    tokens: null,
  };

  return {
    generatedAt: sample.t,
    backends: [],
    agents: [],
    limits: [assessment],
    agentBurns: [],
    epsilon: null,
    fitConfidence: 'low',
  };
}

export function replayHistory(
  samples: HistorySample[],
  rules: Rule[],
  opts: ReplayOptions = {},
): ReplayResult {
  const notEvaluable: NotEvaluable[] = rules
    .filter((r) => NEEDS_AGENTS.has(r.type))
    .map((r) => ({
      ruleId: r.id,
      type: r.type,
      reason:
        'history records vendor utilization only, with no per-agent data — this rule was not evaluated, and "no alarms" would be misleading',
    }));

  const runnable = rules.filter((r) => !NEEDS_AGENTS.has(r.type));
  const byRule: Record<string, number> = {};
  for (const r of runnable) byRule[r.id] = 0;

  // Timestamp order matters: the fire log is stateful, and cooldowns and
  // threshold rearming only mean anything if events arrive as they happened.
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  const fireLog = emptyFireLog();
  const track = new Map<string, { at: number; u: number }>();
  const alarms: ReplayedAlarm[] = [];

  for (const sample of ordered) {
    const windowMinutes =
      opts.windowMinutes?.[sample.w] ?? opts.defaultWindowMinutes ?? DEFAULT_WINDOW_MINUTES;
    const fired = evaluate(stateAt(sample, windowMinutes, track), runnable, fireLog, sample.t);
    for (const alarm of fired) {
      alarms.push({ alarm, sample });
      byRule[alarm.ruleId] = (byRule[alarm.ruleId] ?? 0) + 1;
    }
  }

  // The longest quiet stretch, which is what tells you whether a rule is
  // usable or merely correct: one that fires every four minutes is noise.
  let longestSilenceMs: number | null = null;
  for (let i = 1; i < alarms.length; i++) {
    const gap = alarms[i]!.alarm.firedAt - alarms[i - 1]!.alarm.firedAt;
    if (longestSilenceMs === null || gap > longestSilenceMs) longestSilenceMs = gap;
  }

  return {
    alarms,
    byRule,
    notEvaluable,
    samples: ordered.length,
    from: ordered.length > 0 ? ordered[0]!.t : null,
    to: ordered.length > 0 ? ordered[ordered.length - 1]!.t : null,
    longestSilenceMs,
  };
}
