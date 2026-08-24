/**
 * Renderer smoke tests.
 *
 * The renderer is plain JS with no typechecker, so a field rename in core can
 * break it silently — which is exactly what happened when
 * `LimitAssessment.window` became `.limit` and `const w = a.window;` survived
 * in renderChart: the panel drew the hero and then stopped, with no error.
 *
 * These tests execute the real panel.js against a minimal DOM shim and a
 * realistic AppState, and assert that every section actually rendered. No
 * jsdom: the shim is ~60 lines and keeps the desktop package dependency-free.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_JS = path.join(HERE, '..', 'src', 'renderer', 'panel.js');
const PANEL_HTML = path.join(HERE, '..', 'src', 'renderer', 'panel.html');

// --------------------------------------------------------------------- shim
class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = {
    _s: new Set<string>(),
    add: (c: string) => this.classList._s.add(c),
    remove: (c: string) => this.classList._s.delete(c),
    toggle: (c: string, on?: boolean) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    contains: (c: string) => this.classList._s.has(c),
  };
  hidden = false;
  innerHTML = '';
  title = '';

  // The renderer's esc() helper does `div.textContent = x; return div.innerHTML`,
  // so the shim has to mirror the browser's escaping for that to work.
  #text = '';
  get textContent(): string {
    return this.#text;
  }
  set textContent(v: string) {
    this.#text = String(v);
    this.innerHTML = String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  value = '';
  checked = false;
  dataset: Record<string, string> = {};
  constructor(public id = '') {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  handlers: Record<string, ((ev: unknown) => void)[]> = {};
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  getBoundingClientRect() {
    return { top: 10, bottom: 30, left: 10, right: 100, width: 90, height: 20 };
  }
  querySelector() {
    return new El();
  }
  querySelectorAll() {
    return [] as El[];
  }
  closest(sel: string) {
    // Enough for these tests: an element matches when it carries one of the
    // attributes named in the selector list.
    for (const part of sel.split(',')) {
      const m = /\[([a-z-]+)\]/.exec(part.trim());
      if (m && this.attrs[m[1]!] !== undefined) return this;
    }
    return null;
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
  indexOf() {
    return 0;
  }
}

interface Harness {
  els: Map<string, El>;
  onState: (payload: unknown) => void;
  errors: unknown[];
  hover: (el: El) => string;
  /** Dispatch a delegated click, as the real panel does for limit rows. */
  click: (el: El) => void;
  /** Let the tier-3 detail promise settle. */
  flush: () => Promise<void>;
  /** Script what the main process answers `limit:detail` with. */
  setDetail: (fn: (key: string) => unknown) => void;
  /** Fire an element's own listener, as a real click on it would. */
  fire: (id: string, type?: string, ev?: unknown) => void;
}

/** Load panel.js with a fake document/window and return a handle to drive it. */
function loadPanel(): Harness {
  const els = new Map<string, El>();
  // Seed every id the panel touches, taken from the real HTML so the test
  // fails if markup and script drift apart.
  const html = readFileSync(PANEL_HTML, 'utf-8');
  for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) els.set(m[1]!, new El(m[1]!));

  const errors: unknown[] = [];
  let onState: (p: unknown) => void = () => {};

  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  let detailFor: (key: string) => unknown = () => null;
  const documentShim = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: () => new El(),
    querySelectorAll: () => [] as El[],
    querySelector: () => new El(),
    addEventListener: (t: string, cb: (ev: unknown) => void) => {
      (listeners[t] ??= []).push(cb);
    },
  };
  const windowShim = {
    innerWidth: 380,
    innerHeight: 560,
    localStorage: { getItem: () => null, setItem: () => {} },
    adjent: {
      onState: (cb: (p: unknown) => void) => {
        onState = cb;
      },
      onView: () => {},
      close: () => {},
      refresh: () => {},
      setSettings: () => {},
      openPanel: () => {},
      openTaskbarSettings: () => {},
      clearAlarms: () => {},
      limitDetail: (key: string) => Promise.resolve(detailFor(key)),
    },
  };

  const src = readFileSync(PANEL_JS, 'utf-8');
  const consoleShim = { error: (...a: unknown[]) => errors.push(a), log: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('window', 'document', 'console', 'localStorage', 'setTimeout', 'clearTimeout', src);
  fn(
    windowShim,
    documentShim,
    consoleShim,
    windowShim.localStorage,
    (cb: () => void) => {
      cb();
      return 0;
    },
    () => {},
  );
  // setTimeout runs inline in the shim, so a mouseover resolves the tooltip
  // synchronously and the test can read it straight back.
  const hover = (el: El): string => {
    for (const cb of listeners['mouseover'] ?? []) cb({ target: el });
    return els.get('tip')!.innerHTML;
  };
  const click = (el: El): void => {
    for (const cb of listeners['click'] ?? []) cb({ target: el });
  };
  // The detail path is one await deep; a few microtask turns cover it.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const setDetail = (fn: (key: string) => unknown): void => {
    detailFor = fn;
  };
  const fire = (id: string, type = 'click', ev: unknown = {}): void => {
    const el = els.get(id);
    if (!el) throw new Error(`no element #${id}`);
    for (const cb of el.handlers[type] ?? []) cb(ev);
  };
  return { els, onState, errors, hover, click, flush, setDetail, fire };
}

