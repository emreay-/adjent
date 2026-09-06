/**
 * Codex provider. Formats per docs/DATA-SOURCES.md (verified against client
 * 0.149.x). Quota is read from rate_limits payloads embedded in session
 * rollouts — no network call exists or is needed; freshness = last Codex
 * API activity, surfaced via observedAt.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, Backend, QuotaLimit, TokenTotals, UsageEvent } from '../../model/types.js';
import { ZERO_TOTALS, isKnownModel } from '../../model/types.js';
import { asNum, asObj, asStr, headChunk, parseLine, tailChunk, tailFile, type TailState } from '../../collect/tail.js';
import type { ProviderAdapter } from '../provider.js';

const IDLE_MS = 5 * 60_000;
/** Rollouts touched within this horizon are tailed for agents (cheap steady state). */
const ACTIVE_HORIZON_MS = 48 * 3600_000;
/** Quota lives in the newest rate_limits record with real windows — look further back. */
const QUOTA_HORIZON_MS = 14 * 24 * 3600_000;
/** Threads idle longer than this are dropped from the agent list entirely. */
const LIST_HORIZON_MS = 12 * 3600_000;
/**
 * How much of a rollout to re-read when recovering a thread's model. The turn
 * context sits near the top of the file and again at the newest turn, so both
 * ends are searched and the middle — which is all message content — is not.
 */
const IDENTITY_CHUNK_BYTES = 256 * 1024;
/** How many rollouts to search when recovering quota after a cold start. */
const QUOTA_RECOVERY_FILES = 40;

export interface CodexProviderOptions {
  root?: string;
  now?: () => number;
}

