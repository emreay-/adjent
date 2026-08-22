/* Panel renderer. Component budget per docs/UI.md: one verdict, one hero,
 * one chart, one token line, ≤3 collapsed windows, ≤4 agent rows.
 * Measured values plain; derived values carry ≈. */
/* global window, document */

const VERDICT = {
  'on-pace': { word: 'On pace', cls: 'good', color: 'var(--good)' },
  ahead: { word: 'Ahead of pace', cls: 'warn', color: 'var(--warn)' },
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
const fmtTime = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtTok = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

function esc(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

// --------------------------------------------------------------------------
function renderChart(a, now) {
  const svg = $('chart');
  const W = 352, H = 120, L = 6, R = 346, TOP = 12, BASE = 104;
  const w = a.window;
  const color = (VERDICT[a.verdict] || VERDICT.idle).color;
  const parts = [];

  const windowMs = w.windowMinutes * 60000;
  const start = w.resetsAt !== null ? w.resetsAt - windowMs : now - windowMs;
  const xOf = (t) => L + ((t - start) / windowMs) * (R - L);
  const yOf = (u) => BASE - (u / 100) * (BASE - TOP);

  parts.push(`<line x1="${L}" y1="${TOP}" x2="${R}" y2="${TOP}" stroke="var(--line)" stroke-dasharray="2 4"/>`);
  parts.push(`<line x1="${L}" y1="${BASE}" x2="${R}" y2="${BASE}" stroke="var(--line)"/>`);
  // pace line
  parts.push(`<line x1="${L}" y1="${BASE}" x2="${R}" y2="${TOP}" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="4 4" opacity=".5"/>`);

  // measured curve: linear 0 → current (history buffer lives main-side later)
  const xNow = Math.min(R, Math.max(L, xOf(now)));
  const yNow = yOf(w.utilization);
  parts.push(`<path d="M${L},${BASE} L${xNow},${yNow} L${xNow},${BASE} Z" fill="${color}" opacity=".10"/>`);
  parts.push(`<path d="M${L},${BASE} L${xNow},${yNow}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`);

  // projection to exhaustion or reset edge
  if (a.exhaustsAt !== null && a.burn && a.burn.pctPerHour > 0) {
    const xEx = Math.min(R + 2, xOf(a.exhaustsAt));
    if (xEx > xNow) {
      parts.push(`<path d="M${xNow},${yNow} L${xEx},${yOf(100)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3 3" opacity=".7"/>`);
      if (w.resetsAt !== null && a.exhaustsAt < w.resetsAt) {
        parts.push(`<line x1="${xEx - 4}" y1="${TOP - 4}" x2="${xEx + 4}" y2="${TOP + 4}" stroke="${color}" stroke-width="2"/>`);
        parts.push(`<line x1="${xEx + 4}" y1="${TOP - 4}" x2="${xEx - 4}" y2="${TOP + 4}" stroke="${color}" stroke-width="2"/>`);
        parts.push(`<text x="${Math.min(xEx + 8, 260)}" y="${TOP + 2}">${fmtTime(a.exhaustsAt)} · ${fmtDur(w.resetsAt - a.exhaustsAt)} early</text>`);
      }
    }
  }
  parts.push(`<circle cx="${xNow}" cy="${yNow}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`);
  parts.push(`<text x="${L}" y="${BASE + 12}">${fmtTime(start)}</text>`);
  parts.push(`<text x="${xNow}" y="${BASE + 12}" text-anchor="middle">now</text>`);
  if (w.resetsAt !== null) parts.push(`<text x="${R}" y="${BASE + 12}" text-anchor="end">${fmtTime(w.resetsAt)} · reset</text>`);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
}

// --------------------------------------------------------------------------
function render(payload) {
  const state = payload.state;
  const now = state.generatedAt;
  const live = state.agents.filter((x) => x.state !== 'ended');
  $('liveCount').textContent = `${live.filter((x) => x.state === 'live').length} live`;

  const binding = state.windows.find((w) => w.binding);
  if (!binding) return;
  const v = VERDICT[binding.verdict] || VERDICT.idle;
  const chip = $('verdict');
  chip.textContent = v.word;
  chip.className = `chip ${v.cls}`;

  $('hero').textContent = `${Math.round(binding.window.utilization)}%`;
  $('heroRate').textContent =
    binding.burn && Math.abs(binding.burn.pctPerHour) >= 0.05
      ? `${binding.burn.pctPerHour >= 0 ? '+' : ''}${binding.burn.pctPerHour.toFixed(1)} %/h`
      : '';
  const resetIn = binding.window.resetsAt !== null ? `resets in ${fmtDur(binding.window.resetsAt - now)}` : '';
  const stale = now - binding.window.observedAt > 10 * 60000 ? `as of ${fmtTime(binding.window.observedAt)}` : '';
  $('heroMeta').innerHTML = `${esc(binding.window.label)}<br>${esc(stale || resetIn)}`;
  renderChart(binding, now);

  // token line: exact totals across live agents (this window's exact split comes with history)
  const tot = live.reduce(
    (s, a) => {
      s.all += a.totals.input + a.totals.cacheWrite + a.totals.cacheRead + a.totals.output;
      s.cached += a.totals.cacheRead;
      s.out += a.totals.output;
      return s;
    },
    { all: 0, cached: 0, out: 0 },
  );
  $('tokline').innerHTML =
    tot.all > 0
      ? `<span><b>${fmtTok(tot.all)}</b> tokens tracked</span><span><b>${fmtTok(tot.cached)}</b> cached</span><span><b>${fmtTok(tot.out)}</b> out</span>`
      : '';

  // other windows (≤3), binding first excluded
  const others = state.windows.filter((w) => !w.binding).slice(0, 3);
  $('windows').innerHTML =
    others
      .map((a) => {
        const vv = VERDICT[a.verdict] || VERDICT.idle;
        const staleW = now - a.window.observedAt > 10 * 60000 ? ` · as of ${fmtTime(a.window.observedAt)}` : '';
        return `<div class="row"><span class="dot" style="background:${vv.color}"></span><span class="name">${esc(a.window.label)}</span><span class="meta"><b>${Math.round(a.window.utilization)}%</b>${a.window.severity === 'warning' ? ' ⚠' : ''}${esc(staleW)}</span></div>`;
      })
      .join('') || '<div class="empty">None</div>';

  // agent rows (≤4), sorted by burn — derived rates carry ≈
  const burnOf = new Map(state.agentBurns.map((b) => [b.agentId, b.pctPerHour]));
  const rows = [...live]
    .sort((a, b) => (burnOf.get(b.id) ?? 0) - (burnOf.get(a.id) ?? 0))
    .slice(0, 4)
    .map((a) => {
      const burn = burnOf.get(a.id);
      const proj = a.projectPath ? a.projectPath.split(/[\\/]/).pop() : a.label;
      const model = [a.model || '?', a.effort].filter(Boolean).join(' · ');
      const metaStr =
        burn !== undefined
          ? `${esc(model)} · <b>≈${burn.toFixed(1)} %/h</b>`
          : a.state === 'idle'
            ? `${esc(model)} · idle ${fmtDur(now - a.lastActivityAt)}`
            : `${esc(model)} · —`;
      const dotColor = burn !== undefined && burn > 8 ? 'var(--crit)' : a.state === 'live' ? 'var(--good)' : 'var(--idle)';
      return `<div class="row"><span class="dot" style="background:${dotColor}"></span><span class="name">${esc(proj)}</span><span class="meta">${metaStr}</span></div>`;
    });
  $('agents').innerHTML = rows.join('') || '<div class="empty">None</div>';

  const alarms = (payload.alarms || []).slice(-4).reverse();
  $('alarms').innerHTML =
    alarms.map((a) => `<div class="alarm"><b>${esc(a.title)}</b> — ${esc(a.body)}</div>`).join('') ||
    '<div class="empty">None</div>';
}

window.adjent.onState(render);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.adjent.close();
});
