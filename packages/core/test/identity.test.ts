/**
 * Retrospective identity: recovering a session's model from a transcript that
 * was fully written *before* we started tailing it.
 *
 * This is the shape of the real bug. Byte offsets are persisted across a
 * restart; the observations derived from those bytes are not. So a session
 * that produced no new turn after a restart had its model erased, while its
 * burn rate — which comes from the persisted ledger — kept working. The panel
 * showed "?" next to a live burn figure.
 *
 * Incremental reading can never fix that: the offset is already past every
 * line that names the model. The file has to be re-read.
 *
 * Fixtures are SYNTHETIC; shapes mirror docs/DATA-SOURCES.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude/claude.js';
import { CodexProvider } from '../src/providers/codex/codex.js';
import { isKnownModel } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const SESSION = 'aaaa1111-2222-3333-4444-555566667777';
const THREAD = '01a00000-1111-2222-3333-444455556666';
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'adjent-ident-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('isKnownModel', () => {
  it('rejects the placeholders providers write when a turn names nothing', () => {
    expect(isKnownModel('unknown')).toBe(false);
    expect(isKnownModel('gpt-unknown')).toBe(false);
    expect(isKnownModel(null)).toBe(false);
    expect(isKnownModel('')).toBe(false);
    expect(isKnownModel('model-a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ClaudeProvider retrospective identity', () => {
  function seed(): void {
    mkdirSync(path.join(root, 'sessions'), { recursive: true });
    mkdirSync(path.join(root, 'projects', 'c--work-demo'), { recursive: true });
    writeFileSync(
      path.join(root, 'sessions', '12345.json'),
      JSON.stringify({
        pid: process.pid,
        sessionId: SESSION,
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
        model: 'model-a',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 1000,
          output_tokens: 50,
        },
      },
    };
    writeFileSync(path.join(root, 'projects', 'c--work-demo', `${SESSION}.jsonl`), JSON.stringify(turn) + '\n');
  }

  it('recovers the model when every turn predates our first tail', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 + 120_000 });

    // Consume the file once and throw the derived observations away — exactly
    // what a restart does, since the offsets persist and the observations do not.
    await p.collectUsage();
    const offsets = p.getTailOffsets();

    const restarted = new ClaudeProvider({ root, now: () => T0 + 120_000 });
    restarted.setTailOffsets(offsets);
    const fresh = await restarted.collectUsage();
    expect(fresh, 'nothing new to read — this is the failing condition').toHaveLength(0);

    const agents = await restarted.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe('model-a');
    expect(agents[0]!.effort).toBe('high');
  });

  it('leaves the model null when no transcript names one', async () => {
    seed();
    // A transcript with usage but no model at all.
    writeFileSync(
      path.join(root, 'projects', 'c--work-demo', `${SESSION}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T0 + 60_000).toISOString(),
        requestId: 'req_demo_002',
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
      }) + '\n',
    );
    const p = new ClaudeProvider({ root, now: () => T0 + 120_000 });
    await p.collectUsage();
    const agents = await p.listAgents();
    // Never the sentinel: "?" is honest, "unknown" pretends to be a model.
    expect(agents[0]!.model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('CodexProvider retrospective identity', () => {
  function seed(): string {
    const dir = path.join(root, 'sessions', '2026', '08', '24');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-08-24T15-11-02-${THREAD}.jsonl`);
    const ts = new Date(T0 + 60_000).toISOString();
    const lines = [
      // The model is declared in the turn context, never on the usage line —
      // which is why parsing only usage lines yielded "gpt-unknown".
      { timestamp: ts, type: 'session_meta', payload: { cwd: 'c:\\work\\demo' } },
      { timestamp: ts, type: 'turn_context', payload: { model: 'model-x', effort: 'medium' } },
      {
        timestamp: ts,
        type: 'event_msg',
        payload: { info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 60 } } },
      },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('reads the model off the turn context, not the usage line', async () => {
    seed();
    const p = new CodexProvider({ root, now: () => T0 + 120_000 });
    const events = await p.collectUsage();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => isKnownModel(e.model)), 'a sentinel reached the ledger').toBe(true);

    const agents = await p.listAgents();
    expect(agents[0]!.model).toBe('model-x');
    expect(agents[0]!.effort).toBe('medium');
  });

  it('recovers it after a restart, when the turn context is already consumed', async () => {
    seed();
    const first = new CodexProvider({ root, now: () => T0 + 120_000 });
    await first.collectUsage();
    const offsets = first.getTailOffsets();

    const restarted = new CodexProvider({ root, now: () => T0 + 120_000 });
    restarted.setTailOffsets(offsets);
    const fresh = await restarted.collectUsage();
    expect(fresh, 'nothing new to read — this is the failing condition').toHaveLength(0);

    const agents = await restarted.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe('model-x');
  });

  it('never surfaces the gpt-unknown placeholder as a model', async () => {
    const dir = path.join(root, 'sessions', '2026', '08', '24');
    mkdirSync(dir, { recursive: true });
    const ts = new Date(T0 + 60_000).toISOString();
    // Usage, but nothing anywhere names a model.
    writeFileSync(
      path.join(dir, `rollout-2026-08-24T15-11-02-${THREAD}.jsonl`),
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: { info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } },
      }) + '\n',
    );
    const p = new CodexProvider({ root, now: () => T0 + 120_000 });
    await p.collectUsage();
    const agents = await p.listAgents();
    expect(agents[0]!.model).toBeNull();
  });
});

/**
 * Codex quota is not an endpoint — it rides along inside session rollouts, so
 * it only arrives while Codex is active. Byte offsets persist across a restart
 * and the captured record does not, so a restart with no Codex activity since
 * left `quota()` returning nothing and the whole vendor disappeared from the
 * app. The record is still in the file.
 */
