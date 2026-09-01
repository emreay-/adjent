/**
 * Domain model. Vocabulary follows docs/GLOSSARY.md exactly:
 * utilization, limit, binding limit, bucket, burn rate.
 *
 * Provenance is typed (README rule 4): every displayed number is
 * `reported` (vendor said it), `exact` (counted from transcripts), or
 * `derived` (came out of the fit). Derived values render with `≈`.
 */

export type BackendId = 'claude' | 'codex';

export type Provenance = 'reported' | 'exact' | 'derived';

export type Health = 'ok' | 'degraded' | 'absent';

export interface Backend {
  id: BackendId;
  displayName: string;
  version: string | null;
  /** e.g. 'max', 'pro' — plan identification, never a token. */
  plan: string | null;
  /** e.g. 'demo-tier'. Watched for change → re-bootstrap the fit. */
  rateLimitTier: string | null;
  health: Health;
  /** Human-readable reason when health !== 'ok'. */
  healthDetail: string | null;
}

/**
 * What a provider writes into a usage event when the turn it parsed named no
 * model. The ledger needs *some* bucket key, but these are placeholders, not
 * models: they must never reach the UI, seed a display, or be mistaken for a
 * real answer when filling a gap.
 */
export const UNKNOWN_MODELS: ReadonlySet<string> = new Set(['unknown', 'gpt-unknown']);

export const isKnownModel = (model: string | null | undefined): model is string =>
  typeof model === 'string' && model.length > 0 && !UNKNOWN_MODELS.has(model);

export type AgentState = 'live' | 'idle' | 'ended';

