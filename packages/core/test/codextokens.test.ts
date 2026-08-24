/**
 * Codex turn accounting.
 *
 * A rollout carries two usage objects that mean opposite things:
 * `last_token_usage` is one turn's cost, `total_token_usage` is the session's
 * running total. Summing the cumulative one across n turns counts the session
 * roughly n²/2 times — a week of ordinary use reported 1.46 *trillion* tokens.
 *
 * These tests pin the distinction, because nothing downstream can detect it:
 * an inflated ledger produces confident burn rates, a confident fit, and a
 * token line that is simply wrong by three orders of magnitude.
 *
 * Fixtures are SYNTHETIC; shapes mirror docs/DATA-SOURCES.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodexProvider } from '../src/providers/codex/codex.js';
import { UsageLedger } from '../src/quota/ledger.js';
import type { UsageEvent } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const THREAD = '01a00000-1111-2222-3333-444455556666';
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'adjent-codex-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a rollout whose turns are described by `mk`, one line per turn. */
function rollout(lines: unknown[]): void {
  const dir = path.join(root, 'sessions', '2026', '08', '24');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `rollout-2026-08-24T15-11-02-${THREAD}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

const turnLine = (minute: number, usage: Record<string, unknown>) => ({
  timestamp: new Date(T0 + minute * 60_000).toISOString(),
  type: 'event_msg',
  payload: { info: usage },
});

const sum = (evs: { tokens: { input: number; cacheRead: number; output: number } }[]) =>
  evs.reduce((n, e) => n + e.tokens.input + e.tokens.cacheRead + e.tokens.output, 0);

describe('Codex turn tokens', () => {
  it('uses the per-turn delta when the vendor gives one', async () => {
    // Both objects present, as they are in a real rollout. Deltas: 100, 50, 25.
    rollout([
      { timestamp: new Date(T0).toISOString(), type: 'turn_context', payload: { model: 'model-x' } },
      turnLine(1, {
        last_token_usage: { input_tokens: 100, output_tokens: 0 },
        total_token_usage: { input_tokens: 100, output_tokens: 0 },
      }),
      turnLine(2, {
        last_token_usage: { input_tokens: 50, output_tokens: 0 },
        total_token_usage: { input_tokens: 150, output_tokens: 0 },
      }),
      turnLine(3, {
        last_token_usage: { input_tokens: 25, output_tokens: 0 },
        total_token_usage: { input_tokens: 175, output_tokens: 0 },
      }),
    ]);
    const p = new CodexProvider({ root, now: () => T0 + 10 * 60_000 });
    const evs = await p.collectUsage();

    // The session spent 175 tokens. Summing the cumulative field would give 425.
    expect(sum(evs)).toBe(175);
    expect(evs.map((e) => e.tokens.input)).toEqual([100, 50, 25]);
  });

  it('differences the running total when that is all there is', async () => {
    rollout([
      { timestamp: new Date(T0).toISOString(), type: 'turn_context', payload: { model: 'model-x' } },
      turnLine(1, { total_token_usage: { input_tokens: 23_055, output_tokens: 0 } }),
      turnLine(2, { total_token_usage: { input_tokens: 46_731, output_tokens: 0 } }),
      turnLine(3, { total_token_usage: { input_tokens: 82_916, output_tokens: 0 } }),
    ]);
    const p = new CodexProvider({ root, now: () => T0 + 10 * 60_000 });
    const evs = await p.collectUsage();

    expect(evs.map((e) => e.tokens.input)).toEqual([23_055, 23_676, 36_185]);
    // Equals the last cumulative figure, which is the point.
    expect(sum(evs)).toBe(82_916);
  });

  it('does not go negative when a thread is compacted and the total drops', async () => {
    rollout([
      { timestamp: new Date(T0).toISOString(), type: 'turn_context', payload: { model: 'model-x' } },
      turnLine(1, { total_token_usage: { input_tokens: 90_000, output_tokens: 0 } }),
      // Compaction: the running total restarts lower than it was.
      turnLine(2, { total_token_usage: { input_tokens: 1_200, output_tokens: 0 } }),
      turnLine(3, { total_token_usage: { input_tokens: 3_000, output_tokens: 0 } }),
    ]);
    const p = new CodexProvider({ root, now: () => T0 + 10 * 60_000 });
    const evs = await p.collectUsage();

    expect(evs.every((e) => e.tokens.input >= 0), 'a turn cost negative tokens').toBe(true);
    expect(evs.map((e) => e.tokens.input)).toEqual([90_000, 1_200, 1_800]);
  });

  it('keeps the cumulative cursor per thread', async () => {
    const dir = path.join(root, 'sessions', '2026', '08', '24');
    mkdirSync(dir, { recursive: true });
    const other = '01a00000-9999-8888-7777-666655554444';
    for (const [id, totals] of [
      [THREAD, [1000, 1500]],
      [other, [700, 900]],
    ] as const) {
      writeFileSync(
        path.join(dir, `rollout-2026-08-24T15-11-02-${id}.jsonl`),
        [
          { timestamp: new Date(T0).toISOString(), type: 'turn_context', payload: { model: 'model-x' } },
          ...totals.map((v, i) => turnLine(i + 1, { total_token_usage: { input_tokens: v, output_tokens: 0 } })),
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
      );
    }
    const p = new CodexProvider({ root, now: () => T0 + 10 * 60_000 });
    const evs = await p.collectUsage();
    const byThread = new Map<string, number>();
    for (const e of evs) byThread.set(e.agentId, (byThread.get(e.agentId) ?? 0) + e.tokens.input);

    // Each thread's own last total — neither differenced against the other.
    expect(byThread.get(`codex:${THREAD}`)).toBe(1500);
    expect(byThread.get(`codex:${other}`)).toBe(900);
  });

  it('splits cached reads out of the input total', async () => {
    rollout([
      { timestamp: new Date(T0).toISOString(), type: 'turn_context', payload: { model: 'model-x' } },
      turnLine(1, {
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
      }),
    ]);
    const p = new CodexProvider({ root, now: () => T0 + 10 * 60_000 });
    const [ev] = await p.collectUsage();

    // input_tokens includes the cached portion; they are metered differently.
    expect(ev!.tokens.input).toBe(200);
    expect(ev!.tokens.cacheRead).toBe(800);
    expect(ev!.tokens.output).toBe(50);
  });
});

/**
 * A cold start hands the ledger everything at once. `push(...evs)` passes each
 * element as an argument and V8 overflows the stack above roughly a hundred
 * thousand of them — which threw RangeError on a real Codex history, and the
 * caller could only conclude the whole provider was broken. By then the byte
 * offsets had advanced, so the events were unrecoverable: the vendor simply
 * had no usage data, permanently and silently.
 */
describe('UsageLedger with a cold-start batch', () => {
  const bulk = (n: number): UsageEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      ts: T0 + i,
      backend: 'codex' as const,
      agentId: 'codex:a',
      model: 'model-x',
      effort: null,
      tokens: { input: 1, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
      requests: 1,
      requestId: `bulk-${i}`,
    }));

  it('accepts a batch far larger than the argument limit', () => {
    const l = new UsageLedger();
    expect(() => l.add(bulk(200_000))).not.toThrow();
    expect(l.size).toBeGreaterThan(0);
  });

  it('keeps every event of a large batch queryable', () => {
    const l = new UsageLedger();
    const n = 150_000;
    l.add(bulk(n));
    expect(l.slice(T0 - 1, T0 + n).length).toBe(n);
  });
});
