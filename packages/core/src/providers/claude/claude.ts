/**
 * Claude Code provider. Formats per docs/DATA-SOURCES.md (verified 2026-08-21/22
 * against client 2.1.23x). All parsing is additive-tolerant; failures degrade
 * this provider, never the app.
 *
 * HARD RULES (CLAUDE.md):
 *  - read-only: never write into ~/.claude, never touch credentials beyond reading
 *  - never run an OAuth refresh; 401 = back off and serve stale
 *  - metadata only: message bodies are never retained
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent, Backend, QuotaLimit, TokenTotals, UsageEvent } from '../../model/types.js';
import { ZERO_TOTALS } from '../../model/types.js';
import { asNum, asObj, asStr, parseLine, tailFile, type TailState } from '../../collect/tail.js';
import { pidAlive, type ProviderAdapter } from '../provider.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Poll at most once a minute, and only while something is live (docs/DATA-SOURCES.md). */
const MIN_POLL_MS = 60_000;
/** After a 401/429, hold off and keep serving the stale snapshot. */
const BACKOFF_MS = 5 * 60_000;
/** Idle threshold for a session with no recent transcript activity. */
const IDLE_MS = 5 * 60_000;

export interface ClaudeProviderOptions {
  /** Override for tests. Defaults to ~/.claude. */
  root?: string;
  /** Injectable clock/fetch for tests. */
  now?: () => number;
  fetchFn?: typeof fetch;
}

interface SessionRecord {
  pid: number | null;
  sessionId: string;
  cwd: string | null;
  name: string | null;
  startedAt: number | null;
  entrypoint: string | null;
  version: string | null;
}