export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly supportedVersions = '>=0.100.0 <1.0.0';

  private readonly root: string;
  private readonly now: () => number;
  private readonly tail: TailState = { offsets: {} };
  private readonly seenEventIds = new Set<string>();
  private readonly threadNames = new Map<string, string>();
  private readonly threadObservations = new Map<
    string,
    { model: string | null; effort: string | null; lastTs: number; totals: TokenTotals; cwd: string | null }
  >();

  /** threadId → last cumulative usage seen, for differencing. */
  private readonly lastCumulative = new Map<string, Record<string, number>>();

  /** threadId → rollout path, so identity can be re-read without a rescan. */
  private readonly threadFiles = new Map<string, string>();
  /** Threads already searched retrospectively — the file is read at most once. */
  private readonly identityResolved = new Set<string>();

  private latestRateLimits: { payload: Record<string, unknown>; observedAt: number } | null = null;
  private plan: string | null = null;

  constructor(opts: CodexProviderOptions = {}) {
    this.root = opts.root ?? path.join(os.homedir(), '.codex');
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  async detect(): Promise<Backend | null> {
    try {
      await fs.access(this.root);
    } catch {
      return null;
    }
    let version: string | null = null;
    try {
      const v = asObj(JSON.parse(await fs.readFile(path.join(this.root, 'version.json'), 'utf-8')));
      version = asStr(v?.['version'] ?? v?.['client_version']);
    } catch {
      /* absent is fine */
    }
    return {
      id: 'codex',
      displayName: 'Codex',
      version,
      plan: this.plan,
      rateLimitTier: this.plan, // Codex exposes plan_type only; tier == plan
      health: this.tail.skippedLines ? 'degraded' : 'ok',
      healthDetail: this.tail.skippedLines ? 'Oversized transcript records were skipped; token totals may be incomplete.' : null,
    };
  }

  // -------------------------------------------------------------------------
  async listAgents(): Promise<Agent[]> {
    await this.readThreadIndex();
    await this.resolveMissingIdentity();
    const agents: Agent[] = [];
    for (const [threadId, obs] of this.threadObservations) {
      if (this.now() - obs.lastTs > LIST_HORIZON_MS) continue;
      const state = this.now() - obs.lastTs > IDLE_MS ? 'idle' : 'live';
      agents.push({
        id: `codex:${threadId}`,
        backend: 'codex',
        label: this.threadNames.get(threadId) ?? threadId.slice(0, 8),
        projectPath: obs.cwd,
        gitBranch: null,
        model: isKnownModel(obs.model) ? obs.model : null,
        effort: obs.effort,
        entrypoint: null,
        parentId: null,
        pid: null, // rollouts carry no pid; liveness is activity-based
        state,
        startedAt: 0,
        lastActivityAt: obs.lastTs,
        totals: obs.totals,
      });
    }
    return agents;
  }

  private async readThreadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.root, 'session_index.jsonl'), 'utf-8');
      for (const line of raw.split('\n')) {
        const d = parseLine(line);
        const id = asStr(d?.['id']);
        const name = asStr(d?.['thread_name']);
        if (id && name) this.threadNames.set(id, name); // later lines win — file is append-ordered
      }
    } catch {
      /* absent index only costs labels */
    }
  }

  // -------------------------------------------------------------------------
  async collectUsage(): Promise<UsageEvent[]> {
    const files = await this.findActiveRollouts();
    const events: UsageEvent[] = [];
    await this.recoverRateLimits(files);

    const listCutoff = this.now() - LIST_HORIZON_MS;
    for (const f of files) {
      this.threadFiles.set(f.threadId, f.path);
      // Identity first. A usage line inherits the thread's model, so the model
      // has to be known *before* the first line is parsed — resolving it
      // afterwards still writes a batch of placeholder-model events into the
      // ledger, and those are what kept surfacing as "gpt-unknown".
      //
      // Only for threads new enough to reach the agent list: when quota is
      // still unknown the file horizon stretches to two weeks, and re-reading
      // both ends of every rollout in it would be a great deal of I/O for
      // threads that get dropped from the list anyway.
      if (f.mtime >= listCutoff) await this.resolveIdentityFor(f.threadId, f.path);
      const { lines } = await tailFile(this.tail, f.path);
      for (const line of lines) {
        if (line.includes('"rate_limits"')) this.captureRateLimits(line);
        if (line.includes('"session_meta"')) this.captureSessionMeta(line, f.threadId);
        // Usage lines never name the model; the turn context does.
        if (line.includes('"turn_context"') || line.includes('"world_state"')) {
          this.captureIdentityLine(line, f.threadId);
        }
        if (!line.includes('token') && !line.includes('usage')) continue;
        const ev = this.parseUsageLine(line, f.threadId);
        if (ev) events.push(ev);
      }
    }
    return events;
  }

  /**
   * Rollout token events vary across client versions; accept the shapes we have
   * seen and ignore the rest (additive-tolerant). The canonical shape carries
   * an `info`/`token_usage`-style object with *_tokens fields.
   */
  private parseUsageLine(line: string, threadId: string): UsageEvent | null {
    const d = parseLine(line);
    if (!d) return null;
    const usage = this.turnTokens(d, threadId);
    if (!usage) return null;

    const input = asNum(usage['input_tokens']) ?? 0;
    const cached = asNum(usage['cached_input_tokens']) ?? asNum(usage['cache_read_input_tokens']) ?? 0;
    const output = asNum(usage['output_tokens']) ?? 0;
    const thinking = asNum(usage['reasoning_output_tokens']) ?? 0;
    if (input === 0 && cached === 0 && output === 0) return null;

    const ts = Date.parse(asStr(d['timestamp']) ?? '') || this.now();
    // Rollout lines carry no per-event id → synthesize a dedup key. Restarted
    // files replay identical lines, which this de-duplicates.
    const requestId = `codex:${threadId}:${ts}:${input}:${cached}:${output}`;
    if (this.seenEventIds.has(requestId)) return null;
    this.seenEventIds.add(requestId);

    const tokens: TokenTotals = { input: Math.max(0, input - cached), cacheWrite: 0, cacheRead: cached, output, thinking };
    const obs = this.threadObservations.get(threadId) ?? {
      model: null,
      effort: null,
      lastTs: 0,
      totals: { ...ZERO_TOTALS },
      cwd: null,
    };
    // A usage line carries tokens, not identity. Prefer what the thread is
    // known to be running over stamping a placeholder into the ledger, which
    // would then be indistinguishable from a real model downstream.
    const lineModel = this.findStr(d, 'model');
    const model = lineModel ?? obs.model ?? 'gpt-unknown';
    const effort = this.findStr(d, 'effort') ?? this.findStr(d, 'reasoning_effort') ?? obs.effort;
    const cwd = this.findStr(d, 'cwd');

    obs.model = isKnownModel(model) ? model : obs.model;
    obs.effort = effort ?? obs.effort;
    obs.cwd = cwd ?? obs.cwd;
    obs.lastTs = Math.max(obs.lastTs, ts);
    obs.totals.input += tokens.input;
    obs.totals.cacheRead += tokens.cacheRead;
    obs.totals.output += tokens.output;
    obs.totals.thinking += tokens.thinking;
    this.threadObservations.set(threadId, obs);

    return { ts, backend: 'codex', agentId: `codex:${threadId}`, model, effort, tokens, requests: 1, requestId };
  }

  /**
   * The tokens spent by *one* turn.
   *
   * A rollout carries two usage objects and they mean opposite things:
   * `last_token_usage` is the turn's own cost, `total_token_usage` is the
   * session's running total. A depth-first search for "an object with
   * input_tokens" finds whichever comes first, and summing the cumulative one
   * across n turns counts the session roughly n²/2 times — which is how a
   * week of Codex arrived at 1.46 *trillion* tokens.
   *
   * So: take the delta when the vendor provides it. When only a cumulative
   * figure exists, difference it against the last one seen for that thread,
   * which is the same quantity by another route.
   */
  private turnTokens(d: Record<string, unknown>, threadId: string): Record<string, unknown> | null {
    const delta = this.findUsageNamed(d, 'last_token_usage', 0);
    if (delta) return delta;

    const cumulative = this.findUsageNamed(d, 'total_token_usage', 0);
    if (cumulative) return this.differenceCumulative(cumulative, threadId);

    // Neither name present: an older or newer shape. Fall back to the first
    // usage-shaped object, which is what this did before either name existed.
    return this.findTokenUsage(d, 0);
  }

  /** Depth-limited search for a usage object stored under an exact key. */
  private findUsageNamed(o: Record<string, unknown>, name: string, depth: number): Record<string, unknown> | null {
    if (depth > 5) return null;
    const direct = asObj(o[name]);
    if (direct && ('input_tokens' in direct || 'output_tokens' in direct)) return direct;
    for (const v of Object.values(o)) {
      const child = asObj(v);
      if (child) {
        const hit = this.findUsageNamed(child, name, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Turn a running total into this turn's share. A total that went *down*
   * means the thread was compacted or restarted, so the new total is taken
   * whole rather than yielding a negative turn.
   */
  private differenceCumulative(
    cumulative: Record<string, unknown>,
    threadId: string,
  ): Record<string, unknown> | null {
    const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
    const prev = this.lastCumulative.get(threadId);
    const now: Record<string, number> = {};
    const out: Record<string, unknown> = {};
    let any = false;
    for (const f of FIELDS) {
      const v = asNum(cumulative[f]);
      if (v === null) continue;
      now[f] = v;
      const before = prev?.[f] ?? 0;
      const step = v >= before ? v - before : v;
      out[f] = step;
      if (step > 0) any = true;
    }
    this.lastCumulative.set(threadId, now);
    return any ? out : null;
  }

  /** Depth-limited search for an object holding *_tokens fields. */
  private findTokenUsage(o: Record<string, unknown>, depth: number): Record<string, unknown> | null {
    if (depth > 4) return null;
    if ('input_tokens' in o || 'output_tokens' in o) return o;
    for (const v of Object.values(o)) {
      const child = asObj(v);
      if (child) {
        const hit = this.findTokenUsage(child, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  private findStr(o: Record<string, unknown>, key: string, depth = 0): string | null {
    if (depth > 4) return null;
    const direct = asStr(o[key]);
    if (direct) return direct;
    for (const v of Object.values(o)) {
      const child = asObj(v);
      if (child) {
        const hit = this.findStr(child, key, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** A session_meta line names the thread's cwd before any turn completes. */
  /**
   * Rebuild what a rollout already says, for threads the incremental tail can
   * no longer tell us anything about.
   *
   * Codex has no session-file inventory the way Claude does: a thread exists
   * to us only because we parsed its lines. So after a restart the byte offset
   * sits at the end of the file, nothing new arrives, and the thread is not
   * merely missing its model — it is missing entirely, along with the window
   * of usage the panel is meant to be showing.
   *
   * Re-reading the file fixes both. Bounded, once per thread, both ends: the
   * head carries session metadata and the opening turn context, the tail the
   * newest turn context and the latest activity.
   */
  /**
   * Recover the newest `rate_limits` record from rollouts we have already read.
   *
   * Codex quota is not an endpoint; it rides along inside session rollouts, so
   * it only reaches us while Codex is active. The byte offsets persist across a
   * restart but the captured record does not — so after a restart with no
   * Codex activity since, the tail has nothing new to give and the vendor's
   * quota disappears from the app altogether. The record is still sitting in
   * the files. Read it back.
   *
   * Newest file first, stopping at the first record that carries a real
   * window, and capped: this is a cold-start path, not a per-tick cost.
   */
  private async recoverRateLimits(files: Array<{ path: string; mtime: number }>): Promise<void> {
    if (this.latestRateLimits !== null) return;
    const newest = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, QUOTA_RECOVERY_FILES);
    for (const f of newest) {
      for (const line of await tailChunk(f.path, IDENTITY_CHUNK_BYTES)) {
        if (line.includes('"rate_limits"')) this.captureRateLimits(line);
      }
      if (this.latestRateLimits !== null) return;
    }
  }

  private async resolveMissingIdentity(): Promise<void> {
    for (const [threadId, file] of this.threadFiles) await this.resolveIdentityFor(threadId, file);
  }

  /** One thread, at most once: see resolveMissingIdentity for why. */
  private async resolveIdentityFor(threadId: string, file: string): Promise<void> {
    const known = this.threadObservations.get(threadId);
    if (known !== undefined && isKnownModel(known.model)) return;
    if (this.identityResolved.has(threadId)) return;
    this.identityResolved.add(threadId);

    const tail = await tailChunk(file, IDENTITY_CHUNK_BYTES);
    const head = await headChunk(file, IDENTITY_CHUNK_BYTES);
    // Tail first: if the model changed mid-session, the newest one wins.
    for (const chunk of [tail, head]) {
      for (let i = chunk.length - 1; i >= 0; i--) {
        const line = chunk[i] as string;
        if (line.includes('"session_meta"')) this.captureSessionMeta(line, threadId);
        if (line.includes('"model"')) this.captureIdentityLine(line, threadId);
      }
    }

    // Liveness comes from the newest timestamp in the file, not from when we
    // happened to read it — otherwise a restored thread looks brand new.
    let newest = 0;
    for (let i = tail.length - 1; i >= 0 && newest === 0; i--) {
      const d = parseLine(tail[i] as string);
      const ts = Date.parse(asStr(d?.['timestamp']) ?? '');
      if (Number.isFinite(ts)) newest = ts;
    }
    const obs = this.threadObservations.get(threadId);
    if (obs !== undefined && newest > obs.lastTs) obs.lastTs = newest;
  }

  /**
   * Pull model and effort off a turn-context-shaped line. Depth-limited search
   * rather than a fixed path: the payload shape has moved between client
   * versions, and an additive-tolerant reader survives that (README rule 6).
   */
  private captureIdentityLine(line: string, threadId: string): void {
    if (!line.includes('"model"')) return;
    const d = parseLine(line);
    if (!d) return;
    const model = this.findStr(d, 'model');
    if (!isKnownModel(model)) return;
    const effort = this.findStr(d, 'effort') ?? this.findStr(d, 'reasoning_effort');
    const obs = this.threadObservations.get(threadId) ?? {
      model: null,
      effort: null,
      lastTs: 0,
      totals: { ...ZERO_TOTALS },
      cwd: null,
    };
    obs.model = model;
    obs.effort = effort ?? obs.effort;
    this.threadObservations.set(threadId, obs);
  }

  private captureSessionMeta(line: string, threadId: string): void {
    const d = parseLine(line);
    if (!d || d['type'] !== 'session_meta') return;
    const payload = asObj(d['payload']);
    if (!payload) return;
    const ts = Date.parse(asStr(d['timestamp']) ?? '') || this.now();
    const obs = this.threadObservations.get(threadId) ?? {
      model: null,
      effort: null,
      lastTs: 0,
      totals: { ...ZERO_TOTALS },
      cwd: null,
    };
    obs.cwd = asStr(payload['cwd']) ?? obs.cwd;
    obs.lastTs = Math.max(obs.lastTs, ts);
    this.threadObservations.set(threadId, obs);
  }

  private captureRateLimits(line: string): void {
    const d = parseLine(line);
    if (!d) return;
    const rl = this.findRateLimits(d, 0);
    if (!rl) return;
    // Only records that actually carry a window are quota truth; null-window
    // records (e.g. limit_id "premium" with primary/secondary null) are noise.
    const hasWindow = asObj(rl['primary']) !== null || asObj(rl['secondary']) !== null;
    if (!hasWindow) return;
    const observedAt = Date.parse(asStr(d['timestamp']) ?? '') || this.now();
    if (!this.latestRateLimits || observedAt >= this.latestRateLimits.observedAt) {
      this.latestRateLimits = { payload: rl, observedAt };
      this.plan = asStr(rl['plan_type']) ?? this.plan;
    }
  }

  private findRateLimits(o: Record<string, unknown>, depth: number): Record<string, unknown> | null {
    if (depth > 5) return null;
    const rl = asObj(o['rate_limits']);
    if (rl) return rl;
    for (const v of Object.values(o)) {
      const child = asObj(v);
      if (child) {
        const hit = this.findRateLimits(child, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  private async findActiveRollouts(): Promise<Array<{ path: string; threadId: string; mtime: number }>> {
    // Until a rate_limits record with windows is found, look further back so
    // quota survives idle stretches; afterwards the short horizon suffices.
    const horizon = this.latestRateLimits === null ? QUOTA_HORIZON_MS : ACTIVE_HORIZON_MS;
    const out: Array<{ path: string; threadId: string; mtime: number }> = [];
    const sessionsDir = path.join(this.root, 'sessions');
    const cutoff = this.now() - horizon;
    // sessions/YYYY/MM/DD/rollout-*.jsonl — walk only recent date directories.
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
      try {
        entries = (await fs.readdir(dir, { withFileTypes: true })) as never;
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          let mtime: number;
          try {
            const st = await fs.stat(p);
            if (st.mtimeMs < cutoff) continue;
            mtime = st.mtimeMs;
          } catch {
            continue;
          }
          const m = /rollout-.*T[\d-]+-([0-9a-f-]{36})\.jsonl$/.exec(e.name);
          out.push({ path: p, threadId: m?.[1] ?? e.name, mtime });
        }
      }
    };
    await walk(sessionsDir, 0);
    return out;
  }


  // ---- persistence -------------------------------------------------------
  getTailOffsets(): Record<string, number> {
    return { ...this.tail.offsets };
  }

  setTailOffsets(offsets: Record<string, number>): void {
    Object.assign(this.tail.offsets, offsets);
  }

  /** Seed the dedup set from a restored ledger so replays are suppressed. */
  seedSeen(ids: Iterable<string>): void {
    for (const id of ids) this.seenEventIds.add(id);
  }

  // -------------------------------------------------------------------------
  async quota(): Promise<QuotaLimit[]> {
    // Ensure we have scanned at least once even if collectUsage was not called.
    if (!this.latestRateLimits) await this.collectUsage();
    const rl = this.latestRateLimits;
    if (!rl) return [];
    const out: QuotaLimit[] = [];
    for (const field of ['primary', 'secondary'] as const) {
      const w = asObj(rl.payload[field]);
      const pct = asNum(w?.['used_percent']);
      if (!w || pct === null) continue;
      const windowMinutes = asNum(w['window_minutes']) ?? 0;
      const resetsAtSec = asNum(w['resets_at']);
      const key = windowMinutes === 300 ? '5h' : windowMinutes === 10_080 ? '7d' : `${windowMinutes}m`;
      out.push({
        backend: 'codex',
        key: `codex:${key}`,
        label: `Codex · ${key}`,
        windowMinutes,
        utilization: pct,
        resetsAt: resetsAtSec !== null ? resetsAtSec * 1000 : null,
        severity: null,
        vendorActive: false,
        scope: null,
        source: 'reported',
        observedAt: rl.observedAt,
      });
    }
    return out;
  }
}
