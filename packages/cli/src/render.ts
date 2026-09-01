/**
 * Human rendering. Separated from the command table so the same data can be
 * served two ways without either format bending to suit the other.
 *
 * Follows docs/UI.md: measured values plain, derived values with ≈, the binding
 * limit leads, verdict words carry the meaning rather than colour alone.
 */
import {
  agentLabels,
  compareUrgency,
  fmtDur,
  fmtWhen,
  isKnownModel,
  type AppState,
  type LimitAssessment,
  type Snapshot,
} from '@adjent/core';

export const VERDICT_MARK: Record<string, string> = { 'on-pace': '✓', ahead: '▲', over: '■', idle: '·' };
export const VERDICT_WORD: Record<string, string> = {
  'on-pace': 'On pace',
  ahead: 'Ahead of pace',
  over: 'Over',
  idle: 'Idle',
};

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Billable kinds only — thinking already sits inside output for both vendors. */
const sumTokens = (t: { input: number; cacheWrite: number; cacheRead: number; output: number }): number =>
  t.input + t.cacheWrite + t.cacheRead + t.output;

/** Longest duration worth printing: past this it is a missing timestamp. */
const MAX_SANE_DUR_MS = 400 * 24 * 3600_000;
const durOrNull = (ms: number): string | null =>
  Number.isFinite(ms) && ms > 0 && ms <= MAX_SANE_DUR_MS ? fmtDur(ms) : null;

/**
 * Binding first, then by urgency — the same order the panel uses, so the two
 * surfaces never disagree about which limit matters most.
 */
export function orderedLimits(limits: LimitAssessment[]): LimitAssessment[] {
  return [...limits].sort((a, b) => Number(b.binding) - Number(a.binding) || compareUrgency(a, b));
}

function limitLine(a: LimitAssessment, now: number): string {
  const w = a.limit;
  const mark = VERDICT_MARK[a.verdict] ?? '·';
  const rate =
    a.burn && Math.abs(a.burn.pctPerHour) >= 0.05
      ? `  ${a.burn.pctPerHour >= 0 ? '+' : ''}${a.burn.pctPerHour.toFixed(1)} %/h`
      : '';
  const reset = w.resetsAt !== null ? `  resets in ${fmtDur(w.resetsAt - now)}` : '';
  const binding = a.binding ? '  ← binding' : '';
  const exhaust =
    a.exhaustsAt !== null && w.resetsAt !== null && a.exhaustsAt < w.resetsAt
      ? `  runs out ${fmtWhen(a.exhaustsAt, now)}`
      : '';
  // Every limit carries its own token count, not just the binding one.
  const tok = a.tokens ? sumTokens(a.tokens) : 0;
  const tokens = `  ${(tok > 0 ? fmtTokens(tok) : '—').padStart(8)} tok`;
  return `  ${mark} ${w.label.padEnd(22)} ${String(Math.round(w.utilization)).padStart(3)}%${tokens}${rate}${reset}${exhaust}${binding}`;
}

export function renderLimits(state: AppState): string {
  const lines = ['Quota limits'];
  if (state.limits.length === 0) lines.push('  (none reported)');
  for (const a of orderedLimits(state.limits)) lines.push(limitLine(a, state.generatedAt));
  return lines.join('\n');
}

