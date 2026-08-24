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
/** Local midnight, so "tomorrow" means the next calendar day, not +24h. */
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const calendarDaysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

/**
 * A moment, relative to now. Mirrors core's fmtWhen (packages/core/src/rules/
 * evaluate.ts) — the panel is a plain script with no bundler, so the two are
 * kept in step by hand. A bare clock is only unambiguous inside today: on a
 * 7-day limit "runs out at 05:29" reads as five hours away when it is five
 * days away.
 */
function fmtWhen(t, now) {
  const clock = fmtTime(t);
  const days = calendarDaysBetween(now, t);
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  const d = new Date(t);
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock}`;
}

/** Chart axis: bare clock inside a day-long limit, weekday + clock beyond it. */
const fmtAxis = (t, windowMinutes) =>
  windowMinutes > 1440 ? `${new Date(t).toLocaleDateString(undefined, { weekday: 'short' })} ${fmtTime(t)}` : fmtTime(t);

const fmtTok = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

function esc(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

/**
 * Advance width of the chart's 9px monospace face. An estimate is enough: it
 * only decides whether two labels would touch, and erring slightly wide costs
 * a dropped label rather than an unreadable one.
 */
const AXIS_CH = 5.5;
const axisW = (s) => s.length * AXIS_CH;

/**
 * Lay out baseline labels so they can never overlap.
 *
 * The three axis labels are anchored independently — start at the left edge,
 * reset at the right, "now" wherever the cursor is — so at the ends of a
 * window "now" lands on top of its neighbour. Long labels made this routine:
 * a 7-day limit names its weekday, which more than doubles the width.
 *
 * Lower `priority` wins the space. Anything that would collide is dropped
 * rather than drawn on top, because two strings sharing pixels are less
 * readable than one, and "now" is already marked by the dot on the curve.
 */
function placeLabels(items, gap) {
  const kept = [];
  for (const it of [...items].sort((x, y) => x.priority - y.priority)) {
    const w = axisW(it.text);
    const l = it.anchor === 'end' ? it.x - w : it.anchor === 'middle' ? it.x - w / 2 : it.x;
    const box = { l, r: l + w };
    if (kept.some((k) => box.l < k.r + gap && box.r + gap > k.l)) continue;
    kept.push({ ...it, l: box.l, r: box.r });
  }
  return kept;
}

// --------------------------------------------------------------------------
function renderChart(a, now, history, svg) {
  svg = svg || $('chart');
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
        // Sits right of the cross by default; flips left when that would run
        // off the frame, which a dated label on a multi-day limit always did.
        const exText = `${fmtAxis(a.exhaustsAt, w.windowMinutes)} · ${fmtDur(w.resetsAt - a.exhaustsAt)} early`;
        const exW = axisW(exText);
        let exX = xEx + 8;
        let exAnchor = 'start';
        if (exX + exW > R) {
          exX = xEx - 8;
          exAnchor = 'end';
          if (exX - exW < L) {
            exX = L;
            exAnchor = 'start';
          }
        }
        parts.push(`<text x="${exX.toFixed(1)}" y="${TOP + 2}" text-anchor="${exAnchor}">${exText}</text>`);
      }
    }
  }
  parts.push(`<circle cx="${xNow}" cy="${yNow}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`);
  const axis = [{ text: fmtAxis(start, w.windowMinutes), x: L, anchor: 'start', priority: 0 }];
  if (w.resetsAt !== null) {
    axis.push({ text: `${fmtAxis(w.resetsAt, w.windowMinutes)} · reset`, x: R, anchor: 'end', priority: 1 });
  }
  // Lowest priority: the curve's dot already says where now is.
  axis.push({ text: 'now', x: xNow, anchor: 'middle', priority: 2 });
  for (const lab of placeLabels(axis, 6)) {
    parts.push(`<text x="${lab.x.toFixed(1)}" y="${BASE + 12}" text-anchor="${lab.anchor}">${lab.text}</text>`);
  }
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
  $('heroMeta').setAttribute('data-limit', limitKeyOf(binding.limit));
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
        return `<div class="row" data-tip="${tip}" data-limit="${esc(limitKeyOf(a.limit))}"><span class="dot" style="background:${vv.color}"></span><span class="name">${esc(a.limit.label)}</span><span class="meta"><b>${Math.round(a.limit.utilization)}%</b>${a.limit.severity === 'warning' ? ' ⚠' : ''}${esc(staleW)}</span></div>`;
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
    ['Started', agent.startedAt ? `${fmtWhen(agent.startedAt, now)} · ${fmtDur(now - agent.startedAt)} ago` : null],
    ['Last turn', agent.lastActivityAt ? `${fmtDur(now - agent.lastActivityAt)} ago` : null],
    ['Burn', burn !== undefined ? `<b>≈${burn.toFixed(1)} %/h</b>` : '—'],
    ['Tokens', `${esc(fmtTok(all))} · ${esc(fmtTok(tot.cacheRead))} cached · ${esc(fmtTok(tot.output))} out`],
  ]);
  // Keep the contextual explanation the row used to carry on its own: the
  // facts say what this agent is, the explanation says what the number means.
  const key = burn !== undefined ? 'agentBurn' : agent.state === 'idle' ? 'idle' : 'model';
  const e = EXPL[key];
  if (e) {
    html += `<span class="ctxh">${esc(e.title)}</span>`;
    html += `<span class="expl">${esc(e.body)}</span>`;
    if (e.provenance) {
      html += `<span class="p ${e.provenance}">${esc(e.provenance)}</span>`;
      html += `<span class="pn">${esc(PROV_NOTE[e.provenance] || '')}</span>`;
    }
  }
  return html;
}

