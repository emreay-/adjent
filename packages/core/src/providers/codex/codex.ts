/**
 * Codex provider. Formats per docs/DATA-SOURCES.md (verified against client
 * 0.149.x). Quota is read from rate_limits payloads embedded in session
 * rollouts — no network call exists or is needed; freshness = last Codex
 * API activity, surfaced via observedAt.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, Backend, QuotaWindow, TokenTotals, UsageEvent } from '../../model/types.js';
import { ZERO_TOTALS } from '../../model/types.js';
import { asNum, asObj, asStr, parseLine, tailFile, type TailState } from '../../collect/tail.js';
import type { ProviderAdapter } from '../provider.js';

const IDLE_MS = 5 * 60_000;
/** Rollouts touched within this horizon are tailed for agents (cheap steady state). */
const ACTIVE_HORIZON_MS = 48 * 3600_000;
/** Quota lives in the newest rate_limits record with real windows — look further back. */
const QUOTA_HORIZON_MS = 14 * 24 * 3600_000;
/** Threads idle longer than this are dropped from the agent list entirely. */
const LIST_HORIZON_MS = 12 * 3600_000;

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
      health: 'ok',
      healthDetail: null,
    };
  }

  // -------------------------------------------------------------------------
  async listAgents(): Promise<Agent[]> {
    await this.readThreadIndex();
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
        model: obs.model,
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
    for (const f of files) {
      const { lines } = await tailFile(this.tail, f.path);
      for (const line of lines) {
        if (line.includes('"rate_limits"')) this.captureRateLimits(line);
        if (line.includes('"session_meta"')) this.captureSessionMeta(line, f.threadId);
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
    const usage = this.findTokenUsage(d, 0);
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

    const model = this.findStr(d, 'model') ?? 'gpt-unknown';
    const effort = this.findStr(d, 'effort') ?? this.findStr(d, 'reasoning_effort');
    const cwd = this.findStr(d, 'cwd');

    const tokens: TokenTotals = { input: Math.max(0, input - cached), cacheWrite: 0, cacheRead: cached, output, thinking };
    const obs = this.threadObservations.get(threadId) ?? {
      model: null,
      effort: null,
      lastTs: 0,
      totals: { ...ZERO_TOTALS },
      cwd: null,
    };
    obs.model = model !== 'gpt-unknown' ? model : obs.model;
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

  private async findActiveRollouts(): Promise<Array<{ path: string; threadId: string }>> {
    // Until a rate_limits record with windows is found, look further back so
    // quota survives idle stretches; afterwards the short horizon suffices.
    const horizon = this.latestRateLimits === null ? QUOTA_HORIZON_MS : ACTIVE_HORIZON_MS;
    const out: Array<{ path: string; threadId: string }> = [];
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
          try {
            const st = await fs.stat(p);
            if (st.mtimeMs < cutoff) continue;
          } catch {
            continue;
          }
          const m = /rollout-.*T[\d-]+-([0-9a-f-]{36})\.jsonl$/.exec(e.name);
          out.push({ path: p, threadId: m?.[1] ?? e.name });
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
  async quota(): Promise<QuotaWindow[]> {
    // Ensure we have scanned at least once even if collectUsage was not called.
    if (!this.latestRateLimits) await this.collectUsage();
    const rl = this.latestRateLimits;
    if (!rl) return [];
    const out: QuotaWindow[] = [];
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