export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly supportedVersions = '>=2.0.0 <3.0.0';

  private readonly root: string;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly tail: TailState = { offsets: {} };
  private readonly seenRequestIds = new Set<string>();
  /** sessionId → latest observed model/effort/branch/activity, fed by collectUsage. */
  private readonly sessionObservations = new Map<
    string,
    { model: string | null; effort: string | null; gitBranch: string | null; lastTs: number; totals: TokenTotals }
  >();

  private lastQuota: QuotaLimit[] = [];
  private lastPollAt = 0;
  private backoffUntil = 0;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.root = opts.root ?? path.join(os.homedir(), '.claude');
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  // -------------------------------------------------------------------------
  async detect(): Promise<Backend | null> {
    try {
      await fs.access(this.root);
    } catch {
      return null;
    }
    const creds = await this.readCredentials();
    return {
      id: 'claude',
      displayName: 'Claude Code',
      version: null, // filled from session records when one is live
      plan: creds?.subscriptionType ?? null,
      rateLimitTier: creds?.rateLimitTier ?? null,
      health: 'ok',
      healthDetail: null,
    };
  }

  /** Reads plan metadata only. The token is used solely against USAGE_URL and never stored. */
  private async readCredentials(): Promise<{
    accessToken: string | null;
    subscriptionType: string | null;
    rateLimitTier: string | null;
  } | null> {
    try {
      const raw = await fs.readFile(path.join(this.root, '.credentials.json'), 'utf-8');
      const oauth = asObj(asObj(JSON.parse(raw))?.['claudeAiOauth']);
      if (!oauth) return null;
      return {
        accessToken: asStr(oauth['accessToken']),
        subscriptionType: asStr(oauth['subscriptionType']),
        rateLimitTier: asStr(oauth['rateLimitTier']),
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  async listAgents(): Promise<Agent[]> {
    const sessions = await this.readSessions();
    const agents: Agent[] = [];
    for (const s of sessions) {
      const alive = s.pid !== null && pidAlive(s.pid);
      const obs = this.sessionObservations.get(s.sessionId);
      const lastActivity = obs?.lastTs ?? s.startedAt ?? 0;
      const state = !alive ? 'ended' : this.now() - lastActivity > IDLE_MS ? 'idle' : 'live';
      agents.push({
        id: `claude:${s.sessionId}`,
        backend: 'claude',
        label: s.name ?? s.sessionId.slice(0, 8),
        projectPath: s.cwd,
        gitBranch: obs?.gitBranch ?? null,
        model: obs?.model ?? null,
        effort: obs?.effort ?? null,
        entrypoint: s.entrypoint,
        parentId: null,
        pid: s.pid,
        state,
        startedAt: s.startedAt ?? 0,
        lastActivityAt: lastActivity,
        totals: obs?.totals ?? { ...ZERO_TOTALS },
      });
    }
    return agents;
  }

  private async readSessions(): Promise<SessionRecord[]> {
    const dir = path.join(this.root, 'sessions');
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: SessionRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const d = asObj(JSON.parse(await fs.readFile(path.join(dir, n), 'utf-8')));
        if (!d) continue;
        const sessionId = asStr(d['sessionId']);
        if (!sessionId) continue;
        out.push({
          pid: asNum(d['pid']),
          sessionId,
          cwd: asStr(d['cwd']),
          name: asStr(d['name']),
          startedAt: asNum(d['startedAt']),
          entrypoint: asStr(d['entrypoint']),
          version: asStr(d['version']),
        });
      } catch {
        /* one bad session file is not a provider failure */
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  async collectUsage(): Promise<UsageEvent[]> {
    const projectsDir = path.join(this.root, 'projects');
    const files = await this.findTranscripts(projectsDir);
    const events: UsageEvent[] = [];
    for (const f of files) {
      const { lines } = await tailFile(this.tail, f.path);
      for (const line of lines) {
        // Cheap pre-filter: metadata-only rule — we only parse lines that can
        // carry usage, and we never retain message content.
        if (!line.includes('"usage"')) continue;
        const ev = this.parseUsageLine(line, f.sessionId, f.parentSessionId);
        if (ev) events.push(ev);
      }
    }
    return events;
  }

  private parseUsageLine(line: string, sessionId: string, parentSessionId: string | null): UsageEvent | null {
    const d = parseLine(line);
    if (!d || d['type'] !== 'assistant') return null;
    const msg = asObj(d['message']);
    const usage = asObj(msg?.['usage']);
    if (!msg || !usage) return null;
    const requestId = asStr(d['requestId']);
    if (!requestId || this.seenRequestIds.has(requestId)) return null;
    this.seenRequestIds.add(requestId);

    const ts = Date.parse(asStr(d['timestamp']) ?? '') || this.now();
    const model = asStr(msg['model']) ?? 'unknown';
    const details = asObj(usage['output_tokens_details']);
    const tokens: TokenTotals = {
      input: asNum(usage['input_tokens']) ?? 0,
      cacheWrite: asNum(usage['cache_creation_input_tokens']) ?? 0,
      cacheRead: asNum(usage['cache_read_input_tokens']) ?? 0,
      output: asNum(usage['output_tokens']) ?? 0,
      thinking: asNum(details?.['thinking_tokens']) ?? 0,
    };
    // Attribute subagent turns to the parent session (GLOSSARY: Agent).
    const agentSession = parentSessionId ?? sessionId;
    const effort = asStr(d['effort']);
    const gitBranch = asStr(d['gitBranch']);

    const obs = this.sessionObservations.get(agentSession) ?? {
      model: null,
      effort: null,
      gitBranch: null,
      lastTs: 0,
      totals: { ...ZERO_TOTALS },
    };
    obs.model = model;
    obs.effort = effort ?? obs.effort;
    obs.gitBranch = gitBranch ?? obs.gitBranch;
    obs.lastTs = Math.max(obs.lastTs, ts);
    obs.totals.input += tokens.input;
    obs.totals.cacheWrite += tokens.cacheWrite;
    obs.totals.cacheRead += tokens.cacheRead;
    obs.totals.output += tokens.output;
    obs.totals.thinking += tokens.thinking;
    this.sessionObservations.set(agentSession, obs);

    return {
      ts,
      backend: 'claude',
      agentId: `claude:${agentSession}`,
      model,
      effort,
      tokens,
      requests: 1,
      requestId,
    };
  }

  /** Top-level transcripts + subagent transcripts (attributed to the parent session). */
  private async findTranscripts(
    projectsDir: string,
  ): Promise<Array<{ path: string; sessionId: string; parentSessionId: string | null }>> {
    const out: Array<{ path: string; sessionId: string; parentSessionId: string | null }> = [];
    let slugs: string[];
    try {
      slugs = await fs.readdir(projectsDir);
    } catch {
      return out;
    }
    for (const slug of slugs) {
      const slugDir = path.join(projectsDir, slug);
      let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
      try {
        entries = (await fs.readdir(slugDir, { withFileTypes: true })) as never;
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ path: path.join(slugDir, e.name), sessionId: e.name.replace(/\.jsonl$/, ''), parentSessionId: null });
        } else if (e.isDirectory()) {
          // projects/<slug>/<sessionId>/subagents/**/agent-*.jsonl
          const parent = e.name;
          const subRoot = path.join(slugDir, parent, 'subagents');
          for (const sub of await this.walkJsonl(subRoot)) {
            out.push({ path: sub, sessionId: parent, parentSessionId: parent });
          }
        }
      }
    }
    return out;
  }

  private async walkJsonl(dir: string, depth = 0): Promise<string[]> {
    if (depth > 4) return [];
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as never;
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      else if (e.isDirectory()) out.push(...(await this.walkJsonl(p, depth + 1)));
    }
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
    for (const id of ids) this.seenRequestIds.add(id);
  }

  // -------------------------------------------------------------------------
  async quota(): Promise<QuotaLimit[]> {
    const now = this.now();
    if (now < this.backoffUntil || now - this.lastPollAt < MIN_POLL_MS) return this.lastQuota;
    const creds = await this.readCredentials();
    if (!creds?.accessToken) return []; // API-key/Bedrock/Vertex: no endpoint → []
    this.lastPollAt = now;

    try {
      const res = await this.fetchFn(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          Accept: 'application/json',
          'User-Agent': 'adjent/0.1',
        },
      });
      if (res.status === 401 || res.status === 429) {
        // Normal states: Claude Code will refresh the token on its next use.
        this.backoffUntil = now + BACKOFF_MS;
        return this.lastQuota;
      }
      if (!res.ok) return this.lastQuota;
      const body = asObj(await res.json());
      if (!body) return this.lastQuota;
      this.lastQuota = this.parseUsageBody(body, now);
      return this.lastQuota;
    } catch {
      return this.lastQuota; // network failure: serve stale, marked by observedAt
    }
  }

  /**
   * Defensive parse: limits[] and the named windows are mutual fallbacks
   * (docs/ARCHITECTURE.md § Claude — reported).
   */
  private parseUsageBody(body: Record<string, unknown>, observedAt: number): QuotaLimit[] {
    const out: QuotaLimit[] = [];
    const push = (w: Omit<QuotaLimit, 'backend' | 'source' | 'observedAt'>) =>
      out.push({ backend: 'claude', source: 'reported', observedAt, ...w });

    const limits = body['limits'];
    if (Array.isArray(limits)) {
      for (const l0 of limits) {
        const l = asObj(l0);
        if (!l) continue;
        const kind = asStr(l['kind']) ?? 'unknown';
        const pct = asNum(l['percent']);
        if (pct === null) continue;
        const scopeModel = asStr(asObj(asObj(l['scope'])?.['model'])?.['display_name']);
        const group = asStr(l['group']);
        const windowMinutes = group === 'session' ? 300 : 10_080;
        const sevRaw = asStr(l['severity']);
        push({
          key: scopeModel ? `${kind}:${scopeModel.toLowerCase()}` : kind,
          label:
            group === 'session'
              ? 'Claude · 5h'
              : scopeModel
                ? `Claude · 7d · ${scopeModel}`
                : 'Claude · 7d',
          windowMinutes,
          utilization: pct,
          resetsAt: Date.parse(asStr(l['resets_at']) ?? '') || null,
          severity: sevRaw === 'warning' || sevRaw === 'critical' ? sevRaw : sevRaw === 'normal' ? 'normal' : null,
          vendorActive: l['is_active'] === true,
          scope: scopeModel,
        });
      }
    }

    if (out.length === 0) {
      // Fallback to the named windows if limits[] moved.
      const named: Array<[string, string, number]> = [
        ['five_hour', 'Claude · 5h', 300],
        ['seven_day', 'Claude · 7d', 10_080],
      ];
      for (const [field, label, windowMinutes] of named) {
        const w = asObj(body[field]);
        const pct = asNum(w?.['utilization']);
        if (!w || pct === null) continue;
        push({
          key: field,
          label,
          windowMinutes,
          utilization: pct,
          resetsAt: Date.parse(asStr(w['resets_at']) ?? '') || null,
          severity: null,
          vendorActive: false,
          scope: null,
        });
      }
    }
    return out;
  }
}