// -------------------------------------------------------------------- state
const T0 = 1_700_000_000_000;
const H = 3600_000;

function payload(overrides: Record<string, unknown> = {}) {
  const limit = {
    backend: 'claude',
    key: '5h',
    label: 'Claude · 5h',
    windowMinutes: 300,
    utilization: 32,
    resetsAt: T0 + 3 * H,
    severity: null,
    vendorActive: false,
    scope: null,
    source: 'reported',
    observedAt: T0,
  };
  const other = { ...limit, key: '7d', label: 'Claude · 7d', windowMinutes: 10_080, utilization: 3 };
  const mk = (l: typeof limit, binding: boolean) => ({
    limit: l,
    burn: { pctPerHour: 8.1, updatedAt: T0 },
    verdict: 'on-pace',
    paceLinePct: 40,
    exhaustsAt: T0 + 8 * H,
    binding,
  });
  return {
    state: {
      generatedAt: T0,
      backends: [{ id: 'claude', displayName: 'Claude Code', version: null, plan: 'demo', rateLimitTier: null, health: 'ok', healthDetail: null }],
      agents: [
        {
          id: 'claude:a1', backend: 'claude', label: 'demo', projectPath: '/w/demo', gitBranch: 'main',
          model: 'model-x', effort: 'high', entrypoint: 'cli', parentId: null, pid: 1, state: 'live',
          startedAt: T0, lastActivityAt: T0,
          totals: { input: 10, cacheWrite: 20, cacheRead: 30, output: 40, thinking: 5 },
        },
      ],
      limits: [mk(limit, true), mk(other, false)],
      agentBurns: [{ agentId: 'claude:a1', pctPerHour: 4.2, confidence: 'high' }],
      epsilon: 0.5,
      fitConfidence: 'high',
    },
    alarms: [],
    alarmHistory: [],
    history: [
      { t: T0 - 2 * H, w: 'claude:5h', u: 10 },
      { t: T0 - H, w: 'claude:5h', u: 22 },
    ],
    settings: { uiScale: 1, theme: 'system', trayStyle: 'ring', trayThickness: 0.34, widgetEnabled: false, widgetTaskbarButton: true, widgetPosition: null, tickIntervalSec: 30, alarmsPaused: false },
    explanations: {
      hero: { title: 'H', body: 'b'.repeat(50) },
      agentBurn: { title: 'What this agent is costing you', body: 'Share of the limit per hour.', provenance: 'derived' },
      idle: { title: 'Idle agent', body: 'Open but not producing turns.' },
      model: { title: 'Model', body: 'The model used on the most recent turn.' },
    },
    provenanceNote: { measured: 'm', exact: 'e', derived: 'd' },
    ...overrides,
  };
}

// -------------------------------------------------------------------- tests
describe('panel renderer', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('renders every section from a realistic AppState', () => {
    h.onState(payload());

    expect(h.errors, 'renderer logged an error').toHaveLength(0);
    expect(h.els.get('renderError')!.hidden).toBe(true);

    // The regression: hero rendered but everything below it silently did not.
    expect(h.els.get('hero')!.textContent).toBe('32%');
    expect(h.els.get('heroRate')!.textContent).toContain('8.1');
    expect(h.els.get('chart')!.innerHTML, 'chart did not draw').not.toBe('');
    expect(h.els.get('tokline')!.innerHTML, 'token line did not draw').not.toBe('');
    expect(h.els.get('limits')!.innerHTML, 'other limits did not draw').not.toContain('None');
    expect(h.els.get('agents')!.innerHTML, 'agents did not draw').toContain('demo');
    expect(h.els.get('conf')!.innerHTML).toContain('high');
  });

  it('prices the agent row in %/h with the derived marker', () => {
    h.onState(payload());
    expect(h.els.get('agents')!.innerHTML).toContain('≈4.2 %/h');
  });

  it('draws the measured curve through the history samples', () => {
    h.onState(payload());
    const svg = h.els.get('chart')!.innerHTML;
    // one <path> for the area, one for the line, plus the current-point marker
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain('<circle');
  });

  it('a chart failure is reported and does not blank the rest of the panel', () => {
    // windowMinutes = 0 makes the geometry degenerate.
    const bad = payload();
    (bad.state.limits[0]!.limit as { windowMinutes: number }).windowMinutes = 0;
    (bad.state.limits[0] as { exhaustsAt: number | null }).exhaustsAt = null;
    h.onState(bad);
    // Whatever the chart does, the numbers around it must still be there.
    expect(h.els.get('hero')!.textContent).toBe('32%');
    expect(h.els.get('agents')!.innerHTML).toContain('demo');
  });

  it('survives an empty state without throwing', () => {
    const empty = payload();
    empty.state.limits = [];
    empty.state.agents = [];
    empty.state.agentBurns = [];
    h.onState(empty);
    expect(h.errors).toHaveLength(0);
  });
});

