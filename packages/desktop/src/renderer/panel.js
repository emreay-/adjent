/* Panel renderer. Component budget per docs/UI.md: one verdict, one hero,
 * one chart, one token line, ≤3 collapsed limits, ≤4 agent rows.
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
function renderChart(a, now, history) {
  const svg = $('chart');
  const W = 352, H = 120, L = 6, R = 346, TOP = 12, BASE = 104;
  const w = a.limit;
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

  // Measured curve from persisted samples. With no history yet (first run) this
  // degrades to a single segment rather than inventing a shape.
  const xNow = Math.min(R, Math.max(L, xOf(now)));
  const yNow = yOf(w.utilization);
  const pts = (history || [])
    .filter((h) => h.t >= start && h.t <= now)
    .map((h) => [Math.min(R, Math.max(L, xOf(h.t))), yOf(h.u)]);
  pts.push([xNow, yNow]);
  // Anchor at the window start only when the earliest sample is close to it;
  // otherwise begin at the first thing we actually observed.
  const first = pts[0];
  const anchored = first[0] - L < 12 ? [[L, BASE]] : [];
  const all = anchored.concat(pts);
  const line = all.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  parts.push(`<path d="${line} L${xNow},${BASE} L${all[0][0].toFixed(1)},${BASE} Z" fill="${color}" opacity=".10"/>`);
  parts.push(`<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

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

  const binding = state.limits.find((w) => w.binding);
  if (!binding) return;
  const v = VERDICT[binding.verdict] || VERDICT.idle;
  const chip = $('verdict');
  chip.textContent = v.word;
  chip.className = `chip ${v.cls}`;

  $('hero').textContent = `${Math.round(binding.limit.utilization)}%`;
  $('heroRate').textContent =
    binding.burn && Math.abs(binding.burn.pctPerHour) >= 0.05
      ? `${binding.burn.pctPerHour >= 0 ? '+' : ''}${binding.burn.pctPerHour.toFixed(1)} %/h`
      : '';
  const resetIn = binding.limit.resetsAt !== null ? `resets in ${fmtDur(binding.limit.resetsAt - now)}` : '';
  const stale = now - binding.limit.observedAt > 10 * 60000 ? `as of ${fmtTime(binding.limit.observedAt)}` : '';
  $('heroMeta').setAttribute('data-tip', stale ? 'stale' : 'binding');
  $('heroMeta').innerHTML = `${esc(binding.limit.label)}<br>${esc(stale || resetIn)}`;
  try {
    renderChart(binding, now, payload.history);
  } catch (err) {
    // A chart that cannot draw must not blank the numbers around it.
    $('chart').innerHTML = '';
    reportRenderError('chart', err);
  }

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

  // other limits (≤3), binding first excluded
  const others = state.limits.filter((w) => !w.binding).slice(0, 3);
  $('limits').innerHTML =
    others
      .map((a) => {
        const vv = VERDICT[a.verdict] || VERDICT.idle;
        const staleW = now - a.limit.observedAt > 10 * 60000 ? ` · as of ${fmtTime(a.limit.observedAt)}` : '';
        const tip = staleW ? 'stale' : a.limit.scope ? 'scoped' : 'otherLimits';
        return `<div class="row" data-tip="${tip}"><span class="dot" style="background:${vv.color}"></span><span class="name">${esc(a.limit.label)}</span><span class="meta"><b>${Math.round(a.limit.utilization)}%</b>${a.limit.severity === 'warning' ? ' ⚠' : ''}${esc(staleW)}</span></div>`;
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
      return `<div class="row" data-agent="${esc(a.id)}"><span class="dot" style="background:${dotColor}"></span><span class="name">${esc(proj)}</span><span class="meta">${metaStr}</span></div>`;
    });
  $('agents').innerHTML = rows.join('') || '<div class="empty">None</div>';

  const conf = $('conf');
  if (conf) {
    conf.innerHTML =
      state.epsilon !== null
        ? `fit confidence <b>${esc(state.fitConfidence)}</b> · ε ${state.epsilon.toFixed(2)} %/h`
        : `fit confidence <b>${esc(state.fitConfidence)}</b> · learning`;
  }

  const alarms = (payload.alarms || []).slice(-4).reverse();
  $('alarms').innerHTML =
    alarms.map((a) => `<div class="alarm"><b>${esc(a.title)}</b> — ${esc(a.body)}</div>`).join('') ||
    '<div class="empty">None</div>';
}


// --------------------------------------------------------------------------
// Hover explanations. Copy comes from core (one source of truth, shared with
// the CLI's `adjent explain`). Delegated listeners so rows re-rendered every
// tick keep working without rebinding.
// --------------------------------------------------------------------------
let EXPL = {};
let PROV_NOTE = {};
let tipTimer = null;
/** Last payload, so per-agent tooltips can resolve an id at hover time. */
let lastPayload = null;

