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
  /** Oversized records skipped in this process; providers expose degraded health. */
  skippedLines?: number;
}

const READ_BYTES = 64 * 1024;
/** Return roughly this much complete-line data per tick, rather than a whole history. */
export const TAIL_BATCH_BYTES = 1024 * 1024;
/** A pathological transcript record must not exhaust the monitor's memory. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export const emptyTailState = (): TailState => ({ offsets: {} });

export interface TailResult {
  lines: string[];
  /** true when the file had shrunk and was restarted from zero */
  restarted: boolean;
}

/** Read complete lines appended since the recorded offset. Never throws on FS races. */
export async function tailFile(state: TailState, path: string): Promise<TailResult> {
  let handle: fs.FileHandle | null = null;
  const lines: string[] = [];
  let restarted = false;
  try {
    handle = await fs.open(path, 'r');
    const stat = await handle.stat();
    let start = state.offsets[path] ?? 0;
    if (stat.size < start) {
      start = 0; // rewritten / truncated (compaction)
      restarted = true;
    }
    // Persist the rewind even if a truncated file contains no complete line yet.
    if (restarted) state.offsets[path] = 0;
    if (stat.size === start) return { lines: [], restarted };
    let chunks: Buffer[] = [];
    let lineBytes = 0;
    let batchBytes = 0;
    let oversized = false;
    let position = start;
    while (position < stat.size) {
      const buf = Buffer.alloc(Math.min(READ_BYTES, stat.size - position));
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break; // file changed after stat
      let from = 0;
      while (from < bytesRead) {
        const found = buf.indexOf(0x0a, from);
        const newline = found >= 0 && found < bytesRead ? found : -1;
        const end = newline < 0 ? bytesRead : newline;
        lineBytes += end - from;
        if (lineBytes > MAX_LINE_BYTES) {
          oversized = true;
          chunks = [];
        } else if (!oversized) {
          chunks.push(buf.subarray(from, end));
        }
        if (newline < 0) break;
        if (oversized) {
          state.skippedLines = (state.skippedLines ?? 0) + 1;
        } else {
          const text = Buffer.concat(chunks, lineBytes).toString('utf-8');
          const line = text.endsWith('\r') ? text.slice(0, -1) : text;
          if (line.length > 0) lines.push(line);
        }
        state.offsets[path] = position + newline + 1;
        batchBytes += lineBytes + 1;
        chunks = [];
        lineBytes = 0;
        oversized = false;
        if (batchBytes >= TAIL_BATCH_BYTES) return { lines, restarted };
        from = newline + 1;
      }
      position += bytesRead;
    }
    // A partial final record remains behind the offset for the next tick.
    return { lines, restarted };
  } catch {
    // Offsets already advanced over these complete records. Returning an empty
    // batch after a later read race would silently lose their usage forever.
    return { lines, restarted };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read a bounded slice of a file as complete lines, ignoring tail offsets.
 *
 * `tailFile` answers "what is new"; this answers "what does this file already
 * say", which is a different question and the one identity lookups ask. A
 * session's model is written once, near the top, and again on each turn
 * context — so after a restart the offsets are past all of it and incremental
 * reading can never recover it, however long it waits.
 *
 * Bounded on purpose: transcripts reach hundreds of megabytes, and the answer
 * is always near one end or the other.
 */
async function readChunk(path: string, bytes: number, from: 'head' | 'tail'): Promise<string[]> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path, 'r');
    const { size } = await handle.stat();
    if (size === 0) return [];
    const length = Math.min(bytes, size);
    const start = from === 'head' ? 0 : size - length;
    const buf = Buffer.alloc(Number(length));
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    // A window into the middle of a file starts and ends mid-line; drop the
    // fragments rather than handing a caller half a JSON object.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    if (start + length < size) {
      const nl = text.lastIndexOf('\n');
      text = nl === -1 ? '' : text.slice(0, nl);
    }
    return text
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .filter((l) => l.length > 0);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Complete lines from the start of a file — where session metadata lives. */
export const headChunk = (path: string, bytes: number): Promise<string[]> => readChunk(path, bytes, 'head');

/** Complete lines from the end of a file — where the latest turn lives. */
export const tailChunk = (path: string, bytes: number): Promise<string[]> => readChunk(path, bytes, 'tail');

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