describe('hover detail', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('an agent row resolves to that agent and shows its project directory', () => {
    h.onState(payload());
    expect(h.els.get('agents')!.innerHTML).toContain('data-agent="claude:a1"');

    const row = new El();
    row.setAttribute('data-agent', 'claude:a1');
    const tip = h.hover(row);

    expect(tip, 'directory missing from agent hover').toContain('/w/demo');
    expect(tip).toContain('Directory');
    expect(tip).toContain('main');           // branch
    expect(tip).toContain('model-x');        // model
    expect(tip).toContain('4.2 %/h');        // derived burn
  });

  it('the agent card keeps the explanation as well as the facts', () => {
    h.onState(payload());
    const row = new El();
    row.setAttribute('data-agent', 'claude:a1');
    const tip = h.hover(row);

    // Facts.
    expect(tip).toContain('Directory');
    expect(tip).toContain('/w/demo');
    // ...and the contextual explanation the row used to carry on its own. An
    // earlier change swapped one for the other; both belong here.
    expect(tip, 'explanation title missing').toContain('What this agent is costing you');
    expect(tip, 'explanation body missing').toContain('Share of the limit per hour.');
    expect(tip, 'provenance tag missing').toContain('derived');
  });

  it('an idle agent gets the idle explanation, not the burn one', () => {
    const idle = payload();
    idle.state.agents[0]!.state = 'idle';
    idle.state.agentBurns = [];
    h.onState(idle);
    const row = new El();
    row.setAttribute('data-agent', 'claude:a1');
    const tip = h.hover(row);
    expect(tip).toContain('Idle agent');
    expect(tip).not.toContain('What this agent is costing you');
  });

  it('a notification hover lists each agent with its full directory', () => {
    const withAlarm = payload({
      alarmHistory: [
        {
          id: 'a1', ruleId: 'steps', severity: 'warn', title: 'Crossed 80%', body: 'B',
          firedAt: T0, backend: 'claude', limitKey: '5h', agentId: null,
          context: {
            limitLabel: 'Claude \u00b7 5h', utilization: 85, burnPctPerHour: 12,
            paceLinePct: 40, resetsAt: T0 + H, exhaustsAt: null, plan: 'demo',
            fitConfidence: 'high',
            agents: [
              {
                label: 'one', project: 'adjent-core',
                projectPath: 'C:\\dev\\checkout-two\\adjent-core',
                branch: 'work/core', model: 'model-x', effort: 'high',
                pctPerHour: 4.2, tokens: 1000,
              },
            ],
          },
        },
      ],
    });
    h.onState(withAlarm);

    const row = new El();
    row.setAttribute('data-alarm', '0');
    const tip = h.hover(row);

    // Two checkouts of one repo share a basename; the path is what tells them apart.
    expect(tip, 'directory missing from notification hover').toContain('checkout-two');
    expect(tip).toContain('work/core');
    expect(tip).toContain('Claude');
  });

  it('a dictionary tooltip still works alongside the per-record ones', () => {
    h.onState(payload());
    const el = new El();
    el.setAttribute('data-tip', 'hero');
    expect(h.hover(el)).toContain('H');
  });
});

// ----------------------------------------- tier 3: any limit, on demand
/**
 * The resting panel deliberately shows the binding limit and at most three
 * others. These cover the way out of that cap: a click reaches every limit the
 * vendors report, with its own curve and its own exact token split.
 */
function manyLimits() {
  const p = payload() as ReturnType<typeof payload> & {
    state: { limits: unknown[] };
  };
  const base = (p.state.limits[0] as { limit: Record<string, unknown> }).limit;
  const mk = (key: string, label: string, util: number, binding = false, scope: string | null = null) => ({
    limit: { ...base, key, label, utilization: util, scope },
    burn: { pctPerHour: 2.4, updatedAt: T0 },
    verdict: 'on-pace',
    paceLinePct: 40,
    exhaustsAt: null,
    binding,
  });
  // Five limits — more than the resting panel can ever show.
  p.state.limits = [
    mk('5h', 'Claude · 5h', 32, true),
    mk('7d', 'Claude · 7d', 46),
    mk('7d:scoped', 'Claude · 7d · Scoped', 84, false, 'Scoped'),
    mk('codex7d', 'Codex · 7d', 64),
    mk('codex5h', 'Codex · 5h', 12),
  ];
  return p;
}

function detailOf(p: ReturnType<typeof manyLimits>, key: string, over: Record<string, unknown> = {}) {
  const a = (p.state.limits as { limit: { backend: string; key: string; scope: string | null } }[]).find(
    (x) => `${x.limit.backend}:${x.limit.key}` === key,
  )!;
  return {
    assessment: a,
    history: [{ t: T0 - 2 * H, w: key, u: 18 }],
    generatedAt: T0,
    breakdown: {
      limitKey: key,
      backend: 'claude',
      from: T0 - 3 * H,
      to: T0,
      scope: a.limit.scope,
      rows: [
        {
          model: 'model-x',
          tokens: { input: 1000, cacheWrite: 200, cacheRead: 8000, output: 500 },
          total: 9700,
          requests: 12,
          agents: [
            { agentId: 'claude:a1', total: 9000, requests: 10 },
            // An id with no live agent behind it: spend outlives the session.
            { agentId: 'claude:gone', total: 700, requests: 2 },
          ],
        },
        {
          model: 'model-y',
          tokens: { input: 100, cacheWrite: 0, cacheRead: 300, output: 50 },
          total: 450,
          requests: 3,
          agents: [{ agentId: 'claude:a1', total: 450, requests: 3 }],
        },
      ],
      totals: { input: 1100, cacheWrite: 200, cacheRead: 8300, output: 550 },
      total: 10150,
      requests: 15,
      events: 15,
      source: 'exact',
      ...over,
    },
  };
}

