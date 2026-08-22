/**
 * The provider interface (docs/ARCHITECTURE.md). Adding a backend = implement
 * this + drop fixtures in test/. Nothing else in the app changes.
 */
import type { Agent, Backend, BackendId, QuotaWindow, UsageEvent } from '../model/types.js';

export interface ProviderAdapter {
  readonly id: BackendId;
  /** Semver-ish range of vendor client versions the parsers were written against. */
  readonly supportedVersions: string;

  /** Detect installation. null = absent (not an error). */
  detect(): Promise<Backend | null>;

  /** Live + recent sessions. */
  listAgents(): Promise<Agent[]>;

  /** Usage events appended since the last call (byte-offset incremental). */
  collectUsage(): Promise<UsageEvent[]>;

  /** Reported quota windows. [] when the vendor exposes none (API-key auth etc.). */
  quota(): Promise<QuotaWindow[]>;

  /** Byte offsets consumed so far, so a restart resumes instead of re-reading. */
  getTailOffsets(): Record<string, number>;
  setTailOffsets(offsets: Record<string, number>): void;
}

/** Cross-platform pid liveness. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours; ESRCH = gone.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