export function renderAgents(state: AppState, limit = 10): string {
  const now = state.generatedAt;
  const burnOf = new Map(state.agentBurns.map((b) => [b.agentId, b.pctPerHour]));
  const live = state.agents.filter((a) => a.state !== 'ended');
  // Labelled against every agent, not just the ones printed: a row must not
  // change its name depending on how many happen to fit under `limit`.
  const labelOf = agentLabels(state.agents);
  const lines = [`Agents (${live.length} live/idle)`];
  if (live.length === 0) lines.push('  (none)');

  // Burn, then tokens in the window, then recency — the same ordering the
  // panel's agents view uses.
  const sorted = [...live].sort(
    (a, b) =>
      (burnOf.get(b.id) ?? 0) - (burnOf.get(a.id) ?? 0) ||
      sumTokens(b.totals) - sumTokens(a.totals) ||
      b.lastActivityAt - a.lastActivityAt,
  );
  for (const a of sorted.slice(0, limit)) {
    const burn = burnOf.get(a.id);
    const idleFor = a.lastActivityAt ? durOrNull(now - a.lastActivityAt) : null;
    // Missing burn means the fit is silent, not that the agent stopped.
    const state_ =
      burn !== undefined
        ? `≈${burn.toFixed(1)} %/h`
        : a.state === 'idle'
          ? idleFor
            ? `idle ${idleFor}`
            : 'idle'
          : 'live';
    // A placeholder is a bucket key, never an answer to "which model".
    const model = [isKnownModel(a.model) ? a.model : '—', a.effort].filter(Boolean).join(' · ');
    const proj = labelOf.get(a.id) ?? a.label;
    lines.push(
      `  ${a.state === 'live' ? '●' : '·'} ${String(proj).padEnd(24).slice(0, 24)} ${model
        .padEnd(22)
        .slice(0, 22)} ${state_.padStart(12)}  ${fmtTokens(sumTokens(a.totals)).padStart(8)} tok`,
    );
  }
  return lines.join('\n');
}

export function renderBackends(state: AppState): string {
  const lines = ['Backends'];
  if (state.backends.length === 0) lines.push('  (none detected)');
  for (const b of state.backends) {
    const bits = [
      b.displayName,
      b.version ?? '',
      b.plan ? `plan: ${b.plan}` : '',
      b.health !== 'ok' ? `[${b.health}] ${b.healthDetail ?? ''}` : '',
    ]
      .filter(Boolean)
      .join('  ');
    lines.push(`  ${bits}`);
  }
  return lines.join('\n');
}

export function renderStatus(state: AppState): string {
  const lines: string[] = [];
  const binding = state.limits.find((a) => a.binding);
  if (binding) {
    const word = VERDICT_WORD[binding.verdict] ?? '';
    lines.push(
      `${VERDICT_MARK[binding.verdict] ?? ''} ${word} — ${binding.limit.label} at ${Math.round(
        binding.limit.utilization,
      )}%`,
    );
  }
  lines.push('', renderLimits(state), '', renderBackends(state), '', renderAgents(state));
  if (state.epsilon !== null) {
    lines.push('', `fit confidence: ${state.fitConfidence}  ·  ε ${state.epsilon.toFixed(2)} %/h`);
  }
  return lines.join('\n');
}

export function renderStatusline(state: AppState): string {
  const b = state.limits.find((a) => a.binding);
  if (!b) return 'adjent: no quota data';
  const mark = VERDICT_MARK[b.verdict] ?? '';
  const rate =
    b.burn && Math.abs(b.burn.pctPerHour) >= 0.05
      ? ` ${b.burn.pctPerHour >= 0 ? '+' : ''}${b.burn.pctPerHour.toFixed(0)}%/h`
      : '';
  const reset = b.limit.resetsAt !== null ? ` ↺${fmtDur(b.limit.resetsAt - state.generatedAt)}` : '';
  return `${mark} ${b.limit.label} ${Math.round(b.limit.utilization)}%${rate}${reset}`;
}

/** Wrap prose to a readable width without pulling in a dependency. */
export function wrap(text: string, width = 76, indent = '  '): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      out.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}

/**
 * Why a snapshot is empty, in one line, for stderr. Silence would leave a
 * caller unable to tell "nothing running" from "Adjent is broken".
 */
export function degradationNote(snapshot: Snapshot): string | null {
  if (snapshot.backends.length === 0) {
    return 'no backend detected — is Claude Code or Codex installed for this user?';
  }
  const unhealthy = snapshot.backends.filter((b) => b.health !== 'ok');
  if (unhealthy.length > 0) {
    return unhealthy.map((b) => `${b.id}: ${b.health}${b.healthDetail ? ` — ${b.healthDetail}` : ''}`).join('; ');
  }
  if (snapshot.limits.length === 0) {
    return 'no quota reported — the vendor publishes limits only after recent activity';
  }
  return null;
}
