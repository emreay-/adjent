/**
 * `Monitor.limitDetail` — the glue behind tier 3 (docs/UI.md § Any limit, on
 * demand). Thin, but it is the one place that joins three separately-correct
 * things: the assessment from the current snapshot, the history for that limit
 * key, and the exact token split. Getting the key format wrong in any one of
 * them yields a view that renders happily with the wrong limit's numbers.
 *
 * A fake provider keeps this in memory: no vendor directories are read.
 */
import { describe, expect, it } from 'vitest';
import { Monitor } from '../src/monitor.js';
import type { ProviderAdapter } from '../src/providers/provider.js';
import type { Agent, Backend, QuotaLimit, UsageEvent } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const H = 3600_000;

function fakeProvider(limits: QuotaLimit[], events: UsageEvent[], agents: Agent[] = []): ProviderAdapter {
  let served = false;
  return {
    id: 'claude',
    supportedVersions: '*',
    async detect(): Promise<Backend> {
      return {
        id: 'claude',
        displayName: 'Fake',
        version: null,
        plan: null,
        rateLimitTier: null,
        health: 'ok',
        healthDetail: null,
      };
    },
    async listAgents(): Promise<Agent[]> {
      return agents.map((a) => ({ ...a }));
    },
    async collectUsage(): Promise<UsageEvent[]> {
      // Incremental by contract: hand the events over exactly once.
      if (served) return [];
      served = true;
      return events;
    },
    async quota(): Promise<QuotaLimit[]> {
      return limits;
    },
    getTailOffsets() {
      return {};
    },
    setTailOffsets() {},
  };
}

const limit = (over: Partial<QuotaLimit> = {}): QuotaLimit => ({
  backend: 'claude',
  key: '5h',
  label: 'Fake · 5h',
  windowMinutes: 300,
  utilization: 40,
  resetsAt: T0 + 2 * H,
  severity: null,
  vendorActive: false,
  scope: null,
  source: 'reported',
  observedAt: T0,
  ...over,
});

