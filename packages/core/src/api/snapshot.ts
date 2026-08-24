/**
 * The published snapshot — Adjent's API surface.
 *
 * A *projection* of `AppState`, never an alias for it. The internal model must
 * stay free to move; anything that has escaped this module is a promise to
 * consumers, so the two are deliberately separate types with a pure function
 * between them (docs/API.md).
 *
 * Three rules hold this shape together:
 *
 * 1. **Provenance is data, not decoration.** Every object carrying numbers
 *    carries `provenance` keyed by its own numeric field names. A consumer
 *    renders `≈` from that map; it never string-matches a rendered value, and
 *    it never has to guess whether a figure was measured or modelled.
 * 2. **Names come from GLOSSARY.md.** `utilization`, `bindingLimit`,
 *    `burnPctPerHour`. No synonym enters the API, because a synonym in a
 *    published payload is permanent.
 * 3. **Metadata only.** No field here can carry message content, and none may
 *    identify the machine beyond an opaque id (README rule 2).
 */
import type {
  Agent,
  AppState,
  BackendId,
  Confidence,
  Health,
  LimitAssessment,
  Provenance,
  TokenKind,
  Verdict,
} from '../model/types.js';
import { isKnownModel } from '../model/types.js';

/**
 * Additive changes only inside a version. A removal or a rename is a bump and
 * a documented migration, landing in the same commit as the doc edit.
 */
export const SCHEMA_VERSION = 1;

/** Provenance map for one object, keyed by that object's numeric fields. */
export type ProvenanceMap = Record<string, Provenance>;

export interface SnapshotMeta {
  /**
   * Opaque per-installation id. Not a hostname, user name or MAC — a payload
   * that crosses a machine boundary must not be able to say whose it is.
   */
  machineId: string;
}

export interface SnapshotBackend {
  id: BackendId;
  displayName: string;
  version: string | null;
  plan: string | null;
  rateLimitTier: string | null;
  health: Health;
  healthDetail: string | null;
}

/** Billable kinds only: thinking is already inside `output` for both vendors. */
export type SnapshotTokens = Record<TokenKind, number>;

export interface SnapshotLimit {
  backend: BackendId;
  /** Stable within a backend: '5h', '7d', or a vendor limit id. */
  key: string;
  label: string;
  windowMinutes: number;
  utilization: number;
  resetsAt: number | null;
  severity: 'normal' | 'warning' | 'critical' | null;
  scope: string | null;
  /** The one limit that will stop you first (GLOSSARY: binding limit). */
  bindingLimit: boolean;
  verdict: Verdict;
  paceLinePct: number | null;
  exhaustsAt: number | null;
  /** Percentage points per hour. Null when nothing has been measured yet. */
  burnPctPerHour: number | null;
  /** Exact tokens counted inside this limit's own window; null if uncounted. */
  tokens: SnapshotTokens | null;
  /** When the vendor's reading was taken — Codex freezes this while idle. */
  observedAt: number;
  provenance: ProvenanceMap;
}

export interface SnapshotAgent {
  id: string;
  backend: BackendId;
  label: string;
  projectPath: string | null;
  gitBranch: string | null;
  /** Null when no turn has named one. Placeholders never reach the API. */
  model: string | null;
  effort: string | null;
  entrypoint: string | null;
  state: 'live' | 'idle' | 'ended';
  /** Epoch ms, or null when never observed — never 0 standing in for unknown. */
  startedAt: number | null;
  lastActivityAt: number | null;
  /** Derived share of the binding limit per hour; null when the fit is silent. */
  burnPctPerHour: number | null;
  tokens: SnapshotTokens;
  provenance: ProvenanceMap;
}

export interface Snapshot {
  schemaVersion: number;
  machineId: string;
  generatedAt: number;
  backends: SnapshotBackend[];
  limits: SnapshotLimit[];
  agents: SnapshotAgent[];
  /** Consistency residual ε, in %/h. Null before the fit has an opinion. */
  epsilon: number | null;
  fitConfidence: Confidence;
  provenance: ProvenanceMap;
}