function hideTip() {
  clearTimeout(tipTimer);
  $('tip').classList.remove('on');
}

/** A row of the little key/value table used by both detail cards. */
function ctxRows(rows) {
  let html = '<table class="ctx">';
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '') continue;
    html += `<tr><td>${esc(k)}</td><td>${v}</td></tr>`;
  }
  return html + '</table>';
}

/** A directory is long and matters in full — give it its own wrapping line. */
const pathCell = (p) => `<span class="path">${esc(p)}</span>`;

/** Everything known about one running agent. */
function agentDetailHtml(agent, burn) {
  const now = lastPayload?.state?.generatedAt ?? Date.now();
  const tot = agent.totals;
  const all = tot.input + tot.cacheWrite + tot.cacheRead + tot.output;
  const state =
    agent.state === 'live' ? 'Live' : agent.state === 'idle' ? `Idle ${fmtDur(now - agent.lastActivityAt)}` : 'Ended';

  let html = `<span class="t">${esc(agent.projectPath ? agent.projectPath.split(/[\\/]/).pop() : agent.label)}</span>`;
  html += esc([state, agent.model, agent.effort].filter(Boolean).join(' · '));
  html += ctxRows([
    ['Directory', agent.projectPath ? pathCell(agent.projectPath) : null],
    ['Branch', agent.gitBranch ? esc(agent.gitBranch) : null],
    ['Session', esc(agent.label)],
    ['Backend', esc(agent.backend) + (agent.entrypoint ? ` · ${esc(agent.entrypoint)}` : '')],
    ['Started', agent.startedAt ? `${clockOf(agent.startedAt)} · ${fmtDur(now - agent.startedAt)} ago` : null],
    ['Last turn', agent.lastActivityAt ? `${fmtDur(now - agent.lastActivityAt)} ago` : null],
    ['Burn', burn !== undefined ? `<b>≈${burn.toFixed(1)} %/h</b>` : '—'],
    ['Tokens', `${esc(fmtTok(all))} · ${esc(fmtTok(tot.cacheRead))} cached · ${esc(fmtTok(tot.output))} out`],
  ]);
  if (burn !== undefined) {
    html += `<span class="pn">${esc(PROV_NOTE.derived || '')}</span>`;
  }
  return html;
}