const rowFor = (key: string): El => {
  const el = new El();
  el.setAttribute('data-limit', key);
  return el;
};

describe('limit detail (tier 3)', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('marks the resting panel’s limit rows as the way in', () => {
    h.onState(payload());
    // Both the collapsed rows and the hero's own meta open their limit.
    expect(h.els.get('limits')!.innerHTML).toContain('data-limit="claude:7d"');
    expect(h.els.get('heroMeta')!.getAttribute('data-limit')).toBe('claude:5h');
  });

  it('opens on click and lists every limit, past the resting cap of three', async () => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail((key) => detailOf(p, key));

    h.click(rowFor('claude:7d'));
    await h.flush();

    expect(h.errors, 'renderer logged an error').toHaveLength(0);
    const picker = h.els.get('limitPicker')!.innerHTML;
    for (const label of ['Claude · 5h', 'Claude · 7d', 'Claude · 7d · Scoped', 'Codex · 7d', 'Codex · 5h']) {
      expect(picker, `picker is missing ${label}`).toContain(label);
    }
    // The binding limit is called out, and the opened one is the selected one.
    expect(picker).toContain('binding');
    expect(picker).toContain('data-limit="claude:7d"');
  });

  it('renders the chosen limit’s numbers, curve and exact token split', async () => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail((key) => detailOf(p, key));

    h.click(rowFor('claude:7d:scoped'));
    await h.flush();

    expect(h.errors).toHaveLength(0);
    expect(h.els.get('limitBody')!.hidden).toBe(false);
    expect(h.els.get('limitHero')!.textContent).toBe('84%');
    expect(h.els.get('limitChart')!.innerHTML).toContain('<path');

    const facts = h.els.get('limitFacts')!.innerHTML;
    expect(facts).toContain('Utilization');
    expect(facts).toContain('Pace line');
    expect(facts).toContain('Scoped');

    // The split is by model and by kind, and says so is exact.
    const split = h.els.get('limitSplit')!.innerHTML;
    expect(split).toContain('model-x');
    expect(split).toContain('model-y');
    expect(split).toContain('read 8.0k');
    expect(split).toContain('12 req');
    expect(split).toContain('10.2k');
  });

  it('switches limits without leaving a stale body behind', async () => {
    const p = manyLimits();
    h.onState(p);
    const asked: string[] = [];
    h.setDetail((key) => {
      asked.push(key);
      return detailOf(p, key);
    });

    h.click(rowFor('claude:7d'));
    await h.flush();
    expect(h.els.get('limitHero')!.textContent).toBe('46%');

    h.click(rowFor('claude:codex7d'));
    await h.flush();
    expect(h.els.get('limitHero')!.textContent).toBe('64%');
    expect(asked).toEqual(['claude:7d', 'claude:codex7d']);
  });

  it('says so plainly when nothing was spent in the window', async () => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail((key) => detailOf(p, key, { rows: [], totals: {}, total: 0, requests: 0, events: 0 }));

    h.click(rowFor('claude:7d'));
    await h.flush();

    expect(h.errors).toHaveLength(0);
    expect(h.els.get('limitSplit')!.innerHTML).toContain('No usage observed');
  });

  it('stays live: a tick refreshes the open limit rather than freezing it', async () => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail((key) => detailOf(p, key));
    h.click(rowFor('claude:7d'));
    await h.flush();
    expect(h.els.get('limitHero')!.textContent).toBe('46%');

    // Next tick: the same limit, fuller. The dashboard is not what is on screen,
    // so this only updates if the 'limits' branch of onState does the work.
    const p2 = manyLimits();
    (p2.state.limits as { limit: { key: string; utilization: number } }[]).find(
      (x) => x.limit.key === '7d',
    )!.limit.utilization = 59;
    // Script the answer before the tick: onState requests the detail synchronously.
    h.setDetail((key) => detailOf(p2, key));
    h.onState(p2);
    await h.flush();

    expect(h.errors).toHaveLength(0);
    expect(h.els.get('limitHero')!.textContent).toBe('59%');
    expect(h.els.get('limitPicker')!.innerHTML).toContain('59%');
  });

  it('survives a limit the main process no longer knows about', async () => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail(() => null);

    h.click(rowFor('claude:gone'));
    await h.flush();

    expect(h.errors).toHaveLength(0);
    expect(h.els.get('limitBody')!.hidden).toBe(true);
  });
});

