/**
 * The advisory gate — a hold/open signal an orchestrator reads before starting
 * more work.
 *
 * This is the whole of Adjent's "control" story, and its most important
 * property is what it does *not* do. It signals no process, stops nothing, and
 * kills nothing. It writes one small file under `~/.adjent/`, and a wrapper
 * script or orchestrator you control decides whether to honour it. The decision
 * and the enforcement stay in your code — see
 * [What Adjent will not do](../../../../README.md#what-adjent-will-not-do)
 * and §4 Q1 of the internal plan, where that boundary was settled.
 *
 * Deliberately inert, and still the only thing in the surveyed field that
 * answers "may I launch five more workers?" with something a shell can branch
 * on.
 *
 * **A held gate is a predicate failure, not a new kind of outcome.** `adjent
 * check` reports it through the same exit code as any other unmet condition
 * (4, `PREDICATE_FAILED`), because to a caller asking "may I start work?" the
 * answer is the same "no" — docs/API.md freezes that table, and reusing the
 * code is a restatement of an existing meaning rather than a new one.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Bumped only for a breaking change to this file's shape. It is its own
 * version, not the snapshot's: the two are read by different consumers and
 * have no reason to move together.
 */
export const GATE_SCHEMA_VERSION = 1;

export interface GateState {
  schemaVersion: number;
  /** True while work should be held. */
  held: boolean;
  /** Why, in the holder's own words. Null when open, or when none was given. */
  reason: string | null;
  /**
   * Epoch ms after which the hold stops applying, or null for "until released".
   * An expired hold reads as open rather than being rewritten: reading must
   * never require write access, so the file is not repaired on read.
   */
  until: number | null;
  /** When this state was written. */
  at: number;
  /**
   * What set it: a person at a terminal, or a rule. Recorded because the two
   * are governed differently — a rule may only set the gate when
   * `settings.actions.enabled` is on, while a human is never gated.
   */
  source: 'human' | 'rule';
  /** The rule that set it, when `source` is 'rule'. */
  ruleId: string | null;
}

export const OPEN: GateState = {
  schemaVersion: GATE_SCHEMA_VERSION,
  held: false,
  reason: null,
  until: null,
  at: 0,
  source: 'human',
  ruleId: null,
};

export const gatePath = (): string => path.join(os.homedir(), '.adjent', 'gate.json');

const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Read a gate state, tolerantly.
 *
 * A missing, unreadable or malformed file means **open**. That direction is
 * deliberate: a gate that fails closed would silently halt an orchestrator
 * because a JSON file got truncated, which is a worse failure than not holding
 * — Adjent is advisory, and an advisory signal that cannot be read has nothing
 * to advise.
 */
export function coerceGate(raw: unknown, now: number): GateState {
  const o = asObj(raw);
  if (!o) return { ...OPEN };
  const until = typeof o['until'] === 'number' ? o['until'] : null;
  const held = o['held'] === true && (until === null || until > now);
  return {
    schemaVersion: typeof o['schemaVersion'] === 'number' ? o['schemaVersion'] : GATE_SCHEMA_VERSION,
    held,
    reason: held && typeof o['reason'] === 'string' && o['reason'] !== '' ? o['reason'] : null,
    until: held ? until : null,
    at: typeof o['at'] === 'number' ? o['at'] : 0,
    source: o['source'] === 'rule' ? 'rule' : 'human',
    ruleId: typeof o['ruleId'] === 'string' ? o['ruleId'] : null,
  };
}

export async function readGate(now: number, file: string = gatePath()): Promise<GateState> {
  try {
    return coerceGate(JSON.parse(await fs.readFile(file, 'utf-8')), now);
  } catch {
    return { ...OPEN };
  }
}

/** Write atomically, the way every other file under ~/.adjent/ is written. */
export async function writeGate(state: GateState, file: string = gatePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), 'utf-8');
  await fs.rename(tmp, file);
}

/** One line describing the gate, shared by the CLI and any other surface. */
export function describeGate(g: GateState, now: number): string {
  if (!g.held) return 'open';
  const bits: string[] = ['held'];
  if (g.reason) bits.push(`— ${g.reason}`);
  if (g.until !== null) {
    const mins = Math.max(0, Math.round((g.until - now) / 60_000));
    bits.push(mins >= 60 ? `(${Math.round(mins / 60)}h left)` : `(${mins}m left)`);
  }
  if (g.source === 'rule' && g.ruleId) bits.push(`[rule ${g.ruleId}]`);
  return bits.join(' ');
}