/** Full state at the moment an alarm fired — the "what was I doing?" answer. */
function alarmDetailHtml(a) {
  const c = a.context;
  const when = new Date(a.firedAt);
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push([k, v]); };

  add('Fired', when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  if (c) {
    add('Window', c.limitLabel);
    add('Utilization', c.utilization !== null ? `${c.utilization.toFixed(0)}%` : null);
    add(
      'Burn rate',
      c.burnPctPerHour !== null && c.burnPctPerHour !== undefined
        ? `${c.burnPctPerHour >= 0 ? '+' : ''}${c.burnPctPerHour.toFixed(1)} %/h`
        : null,
    );
    add('Pace line', c.paceLinePct !== null && c.paceLinePct !== undefined ? `${c.paceLinePct.toFixed(0)}%` : null);
    add('Resets', c.resetsAt ? `${clockOf(c.resetsAt)} · in ${fmtDur(c.resetsAt - a.firedAt)}` : null);
    add(
      'Projected out',
      c.exhaustsAt ? `${clockOf(c.exhaustsAt)}${c.resetsAt && c.exhaustsAt < c.resetsAt ? ' — before reset' : ''}` : null,
    );
    add('Plan', c.plan);
  }

  let html = `<span class="t">${esc(a.title)}</span>${esc(a.body)}`;
  html += '<table class="ctx">';
  for (const [k, v] of rows) html += `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
  html += '</table>';

  const agents = c?.agents ?? [];
  if (agents.length > 0) {
    html += `<span class="ctxh">${agents.length === 1 ? 'Agent' : 'Running then'}</span>`;
    for (const g of agents) {
      const bits = [g.model, g.effort].filter(Boolean).join(' · ');
      const rate = g.pctPerHour !== null && g.pctPerHour !== undefined ? `≈${g.pctPerHour.toFixed(1)} %/h` : '—';
      html +=
        `<span class="ag"><b>${esc(g.project || g.label)}</b>` +
        (g.branch ? `<span class="br">${esc(g.branch)}</span>` : '') +
        // The directory is the point: two checkouts of one repo look identical
        // by name, and a notification read later has to say which one.
        (g.projectPath ? `<span class="path">${esc(g.projectPath)}</span>` : '') +
        `<span class="mt">${esc(bits)} · ${esc(rate)} · ${esc(fmtTok(g.tokens))} tok</span></span>`;
    }
  } else if (c) {
    html += '<span class="ctxh">No agents were running</span>';
  }
  if (c?.fitConfidence) {
    html += `<span class="pn">Derived values from a fit with ${esc(c.fitConfidence)} confidence.</span>`;
  }
  return html;
}

function showTip(target) {
  const tip = $('tip');

  // Agent rows resolve to the live agent rather than a dictionary key.
  const agentId = target.getAttribute('data-agent');
  if (agentId !== null) {
    const agent = lastPayload?.state?.agents.find((a) => a.id === agentId);
    if (!agent) return;
    const burn = lastPayload.state.agentBurns.find((b) => b.agentId === agentId)?.pctPerHour;
    tip.innerHTML = agentDetailHtml(agent, burn);
    positionTip(target, tip);
    return;
  }

  // Notification rows carry their own record rather than a dictionary key.
  const alarmIdx = target.getAttribute('data-alarm');
  if (alarmIdx !== null) {
    const a = alarmHistory[Number(alarmIdx)];
    if (!a) return;
    tip.innerHTML = alarmDetailHtml(a);
    positionTip(target, tip);
    return;
  }

  const key = target.getAttribute('data-tip');
  const e = EXPL[key];
  if (!e) return;
  const prov = e.provenance
    ? `<span class="p ${e.provenance}">${e.provenance}</span><span class="pn">${esc(PROV_NOTE[e.provenance] || '')}</span>`
    : '';
  tip.innerHTML = `<span class="t">${esc(e.title)}</span>${esc(e.body)}${prov}`;

  positionTip(target, tip);
}

/** Above when there is room, else below; always clamped inside the panel. */
function positionTip(target, tip) {
  tip.classList.add('on');
  const r = target.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let top = r.top - tr.height - 8;
  if (top < 6) top = Math.min(r.bottom + 8, window.innerHeight - tr.height - 6);
  if (top < 6) top = 6;
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

const TIP_SEL = '[data-tip],[data-alarm],[data-agent]';
document.addEventListener('mouseover', (ev) => {
  const t = ev.target.closest ? ev.target.closest(TIP_SEL) : null;
  if (!t) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(t), 320);
});
document.addEventListener('mouseout', (ev) => {
  const t = ev.target.closest ? ev.target.closest(TIP_SEL) : null;
  if (t) hideTip();
});
document.addEventListener('scroll', hideTip, true);


// --------------------------------------------------------------------------
// Notifications view. Toasts vanish; this is the durable log, read from
// ~/.adjent/alarms.jsonl via the main process.
// --------------------------------------------------------------------------
const SEV = { info: 'var(--idle)', warn: 'var(--warn)', critical: 'var(--crit)' };
let alarmHistory = [];
let lastSeenAlarmAt = Number(localStorage.getItem('adjent.lastSeenAlarm') || 0);

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function clockOf(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderNotifications() {
  const list = $('notifList');
  if (alarmHistory.length === 0) {
    list.innerHTML = '<div class="empty">No notifications yet.</div>';
    return;
  }
  const out = [];
  let day = null;
  for (const a of alarmHistory) {
    const d = dayLabel(a.firedAt);
    if (d !== day) {
      out.push(`<div class="daySep">${esc(d)}</div>`);
      day = d;
    }
    const i = alarmHistory.indexOf(a);
    const more = a.context ? '<span class="more">details on hover</span>' : '';
    out.push(
      `<div class="notif" data-alarm="${i}">` +
        `<span class="sev" style="background:${SEV[a.severity] || SEV.info}"></span>` +
        `<span class="body"><span class="t">${esc(a.title)}</span>` +
        `<span class="b">${esc(a.body)}</span>` +
        `<span class="when">${esc(clockOf(a.firedAt))} · ${esc(a.severity)}${more}</span></span>` +
      `</div>`,
    );
  }
  list.innerHTML = out.join('');
}

function updateBellDot() {
  const newest = alarmHistory[0]?.firedAt ?? 0;
  $('bellDot').classList.toggle('on', newest > lastSeenAlarmAt);
}

// --------------------------------------------------------------------------
// Settings view. Every control writes through to the main process, which
// persists to ~/.adjent/settings.json and applies live.
// --------------------------------------------------------------------------
const OVERLAYS = ['settingsView', 'notificationsView'];
const DATA_SECTIONS = () =>
  [...document.querySelectorAll('main > section')].filter((el) => !OVERLAYS.includes(el.id));
let activeView = null; // null = the dashboard
let current = null;

function showView(view) {
  activeView = view;
  DATA_SECTIONS().forEach((el) => { el.hidden = view !== null; });
  $('settingsView').hidden = view !== 'settings';
  $('notificationsView').hidden = view !== 'notifications';
  $('gear').classList.toggle('on', view === 'settings');
  $('bell').classList.toggle('on', view === 'notifications');
  if (view === 'notifications') {
    lastSeenAlarmAt = Date.now();
    localStorage.setItem('adjent.lastSeenAlarm', String(lastSeenAlarmAt));
    renderNotifications();
    updateBellDot();
  }
}
const showSettings = (on) => showView(on ? 'settings' : null);

function syncSettingsUI(s) {
  if (!s) return;
  $('scaleVal').textContent = `${Math.round(s.uiScale * 100)}%`;
  $('tickVal').textContent = `${s.tickIntervalSec}s`;
  $('thick').value = String(s.trayThickness);
  $('widgetOn').checked = !!s.widgetEnabled;
  $('widgetTask').checked = !!s.widgetTaskbarButton;
  $('pauseAlarms').checked = !!s.alarmsPaused;
  for (const b of document.querySelectorAll('#trayStyle button')) {
    b.classList.toggle('on', b.dataset.style === s.trayStyle);
  }
  for (const b of document.querySelectorAll('#theme button')) {
    b.classList.toggle('on', b.dataset.theme === (s.theme || 'system'));
  }
}

const set = (patch) => window.adjent.setSettings(patch);

$('gear').addEventListener('click', () => showView(activeView === 'settings' ? null : 'settings'));
$('bell').addEventListener('click', () => showView(activeView === 'notifications' ? null : 'notifications'));
$('clearAlarms').addEventListener('click', () => window.adjent.clearAlarms());
document.querySelectorAll('[data-scale]').forEach((b) =>
  b.addEventListener('click', () => {
    const step = b.dataset.scale === '+' ? 0.1 : -0.1;
    const next = Math.min(2, Math.max(0.8, Math.round(((current?.uiScale ?? 1) + step) * 10) / 10));
    set({ uiScale: next });
  }),
);
document.querySelectorAll('[data-tick]').forEach((b) =>
  b.addEventListener('click', () => {
    const cur = current?.tickIntervalSec ?? 30;
    const steps = [10, 15, 30, 60, 120, 300];
    const i = steps.indexOf(cur);
    const base = i === -1 ? 2 : i;
    const next = steps[Math.min(steps.length - 1, Math.max(0, base + (b.dataset.tick === '+' ? 1 : -1)))];
    set({ tickIntervalSec: next });
  }),
);
document.querySelectorAll('#trayStyle button').forEach((b) =>
  b.addEventListener('click', () => set({ trayStyle: b.dataset.style })),
);
document.querySelectorAll('#theme button').forEach((b) =>
  b.addEventListener('click', () => set({ theme: b.dataset.theme })),
);
$('thick').addEventListener('input', (e) => set({ trayThickness: Number(e.target.value) }));
$('widgetOn').addEventListener('change', (e) => set({ widgetEnabled: e.target.checked }));
$('widgetTask').addEventListener('change', (e) => set({ widgetTaskbarButton: e.target.checked }));
$('pauseAlarms').addEventListener('change', (e) => set({ alarmsPaused: e.target.checked }));
$('openTaskbarSettings').addEventListener('click', () => window.adjent.openTaskbarSettings());

/**
 * Renderer failures used to be invisible: the panel simply stopped updating
 * partway down and looked like "no data". Show them instead.
 */
function reportRenderError(where, err) {
  const msg = err && err.message ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[adjent] render failed in ${where}:`, err);
  const bar = $('renderError');
  if (bar) {
    bar.textContent = `Display error in ${where}: ${msg}`;
    bar.hidden = false;
  }
}

window.adjent.onState((payload) => {
  lastPayload = payload;
  if (payload.explanations) EXPL = payload.explanations;
  if (payload.provenanceNote) PROV_NOTE = payload.provenanceNote;
  current = payload.settings || current;
  syncSettingsUI(current);
  if (payload.alarmHistory) {
    alarmHistory = payload.alarmHistory;
    updateBellDot();
    if (activeView === 'notifications') renderNotifications();
  }
  if (activeView === null) {
    try {
      $('renderError').hidden = true;
      render(payload);
    } catch (err) {
      reportRenderError('panel', err);
    }
  }
});
window.adjent.onView((view) => showView(view));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (activeView !== null) showView(null);
  else window.adjent.close();
});
