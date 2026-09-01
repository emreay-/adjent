/**
 * The advisory gate.
 *
 * Its defining property is what it does not do: it signals no process and
 * stops nothing. So the tests are about the file's semantics — what a hold
 * means, when it stops meaning it, and which way it fails.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GATE_SCHEMA_VERSION, OPEN, coerceGate, describeGate, readGate, writeGate } from '../src/api/gate.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adjent-gate-'));
  file = path.join(dir, 'gate.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reading a gate', () => {
  it('is open when no file exists', async () => {
    const g = await readGate(T0, file);
    expect(g.held).toBe(false);
  });

  /**
   * The direction of failure is a decision, not an accident. A gate that
   * failed *closed* would halt an orchestrator because a JSON file got
   * truncated — a worse outcome than not holding, since the signal is advisory
   * and one that cannot be read has nothing to advise.
   */
  it('is open when the file is corrupt', async () => {
    writeFileSync(file, '{ not json');
    expect((await readGate(T0, file)).held).toBe(false);
  });

  it('is open when the file is a JSON value that is not an object', async () => {
    writeFileSync(file, '"held"');
    expect((await readGate(T0, file)).held).toBe(false);
  });

  it('round-trips a hold', async () => {
    await writeGate(
      { schemaVersion: GATE_SCHEMA_VERSION, held: true, reason: 'deploying', until: null, at: T0, source: 'human', ruleId: null },
      file,
    );
    const g = await readGate(T0 + MIN, file);
    expect(g.held).toBe(true);
    expect(g.reason).toBe('deploying');
    expect(g.source).toBe('human');
  });
});

describe('a hold with an expiry', () => {
  const withUntil = (until: number) => ({
    schemaVersion: GATE_SCHEMA_VERSION,
    held: true,
    reason: 'brief pause',
    until,
    at: T0,
    source: 'human' as const,
    ruleId: null,
  });

  it('still holds before it expires', async () => {
    await writeGate(withUntil(T0 + 30 * MIN), file);
    expect((await readGate(T0 + 10 * MIN, file)).held).toBe(true);
  });

  it('stops holding once it expires, with no one having to release it', async () => {
    await writeGate(withUntil(T0 + 30 * MIN), file);
    expect((await readGate(T0 + 31 * MIN, file)).held).toBe(false);
  });

  it('does not rewrite the file to expire it', async () => {
    // Reading must never require write access: a script running as another
    // user, or from a read-only mount, still needs an answer.
    await writeGate(withUntil(T0 + 30 * MIN), file);
    const before = (await import('node:fs')).readFileSync(file, 'utf-8');
    await readGate(T0 + 99 * MIN, file);
    expect((await import('node:fs')).readFileSync(file, 'utf-8')).toBe(before);
  });

  it('reports an expired hold with no stale reason attached', async () => {
    await writeGate(withUntil(T0 + MIN), file);
    const g = await readGate(T0 + 99 * MIN, file);
    expect(g.reason).toBeNull();
    expect(g.until).toBeNull();
  });
});

describe('coerceGate', () => {
  it('treats a missing held flag as open', () => {
    expect(coerceGate({ reason: 'x' }, T0).held).toBe(false);
  });

  it('keeps an unknown source out of the typed field', () => {
    expect(coerceGate({ held: true, source: 'aliens' }, T0).source).toBe('human');
  });

  it('records a rule as the source when it says so', () => {
    const g = coerceGate({ held: true, source: 'rule', ruleId: 'pace-any' }, T0);
    expect(g.source).toBe('rule');
    expect(g.ruleId).toBe('pace-any');
  });
});

describe('describeGate', () => {
  it('says open plainly', () => {
    expect(describeGate({ ...OPEN }, T0)).toBe('open');
  });

  it('gives the reason and the time left', () => {
    const text = describeGate(
      { ...OPEN, held: true, reason: 'deploying', until: T0 + 20 * MIN, at: T0 },
      T0,
    );
    expect(text).toContain('held');
    expect(text).toContain('deploying');
    expect(text).toContain('20m left');
  });

  it('names the rule when a rule set it', () => {
    const text = describeGate({ ...OPEN, held: true, source: 'rule', ruleId: 'runaway-agent', at: T0 }, T0);
    expect(text).toContain('runaway-agent');
  });
});
