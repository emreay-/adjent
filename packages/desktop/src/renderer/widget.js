/* Pinned widget (docs/UI.md § form factor): verdict, hero, rate, pace bar,
 * plus the top agent row only when one is hot. Two rows otherwise. */
/* global window, document */

const V = {
  'on-pace': { word: 'On pace', cls: 'good', color: 'var(--good)' },
  ahead: { word: 'Ahead', cls: 'warn', color: 'var(--warn)' },
  over: { word: 'Over', cls: 'crit', color: 'var(--crit)' },
  idle: { word: 'Idle', cls: 'idle', color: 'var(--idle)' },
};
const $ = (id) => document.getElementById(id);

function fmtDur(ms) {
  if (ms <= 0) return '0m';
  const min = Math.round(ms / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

let EXPL = {};
const tipFor = (key) => {
  const e = EXPL[key];
  return e ? `${e.title}\n\n${e.body}` : '';
};

window.adjent.onState((payload) => {
  if (payload.explanations) EXPL = payload.explanations;
  const state = payload.state;
  const now = state.generatedAt;
  const b = state.limits.find((w) => w.binding);
  if (!b) return;
  const v = V[b.verdict] || V.idle;

  $('verdict').textContent = v.word;
  $('verdict').className = `chip ${v.cls}`;
  $('hero').textContent = `${Math.round(b.limit.utilization)}%`;
  $('rate').textContent =
    b.burn && Math.abs(b.burn.pctPerHour) >= 0.05
      ? `${b.burn.pctPerHour >= 0 ? '+' : ''}${b.burn.pctPerHour.toFixed(1)} %/h`
      : '';
  const reset = b.limit.resetsAt !== null ? `↺ ${fmtDur(b.limit.resetsAt - now)}` : '';
  $('meta').innerHTML = `${b.limit.label}<br>${reset}`;

  // The strip is too small for a tooltip layer, so use native titles.
  $('hero').title = tipFor('hero');
  $('rate').title = tipFor('burnRate');
  $('verdict').title = tipFor('verdict');
  $('meta').title = tipFor('binding');
  document.querySelector('.bar').title = tipFor('paceLine');

  const fill = $('fill');
  fill.style.width = `${Math.min(100, Math.max(0, b.limit.utilization))}%`;
  fill.style.background = v.color;
  // The pace line as a tick on the bar: the gap to it is the insight.
  $('pace').style.left = b.paceLinePct !== null ? `${Math.min(100, Math.max(0, b.paceLinePct))}%` : '-10px';

  // Third row only when an agent is actually hot (docs/UI.md).
  const top = state.agentBurns[0];
  const hot = top && top.pctPerHour > 4;
  $('hot').hidden = !hot;
  if (hot) {
    const agent = state.agents.find((a) => a.id === top.agentId);
    const proj = agent?.projectPath ? agent.projectPath.split(/[\\/]/).pop() : (agent?.label ?? top.agentId);
    $('hot').querySelector('.dot').style.background = top.pctPerHour > 8 ? 'var(--crit)' : 'var(--warn)';
    $('hot').querySelector('.n').textContent = proj;
    $('hot').querySelector('.v').textContent = `≈${top.pctPerHour.toFixed(1)} %/h`;
    $('hot').title = tipFor('agentBurn');
  }
});

document.getElementById('open').addEventListener('click', () => window.adjent.openPanel());
