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
  addEventListener() {}
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
  return { els, onState, errors, hover };
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