describe('where it went: agents behind a model', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  const openSplit = async (over: Record<string, unknown> = {}) => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail((key) => detailOf(p, key, over));
    h.click(rowFor('claude:7d'));
    await h.flush();
    return p;
  };

  it('marks each split row with its model, so the row can be hovered', async () => {
    await openSplit();
    expect(h.els.get('limitSplit')!.innerHTML).toContain('data-split="model-x"');
    expect(h.els.get('limitSplit')!.innerHTML).toContain('data-split="model-y"');
  });

  it('names the agents behind that model, with the directory in full', async () => {
    await openSplit();
    const el = new El();
    el.setAttribute('data-split', 'model-x');
    const tip = h.hover(el);

    expect(tip).toContain('model-x');
    // Resolved against the live agent: project name, branch and full path.
    expect(tip).toContain('demo');
    expect(tip).toContain('/w/demo');
    expect(tip).toContain('main');
    // Shares within the model, not of the whole limit.
    expect(tip).toContain('93%');
    expect(tip).toContain('2 agents');
  });

  it('says a session ended rather than printing a bare id as a name', async () => {
    await openSplit();
    const el = new El();
    el.setAttribute('data-split', 'model-x');
    const tip = h.hover(el);
    expect(tip).toContain('ended session');
    expect(tip).toContain('not running');
    expect(tip).not.toContain('claude:gone');
  });

  it('handles a model with no attribution at all', async () => {
    await openSplit({
      rows: [
        {
          model: 'model-z',
          tokens: { input: 5, cacheWrite: 0, cacheRead: 0, output: 5 },
          total: 10,
          requests: 1,
          agents: [],
        },
      ],
      total: 10,
    });
    const el = new El();
    el.setAttribute('data-split', 'model-z');
    expect(h.hover(el)).toContain('No agent attribution');
    expect(h.errors).toHaveLength(0);
  });
});

describe('dates, not just clock times', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('names the day for a reset that is not today', async () => {
    const p = manyLimits();
    // A 7-day limit resetting five days out: "05:29" alone would read as today.
    const target = (p.state.limits as { limit: Record<string, unknown> }[])[1]!;
    target.limit.resetsAt = T0 + 5 * 24 * H;
    target.limit.windowMinutes = 10_080;
    h.onState(p);
    h.setDetail((key) => detailOf(p, key));
    h.click(rowFor('claude:7d'));
    await h.flush();

    const facts = h.els.get('limitFacts')!.innerHTML;
    // Letters ahead of the clock — a weekday or "tomorrow", never a bare HH:MM.
    expect(facts).toMatch(/\p{L}[^<]*\d{2}:\d{2}/u);
    expect(h.errors).toHaveLength(0);
  });

  it('keeps a same-day reset to the bare clock', async () => {
    const p = manyLimits();
    const target = (p.state.limits as { limit: Record<string, unknown> }[])[1]!;
    // Two minutes out is unambiguously today whatever the local hour.
    target.limit.resetsAt = T0 + 2 * 60_000;
    h.onState(p);
    h.setDetail((key) => detailOf(p, key));
    h.click(rowFor('claude:7d'));
    await h.flush();

    expect(h.els.get('limitFacts')!.innerHTML).not.toContain('tomorrow');
    expect(h.errors).toHaveLength(0);
  });
});

/**
 * Chart labels must never overlap. The three axis labels are anchored
 * independently — left edge, right edge, and wherever "now" happens to fall —
 * so near either end of a window they collided. Dating the labels on
 * multi-day limits more than doubled their width and made it routine.
 */
describe('chart labels never overlap', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  /** Same estimate the renderer places with. */
  const CH = 5.5;

  function boxes(svg: string) {
    const out: { y: number; l: number; r: number; text: string }[] = [];
    const re = /<text x="([\d.-]+)" y="([\d.-]+)"(?: text-anchor="(\w+)")?>([^<]*)<\/text>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(svg)) !== null) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      const anchor = m[3] ?? 'start';
      const text = m[4]!;
      const w = text.length * CH;
      const l = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
      out.push({ y, l, r: l + w, text });
    }
    return out;
  }

  function assertNoOverlap(svg: string, label: string) {
    const bs = boxes(svg);
    expect(bs.length, `${label}: no labels drawn at all`).toBeGreaterThan(0);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!;
        const b = bs[j]!;
        if (a.y !== b.y) continue;
        const overlap = a.l < b.r && b.l < a.r;
        expect(overlap, `${label}: "${a.text}" and "${b.text}" overlap`).toBe(false);
      }
    }
  }

  // now at the very start, the very end, and points between: the "now" label
  // has to give way at both extremes rather than land on its neighbour.
  const OFFSETS = [1, 5, 30, 60, 150, 240, 290, 299];

  it('holds for a 5-hour limit wherever now falls in it', () => {
    for (const mins of OFFSETS) {
      const p = payload() as { state: { limits: { limit: Record<string, unknown> }[] } };
      const w = p.state.limits[0]!.limit;
      w.windowMinutes = 300;
      // now sits `mins` into a 300-minute window.
      w.resetsAt = T0 + (300 - mins) * 60_000;
      h.onState(p);
      assertNoOverlap(h.els.get('chart')!.innerHTML, `5h at +${mins}m`);
    }
  });

  it('holds for a 7-day limit, whose labels carry a weekday', () => {
    for (const frac of [0.001, 0.02, 0.5, 0.94, 0.99, 0.999]) {
      const p = payload() as { state: { limits: { limit: Record<string, unknown> }[] } };
      const w = p.state.limits[0]!.limit;
      w.windowMinutes = 10_080;
      w.resetsAt = T0 + Math.round(10_080 * (1 - frac)) * 60_000;
      h.onState(p);
      assertNoOverlap(h.els.get('chart')!.innerHTML, `7d at ${frac}`);
    }
  });

  it('drops the "now" label at the ends rather than stacking it', () => {
    const labelsAt = (frac: number) => {
      const p = payload() as { state: { limits: { limit: Record<string, unknown> }[] } };
      const w = p.state.limits[0]!.limit;
      w.windowMinutes = 10_080;
      w.resetsAt = T0 + Math.round(10_080 * (1 - frac)) * 60_000;
      h.onState(p);
      return boxes(h.els.get('chart')!.innerHTML).map((b) => b.text);
    };
    // Mid-window there is room for all three; hard against the reset there is not.
    expect(labelsAt(0.5)).toContain('now');
    expect(labelsAt(0.999), 'now should have given way to the reset label').not.toContain('now');
  });

  it('keeps the exhaustion callout inside the frame', () => {
    for (const frac of [0.05, 0.5, 0.97]) {
      const p = payload() as {
        state: { limits: { limit: Record<string, unknown>; exhaustsAt: number }[] };
      };
      const a = p.state.limits[0]!;
      a.limit.windowMinutes = 10_080;
      a.limit.resetsAt = T0 + 6 * 24 * H;
      a.exhaustsAt = T0 + Math.round(6 * 24 * H * frac);
      h.onState(p);
      for (const b of boxes(h.els.get('chart')!.innerHTML)) {
        expect(b.l, `label "${b.text}" starts left of the frame`).toBeGreaterThanOrEqual(-0.5);
        expect(b.r, `label "${b.text}" runs past the frame`).toBeLessThanOrEqual(352.5);
      }
    }
  });
});

