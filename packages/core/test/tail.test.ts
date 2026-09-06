import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { emptyTailState, MAX_LINE_BYTES, TAIL_BATCH_BYTES, tailFile } from '../src/collect/tail.js';

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'adjent-tail-'));
  file = path.join(root, 'synthetic.jsonl');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('bounded transcript tails', () => {
  it('catches up over batches without losing or repeating records', async () => {
    const lines = Array.from({ length: 5_000 }, (_, id) => JSON.stringify({ id, padding: 'x'.repeat(500) }));
    await writeFile(file, lines.join('\n') + '\n');
    const state = emptyTailState();
    const first = await tailFile(state, file);
    expect(first.lines.length).toBeLessThan(lines.length);
    expect(state.offsets[file]).toBeLessThan(TAIL_BATCH_BYTES + 600);
    const seen = [...first.lines];
    for (;;) {
      const next = await tailFile(state, file);
      if (!next.lines.length) break;
      seen.push(...next.lines);
    }
    expect(seen).toEqual(lines);
  });

  it('preserves UTF-8 across read boundaries and waits for partial final records', async () => {
    const line = JSON.stringify({ text: 'x'.repeat(65_520) + '🙂'.repeat(20) });
    await writeFile(file, line + '\r\n' + '{"id":');
    const state = emptyTailState();
    expect((await tailFile(state, file)).lines).toEqual([line]);
    await appendFile(file, '2}\n');
    expect((await tailFile(state, file)).lines).toEqual(['{"id":2}']);
  });

  it('rewinds a truncated file even when its replacement starts incomplete', async () => {
    await writeFile(file, '{"id":"old-record"}\n');
    const state = emptyTailState();
    await tailFile(state, file);
    await writeFile(file, '{"id":');
    expect((await tailFile(state, file)).restarted).toBe(true);
    expect(state.offsets[file]).toBe(0);
    await appendFile(file, '3}\n');
    expect((await tailFile(state, file)).lines).toEqual(['{"id":3}']);
  });

  it('skips pathological records with a diagnostic and reaches later metadata', async () => {
    await writeFile(file, 'x'.repeat(MAX_LINE_BYTES + 1) + '\n{"id":4}\n');
    const state = emptyTailState();
    expect((await tailFile(state, file)).lines).toEqual([]);
    expect(state.skippedLines).toBe(1);
    expect((await tailFile(state, file)).lines).toEqual(['{"id":4}']);
  });

  it('remembers truncation to an empty file before a larger replacement arrives', async () => {
    await writeFile(file, 'old\n');
    const state = emptyTailState();
    await tailFile(state, file);
    await writeFile(file, '');
    expect((await tailFile(state, file)).restarted).toBe(true);
    await appendFile(file, 'replacement\n');
    expect((await tailFile(state, file)).lines).toEqual(['replacement']);
  });

  it('returns already-consumed records if a later chunk read fails', async () => {
    let reads = 0;
    const close = vi.fn(async () => {});
    vi.spyOn(fs, 'open').mockResolvedValueOnce({
      stat: async () => ({ size: 100_000 }),
      read: async (buffer: Buffer) => {
        if (reads++) throw new Error('Synthetic read race');
        buffer.write('first\n');
        return { bytesRead: 6 };
      },
      close,
    } as unknown as fs.FileHandle);
    const state = emptyTailState();
    expect((await tailFile(state, file)).lines).toEqual(['first']);
    expect(state.offsets[file]).toBe(6);
    expect(close).toHaveBeenCalledOnce();
  });
});
