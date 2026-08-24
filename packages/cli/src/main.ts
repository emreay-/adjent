#!/usr/bin/env node
/**
 * adjent — headless CLI (M1).
 *   adjent status      one snapshot: backends, quota limits, agents
 *   adjent watch       continuous loop with alarms to the console
 *   adjent statusline  one line for Claude Code's statusLine setting
 *   adjent explain     plain-language definition of any metric shown
 *
 * Rendering follows docs/UI.md: measured values plain, derived values with ≈,
 * the binding limit leads, verdict words carry the meaning.
 */
import {
  ClaudeProvider,
  CodexProvider,
  ConsoleSink,
  EXPLANATIONS,
  EXPLANATION_KEYS,
  Monitor,
  PROVENANCE_NOTE,
  fmtDur,
  fmtTime,
  fmtWhen,
  loadConfig,
  type AppState,
  type LimitAssessment,
} from '@adjent/core';

const VERDICT_MARK: Record<string, string> = { 'on-pace': '✓', ahead: '▲', over: '■', idle: '·' };
const VERDICT_WORD: Record<string, string> = {
  'on-pace': 'On pace',
  ahead: 'Ahead of pace',
  over: 'Over',
  idle: 'Idle',
};

async function makeMonitor(): Promise<Monitor> {
  const config = await loadConfig();
  const monitor = new Monitor({ providers: [new ClaudeProvider(), new CodexProvider()], config });
  monitor.router.register(new ConsoleSink());
  return monitor;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function limitLine(a: LimitAssessment, now: number): string {
  const w = a.limit;
  const mark = VERDICT_MARK[a.verdict] ?? '·';
  const rate = a.burn && Math.abs(a.burn.pctPerHour) >= 0.05 ? `  ${a.burn.pctPerHour >= 0 ? '+' : ''}${a.burn.pctPerHour.toFixed(1)} %/h` : '';
  const reset = w.resetsAt !== null ? `  resets in ${fmtDur(w.resetsAt - now)}` : '';
  const stale = now - w.observedAt > 10 * 60_000 ? `  (as of ${fmtTime(w.observedAt)})` : '';
  const binding = a.binding ? '  ← binding' : '';
  const exhaust =
    a.exhaustsAt !== null && w.resetsAt !== null && a.exhaustsAt < w.resetsAt
      ? `  runs out ${fmtWhen(a.exhaustsAt, now)}`
      : '';
  return `  ${mark} ${w.label.padEnd(22)} ${String(Math.round(w.utilization)).padStart(3)}%${rate}${reset}${exhaust}${stale}${binding}`;
}

function render(state: AppState): string {
  const now = state.generatedAt;
  const lines: string[] = [];

  const binding = state.limits.find((a) => a.binding);
  if (binding) {
    const word = VERDICT_WORD[binding.verdict] ?? '';
    lines.push(`${VERDICT_MARK[binding.verdict] ?? ''} ${word} — ${binding.limit.label} at ${Math.round(binding.limit.utilization)}%`);
  }

  lines.push('', 'Quota limits');
  if (state.limits.length === 0) lines.push('  (none reported)');
  for (const a of [...state.limits].sort((x, y) => Number(y.binding) - Number(x.binding))) {
    lines.push(limitLine(a, now));
  }

  lines.push('', 'Backends');
  for (const b of state.backends) {
    const bits = [b.displayName, b.version ?? '', b.plan ? `plan: ${b.plan}` : '', b.health !== 'ok' ? `[${b.health}] ${b.healthDetail ?? ''}` : '']
      .filter(Boolean)
      .join('  ');
    lines.push(`  ${bits}`);
  }

  const live = state.agents.filter((a) => a.state !== 'ended');
  lines.push('', `Agents (${live.length} live/idle)`);
  const burnOf = new Map(state.agentBurns.map((b) => [b.agentId, b.pctPerHour]));
  const sorted = [...live].sort((a, b) => (burnOf.get(b.id) ?? 0) - (burnOf.get(a.id) ?? 0));
  for (const a of sorted.slice(0, 10)) {
    const burn = burnOf.get(a.id);
    const burnStr = burn !== undefined ? `≈${burn.toFixed(1)} %/h` : a.state === 'idle' ? `idle ${fmtDur(now - a.lastActivityAt)}` : '—';
    const model = [a.model ?? '?', a.effort].filter(Boolean).join(' · ');
    const proj = a.projectPath ? a.projectPath.split(/[\\/]/).pop() : a.label;
    const tok = a.totals.input + a.totals.cacheWrite + a.totals.cacheRead + a.totals.output;
    lines.push(
      `  ${(a.state === 'live' ? '●' : '·')} ${String(proj).padEnd(24).slice(0, 24)} ${model.padEnd(22).slice(0, 22)} ${burnStr.padStart(12)}  ${fmtTokens(tok).padStart(8)} tok`,
    );
  }

  if (state.epsilon !== null) {
    lines.push('', `fit confidence: ${state.fitConfidence}  ·  ε ${state.epsilon.toFixed(2)} %/h`);
  }
  return lines.join('\n');
}

function statusline(state: AppState): string {
  const b = state.limits.find((a) => a.binding);
  if (!b) return 'adjent: no quota data';
  const mark = VERDICT_MARK[b.verdict] ?? '';
  const rate = b.burn && Math.abs(b.burn.pctPerHour) >= 0.05 ? ` ${b.burn.pctPerHour >= 0 ? '+' : ''}${b.burn.pctPerHour.toFixed(0)}%/h` : '';
  const reset = b.limit.resetsAt !== null ? ` ↺${fmtDur(b.limit.resetsAt - state.generatedAt)}` : '';
  return `${mark} ${b.limit.label} ${Math.round(b.limit.utilization)}%${rate}${reset}`;
}

/** Wrap prose to a readable width without pulling in a dependency. */
function wrap(text: string, width = 76, indent = '  '): string {
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

function explainCmd(term: string | undefined): void {
  if (!term) {
    console.log('Explains any number Adjent shows. Same words as the panel tooltips.\n');
    console.log('  adjent explain <term>\n');
    console.log('terms: ' + EXPLANATION_KEYS.join(', '));
    return;
  }
  const e = EXPLANATIONS[term];
  if (!e) {
    console.error(`unknown term: ${term}\nterms: ${EXPLANATION_KEYS.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  console.log(`\n  ${e.title}\n`);
  console.log(wrap(e.body));
  if (e.provenance) {
    console.log(`\n  [${e.provenance}] ${PROVENANCE_NOTE[e.provenance]}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'explain') {
    explainCmd(process.argv[3]);
    return;
  }
  const monitor = await makeMonitor();

  switch (cmd) {
    case 'status': {
      // Two quick ticks so burn/dedup state exists; the first primes offsets.
      await monitor.tick();
      const state = await monitor.tick();
      console.log(render(state));
      break;
    }
    case 'statusline': {
      await monitor.tick();
      const state = await monitor.tick();
      console.log(statusline(state));
      break;
    }
    case 'watch': {
      const intervalMs = 30_000;
      // eslint-disable-next-line no-constant-condition
      for (;;) {
        const state = await monitor.tick();
        console.clear();
        console.log(render(state));
        console.log(`\n(watch: refreshing every ${intervalMs / 1000}s — Ctrl-C to stop)`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    default:
      console.error(`unknown command: ${cmd}\nusage: adjent [status|watch|statusline|explain]`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
