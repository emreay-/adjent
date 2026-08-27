/**
 * Sink routing, and the silence it used to allow.
 *
 * The defect these tests exist for: every shipped preset — and
 * `DEFAULT_CONFIG` itself — routed critical alarms to `webhook`, which no shell
 * ever registered and which could not be built at all, there being no URL
 * setting. `SinkRouter.route()` skipped the unknown id without a word. So a
 * user followed the documented path, believed their critical alarms were being
 * POSTed somewhere, and received nothing. An alarm engine that quietly stops
 * alarming is the worst failure available to it (see diagnostics.test.ts, same
 * principle) — and this was that failure, shipped by default.
 *
 * Two layers guard it now, answering different questions:
 *   - `parseConfig` — "is this a sink at all?" (catches a typo statically)
 *   - `SinkRouter`  — "is it wired up in this process?" (catches the real drop)
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_SINK_IDS, SinkRouter, type Sink } from '../src/sinks/sink.js';
import { DEFAULT_CONFIG, parseConfig, type Routing } from '../src/rules/config.js';
import type { Alarm } from '../src/model/types.js';

const alarm = (severity: Alarm['severity'], id = 'a1'): Alarm =>
  ({ id, ruleId: 'r', severity, title: 't', body: 'b', at: 0 }) as unknown as Alarm;

const routing = (over: Partial<Routing> = {}): Routing => ({ info: [], warn: [], critical: [], ...over });

class Spy implements Sink {
  readonly delivered: Alarm[] = [];
  constructor(readonly id: string) {}
  async deliver(a: Alarm): Promise<void> {
    this.delivered.push(a);
  }
}

describe('SinkRouter — delivery', () => {
  it('delivers to every registered sink named for the severity', async () => {
    const tray = new Spy('tray');
    const toast = new Spy('toast');
    const r = new SinkRouter(routing({ critical: ['tray', 'toast'] }));
    r.register(tray);
    r.register(toast);

    await r.route([alarm('critical')]);

    expect(tray.delivered).toHaveLength(1);
    expect(toast.delivered).toHaveLength(1);
  });

  it('a failing sink never breaks the loop for the others', async () => {
    const boom: Sink = {
      id: 'tray',
      deliver: () => Promise.reject(new Error('nope')),
    };
    const toast = new Spy('toast');
    const r = new SinkRouter(routing({ critical: ['tray', 'toast'] }));
    r.register(boom);
    r.register(toast);

    await expect(r.route([alarm('critical')])).resolves.toBeUndefined();
    expect(toast.delivered).toHaveLength(1);
  });
});

describe('SinkRouter — an alarm that goes nowhere says so', () => {
  it('reports a routed sink that nothing registered', async () => {
    const seen: Array<[string, string]> = [];
    const r = new SinkRouter(routing({ critical: ['webhook'] }));
    r.setUnroutableReporter((id, sev) => seen.push([id, sev]));

    await r.route([alarm('critical')]);

    expect(seen).toEqual([['webhook', 'critical']]);
  });

  it('reports once per id, not once per alarm — a live loop must not spam', async () => {
    const seen: string[] = [];
    const r = new SinkRouter(routing({ critical: ['webhook'] }));
    r.setUnroutableReporter((id) => seen.push(id));

    await r.route([alarm('critical', 'a1'), alarm('critical', 'a2')]);
    await r.route([alarm('critical', 'a3')]);

    expect(seen).toEqual(['webhook']);
  });

  it('stays silent when every routed sink is registered', async () => {
    const seen: string[] = [];
    const r = new SinkRouter(routing({ critical: ['tray'] }));
    r.setUnroutableReporter((id) => seen.push(id));
    r.register(new Spy('tray'));

    await r.route([alarm('critical')]);

    expect(seen).toEqual([]);
  });

  it('registering the sink later clears the warning, so a URL arriving from settings recovers', async () => {
    const seen: string[] = [];
    const r = new SinkRouter(routing({ critical: ['webhook'] }));
    r.setUnroutableReporter((id) => seen.push(id));

    await r.route([alarm('critical', 'a1')]);
    const late = new Spy('webhook');
    r.register(late);
    await r.route([alarm('critical', 'a2')]);

    expect(seen).toEqual(['webhook']);
    expect(late.delivered).toHaveLength(1);
  });

  it('a hot reload re-checks: a newly bad routing table warns again', async () => {
    const seen: string[] = [];
    const r = new SinkRouter(routing({ critical: ['tray'] }));
    r.setUnroutableReporter((id) => seen.push(id));
    r.register(new Spy('tray'));

    await r.route([alarm('critical', 'a1')]);
    r.setRouting(routing({ critical: ['tray', 'webhook'] }));
    await r.route([alarm('critical', 'a2')]);

    expect(seen).toEqual(['webhook']);
  });

  it('unroutable() lists what this process cannot deliver, before any alarm fires', () => {
    const r = new SinkRouter(routing({ warn: ['tray'], critical: ['tray', 'webhook'] }));
    r.register(new Spy('tray'));

    expect(r.unroutable()).toEqual(['webhook']);
  });
});

describe('routing config — a sink name nobody can build is a diagnostic', () => {
  it('warns on an unknown sink name and names the known ones', () => {
    const { diagnostics } = parseConfig('alarms: []\nrouting:\n  critical: [tray, webhok]\n');
    const d = diagnostics.find((x) => x.path === '$.routing.critical');

    expect(d?.level).toBe('warn');
    expect(d?.message).toContain('webhok');
    expect(d?.message).toContain('dropped');
  });

  it('reporting does not change what runs — the typo is still tolerated', () => {
    const { config } = parseConfig('alarms: []\nrouting:\n  critical: [tray, webhok]\n');
    expect(config.routing.critical).toEqual(['tray', 'webhok']);
  });

  it('says nothing about a known sink, even one this process has not registered', () => {
    const { diagnostics } = parseConfig('alarms: []\nrouting:\n  critical: [tray, toast, webhook]\n');
    expect(diagnostics.filter((x) => x.path === '$.routing.critical')).toEqual([]);
  });
});

describe('what ships must be deliverable', () => {
  /**
   * The regression guard. Before this item, `DEFAULT_CONFIG` named `webhook`,
   * which requires `settings.alarmWebhookUrl` and so cannot exist on a default
   * install. Anything routed by default must be buildable with no user setup.
   */
  const NO_SETUP_REQUIRED = ['tray', 'toast', 'console'];

  it('the default routing names only sinks a fresh install can actually build', () => {
    for (const [severity, ids] of Object.entries(DEFAULT_CONFIG.routing)) {
      for (const id of ids) {
        expect(NO_SETUP_REQUIRED, `${severity} routes to ${id}, which needs configuration`).toContain(id);
      }
    }
  });

  it('every sink the default routing names is a known sink', () => {
    for (const ids of Object.values(DEFAULT_CONFIG.routing)) {
      for (const id of ids) expect(KNOWN_SINK_IDS).toContain(id);
    }
  });

  it('the default routing is deliverable end to end, not merely well-named', async () => {
    const r = new SinkRouter(DEFAULT_CONFIG.routing);
    const spies = NO_SETUP_REQUIRED.map((id) => new Spy(id));
    for (const s of spies) r.register(s);
    const unroutable: string[] = [];
    r.setUnroutableReporter((id) => unroutable.push(id));

    // Asserted before routing and independently of the reporter: a revert that
    // removes the reporter must not be able to make this test pass by silence.
    expect(r.unroutable()).toEqual([]);

    await r.route([alarm('info'), alarm('warn'), alarm('critical')]);

    expect(unroutable).toEqual([]);
    // and the critical alarm genuinely reached something
    expect(spies.find((s) => s.id === 'tray')?.delivered.length).toBeGreaterThan(0);
  });
});