const event = (model: string, input: number): UsageEvent => ({
  ts: T0 - 30 * 60_000,
  backend: 'claude',
  agentId: 'claude:s1',
  model,
  effort: null,
  tokens: { input, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
  requests: 1,
  requestId: `r-${model}-${input}`,
});

async function monitorWith(limits: QuotaLimit[], events: UsageEvent[], agents: Agent[] = []): Promise<Monitor> {
  const m = new Monitor({
    providers: [fakeProvider(limits, events, agents)],
    store: null,
    now: () => T0,
  });
  await m.tick();
  return m;
}

describe('Monitor.limitDetail', () => {
  it('joins assessment, history and split for the requested limit', async () => {
    const m = await monitorWith(
      [limit(), limit({ key: '7d', label: 'Fake · 7d', windowMinutes: 10_080, utilization: 12 })],
      [event('model-a', 500), event('model-b', 100)],
    );

    const d = m.limitDetail('claude:5h');
    expect(d).not.toBeNull();
    expect(d!.assessment.limit.key).toBe('5h');
    expect(d!.breakdown.limitKey).toBe('claude:5h');
    expect(d!.breakdown.rows.map((r) => r.model)).toEqual(['model-a', 'model-b']);
    expect(d!.breakdown.total).toBe(600);
    expect(d!.generatedAt).toBe(T0);
  });

  it('returns the limit asked for, not merely the first one', async () => {
    const m = await monitorWith(
      [limit(), limit({ key: '7d', label: 'Fake · 7d', windowMinutes: 10_080, utilization: 12 })],
      [event('model-a', 500)],
    );
    expect(m.limitDetail('claude:7d')!.assessment.limit.key).toBe('7d');
  });

  it('is null for a limit the vendor is not reporting', async () => {
    const m = await monitorWith([limit()], []);
    expect(m.limitDetail('claude:nope')).toBeNull();
    expect(m.limitDetail('codex:5h')).toBeNull();
  });

  it('is null before the first tick, rather than throwing', () => {
    const m = new Monitor({ providers: [fakeProvider([limit()], [])], store: null, now: () => T0 });
    expect(m.limitDetail('claude:5h')).toBeNull();
  });
});

/**
 * A session that produced no turn since Adjent last started has no observed
 * model — the byte offsets survive a restart, the observations derived from
 * them do not. The ledger does survive, and its events carry the model, so an
 * agent that is visibly burning quota must not render its model as "?".
 */
describe('agent identity backfill', () => {
  const agent = (over: Partial<Agent> = {}): Agent => ({
    id: 'claude:s1',
    backend: 'claude',
    label: 'session',
    projectPath: null,
    gitBranch: null,
    model: null,
    effort: null,
    entrypoint: null,
    parentId: null,
    pid: 1,
    state: 'live',
    startedAt: T0 - H,
    lastActivityAt: T0 - H,
    totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
    ...over,
  });

  it('fills a missing model from the agent’s most recent event', async () => {
    const m = await monitorWith([limit()], [event('model-a', 100)], [agent()]);
    const a = m.state!.agents.find((x) => x.id === 'claude:s1')!;
    expect(a.model).toBe('model-a');
  });

  it('prefers the latest turn when the model changed mid-session', async () => {
    const older = { ...event('model-old', 100), ts: T0 - 50 * 60_000 };
    const newer = { ...event('model-new', 100), ts: T0 - 10 * 60_000 };
    const m = await monitorWith([limit()], [older, newer], [agent()]);
    expect(m.state!.agents[0]!.model).toBe('model-new');
  });

  it('never overwrites a model the provider actually observed', async () => {
    const m = await monitorWith(
      [limit()],
      [event('model-from-ledger', 100)],
      [agent({ model: 'model-from-provider' })],
    );
    expect(m.state!.agents[0]!.model).toBe('model-from-provider');
  });

  it('leaves the model null when the ledger has nothing for that agent', async () => {
    const m = await monitorWith([limit()], [], [agent()]);
    expect(m.state!.agents[0]!.model).toBeNull();
  });

  it('does not borrow another agent’s model', async () => {
    const other = { ...event('model-other', 100), agentId: 'claude:someone-else' };
    const m = await monitorWith([limit()], [other], [agent()]);
    expect(m.state!.agents[0]!.model).toBeNull();
  });
});

/**
 * Agent totals must describe the window on screen, not "since this process
 * started". A restart used to reset every agent to zero while the vendor's
 * utilization carried on, so the token line disagreed with the hero above it
 * for the rest of the window.
 */
describe('window totals', () => {
  const agent = (id: string): Agent => ({
    id,
    backend: 'claude',
    label: id,
    projectPath: null,
    gitBranch: null,
    model: 'model-a',
    effort: null,
    entrypoint: null,
    parentId: null,
    pid: 1,
    state: 'live',
    startedAt: T0 - 10 * H,
    lastActivityAt: T0,
    totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
  });

  const at = (ts: number, input: number, id = 'claude:s1'): UsageEvent => ({
    ...event('model-a', input),
    ts,
    agentId: id,
    requestId: `w-${id}-${ts}-${input}`,
  });

  it('sums the binding limit’s window, ignoring what the provider reported', async () => {
    // The 5h limit resets 2h out, so its window opened 3h ago.
    const m = await monitorWith(
      [limit()],
      [at(T0 - 2 * H, 100), at(T0 - 30 * 60_000, 250)],
      [agent('claude:s1')],
    );
    expect(m.state!.agents[0]!.totals.input).toBe(350);
  });

  it('excludes spend from before the window opened', async () => {
    const m = await monitorWith(
      [limit()],
      [at(T0 - 4 * H, 999), at(T0 - H, 20)],
      [agent('claude:s1')],
    );
    expect(m.state!.agents[0]!.totals.input).toBe(20);
  });

  it('reports zero for an agent that spent nothing in the window', async () => {
    const m = await monitorWith([limit()], [at(T0 - 4 * H, 999)], [agent('claude:s1')]);
    expect(m.state!.agents[0]!.totals.input).toBe(0);
  });

  it('keeps each agent’s spend to itself', async () => {
    const m = await monitorWith(
      [limit()],
      [at(T0 - H, 10, 'claude:s1'), at(T0 - H, 70, 'claude:s2')],
      [agent('claude:s1'), agent('claude:s2')],
    );
    const byId = new Map(m.state!.agents.map((a) => [a.id, a.totals.input]));
    expect(byId.get('claude:s1')).toBe(10);
    expect(byId.get('claude:s2')).toBe(70);
  });
});
