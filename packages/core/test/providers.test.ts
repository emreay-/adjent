/**
 * Provider parsing tests against SYNTHETIC fixtures written to a temp dir.
 * Fixture values are invented; shapes mirror docs/DATA-SOURCES.md.
 * (CLAUDE.md: fixtures keep only the shape of real vendor files.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude/claude.js';
import { CodexProvider } from '../src/providers/codex/codex.js';
import { Monitor } from '../src/monitor.js';
import type { ProviderAdapter } from '../src/providers/provider.js';
import { DEFAULT_CONFIG } from '../src/rules/config.js';

const T0 = 1_700_000_000_000;
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'adjent-test-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('ClaudeProvider', () => {
  function seedClaude(): void {
    mkdirSync(path.join(root, 'sessions'), { recursive: true });
    mkdirSync(path.join(root, 'projects', 'c--work-demo'), { recursive: true });
    writeFileSync(
      path.join(root, 'sessions', '12345.json'),
      JSON.stringify({
        pid: process.pid, // our own pid → definitely alive
        sessionId: 'aaaa1111-2222-3333-4444-555566667777',
        cwd: 'c:\\work\\demo',
        startedAt: T0,
        version: '2.1.0',
        entrypoint: 'cli',
        name: 'demo-session',
      }),
    );
    const turn = {
      type: 'assistant',
      timestamp: new Date(T0 + 60_000).toISOString(),
      requestId: 'req_demo_001',
      effort: 'high',
      gitBranch: 'feature/demo',
      message: {
        model: 'model-x',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 50_000,
          output_tokens: 700,
          output_tokens_details: { thinking_tokens: 150 },
        },
        content: [{ type: 'text', text: 'THIS BODY MUST NEVER BE RETAINED' }],
      },
    };
    writeFileSync(
      path.join(root, 'projects', 'c--work-demo', 'aaaa1111-2222-3333-4444-555566667777.jsonl'),
      JSON.stringify(turn) + '\n',
    );
  }

  it('detects, lists agents, and collects deduped usage', async () => {
    seedClaude();
    const p = new ClaudeProvider({ root, now: () => T0 + 120_000 });
    expect(await p.detect()).not.toBeNull();

    const events = await p.collectUsage();
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens).toEqual({ input: 10, cacheWrite: 2000, cacheRead: 50_000, output: 700, thinking: 150 });
    expect(events[0]!.model).toBe('model-x');
    // metadata-only: no field of the event carries message content
    expect(JSON.stringify(events[0])).not.toContain('NEVER BE RETAINED');

    // Same line again (file restart) must not double-count.
    expect(await p.collectUsage()).toHaveLength(0);

    const agents = await p.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.label).toBe('demo-session');
    expect(agents[0]!.model).toBe('model-x');
    expect(agents[0]!.gitBranch).toBe('feature/demo');
    expect(agents[0]!.state).toBe('live');
  });

  it('parses quota from the usage endpoint shape, limits[] first', async () => {
    seedClaude();
    writeFileSync(
      path.join(root, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token', subscriptionType: 'demo-plan', rateLimitTier: 'demo-tier' } }),
    );
    const body = {
      five_hour: { utilization: 52, resets_at: new Date(T0 + 3 * 3600_000).toISOString() },
      seven_day: { utilization: 46, resets_at: new Date(T0 + 100 * 3600_000).toISOString() },
      limits: [
        { kind: 'session', group: 'session', percent: 52, severity: 'normal', resets_at: new Date(T0 + 3 * 3600_000).toISOString(), is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 46, severity: 'normal', resets_at: new Date(T0 + 100 * 3600_000).toISOString(), is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 84, severity: 'warning', resets_at: new Date(T0 + 100 * 3600_000).toISOString(), scope: { model: { display_name: 'Model X' } }, is_active: true },
      ],
    };
    const fetched: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(url));
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const p = new ClaudeProvider({ root, now: () => T0, fetchFn: fakeFetch });
    const q = await p.quota();
    expect(q).toHaveLength(3);
    const scoped = q.find((w) => w.vendorActive);
    expect(scoped?.utilization).toBe(84);
    expect(scoped?.scope).toBe('Model X');
    expect(scoped?.severity).toBe('warning');

    // Second call within a minute must be served from cache, not the network.
    await p.quota();
    expect(fetched).toHaveLength(1);
  });

  it('401 backs off and serves the stale snapshot', async () => {
    seedClaude();
    writeFileSync(
      path.join(root, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token' } }),
    );
    let calls = 0;
    let clock = T0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    const p = new ClaudeProvider({ root, now: () => clock, fetchFn: fakeFetch });
    await p.quota();
    clock += 90_000; // past MIN_POLL but inside backoff
    await p.quota();
    expect(calls).toBe(1);
  });

  it.each(['headers', 'body'])('a stalled %s read preserves stale quota and lets the next provider update', async (stage) => {
    seedClaude();
    writeFileSync(path.join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token' } }));
    vi.useFakeTimers();
    let clock = T0;
    let call = 0;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    const fetchFn = (async (_url, init) => {
      if (call++ === 0) return new Response(JSON.stringify({ five_hour: { utilization: 25 } }));
      signal = init?.signal ?? undefined;
      started();
      if (stage === 'headers') return new Promise<Response>(() => {});
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
    }) as typeof fetch;
    const claude = new ClaudeProvider({ root, now: () => clock, fetchFn });
    const fresh = await claude.quota();
    clock += 61_000;
    const next: ProviderAdapter = {
      id: 'codex', supportedVersions: 'synthetic',
      detect: async () => ({ id: 'codex', displayName: 'Codex', version: null, plan: null, rateLimitTier: null, health: 'ok', healthDetail: null }),
      collectUsage: async () => [], listAgents: async () => [],
      quota: vi.fn(async () => []), getTailOffsets: () => ({}), setTailOffsets: () => {},
    };
    const monitor = new Monitor({ providers: [claude, next], now: () => clock,
      store: null, config: { ...DEFAULT_CONFIG, rules: [] } });
    const tick = monitor.tick();
    await fetching;
    await vi.advanceTimersByTimeAsync(5_000);
    const state = await tick;
    expect(signal?.aborted).toBe(true);
    expect(next.quota).toHaveBeenCalledOnce();
    expect(state.limits[0]?.limit).toEqual(fresh[0]);
    expect(state.limits[0]?.limit.observedAt).toBe(T0);
    expect(state.backends.map((b) => b.id)).toEqual(['claude', 'codex']);
  });
});

// ---------------------------------------------------------------------------
describe('CodexProvider', () => {
  function seedCodex(nowIso: string): string {
    const day = path.join(root, 'sessions', '2024', '01', '15');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      path.join(root, 'session_index.jsonl'),
      JSON.stringify({ id: 'bbbb2222-3333-4444-5555-666677778888', thread_name: 'Demo thread', updated_at: nowIso }) + '\n',
    );
    const rollout = path.join(day, `rollout-2024-01-15T10-00-00-bbbb2222-3333-4444-5555-666677778888.jsonl`);
    const usageLine = {
      timestamp: nowIso,
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-demo',
          token_usage: { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 450, reasoning_output_tokens: 200 },
        },
        rate_limits: {
          limit_id: 'demo',
          primary: { used_percent: 64, window_minutes: 10_080, resets_at: Math.floor((T0 + 40 * 3600_000) / 1000) },
          secondary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor((T0 + 2 * 3600_000) / 1000) },
          plan_type: 'demo-plan',
        },
      },
    };
    writeFileSync(rollout, JSON.stringify(usageLine) + '\n');
    return rollout;
  }

  it('collects usage, captures rate limits, and reports quota', async () => {
    const nowIso = new Date(T0).toISOString();
    seedCodex(nowIso);
    const p = new CodexProvider({ root, now: () => T0 });

    const events = await p.collectUsage();
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens.cacheRead).toBe(8000);
    expect(events[0]!.tokens.input).toBe(1000); // input minus cached
    expect(events[0]!.model).toBe('gpt-demo');

    const q = await p.quota();
    expect(q).toHaveLength(2);
    const weekly = q.find((w) => w.key === 'codex:7d');
    expect(weekly?.utilization).toBe(64);
    expect(weekly?.resetsAt).toBe((Math.floor((T0 + 40 * 3600_000) / 1000)) * 1000);

    const agents = await p.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.label).toBe('Demo thread');
  });

  it('appended lines are picked up incrementally', async () => {
    const nowIso = new Date(T0).toISOString();
    const rollout = seedCodex(nowIso);
    const p = new CodexProvider({ root, now: () => T0 });
    expect(await p.collectUsage()).toHaveLength(1);

    appendFileSync(
      rollout,
      JSON.stringify({
        timestamp: new Date(T0 + 60_000).toISOString(),
        payload: { type: 'token_count', info: { token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100 } } },
      }) + '\n',
    );
    const more = await p.collectUsage();
    expect(more).toHaveLength(1);
    expect(more[0]!.tokens.output).toBe(100);
  });
});
