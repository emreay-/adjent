/**
 * Byte-offset incremental JSONL reading (docs/ARCHITECTURE.md § Collection loop).
 * Offsets persist per file so restarts do not re-parse gigabytes; a file that
 * shrinks (rewritten transcript) is re-read from zero and the requestId dedup
 * upstream keeps the ledger idempotent.
 */
import { promises as fs } from 'node:fs';

export interface TailState {
  /** absolute path → byte offset already consumed */
  offsets: Record<string, number>;
}

export const emptyTailState = (): TailState => ({ offsets: {} });

export interface TailResult {
  lines: string[];
  /** true when the file had shrunk and was restarted from zero */
  restarted: boolean;
}

/** Read complete lines appended since the recorded offset. Never throws on FS races. */
export async function tailFile(state: TailState, path: string): Promise<TailResult> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path, 'r');
    const stat = await handle.stat();
    let start = state.offsets[path] ?? 0;
    let restarted = false;
    if (stat.size < start) {
      start = 0; // rewritten / truncated (compaction)
      restarted = true;
    }
    if (stat.size === start) return { lines: [], restarted: false };

    const length = stat.size - start;
    const buf = Buffer.alloc(Number(length));
    await handle.read(buf, 0, buf.length, start);

    // Only consume up to the last newline — a partially-written trailing line
    // is left for the next tail.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return { lines: [], restarted };
    state.offsets[path] = start + lastNl + 1;

    const text = buf.subarray(0, lastNl).toString('utf-8');
    const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
    return { lines, restarted };
  } catch {
    return { lines: [], restarted: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Additive-tolerant JSON parse: unknown fields ignored by callers, bad lines yield null, never throw. */
export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Narrowing helpers for defensive parsing (missing optionals → null, never throw).
export const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