describe('header navigation', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('the live count opens the agents view, and toggles back', () => {
    h.onState(payload());
    h.fire('liveCount');
    expect(h.els.get('agentsView')!.hidden).toBe(false);
    expect(h.els.get('agentList')!.innerHTML).toContain('demo');
    h.fire('liveCount');
    expect(h.els.get('agentsView')!.hidden).toBe(true);
  });

  it('the wordmark returns to the dashboard from anywhere', () => {
    h.onState(payload());
    h.fire('gear');
    expect(h.els.get('settingsView')!.hidden).toBe(false);
    h.fire('brandHome');
    expect(h.els.get('settingsView')!.hidden).toBe(true);
    expect(h.els.get('agentsView')!.hidden).toBe(true);
    expect(h.els.get('limitView')!.hidden).toBe(true);
  });

  it('the wordmark also answers the keyboard', () => {
    h.onState(payload());
    h.fire('bell');
    expect(h.els.get('notificationsView')!.hidden).toBe(false);
    h.fire('brandHome', 'keydown', { key: 'Enter' });
    expect(h.els.get('notificationsView')!.hidden).toBe(true);
  });
});

describe('all agents view', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  /** Four agents: two with burn, one idle, one whose model is a placeholder. */
  function manyAgents() {
    const p = payload() as { state: { agents: unknown[]; agentBurns: unknown[] } };
    const base = p.state.agents[0] as Record<string, unknown>;
    const mk = (id: string, project: string, model: string | null, tokens: number, state = 'live') => ({
      ...base,
      id,
      label: id,
      projectPath: `/w/${project}`,
      model,
      state,
      totals: { input: tokens, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
    });
    p.state.agents = [
      mk('claude:a1', 'alpha', 'model-x', 1000),
      mk('claude:a2', 'bravo', 'gpt-unknown', 9000),
      mk('claude:a3', 'charlie', null, 50, 'idle'),
      mk('claude:a4', 'delta', 'model-y', 30),
    ];
    p.state.agentBurns = [{ agentId: 'claude:a4', pctPerHour: 12.5, confidence: 'high' }];
    return p;
  }

  it('lists every agent, not just the four the dashboard shows', () => {
    h.onState(manyAgents());
    h.fire('liveCount');
    const list = h.els.get('agentList')!.innerHTML;
    for (const p of ['alpha', 'bravo', 'charlie', 'delta']) expect(list).toContain(p);
    expect(h.errors).toHaveLength(0);
  });

  it('orders by cost: burn first, then tokens in the window', () => {
    h.onState(manyAgents());
    h.fire('liveCount');
    const list = h.els.get('agentList')!.innerHTML;
    const order = ['delta', 'bravo', 'alpha', 'charlie'].map((n) => list.indexOf(n));
    // delta burns; bravo has the most tokens; charlie the fewest.
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('never shows a placeholder as if it were a model', () => {
    h.onState(manyAgents());
    h.fire('liveCount');
    const list = h.els.get('agentList')!.innerHTML;
    expect(list).not.toContain('gpt-unknown');
    expect(list).toContain('model unknown');
  });

  it('stays live as ticks arrive', () => {
    h.onState(manyAgents());
    h.fire('liveCount');
    const p2 = manyAgents() as { state: { agents: Record<string, unknown>[] } };
    p2.state.agents[0]!.projectPath = '/w/renamed';
    h.onState(p2);
    expect(h.els.get('agentList')!.innerHTML).toContain('renamed');
    expect(h.errors).toHaveLength(0);
  });
});

describe('other limits carry their own numbers', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('shows what filled each limit, not only the binding one', () => {
    const p = payload() as { state: { limits: Record<string, unknown>[] } };
    p.state.limits[1]!.tokens = { input: 400_000, cacheWrite: 0, cacheRead: 1_000_000, output: 100_000 };
    h.onState(p);
    // 1.5M across the billable kinds.
    expect(h.els.get('limits')!.innerHTML).toContain('1.5M');
  });

  it('says nothing rather than zero when a limit has no ledger yet', () => {
    const p = payload() as { state: { limits: Record<string, unknown>[] } };
    p.state.limits[1]!.tokens = null;
    h.onState(p);
    expect(h.els.get('limits')!.innerHTML).not.toContain(' · 0');
    expect(h.errors).toHaveLength(0);
  });
});

describe('placeholder models never reach the split', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('renders an unattributable model honestly', async () => {
    const p = manyLimits();
    h.onState(p);
    h.setDetail((key) =>
      detailOf(p, key, {
        rows: [
          {
            model: 'gpt-unknown',
            tokens: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 },
            total: 15,
            requests: 1,
            agents: [{ agentId: 'claude:a1', total: 15, requests: 1 }],
          },
        ],
        total: 15,
      }),
    );
    h.click(rowFor('claude:7d'));
    await h.flush();

    const split = h.els.get('limitSplit')!.innerHTML;
    // The attribute stays the raw key — it is how the hover finds the row.
    // What a reader sees must not be the placeholder.
    const shown = /<span class="name">([^<]*)<\/span>/.exec(split)?.[1];
    expect(shown).toBe('unknown model');

    const el = new El();
    el.setAttribute('data-split', 'gpt-unknown');
    const tip = h.hover(el);
    expect(tip).toContain('unknown model');
    expect(/<span class="t">([^<]*)<\/span>/.exec(tip)?.[1]).toBe('unknown model');
  });
});