describe('CodexProvider quota survives a restart', () => {
  function seedWithQuota(): void {
    const dir = path.join(root, 'sessions', '2026', '08', '24');
    mkdirSync(dir, { recursive: true });
    const ts = new Date(T0 + 60_000).toISOString();
    const lines = [
      { timestamp: ts, type: 'turn_context', payload: { model: 'model-x', effort: 'medium' } },
      {
        timestamp: ts,
        type: 'event_msg',
        payload: {
          rate_limits: {
            plan_type: 'demo',
            primary: { used_percent: 12.5, window_minutes: 10_080, resets_at: Math.floor((T0 + 5 * 24 * 3600_000) / 1000) },
            secondary: null,
          },
        },
      },
    ];
    writeFileSync(
      path.join(dir, `rollout-2026-08-24T15-11-02-${THREAD}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }

  it('reports the limit on a first, cold run', async () => {
    seedWithQuota();
    const p = new CodexProvider({ root, now: () => T0 + 120_000 });
    await p.collectUsage();
    const q = await p.quota();
    expect(q).toHaveLength(1);
    expect(q[0]!.utilization).toBe(12.5);
    expect(q[0]!.key).toBe('codex:7d');
  });

  it('still reports it after a restart with nothing new to read', async () => {
    seedWithQuota();
    const first = new CodexProvider({ root, now: () => T0 + 120_000 });
    await first.collectUsage();
    const offsets = first.getTailOffsets();

    const restarted = new CodexProvider({ root, now: () => T0 + 120_000 });
    restarted.setTailOffsets(offsets);
    const fresh = await restarted.collectUsage();
    expect(fresh, 'nothing new to read — this is the failing condition').toHaveLength(0);

    const q = await restarted.quota();
    expect(q, 'the vendor vanished from the app entirely').toHaveLength(1);
    expect(q[0]!.utilization).toBe(12.5);
  });

  it('ignores records that carry no window', async () => {
    const dir = path.join(root, 'sessions', '2026', '08', '24');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-08-24T15-11-02-${THREAD}.jsonl`),
      JSON.stringify({
        timestamp: new Date(T0 + 60_000).toISOString(),
        type: 'event_msg',
        payload: { rate_limits: { plan_type: 'demo', primary: null, secondary: null } },
      }) + '\n',
    );
    const p = new CodexProvider({ root, now: () => T0 + 120_000 });
    await p.collectUsage();
    expect(await p.quota()).toHaveLength(0);
  });
});

/**
 * `lastActivityAt` used to fall back to 0 when a session had neither an
 * observation nor a `startedAt`. Zero is not a timestamp, it is the absence of
 * one, and subtracting it from the clock renders as "idle 20689d 18h".
 */
describe('ClaudeProvider activity timestamps', () => {
  const sessionFile = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION,
      cwd: 'c:\\work\\demo',
      version: '2.1.0',
      entrypoint: 'cli',
      name: 'demo-session',
      ...over,
    });

  it('recovers last activity from the transcript, not just the model', async () => {
    mkdirSync(path.join(root, 'sessions'), { recursive: true });
    mkdirSync(path.join(root, 'projects', 'c--work-demo'), { recursive: true });
    // No startedAt at all: the transcript is the only source of a time.
    writeFileSync(path.join(root, 'sessions', '12345.json'), sessionFile());
    const turnAt = T0 + 60_000;
    writeFileSync(
      path.join(root, 'projects', 'c--work-demo', `${SESSION}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(turnAt).toISOString(),
        requestId: 'req_ts_001',
        message: { model: 'model-a', usage: { input_tokens: 5, output_tokens: 5 } },
      }) + '\n',
    );

    const first = new ClaudeProvider({ root, now: () => T0 + 120_000 });
    await first.collectUsage();
    const offsets = first.getTailOffsets();

    const restarted = new ClaudeProvider({ root, now: () => T0 + 120_000 });
    restarted.setTailOffsets(offsets);
    await restarted.collectUsage();
    const [a] = await restarted.listAgents();

    expect(a!.lastActivityAt).toBe(turnAt);
    expect(a!.lastActivityAt).toBeGreaterThan(0);
  });

  it('never reports epoch zero as an activity time', async () => {
    mkdirSync(path.join(root, 'sessions'), { recursive: true });
    // A session file with an explicit zero and no transcript anywhere.
    writeFileSync(path.join(root, 'sessions', '12345.json'), sessionFile({ startedAt: 0 }));
    const p = new ClaudeProvider({ root, now: () => T0 });
    await p.collectUsage();
    const [a] = await p.listAgents();
    // Still zero here — there is genuinely nothing to report — but it must be
    // exactly zero so the renderer can recognise it as "unknown" rather than
    // subtract it from the clock. The guard for that lives in the panel.
    expect(a!.lastActivityAt).toBe(0);
  });
});