/** 0 is the absence of a timestamp, not a moment in 1970. */
const timeOrNull = (t: number | null | undefined): number | null =>
  typeof t === 'number' && t > 0 ? t : null;

const tokensOf = (t: {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}): SnapshotTokens => ({
  input: t.input,
  cacheWrite: t.cacheWrite,
  cacheRead: t.cacheRead,
  output: t.output,
});

/**
 * Provenance for a limit. Utilization and the burn measured from it come
 * straight from the vendor; the projection is a model output; the tokens are
 * counted from transcripts.
 */
function limitProvenance(a: LimitAssessment): ProvenanceMap {
  const p: ProvenanceMap = { utilization: 'reported' };
  if (a.burn !== null) p['burnPctPerHour'] = 'reported';
  if (a.paceLinePct !== null) p['paceLinePct'] = 'reported';
  if (a.exhaustsAt !== null) p['exhaustsAt'] = 'derived';
  if (a.tokens) p['tokens'] = 'exact';
  return p;
}

function toLimit(a: LimitAssessment): SnapshotLimit {
  const w = a.limit;
  return {
    backend: w.backend,
    key: w.key,
    label: w.label,
    windowMinutes: w.windowMinutes,
    utilization: w.utilization,
    resetsAt: w.resetsAt,
    severity: w.severity,
    scope: w.scope,
    bindingLimit: a.binding,
    verdict: a.verdict,
    paceLinePct: a.paceLinePct,
    exhaustsAt: a.exhaustsAt,
    burnPctPerHour: a.burn ? a.burn.pctPerHour : null,
    tokens: a.tokens ? { ...a.tokens } : null,
    observedAt: w.observedAt,
    provenance: limitProvenance(a),
  };
}

function toAgent(a: Agent, burn: number | null): SnapshotAgent {
  const provenance: ProvenanceMap = { tokens: 'exact' };
  if (burn !== null) provenance['burnPctPerHour'] = 'derived';
  return {
    id: a.id,
    backend: a.backend,
    label: a.label,
    projectPath: a.projectPath,
    gitBranch: a.gitBranch,
    // A provider writes a placeholder when a turn names no model. It is a
    // bucket key, not an answer, and it must not cross the API boundary.
    model: isKnownModel(a.model) ? a.model : null,
    effort: a.effort,
    entrypoint: a.entrypoint,
    state: a.state,
    startedAt: timeOrNull(a.startedAt),
    lastActivityAt: timeOrNull(a.lastActivityAt),
    burnPctPerHour: burn,
    tokens: tokensOf(a.totals),
    provenance,
  };
}

/**
 * Project the live state onto the published shape. Pure: the machine id is
 * supplied rather than read, so this function never touches the filesystem and
 * is trivially testable.
 */
export function toSnapshot(state: AppState, meta: SnapshotMeta): Snapshot {
  const burnOf = new Map(state.agentBurns.map((b) => [b.agentId, b.pctPerHour]));
  const provenance: ProvenanceMap = {};
  if (state.epsilon !== null) provenance['epsilon'] = 'derived';

  return {
    schemaVersion: SCHEMA_VERSION,
    machineId: meta.machineId,
    generatedAt: state.generatedAt,
    backends: state.backends.map((b) => ({
      id: b.id,
      displayName: b.displayName,
      version: b.version,
      plan: b.plan,
      rateLimitTier: b.rateLimitTier,
      health: b.health,
      healthDetail: b.healthDetail,
    })),
    limits: state.limits.map(toLimit),
    agents: state.agents.map((a) => toAgent(a, burnOf.get(a.id) ?? null)),
    epsilon: state.epsilon,
    fitConfidence: state.fitConfidence,
    provenance,
  };
}
