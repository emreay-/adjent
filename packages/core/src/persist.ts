/**
 * Durable state under ~/.adjent (docs/ARCHITECTURE.md § storage).
 *
 * Adjent writes only here — never into a vendor directory (CLAUDE.md rule 1).
 * Layout:
 *
 *   settings.json   user preferences            (settings.ts)
 *   alarms.yaml     user-authored rules         (read-only, config.ts)
 *   state.json      tail offsets, fit, alarm memory, burn tracks
 *   ledger.jsonl    recent usage events, so a restart is not a cold start
 *   history.jsonl   downsampled utilization samples — draws the real curve
 *   alarms.jsonl    alarm history — the notifications tab reads this
 *
 * Everything here is best-effort: a corrupt or missing file degrades to "no
 * history", never to an error. Writes are atomic (tmp + rename) so a crash
 * mid-write cannot leave a half-parsed file behind.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Alarm, FireLog, UsageEvent } from './model/types.js';

export const STORE_VERSION = 1;

/** Windows of retention, chosen so the files stay small on a busy machine. */
export const RETENTION = {
  /** Enough to cover the longest window we feed the fit from, plus slack. */
  ledgerMs: 48 * 3600_000,
  /** Two weeks of utilization samples ≈ a few hundred KB. */
  historyMs: 14 * 24 * 3600_000,
  /** Alarm history: generous, but capped by count as well. */
  alarmsMs: 90 * 24 * 3600_000,
  alarmsMax: 500,
};

export interface HistorySample {
  /** epoch ms */
  t: number;
  /** `${backend}:${limitKey}` */
  w: string;
  /** utilization percent */
  u: number;
}

export interface PersistedState {
  version: number;
  savedAt: number;
  /** provider id → { absolute path → byte offset } */
  tailOffsets: Record<string, Record<string, number>>;
  /** ExchangeRateFit.toJSON(), keyed by window */
  fits: Record<string, unknown>;
  /** LimitAssessor.toJSON() */
  assessor: unknown;
  fireLog: FireLog | null;
  epsilon: { value: number; at: number } | null;
  /** Tier per backend, so a plan change across restarts is still detected. */
  tiers: Record<string, string | null>;
}

const storeDir = (): string => path.join(os.homedir(), '.adjent');

export class Store {
  constructor(private readonly dir: string = storeDir()) {}

  private p(name: string): string {
    return path.join(this.dir, name);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** tmp + rename: a reader never sees a partially written file. */
  private async atomicWrite(name: string, data: string): Promise<void> {
    try {
      await this.ensureDir();
      const tmp = this.p(`${name}.tmp`);
      await fs.writeFile(tmp, data, 'utf-8');
      await fs.rename(tmp, this.p(name));
    } catch {
      /* persistence is best-effort; never take the app down for it */
    }
  }

  private async readLines(name: string): Promise<Record<string, unknown>[]> {
    try {
      const raw = await fs.readFile(this.p(name), 'utf-8');
      const out: Record<string, unknown>[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const v: unknown = JSON.parse(line);
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) out.push(v as Record<string, unknown>);
        } catch {
          /* skip a torn line rather than discarding the whole file */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  async loadState(): Promise<PersistedState | null> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.p('state.json'), 'utf-8'));
      if (typeof raw !== 'object' || raw === null) return null;
      const s = raw as Partial<PersistedState>;
      // A version bump means the shape changed: drop rather than mis-read it.
      if (s.version !== STORE_VERSION) return null;
      return {
        version: STORE_VERSION,
        savedAt: typeof s.savedAt === 'number' ? s.savedAt : 0,
        tailOffsets: (s.tailOffsets as PersistedState['tailOffsets']) ?? {},
        fits: (s.fits as PersistedState['fits']) ?? {},
        assessor: s.assessor ?? null,
        fireLog: (s.fireLog as FireLog) ?? null,
        epsilon: (s.epsilon as PersistedState['epsilon']) ?? null,
        tiers: (s.tiers as PersistedState['tiers']) ?? {},
      };
    } catch {
      return null;
    }
  }

  async saveState(state: PersistedState): Promise<void> {
    await this.atomicWrite('state.json', JSON.stringify(state));
  }

  // -------------------------------------------------------------------------
  /** Recent usage events, so per-agent burn survives a restart. */
  async loadLedger(now: number): Promise<UsageEvent[]> {
    const cutoff = now - RETENTION.ledgerMs;
    const out: UsageEvent[] = [];
    for (const r of await this.readLines('ledger.jsonl')) {
      const e = r as unknown as UsageEvent;
      if (typeof e.ts === 'number' && e.ts >= cutoff && typeof e.requestId === 'string' && e.tokens) out.push(e);
    }
    return out;
  }

  /** Rewritten whole (pruned) rather than appended — it stays small. */
  async saveLedger(events: UsageEvent[], now: number): Promise<void> {
    const cutoff = now - RETENTION.ledgerMs;
    const kept = events.filter((e) => e.ts >= cutoff);
    await this.atomicWrite('ledger.jsonl', kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  }

  // -------------------------------------------------------------------------
  async loadHistory(now: number): Promise<HistorySample[]> {
    const cutoff = now - RETENTION.historyMs;
    const out: HistorySample[] = [];
    for (const r of await this.readLines('history.jsonl')) {
      const t = r['t'];
      const w = r['w'];
      const u = r['u'];
      if (typeof t === 'number' && typeof w === 'string' && typeof u === 'number' && t >= cutoff) out.push({ t, w, u });
    }
    return out;
  }

  async appendHistory(samples: HistorySample[]): Promise<void> {
    if (samples.length === 0) return;
    try {
      await this.ensureDir();
      await fs.appendFile(this.p('history.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');
    } catch {
      /* best effort */
    }
  }

  /** Rewrite the history file without expired samples. Cheap, run rarely. */
  async compactHistory(now: number): Promise<void> {
    const kept = await this.loadHistory(now);
    await this.atomicWrite('history.jsonl', kept.map((s) => JSON.stringify(s)).join('\n') + (kept.length ? '\n' : ''));
  }

  // -------------------------------------------------------------------------
  /** Newest last. The notifications tab reverses for display. */
  async loadAlarms(now: number): Promise<Alarm[]> {
    const cutoff = now - RETENTION.alarmsMs;
    const out: Alarm[] = [];
    for (const r of await this.readLines('alarms.jsonl')) {
      const a = r as unknown as Alarm;
      if (typeof a.firedAt === 'number' && a.firedAt >= cutoff && typeof a.title === 'string') out.push(a);
    }
    return out.slice(-RETENTION.alarmsMax);
  }

  async appendAlarms(alarms: Alarm[]): Promise<void> {
    if (alarms.length === 0) return;
    try {
      await this.ensureDir();
      await fs.appendFile(this.p('alarms.jsonl'), alarms.map((a) => JSON.stringify(a)).join('\n') + '\n', 'utf-8');
    } catch {
      /* best effort */
    }
  }

  async compactAlarms(now: number): Promise<void> {
    const kept = await this.loadAlarms(now);
    await this.atomicWrite('alarms.jsonl', kept.map((a) => JSON.stringify(a)).join('\n') + (kept.length ? '\n' : ''));
  }

  /** Explicit user action: forget the notification log. */
  async clearAlarms(): Promise<void> {
    await this.atomicWrite('alarms.jsonl', '');
  }
}
