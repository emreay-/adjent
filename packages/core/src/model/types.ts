/**
 * Domain model. Vocabulary follows docs/GLOSSARY.md exactly:
 * utilization, window, binding limit, bucket, burn rate.
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
  model: string;
  effort: string | null;
  tokens: TokenTotals;
  requests: number; // 1 per API call; server tool calls add their own columns later
  requestId: string;
}

export interface QuotaWindow {
  backend: BackendId;
  /** Stable key: '5h' | '7d' | vendor limit id (e.g. 'weekly_scoped:opus'). */
  key: string;
  label: string;
  windowMinutes: number;
  /** Percent 0..100 as the vendor reports it. Never computed. */
  utilization: number;
  /** Epoch ms; when this window resets. */
  resetsAt: number | null;
  /** Vendor-assigned severity when present (Claude limits[]). */
  severity: 'normal' | 'warning' | 'critical' | null;
  /** Vendor says this is the currently binding limit (Claude is_active). */
  vendorActive: boolean;
  /** Scope, e.g. a model display name for scoped windows. */
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

export interface WindowAssessment {
  window: QuotaWindow;
  burn: BurnRate | null;
  verdict: Verdict;
  /** Where the pace line sits now (elapsed fraction × 100), null if resetsAt unknown. */
  paceLinePct: number | null;
  /** Epoch ms projected exhaustion, null if burn <= 0. */
  exhaustsAt: number | null;
  binding: boolean;
}

export interface AppState {
  generatedAt: number;
  backends: Backend[];
  agents: Agent[];
  windows: WindowAssessment[];
  agentBurns: AgentBurn[];
  /** Consistency residual EWMA (GLOSSARY: ε). */
  epsilon: number | null;
  fitConfidence: Confidence;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warn' | 'critical';

export interface Alarm {
  id: string; // rule id + discriminator (window key / agent id / level)
  ruleId: string;
  severity: Severity;
  /** What happened, then what it means (docs/UI.md copy rules). */
  title: string;
  body: string;
  firedAt: number;
  backend: BackendId | null;
  windowKey: string | null;
  agentId: string | null;
}

export interface PaceRule {
  id: string;
  type: 'pace';
  backend: BackendId | 'any';
  window: string | 'any';
  tolerancePp: number;
  /** Fire when projected exhaustion precedes reset by at least this many minutes. */
  exhaustionLeadMin: number;
  cooldownMin: number;
  severity: Severity;
}

export interface ThresholdRule {
  id: string;
  type: 'threshold';
  backend: BackendId | 'any';
  window: string | 'any';
  levels: number[];
  severity: Partial<Record<number, Severity>>;
}

export interface AgentBurnRule {
  id: string;
  type: 'agent_burn';
  windowMin: number;
  relToMedian: number;
  sharePct: number;
  absPctPerHour: number;
  cooldownMin: number;
  severity: Severity;
}

export type Rule = PaceRule | ThresholdRule | AgentBurnRule;

/** Persistent memory the alarm engine needs between evaluations. */
export interface FireLog {
  /** ruleId+discriminator → last fired epoch ms. */
  lastFired: Record<string, number>;
  /** threshold rule: windowKey → levels already fired in current occupancy. */
  firedLevels: Record<string, number[]>;
  /** windowKey → resetsAt seen last evaluation (detects rollover → rearm). */
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