export interface TokenTotals {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

export const ZERO_TOTALS: Readonly<TokenTotals> = Object.freeze({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
});

/** One running or recent session of one backend, in one project. */
export interface Agent {
  /** Stable id: `${backend}:${sessionId}`. */
  id: string;
  backend: BackendId;
  /** Human label: Claude session `name`, Codex `thread_name`. */
  label: string;
  projectPath: string | null;
  gitBranch: string | null;
  /** Last observed model on this session. */
  model: string | null;
  /** Last observed reasoning effort (display only — never a bucket dimension). */
  effort: string | null;
  /** cli | vscode | sdk | unknown */
  entrypoint: string | null;
  /** Parent agent id for subagents; attribution rolls up to the parent. */
  parentId: string | null;
  pid: number | null;
  state: AgentState;
  startedAt: number; // epoch ms
  lastActivityAt: number; // epoch ms
  totals: TokenTotals;
}

/**
 * One billable quantity the vendor meters (GLOSSARY: "bucket").
 * Normally model×kind; `requests` exists so a per-request fixed cost is
 * fitted rather than assumed absent (docs/GLOSSARY.md step 2).
 */
export type TokenKind = 'input' | 'cacheWrite' | 'cacheRead' | 'output';

export interface BucketKey {
  model: string;
  kind: TokenKind | 'requests';
}

export const bucketId = (b: BucketKey): string => `${b.model}:${b.kind}`;

/** One parsed assistant turn. requestId is the dedup key. */
export interface UsageEvent {
  ts: number; // epoch ms
  backend: BackendId;
  agentId: string;
  /**
   * Which subagent of `agentId` produced this turn, or null for the session's
   * own turns. A **detection label, not an identity**: an Agent is the session
   * including its subagents (GLOSSARY), tokens are counted exactly once at the
   * parent, and nothing derived from this field may reach the UI as a row, a
   * count or a total. It exists because a looping subagent and its parent are
   * indistinguishable once their turns are merged.
   *
   * Optional: events written before this field existed simply lack it, and
   * `loadLedger` is duck-typed, so no store migration is needed.
   */
  subId?: string | null;
  model: string;
  effort: string | null;
  tokens: TokenTotals;
  requests: number; // 1 per API call; server tool calls add their own columns later
  requestId: string;
}

export interface QuotaLimit {
  backend: BackendId;
  /** Stable key: '5h' | '7d' | vendor limit id (e.g. 'weekly_scoped:opus'). */
  key: string;
  label: string;
  windowMinutes: number;
  /** Percent 0..100 as the vendor reports it. Never computed. */
  utilization: number;
  /** Epoch ms; when this limit resets. */
  resetsAt: number | null;
  /** Vendor-assigned severity when present (Claude limits[]). */
  severity: 'normal' | 'warning' | 'critical' | null;
  /** Vendor says this is the currently binding limit (Claude is_active). */
  vendorActive: boolean;
  /** Scope, e.g. a model display name for scoped limits. */
  scope: string | null;
  source: Provenance; // always 'reported' for both current backends
  /** Epoch ms the reading was taken (Codex readings can be stale while idle). */
  observedAt: number;
}

export interface BurnRate {
  /** Percentage points per hour, EWMA-smoothed. */
  pctPerHour: number;
  /** Epoch ms of last update. */
  updatedAt: number;
}

export interface AgentBurn {
  agentId: string;
  /** Derived: %/h through the fitted weights. Render with ≈. */
  pctPerHour: number;
  confidence: Confidence;
}

export type Confidence = 'low' | 'medium' | 'high';

export type Verdict = 'on-pace' | 'ahead' | 'over' | 'idle';

export interface LimitAssessment {
  limit: QuotaLimit;
  burn: BurnRate | null;
  verdict: Verdict;
  /** Where the pace line sits now (elapsed fraction × 100), null if resetsAt unknown. */
  paceLinePct: number | null;
  /** Epoch ms projected exhaustion, null if burn <= 0. */
  exhaustsAt: number | null;
  binding: boolean;
  /**
   * Exact tokens counted inside this limit's own window, so every limit can
   * show what filled it and not just the binding one. Null until the monitor
   * attaches it — the assessor works from utilization alone and never sees
   * the ledger.
   *
   * Billable kinds only: thinking is already counted inside `output` by both
   * vendors, so listing it beside them would double it.
   */
  tokens?: Record<TokenKind, number> | null;
}

/**
 * The shape of one worker's recent turns — what a loop looks like from the
 * outside, computed from metadata alone (hard rule 2: no message bodies).
 *
 * A "worker" is an agent, or one subagent of it (`UsageEvent.subId`). It is a
 * detection partition, never an identity: see GLOSSARY § Sessions and their
 * subagents.
 *
 * The three numbers together separate a loop from healthy work:
 *  - `turns`   how many turns landed in the lookback window;
 *  - `cv`      coefficient of variation of per-turn total tokens. Near zero
 *              means every turn is the same size, which real work rarely is;
 *  - `growth`  the fraction of consecutive turns whose `cacheRead` rose. A
 *              healthy session accumulates context, so this trends high; a
 *              fixed-point loop plateaus or sawtooths.
 *
 * Any one of them alone has a common innocent explanation. Together they do
 * not — which is why the rule requires all three.
 */
export interface AgentShape {
  agentId: string;
  /** Null when these are the session's own turns rather than a subagent's. */
  subId: string | null;
  turns: number;
  cv: number;
  growth: number;
}

export interface AppState {
  generatedAt: number;
  backends: Backend[];
  agents: Agent[];
  limits: LimitAssessment[];
  agentBurns: AgentBurn[];
  /**
   * Per-worker turn shape over the anomaly lookback. Computed by the monitor
   * from the ledger, because `evaluate` is pure over this state and never sees
   * events — the same reason `agentBurns` is precomputed.
   */
  agentShapes: AgentShape[];
  /** Consistency residual EWMA (GLOSSARY: ε). */
  epsilon: number | null;
  fitConfidence: Confidence;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warn' | 'critical';

/** Who was running when an alarm fired — the "what was I doing?" answer. */
export interface AlarmAgentSnapshot {
  label: string;
  /** Directory name only — what the compact rows show. */
  project: string | null;
  /** Full working directory, so a notification read later says *which* checkout. */
  projectPath: string | null;
  branch: string | null;
  model: string | null;
  effort: string | null;
  /** Derived %/h at fire time, null when the fit had nothing to say. */
  pctPerHour: number | null;
  tokens: number;
}

/**
 * State captured at the moment an alarm fired. The alarm body stays short;
 * this is what the notifications view reveals on hover, so a notification read
 * hours later still explains itself.
 */
export interface AlarmContext {
  limitLabel: string | null;
  utilization: number | null;
  burnPctPerHour: number | null;
  paceLinePct: number | null;
  resetsAt: number | null;
  exhaustsAt: number | null;
  plan: string | null;
  fitConfidence: Confidence | null;
  /** Top contributors at fire time, most expensive first. */
  agents: AlarmAgentSnapshot[];
}

export interface Alarm {
  id: string; // rule id + discriminator (limit key / agent id / level)
  ruleId: string;
  severity: Severity;
  /** What happened, then what it means (docs/UI.md copy rules). */
  title: string;
  body: string;
  firedAt: number;
  backend: BackendId | null;
  limitKey: string | null;
  agentId: string | null;
  context?: AlarmContext;
}

/**
 * What a rule may do besides telling you.
 *
 * `hold` sets the advisory gate (api/gate.ts) — it writes a file an
 * orchestrator of yours may choose to honour. It signals no process and stops
 * nothing; that boundary is settled in README § What Adjent will not do, and
 * nothing may be added here that crosses it.
 *
 * Governed by `settings.actions.enabled`, default false: **automation is
 * gated, human intent is not.** A person running `adjent gate hold` is never
 * subject to the switch; a rule always is.
 */
export type RuleAction = 'hold';

/** Fields every rule type accepts, whatever else it needs. */
export interface RuleCommon {
  /** Actions to take when this rule fires. Empty or absent means "just tell me". */
  actions?: RuleAction[];
}

export interface PaceRule extends RuleCommon {
  id: string;
  type: 'pace';
  backend: BackendId | 'any';
  /** Limit key to match, or 'any'. */
  limit: string | 'any';
  tolerancePp: number;
  /** Fire when projected exhaustion precedes reset by at least this many minutes. */
  exhaustionLeadMin: number;
  cooldownMin: number;
  severity: Severity;
}

export interface ThresholdRule extends RuleCommon {
  id: string;
  type: 'threshold';
  backend: BackendId | 'any';
  /** Limit key to match, or 'any'. */
  limit: string | 'any';
  levels: number[];
  severity: Partial<Record<number, Severity>>;
}

export interface AgentBurnRule extends RuleCommon {
  id: string;
  type: 'agent_burn';
  windowMin: number;
  relToMedian: number;
  sharePct: number;
  absPctPerHour: number;
  cooldownMin: number;
  severity: Severity;
}

/**
 * "This worker looks stuck." Fires on turn *shape*, not on spend, which is what
 * makes it catch a loop that is individually cheap and collectively ruinous.
 *
 * All four conditions must hold — each alone has an innocent reading. Enough
 * turns to be a pattern, uniform sizes, no growing context, and enough burn to
 * be worth interrupting someone over.
 */
export interface AnomalyRule extends RuleCommon {
  id: string;
  type: 'anomaly';
  windowMin: number;
  minTurns: number;
  shapeCv: number;
  growthFloor: number;
  absPctPerHour: number;
  cooldownMin: number;
  severity: Severity;
}

export type Rule = PaceRule | ThresholdRule | AgentBurnRule | AnomalyRule;

/** Persistent memory the alarm engine needs between evaluations. */
export interface FireLog {
  /** ruleId+discriminator → last fired epoch ms. */
  lastFired: Record<string, number>;
  /** threshold rule: limitKey → levels already fired in current occupancy. */
  firedLevels: Record<string, number[]>;
  /** limitKey → resetsAt seen last evaluation (detects rollover → rearm). */
  lastResetsAt: Record<string, number>;
  /** pace rule: discriminator → currently latched above the line (hysteresis). */
  paceLatched: Record<string, boolean>;
}

export const emptyFireLog = (): FireLog => ({
  lastFired: {},
  firedLevels: {},
  lastResetsAt: {},
  paceLatched: {},
});
