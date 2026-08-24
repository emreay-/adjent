/**
 * The snapshot is an API, so this file is a contract, not a unit test.
 *
 * The key sets below are golden on purpose: deleting or renaming a published
 * field must fail here loudly, because the alternative is finding out from
 * somebody's broken orchestrator. Adding a field is allowed within a
 * `schemaVersion` — so a new key fails this test too, and the fix is to add it
 * to the list *and* to docs/API.md in the same commit.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SCHEMA_VERSION, toSnapshot } from '../src/api/snapshot.js';
import { machineId } from '../src/api/machineid.js';
import type { AppState } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const H = 3600_000;
const MACHINE = '11111111-2222-4333-8444-555555555555';

function state(over: Partial<AppState> = {}): AppState {
  return {
    generatedAt: T0,
    backends: [
      {
        id: 'claude',
        displayName: 'Claude Code',
        version: '2.1.0',
        plan: 'demo',
        rateLimitTier: 'demo_tier',
        health: 'ok',
        healthDetail: null,
      },
    ],
    agents: [
      {
        id: 'claude:a1',
        backend: 'claude',
        label: 'demo',
        projectPath: '/w/demo',
        gitBranch: 'main',
        model: 'model-x',
        effort: 'high',
        entrypoint: 'cli',
        parentId: null,
        pid: 1,
        state: 'live',
        startedAt: T0 - H,
        lastActivityAt: T0,
        totals: { input: 100, cacheWrite: 10, cacheRead: 1000, output: 50, thinking: 5 },
      },
    ],
    limits: [
      {
        limit: {
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
        },
        burn: { pctPerHour: 8.1, updatedAt: T0 },
        verdict: 'on-pace',
        paceLinePct: 40,
        exhaustsAt: T0 + 8 * H,
        binding: true,
        tokens: { input: 100, cacheWrite: 10, cacheRead: 1000, output: 50 },
      },
    ],
    agentBurns: [{ agentId: 'claude:a1', pctPerHour: 4.2, confidence: 'high' }],
    epsilon: 0.5,
    fitConfidence: 'high',
    ...over,
  };
}

// --------------------------------------------------------------- the contract
const SNAPSHOT_KEYS = [
  'schemaVersion',
  'machineId',
  'generatedAt',
  'backends',
  'limits',
  'agents',
  'epsilon',
  'fitConfidence',
  'provenance',
];

const BACKEND_KEYS = ['id', 'displayName', 'version', 'plan', 'rateLimitTier', 'health', 'healthDetail'];

const LIMIT_KEYS = [
  'backend',
  'key',
  'label',
  'windowMinutes',
  'utilization',
  'resetsAt',
  'severity',
  'scope',
  'bindingLimit',
  'verdict',
  'paceLinePct',
  'exhaustsAt',
  'burnPctPerHour',
  'tokens',
  'observedAt',
  'provenance',
];

const AGENT_KEYS = [
  'id',
  'backend',
  'label',
  'projectPath',
  'gitBranch',
  'model',
  'effort',
  'entrypoint',
  'state',
  'startedAt',
  'lastActivityAt',
  'burnPctPerHour',
  'tokens',
  'provenance',
];

const TOKEN_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'];

describe('snapshot contract', () => {
  const snap = () => toSnapshot(state(), { machineId: MACHINE });

  it('publishes exactly the documented top-level keys', () => {
    expect(Object.keys(snap()).sort()).toEqual([...SNAPSHOT_KEYS].sort());
  });

  it('publishes exactly the documented keys on every nested object', () => {
    const s = snap();
    expect(Object.keys(s.backends[0]!).sort()).toEqual([...BACKEND_KEYS].sort());
    expect(Object.keys(s.limits[0]!).sort()).toEqual([...LIMIT_KEYS].sort());
    expect(Object.keys(s.agents[0]!).sort()).toEqual([...AGENT_KEYS].sort());
    expect(Object.keys(s.limits[0]!.tokens!).sort()).toEqual([...TOKEN_KEYS].sort());
    expect(Object.keys(s.agents[0]!.tokens).sort()).toEqual([...TOKEN_KEYS].sort());
  });

  it('pins the schema version', () => {
    expect(snap().schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('uses the glossary spelling, not a synonym', () => {
    const limit = snap().limits[0]!;
    // `bindingLimit`, not `binding`; `burnPctPerHour`, not `burn` or `rate`.
    expect(limit.bindingLimit).toBe(true);
    expect(limit.burnPctPerHour).toBe(8.1);
    expect(limit).not.toHaveProperty('binding');
    expect(limit).not.toHaveProperty('burn');
    expect(limit).not.toHaveProperty('window');
  });

  it('carries provenance as data, keyed by the fields it describes', () => {
    const s = snap();
    // Measured by the vendor; modelled by us; counted from transcripts.
    expect(s.limits[0]!.provenance).toMatchObject({
      utilization: 'reported',
      burnPctPerHour: 'reported',
      exhaustsAt: 'derived',
      tokens: 'exact',
    });
    expect(s.agents[0]!.provenance).toMatchObject({ burnPctPerHour: 'derived', tokens: 'exact' });
    expect(s.provenance).toMatchObject({ epsilon: 'derived' });
    // Every provenance key names a field that is actually present.
    for (const k of Object.keys(s.limits[0]!.provenance)) expect(s.limits[0]!).toHaveProperty(k);
    for (const k of Object.keys(s.agents[0]!.provenance)) expect(s.agents[0]!).toHaveProperty(k);
  });

  it('omits provenance for a number it did not produce', () => {
    const s = toSnapshot(
      state({ epsilon: null, limits: [{ ...state().limits[0]!, burn: null, exhaustsAt: null, tokens: null }] }),
      { machineId: MACHINE },
    );
    expect(s.limits[0]!.provenance).not.toHaveProperty('burnPctPerHour');
    expect(s.limits[0]!.provenance).not.toHaveProperty('exhaustsAt');
    expect(s.provenance).not.toHaveProperty('epsilon');
  });

  it('never publishes a placeholder model', () => {
    const s = toSnapshot(state({ agents: [{ ...state().agents[0]!, model: 'gpt-unknown' }] }), {
      machineId: MACHINE,
    });
    expect(s.agents[0]!.model).toBeNull();
  });

  it('reports an absent timestamp as null, never as epoch zero', () => {
    const s = toSnapshot(state({ agents: [{ ...state().agents[0]!, startedAt: 0, lastActivityAt: 0 }] }), {
      machineId: MACHINE,
    });
    expect(s.agents[0]!.startedAt).toBeNull();
    expect(s.agents[0]!.lastActivityAt).toBeNull();
  });

  it('is a projection: mutating it cannot reach back into the state', () => {
    const st = state();
    const s = toSnapshot(st, { machineId: MACHINE });
    s.limits[0]!.tokens!.input = 999_999;
    s.agents[0]!.tokens.input = 999_999;
    expect(st.limits[0]!.tokens!.input).toBe(100);
    expect(st.agents[0]!.totals.input).toBe(100);
  });

  it('survives an empty state without inventing anything', () => {
    const s = toSnapshot(
      { generatedAt: T0, backends: [], agents: [], limits: [], agentBurns: [], epsilon: null, fitConfidence: 'low' },
      { machineId: MACHINE },
    );
    expect(s.limits).toEqual([]);
    expect(s.agents).toEqual([]);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.machineId).toBe(MACHINE);
  });
});

// ------------------------------------------------------------------ machineId
describe('machineId', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'adjent-mid-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints one when nothing is stored, and reuses it after', async () => {
    const first = await machineId(dir);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await machineId(dir)).toBe(first);
  });

  it('persists it to machine.json and nowhere else', async () => {
    const id = await machineId(dir);
    expect(readdirSync(dir)).toEqual(['machine.json']);
    expect(JSON.parse(readFileSync(path.join(dir, 'machine.json'), 'utf-8')).machineId).toBe(id);
  });

  it('re-mints from a corrupt file rather than throwing', async () => {
    writeFileSync(path.join(dir, 'machine.json'), '{ not json');
    const id = await machineId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // And the repaired file is reused from then on.
    expect(await machineId(dir)).toBe(id);
  });

  it('re-mints when the stored value is not an id', async () => {
    writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ version: 1, machineId: 'my-laptop' }));
    expect(await machineId(dir)).not.toBe('my-laptop');
  });

  it('is not derived from anything identifying', async () => {
    const id = await machineId(dir);
    // A UUIDv4 has no room for a hostname or user name; assert the shape that
    // guarantees that rather than trying to prove a negative about content.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ------------------------------------------------------------ the documented example
/**
 * docs/API.md is the contract consumers actually read, so a payload documented
 * there and never emitted is worse than no documentation at all. This parses
 * the example straight out of the markdown and diffs its shape against what
 * the code produces — the doc cannot drift without failing here.
 */