/**
 * The dot and the words beside it are one claim about an agent, so they must
 * come from one place. They did not: the agents view called anything without a
 * burn figure "idle", live agents included, while the dot stayed green.
 */
describe('agent state reads consistently', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  function withStates() {
    const p = payload() as { state: { agents: Record<string, unknown>[]; agentBurns: unknown[] } };
    const base = p.state.agents[0] as Record<string, unknown>;
    const mk = (id: string, project: string, state: string) => ({
      ...base,
      id,
      label: id,
      projectPath: `/w/${project}`,
      state,
      lastActivityAt: T0 - 3 * 60_000,
    });
    p.state.agents = [
      mk('claude:live-noburn', 'liveone', 'live'),
      mk('claude:idle', 'idleone', 'idle'),
      mk('claude:ended', 'endedone', 'ended'),
    ];
    // Nothing has a burn figure: the fit has nothing to say yet.
    p.state.agentBurns = [];
    return p;
  }

  const rowOf = (html: string, id: string) => {
    const i = html.indexOf(`data-agent="${id}"`);
    return i === -1 ? '' : html.slice(i, html.indexOf('</div><div class="agentRow"', i + 1) + 1 || undefined);
  };

  it('does not call a live agent idle just because it has no burn figure', () => {
    h.onState(withStates());
    h.fire('liveCount');
    const row = rowOf(h.els.get('agentList')!.innerHTML, 'claude:live-noburn');
    expect(row).toContain('--good');
    expect(row, 'a live agent was labelled idle').not.toContain('idle');
  });

  it('gives an idle agent the idle colour and the idle word together', () => {
    h.onState(withStates());
    h.fire('liveCount');
    const row = rowOf(h.els.get('agentList')!.innerHTML, 'claude:idle');
    expect(row).toContain('--idle');
    expect(row).toContain('idle');
    expect(row).not.toContain('--good');
  });

  it('marks an ended agent as ended, never green', () => {
    h.onState(withStates());
    h.fire('liveCount');
    const row = rowOf(h.els.get('agentList')!.innerHTML, 'claude:ended');
    expect(row).toContain('ended');
    expect(row).not.toContain('--good');
  });

  it('keeps the dashboard rows saying the same thing as the list', () => {
    const p = withStates();
    h.onState(p);
    const dash = h.els.get('agents')!.innerHTML;
    h.fire('liveCount');
    const list = h.els.get('agentList')!.innerHTML;
    for (const [id, colour] of [
      ['claude:live-noburn', '--good'],
      ['claude:idle', '--idle'],
      ['claude:ended', '--idle'],
    ] as const) {
      expect(rowOf(dash, id) || dash, `dashboard ${id}`).toContain(colour);
      expect(rowOf(list, id), `list ${id}`).toContain(colour);
    }
  });
});

/**
 * An absent timestamp must never be rendered as a duration. `lastActivityAt`
 * of 0 subtracted from the clock produced "idle 20689d 18h" — half a century
 * of idleness, printed with total confidence.
 */
describe('durations from missing timestamps', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  function agentsWith(over: Record<string, unknown>) {
    const p = payload() as { state: { agents: Record<string, unknown>[]; agentBurns: unknown[] } };
    p.state.agents = [{ ...p.state.agents[0], id: 'claude:x', projectPath: '/w/thing', state: 'idle', ...over }];
    p.state.agentBurns = [];
    return p;
  }

  const ABSURD = /\b\d{3,}d\b/;

  it('says just "idle" when there is no activity time at all', () => {
    h.onState(agentsWith({ lastActivityAt: 0 }));
    h.fire('liveCount');
    const list = h.els.get('agentList')!.innerHTML;
    expect(list).toContain('idle');
    expect(list, 'printed a duration from a missing timestamp').not.toMatch(ABSURD);
  });

  it('keeps the same guard on the dashboard rows', () => {
    h.onState(agentsWith({ lastActivityAt: 0 }));
    expect(h.els.get('agents')!.innerHTML).not.toMatch(ABSURD);
  });

  it('keeps it in the hover card too', () => {
    h.onState(agentsWith({ lastActivityAt: 0, startedAt: 0 }));
    const el = new El();
    el.setAttribute('data-agent', 'claude:x');
    const tip = h.hover(el);
    expect(tip).not.toMatch(ABSURD);
    // The rows it cannot fill are dropped rather than filled with nonsense.
    expect(tip).not.toContain('Last turn');
  });

  it('still prints an ordinary idle time', () => {
    h.onState(agentsWith({ lastActivityAt: T0 - 42 * 60_000 }));
    h.fire('liveCount');
    const list = h.els.get('agentList')!.innerHTML;
    expect(list).toContain('idle 42m');
    expect(list).not.toMatch(ABSURD);
  });
});

