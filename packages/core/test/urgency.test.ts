/**
 * Urgency ordering and per-vendor pricing.
 *
 * `compareUrgency` has to agree with the binding choice, or the collapsed list
 * reads as a second opinion rather than a continuation of the hero's ranking:
 * the fullest limit is not the most urgent one, and a list sorted by
 * utilization says otherwise.
 *
 * The fit is a property of one vendor's meter. Pricing an agent with another
 * vendor's weights produces a number that looks exactly as confident as a
 * correct one, which is why it is worth a test rather than a comment.
 */
import { describe, expect, it } from 'vitest';
import { compareUrgency } from '../src/quota/assess.js';
import { Monitor } from '../src/monitor.js';
import type { ProviderAdapter } from '../src/providers/provider.js';
import type { Agent, Backend, BackendId, LimitAssessment, QuotaLimit, UsageEvent } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const H = 3600_000;

const assessment = (over: Partial<LimitAssessment> & { util?: number } = {}): LimitAssessment => {
  const { util = 50, ...rest } = over;
  return {
    limit: {
      backend: 'claude',
      key: 'k',
      label: 'l',
      windowMinutes: 300,
      utilization: util,
      resetsAt: T0 + 5 * H,
      severity: null,
      vendorActive: false,
      scope: null,
      source: 'reported',
      observedAt: T0,
      ...(rest.limit ?? {}),
    },
    burn: null,
    verdict: 'on-pace',
    paceLinePct: null,
    exhaustsAt: null,
    binding: false,
    ...rest,
  } as LimitAssessment;
};

describe('compareUrgency', () => {
  it('puts a limit that runs out before it resets ahead of a fuller one that does not', () => {
    // 84% of a weekly limit with days left is less urgent than 60% of a 5-hour
    // limit running out in forty minutes — the whole point of the binding rule.
    const weekly = assessment({ util: 84 });
    const short = assessment({ util: 60, exhaustsAt: T0 + 40 * 60_000 });
    expect([weekly, short].sort(compareUrgency)[0]).toBe(short);
  });

  it('orders two at-risk limits by which runs out first', () => {
    const later = assessment({ util: 90, exhaustsAt: T0 + 4 * H });
    const sooner = assessment({ util: 20, exhaustsAt: T0 + H });
    expect([later, sooner].sort(compareUrgency)[0]).toBe(sooner);
  });

  it('falls back to fullest when nothing is projected to run out', () => {
    const a = assessment({ util: 20 });
    const b = assessment({ util: 71 });
    expect([a, b].sort(compareUrgency)[0]).toBe(b);
  });

  it('does not treat exhaustion after the reset as urgent', () => {
    // Runs out, but only after it has already reset — so it cannot stop you.
    const afterReset = assessment({ util: 10, exhaustsAt: T0 + 9 * H });
    const fuller = assessment({ util: 55 });
    expect([afterReset, fuller].sort(compareUrgency)[0]).toBe(fuller);
  });
});

// ---------------------------------------------------------------------------
function provider(id: BackendId, limits: QuotaLimit[], events: UsageEvent[], agents: Agent[]): ProviderAdapter {
  let served = false;
  return {
    id,
    supportedVersions: '*',
    async detect(): Promise<Backend> {
      return {
        id,
        displayName: id,
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

const limitFor = (backend: BackendId, util: number): QuotaLimit => ({
  backend,
  key: '5h',
  label: `${backend} 5h`,
  windowMinutes: 300,
  utilization: util,
  resetsAt: T0 + 2 * H,
  severity: null,
  vendorActive: false,
  scope: null,
  source: 'reported',
  observedAt: T0,
});

const agentFor = (backend: BackendId): Agent => ({
  id: `${backend}:s1`,
  backend,
  label: backend,
  projectPath: null,
  gitBranch: null,
  model: 'model-a',
  effort: null,
  entrypoint: null,
  parentId: null,
  pid: 1,
  state: 'live',
  startedAt: T0 - H,
  lastActivityAt: T0,
  totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
});

const eventFor = (backend: BackendId, ts: number, input: number): UsageEvent => ({
  ts,
  backend,
  agentId: `${backend}:s1`,
  model: 'model-a',
  effort: null,
  tokens: { input, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
  requests: 1,
  requestId: `${backend}-${ts}-${input}`,
});

describe('per-vendor pricing', () => {
  it('never prices an agent with another vendor’s fit', async () => {
    // Only Claude has usage the fit can learn from; Codex has an agent and a
    // limit but no history. Codex must therefore get no burn figure at all,
    // rather than one computed with Claude's weights.
    const m = new Monitor({
      providers: [
        provider('claude', [limitFor('claude', 40)], [eventFor('claude', T0 - H, 5000)], [agentFor('claude')]),
        provider('codex', [limitFor('codex', 10)], [], [agentFor('codex')]),
      ],
      store: null,
      now: () => T0,
    });
    await m.tick();
    const burns = m.state!.agentBurns.map((b) => b.agentId);
    expect(burns).not.toContain('codex:s1');
  });

  it('attaches exact tokens to every limit, not just the binding one', async () => {
    const m = new Monitor({
      providers: [
        provider('claude', [limitFor('claude', 40)], [eventFor('claude', T0 - H, 700)], [agentFor('claude')]),
        provider('codex', [limitFor('codex', 10)], [eventFor('codex', T0 - H, 300)], [agentFor('codex')]),
      ],
      store: null,
      now: () => T0,
    });
    await m.tick();
    const byBackend = new Map(m.state!.limits.map((a) => [a.limit.backend, a.tokens]));
    // Each limit counts only its own vendor's tokens.
    expect(byBackend.get('claude')?.input).toBe(700);
    expect(byBackend.get('codex')?.input).toBe(300);
  });
});