/**
 * Who spent one model's share of a limit — the hover behind a "Where it went"
 * row. The breakdown carries agent ids only; labels, directories and branches
 * live on the agent records, so they are resolved here at hover time.
 */
function splitDetailHtml(model) {
  const b = limitDetailData?.breakdown;
  const row = b?.rows?.find((r) => r.model === model);
  if (!row) return '';
  const agents = lastPayload?.state?.agents ?? [];
  const share = b.total > 0 ? (row.total / b.total) * 100 : 0;

  let html = `<span class="t">${esc(row.model)}</span>`;
  html += esc(`${fmtTok(row.total)} tokens · ${share.toFixed(0)}% of this limit · ${row.requests} requests`);
  html += ctxRows([
    ['Input', esc(fmtTok(row.tokens.input))],
    ['Cache write', esc(fmtTok(row.tokens.cacheWrite))],
    ['Cache read', esc(fmtTok(row.tokens.cacheRead))],
    ['Output', esc(fmtTok(row.tokens.output))],
  ]);

  const list = row.agents ?? [];
  if (list.length === 0) {
    html += '<span class="ctxh">No agent attribution</span>';
  } else {
    html += `<span class="ctxh">${list.length === 1 ? 'Agent' : `${list.length} agents`}</span>`;
    for (const g of list) {
      const a = agents.find((x) => x.id === g.agentId);
      // A session can leave the inventory while its spend stays in the ledger:
      // say so rather than rendering a bare uuid as if it were a name.
      const name = a ? (a.projectPath ? a.projectPath.split(/[\\/]/).pop() : a.label) : 'ended session';
      const pct = row.total > 0 ? (g.total / row.total) * 100 : 0;
      html +=
        `<span class="ag"><b>${esc(name)}</b>` +
        (a?.gitBranch ? `<span class="br">${esc(a.gitBranch)}</span>` : '') +
        (a?.projectPath ? `<span class="path">${esc(a.projectPath)}</span>` : '') +
        `<span class="mt">${esc(fmtTok(g.total))} tok · ${pct.toFixed(0)}% · ` +
        `${esc(String(g.requests))} req${a ? '' : ' · not running'}</span></span>`;
    }
  }
  const e = EXPL.tokens;
  if (e) {
    html += `<span class="ctxh">${esc(e.title)}</span><span class="expl">${esc(e.body)}</span>`;
    if (e.provenance) {
      html += `<span class="p ${esc(e.provenance)}">${esc(e.provenance)}</span>`;
      html += `<span class="pn">${esc(PROV_NOTE[e.provenance] || '')}</span>`;
    }
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
    add('Resets', c.resetsAt ? `${fmtWhen(c.resetsAt, a.firedAt)} · in ${fmtDur(c.resetsAt - a.firedAt)}` : null);
    add(
      'Projected out',
      c.exhaustsAt
        ? `${fmtWhen(c.exhaustsAt, a.firedAt)}${c.resetsAt && c.exhaustsAt < c.resetsAt ? ' — before reset' : ''}`
        : null,
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

  // "Where it went" rows resolve to the agents behind that model's spend.
  const splitModel = target.getAttribute('data-split');
  if (splitModel !== null) {
    const html = splitDetailHtml(splitModel);
    if (!html) return;
    tip.innerHTML = html;
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

const TIP_SEL = '[data-tip],[data-alarm],[data-agent],[data-split]';
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
// Tier 3: any limit, on demand (docs/UI.md § Any limit, on demand).
//
// At rest the panel commits to one limit — the binding one — plus three
// collapsed lines. This view reaches *every* limit the vendors report, and for
// the chosen one draws its own curve, its own numbers, and the exact token
// split behind it. It is pulled on open rather than pushed each tick: shipping
// every limit's breakdown every time would be a lot of JSON for something
// usually not on screen.
//
// The token split is `exact` — counted from transcripts. It does not multiply
// out to the utilization percentage and is not meant to: the vendor meters a
// weighted mix, and what relates the two is the fitted exchange rate. This
// answers "where did it go", not "what did it cost".
// --------------------------------------------------------------------------
const limitKeyOf = (l) => `${l.backend}:${l.key}`;

/** Limit key currently open, or null when the view has never been opened. */
let selectedLimit = null;
/** Last resolved detail payload from the main process. */
let limitDetailData = null;
/** Monotonic request id: a slow response must never overwrite a newer one. */
let detailSeq = 0;

const allLimits = () => lastPayload?.state?.limits ?? [];

function defaultLimitKey() {
  const ls = allLimits();
  const pick = ls.find((a) => a.binding) ?? ls[0];
  return pick ? limitKeyOf(pick.limit) : null;
}

function openLimits(key) {
  selectedLimit = key ?? defaultLimitKey();
  showView('limits');
}

/** Every limit, binding first, then fullest — the part that beats the ≤3 cap. */
function renderLimitPicker() {
  const ls = [...allLimits()].sort(
    (a, b) => Number(b.binding) - Number(a.binding) || b.limit.utilization - a.limit.utilization,
  );
  if (ls.length === 0) {
    $('limitPicker').innerHTML = '<div class="empty">No limits reported yet.</div>';
    return;
  }
  $('limitPicker').innerHTML = ls
    .map((a) => {
      const key = limitKeyOf(a.limit);
      const v = VERDICT[a.verdict] || VERDICT.idle;
      const tag = a.binding ? '<span class="tag">binding</span>' : '';
      const on = key === selectedLimit ? ' on' : '';
      return (
        `<div class="limitPick${on}" data-limit="${esc(key)}">` +
        `<span class="dot" style="background:${v.color}"></span>` +
        `<span class="name">${esc(a.limit.label)}</span>${tag}` +
        `<span class="meta"><b>${Math.round(a.limit.utilization)}%</b>` +
        `${a.limit.severity === 'warning' ? ' ⚠' : ''}</span></div>`
      );
    })
    .join('');
}

/** Provenance words come from core's table, so they are never invented here. */
const provTag = (key) => {
  const prov = EXPL[key]?.provenance;
  return prov ? `<span class="prov ${esc(prov)}">${esc(prov)}</span>` : '';
};

async function loadLimitDetail() {
  const key = selectedLimit;
  if (key === null || typeof window.adjent.limitDetail !== 'function') {
    limitDetailData = null;
    renderLimitDetail();
    return;
  }
  const seq = ++detailSeq;
  let d = null;
  try {
    d = await window.adjent.limitDetail(key);
  } catch (err) {
    reportRenderError('limit detail', err);
    return;
  }
  // A newer selection already resolved — drop this one rather than flicker.
  if (seq !== detailSeq || selectedLimit !== key) return;
  limitDetailData = d;
  renderLimitDetail();
}

function renderLimitDetail() {
  const body = $('limitBody');
  const d = limitDetailData;
  if (!d || !d.assessment) {
    body.hidden = true;
    return;
  }
  body.hidden = false;
  const a = d.assessment;
  const w = a.limit;
  const now = d.generatedAt;
  const v = VERDICT[a.verdict] || VERDICT.idle;

  const chip = $('limitVerdict');
  chip.textContent = v.word;
  chip.className = `chip ${v.cls}`;

  $('limitHero').textContent = `${Math.round(w.utilization)}%`;
  $('limitRate').textContent =
    a.burn && Math.abs(a.burn.pctPerHour) >= 0.05
      ? `${a.burn.pctPerHour >= 0 ? '+' : ''}${a.burn.pctPerHour.toFixed(1)} %/h`
      : '';
  $('limitMeta').innerHTML = `${esc(w.label)}<br>${esc(w.scope ? `scoped to ${w.scope}` : w.backend)}`;

  try {
    renderChart(a, now, d.history, $('limitChart'));
  } catch (err) {
    $('limitChart').innerHTML = '';
    reportRenderError('limit chart', err);
  }

  const stale = now - w.observedAt > 10 * 60000;
  const rows = [
    ['Utilization', `<b>${Math.round(w.utilization)}%</b>${provTag('hero')}`],
    [
      'Burn rate',
      a.burn && Math.abs(a.burn.pctPerHour) >= 0.05
        ? `${a.burn.pctPerHour >= 0 ? '+' : ''}${a.burn.pctPerHour.toFixed(1)} %/h${provTag('burnRate')}`
        : '—',
    ],
    ['Pace line', a.paceLinePct !== null && a.paceLinePct !== undefined ? `${Math.round(a.paceLinePct)}%` : null],
    [
      'Resets',
      w.resetsAt !== null ? `${fmtWhen(w.resetsAt, now)} · in ${fmtDur(w.resetsAt - now)}` : 'not reported',
    ],
    [
      'Projected out',
      a.exhaustsAt !== null && a.exhaustsAt !== undefined
        ? `${fmtWhen(a.exhaustsAt, now)}${w.resetsAt !== null && a.exhaustsAt < w.resetsAt ? ' — before reset' : ''}${provTag('exhausts')}`
        : null,
    ],
    ['Scope', w.scope],
    ['Severity', w.severity],
    ['Vendor active', w.vendorActive ? 'yes' : null],
    ['Reading', stale ? `${fmtWhen(w.observedAt, now)} · stale` : fmtWhen(w.observedAt, now)],
  ];
  let html = '<table class="facts">';
  for (const [k, val] of rows) {
    if (val === null || val === undefined || val === '') continue;
    html += `<tr><td>${esc(k)}</td><td>${val}</td></tr>`;
  }
  $('limitFacts').innerHTML = html + '</table>';

  renderLimitSplit(d.breakdown);
}

const KIND_LABEL = { input: 'in', cacheWrite: 'write', cacheRead: 'read', output: 'out' };

/** Token split by model and kind, over exactly the span the curve draws. */
function renderLimitSplit(b) {
  const el = $('limitSplit');
  if (!b) {
    el.innerHTML = '<div class="empty">–</div>';
    return;
  }
  if (b.events === 0) {
    el.innerHTML = `<div class="empty">No usage observed in this window yet${
      b.scope ? ` for ${esc(b.scope)}` : ''
    }.</div>`;
    return;
  }
  const max = b.rows.length > 0 ? b.rows[0].total : 0;
  const rows = b.rows
    .map((r) => {
      const share = b.total > 0 ? (r.total / b.total) * 100 : 0;
      const width = max > 0 ? (r.total / max) * 100 : 0;
      const kinds = Object.keys(KIND_LABEL)
        .filter((k) => r.tokens[k] > 0)
        .map((k) => `${KIND_LABEL[k]} ${fmtTok(r.tokens[k])}`)
        .join(' · ');
      return (
        `<div class="splitRow" data-split="${esc(r.model)}"><div class="splitTop">` +
        `<span class="name">${esc(r.model)}</span>` +
        `<span class="meta"><b>${esc(fmtTok(r.total))}</b> · ${share.toFixed(0)}%</span></div>` +
        `<div class="bar"><i style="width:${width.toFixed(1)}%"></i></div>` +
        `<span class="kinds">${esc(kinds)} · ${esc(String(r.requests))} req</span></div>`
      );
    })
    .join('');
  el.innerHTML =
    rows +
    `<div class="tokline" style="margin-top:8px"><span><b>${esc(fmtTok(b.total))}</b> tokens` +
    `${provTag('tokens')}</span><span>${esc(String(b.requests))} requests</span>` +
    `<span>${esc(fmtWhen(b.from, b.to))} → ${esc(fmtWhen(b.to, b.to))}</span></div>`;
}

// --------------------------------------------------------------------------
// Settings view. Every control writes through to the main process, which
// persists to ~/.adjent/settings.json and applies live.
// --------------------------------------------------------------------------
const OVERLAYS = ['settingsView', 'notificationsView', 'limitView'];
const DATA_SECTIONS = () =>
  [...document.querySelectorAll('main > section')].filter((el) => !OVERLAYS.includes(el.id));
let activeView = null; // null = the dashboard
let current = null;

function showView(view) {
  activeView = view;
  DATA_SECTIONS().forEach((el) => { el.hidden = view !== null; });
  $('settingsView').hidden = view !== 'settings';
  $('notificationsView').hidden = view !== 'notifications';
  $('limitView').hidden = view !== 'limits';
  $('gear').classList.toggle('on', view === 'settings');
  $('bell').classList.toggle('on', view === 'notifications');
  if (view === 'limits') {
    if (selectedLimit === null) selectedLimit = defaultLimitKey();
    renderLimitPicker();
    renderLimitDetail();
    void loadLimitDetail();
  }
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

// Tier-3 entry points, delegated: limit rows and the picker are rebuilt on
// every tick, so per-element handlers would not survive a re-render.
document.addEventListener('click', (ev) => {
  const t = ev.target.closest ? ev.target.closest('[data-limit],[data-limit-all]') : null;
  if (!t) return;
  hideTip();
  if (t.getAttribute('data-limit-all') !== null) {
    openLimits(null);
    return;
  }
  const key = t.getAttribute('data-limit');
  if (activeView === 'limits') {
    // Already inside the view: switch which limit it is showing.
    selectedLimit = key;
    limitDetailData = null;
    renderLimitPicker();
    renderLimitDetail();
    void loadLimitDetail();
  } else {
    openLimits(key);
  }
});
$('limitBack').addEventListener('click', () => showView(null));
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
  } else if (activeView === 'limits') {
    // The detail view is as live as the dashboard: same tick, same numbers.
    try {
      renderLimitPicker();
      void loadLimitDetail();
    } catch (err) {
      reportRenderError('limits', err);
    }
  }
});
window.adjent.onView((view) => showView(view));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (activeView !== null) showView(null);
  else window.adjent.close();
});