/**
 * The collapsed limit rows are a column, not three independent lines: they
 * carry the same cells in the same order so the eye can run down them.
 */
describe('limit rows keep one shape', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  it('shows a token cell on every row, even when nothing was counted', () => {
    const p = payload() as { state: { limits: Record<string, unknown>[] } };
    p.state.limits[1]!.tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    h.onState(p);
    const html = h.els.get('limits')!.innerHTML;
    // An em dash states "none counted"; an absent cell just looked ragged.
    expect(html).toContain('—');
    expect(h.errors).toHaveLength(0);
  });

  it('gives every row the same cell count', () => {
    const p = payload() as { state: { limits: Record<string, unknown>[] } };
    const base = p.state.limits[1]!;
    p.state.limits = [
      p.state.limits[0]!,
      { ...base, tokens: { input: 5_000, cacheWrite: 0, cacheRead: 0, output: 0 } },
      { ...base, limit: { ...(base.limit as object), key: 'b', label: 'B' }, tokens: null },
    ] as Record<string, unknown>[];
    h.onState(p);
    const rows = h.els.get('limits')!.innerHTML.split('<div class="row"').slice(1);
    expect(rows.length).toBe(2);
    // Count separators in the meta cell only: the label itself contains one
    // ("Claude · 7d"), which would otherwise be measured as shape.
    const seps = rows.map((r) => {
      const meta = /<span class="meta">(.*?)<\/span>/s.exec(r)?.[1] ?? '';
      return (meta.match(/·/g) ?? []).length;
    });
    expect(new Set(seps).size, `rows had different shapes: ${seps.join(', ')}`).toBe(1);
  });
});

/**
 * A reading time on one row and not the others made the collapsed list ragged
 * for a detail that belongs in the hover and the detail view. The rows now
 * print the same cells whatever the age of the reading — but staleness is not
 * discarded, it moves to where there is room to say it properly.
 */
describe('staleness leaves the row, not the app', () => {
  let h: Harness;
  beforeEach(() => {
    h = loadPanel();
  });

  /** `other` (index 1) is the non-binding row the collapsed list renders. */
  function withStaleOther() {
    const p = payload() as { state: { generatedAt: number; limits: Record<string, unknown>[] } };
    const other = p.state.limits[1]!;
    // An hour old: comfortably past the ten-minute staleness threshold.
    other.limit = { ...(other.limit as object), observedAt: T0 - 60 * 60_000 };
    other.tokens = { input: 1_000, cacheWrite: 0, cacheRead: 0, output: 0 };
    return p;
  }

  const metaOf = (html: string) => {
    const out: string[] = [];
    const re = /<span class="meta">(.*?)<\/span>/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) out.push(m[1]!);
    return out;
  };

  it('prints no reading time on a stale row', () => {
    h.onState(withStaleOther());
    const html = h.els.get('limits')!.innerHTML;
    expect(html).not.toContain('as of');
    expect(h.errors).toHaveLength(0);
  });

  it('gives a stale row the same shape as a fresh one', () => {
    const p = withStaleOther() as { state: { limits: Record<string, unknown>[] } };
    const stale = p.state.limits[1]!;
    const fresh = {
      ...stale,
      limit: { ...(stale.limit as { observedAt: number }), observedAt: T0, key: 'fresh', label: 'Fresh' },
    };
    p.state.limits = [p.state.limits[0]!, stale, fresh] as Record<string, unknown>[];
    h.onState(p);

    const metas = metaOf(h.els.get('limits')!.innerHTML);
    expect(metas).toHaveLength(2);
    const seps = metas.map((m) => (m.match(/·/g) ?? []).length);
    expect(new Set(seps).size, `stale and fresh rows differ: ${seps.join(' vs ')}`).toBe(1);
  });

  it('still explains staleness on hover, so the fact is not lost', () => {
    h.onState(withStaleOther());
    // The row switches its explanation key rather than printing a time.
    expect(h.els.get('limits')!.innerHTML).toContain('data-tip="stale"');
  });

  it('keeps the reset countdown on the hero when its reading is stale', () => {
    const p = payload() as { state: { limits: Record<string, unknown>[] } };
    const binding = p.state.limits[0]!;
    binding.limit = { ...(binding.limit as object), observedAt: T0 - 60 * 60_000 };
    h.onState(p);

    const meta = h.els.get('heroMeta')!.innerHTML;
    // Staleness used to displace this, dropping the number the hero exists for.
    expect(meta).toContain('resets in');
    expect(meta).not.toContain('as of');
    expect(h.els.get('heroMeta')!.getAttribute('data-tip')).toBe('stale');
  });
});