describe('docs/API.md matches what the code emits', () => {
  const API_MD = path.join(__dirname, '..', '..', '..', 'docs', 'API.md');

  /** First fenced ```json block in the document — the snapshot example. */
  function documentedExample(): Record<string, unknown> {
    const md = readFileSync(API_MD, 'utf-8');
    const m = /```json\n([\s\S]*?)```/.exec(md);
    expect(m, 'docs/API.md has no fenced json example').not.toBeNull();
    return JSON.parse(m![1]!) as Record<string, unknown>;
  }

  /** Recursive key shape: sorted keys per object path, arrays folded to [0]. */
  function shape(v: unknown, at = '$', out: Record<string, string[]> = {}): Record<string, string[]> {
    if (Array.isArray(v)) {
      if (v.length > 0) shape(v[0], `${at}[]`, out);
    } else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out[at] = Object.keys(o).sort();
      for (const k of Object.keys(o)) shape(o[k], `${at}.${k}`, out);
    }
    return out;
  }

  it('documents every key the snapshot emits, and no key it does not', () => {
    const documented = shape(documentedExample());
    const emitted = shape(toSnapshot(state(), { machineId: MACHINE }));

    // Provenance maps are keyed by field name and vary per object, so compare
    // them as a set of paths rather than demanding identical contents.
    const strip = (o: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => !k.includes('provenance')));

    expect(strip(documented)).toEqual(strip(emitted));
  });

  it('documents the same provenance values the code assigns', () => {
    const doc = documentedExample() as { limits: { provenance: unknown }[]; agents: { provenance: unknown }[] };
    const live = toSnapshot(state(), { machineId: MACHINE });
    expect(doc.limits[0]!.provenance).toEqual(live.limits[0]!.provenance);
    expect(doc.agents[0]!.provenance).toEqual(live.agents[0]!.provenance);
  });

  it('pins the schemaVersion in the prose as well as the code', () => {
    expect((documentedExample() as { schemaVersion: number }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('documents the exit-code table the CLI is required to use', () => {
    const md = readFileSync(API_MD, 'utf-8');
    // The table is a contract for scripts; losing a row silently would be worse
    // than losing a field, because nothing type-checks an exit code.
    for (const code of [0, 1, 2, 3, 4, 5, 6]) {
      expect(md, `exit code ${code} is undocumented`).toMatch(new RegExp(`^\| ${code} \|`, 'm'));
    }
  });
});
