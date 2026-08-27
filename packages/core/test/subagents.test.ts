/**
 * Subagent attribution.
 *
 * GLOSSARY: an **Agent** is one session you started, and its subagents are part
 * of it rather than agents beside it — one row, one live count, one burn
 * figure, and the tokens counted exactly once at the parent. That is a product
 * decision with reasons (a header count that jumps 3 → 9 → 3 is noise), and
 * nothing here weakens it.
 *
 * But "which subagent produced this turn" is a distinction the `anomaly`
 * detector cannot work without: a looping subagent emits near-identical turns,
 * and merging them with the parent's varied ones makes the pair look like
 * neither. So `UsageEvent.subId` carries that identity as a **detection label**.
 *
 * The tests below are therefore of two kinds: the label is present and stable,
 * and the label has not leaked into anything that counts.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude/claude.js';

const T0 = 1_700_000_000_000;
const SESSION = 'aaaa1111-2222-3333-4444-555566667777';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'adjent-subagents-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const turn = (i: number, model = 'model-x') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(T0 + i * 1000).toISOString(),
    requestId: `req_${i}`,
    message: {
      model,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
        output_tokens: 20,
      },
      content: [{ type: 'text', text: 'BODY THAT MUST NOT BE RETAINED' }],
    },
  }) + '\n';

/** A session with its own turns plus two subagents, each with their own file. */
function seed(): void {
  const slug = path.join(root, 'projects', 'synthetic-slug');
  mkdirSync(slug, { recursive: true });
  // the parent's own transcript
  writeFileSync(path.join(slug, `${SESSION}.jsonl`), turn(1));

  // projects/<slug>/<sessionId>/subagents/**/agent-*.jsonl
  const subs = path.join(slug, SESSION, 'subagents');
  mkdirSync(path.join(subs, 'nested'), { recursive: true });
  writeFileSync(path.join(subs, 'agent-alpha.jsonl'), turn(2));
  writeFileSync(path.join(subs, 'nested', 'agent-beta.jsonl'), turn(3));
}

describe('subagent turns carry their own detection label', () => {
  it('labels each subagent distinctly and leaves the parent null', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    const events = await p.collectUsage();

    expect(events).toHaveLength(3);
    // Array.sort() stringifies, which would put null last; compare as a set.
    const labels = new Set(events.map((e) => e.subId ?? null));
    expect(labels).toEqual(new Set([null, 'agent-alpha', 'nested/agent-beta']));
  });

  it('uses forward slashes regardless of platform, so one subagent reads as one', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    const events = await p.collectUsage();
    const nested = events.find((e) => e.subId?.includes('beta'));
    expect(nested?.subId).toBe('nested/agent-beta');
    expect(nested?.subId).not.toContain('\\');
  });

  it('carries nothing about the machine it came from', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    const events = await p.collectUsage();
    // The label is relative to the subagents directory: an absolute path would
    // put the user's home directory into ~/.adjent/ledger.jsonl.
    for (const e of events) {
      expect(e.subId ?? '').not.toContain(root);
      expect(e.subId ?? '').not.toContain(path.sep === '\\' ? 'C:' : '/home');
    }
  });
});

describe('the label is not an identity', () => {
  it('every turn is still attributed to the one parent session', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    const events = await p.collectUsage();

    // The invariant GLOSSARY protects: subagents do not become agents.
    expect(new Set(events.map((e) => e.agentId))).toEqual(new Set([`claude:${SESSION}`]));
  });

  it('the session is one agent, not three', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    await p.collectUsage();
    const agents = await p.listAgents();

    // No session file, so no live agent is listed — the point is that nothing
    // invented one per subagent either.
    expect(agents.filter((a) => a.id.includes('agent-alpha'))).toHaveLength(0);
    expect(agents.length).toBeLessThanOrEqual(1);
  });

  it('tokens are counted once, at the parent — not once per level', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    const events = await p.collectUsage();

    // Three turns of 10 input each: 30. Double-counting subagent turns at both
    // the subagent and the parent would read 50, and would show up as a
    // permanent gap against the vendor's own number (GLOSSARY: the free
    // consistency check).
    const input = events.reduce((n, e) => n + e.tokens.input, 0);
    expect(input).toBe(30);
  });

  it('still retains no message content', async () => {
    seed();
    const p = new ClaudeProvider({ root, now: () => T0 });
    const events = await p.collectUsage();
    expect(JSON.stringify(events)).not.toContain('MUST NOT BE RETAINED');
  });
});
