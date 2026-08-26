/**
 * Writing alarms.yaml, which the panel's rules editor does on every save.
 *
 * The file is watched. A plain write is briefly a truncated document, and the
 * watcher would read it, report it as broken, and raise a toast describing a
 * state that no longer exists by the time it appears — so the write has to be
 * atomic, and these run against a real filesystem because that is the only
 * place the property is true or false.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { saveConfigText, loadConfig, parseConfig } from '../src/rules/config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adjent-save-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RULES = 'alarms:\n  - id: steps\n    type: threshold\n    levels: [80, 95]\n';

describe('saving a config', () => {
  it('writes the bytes it was given, verbatim', async () => {
    // Comments are the documentation someone will actually read; a save that
    // round-tripped through the parser would delete every one of them.
    const commented = `# my rules\n${RULES}# end\n`;
    const file = path.join(dir, 'alarms.yaml');
    await saveConfigText(commented, file);
    expect(readFileSync(file, 'utf-8')).toBe(commented);
  });

  it('creates the directory when this is the first thing in it', async () => {
    const file = path.join(dir, 'fresh', 'alarms.yaml');
    await saveConfigText(RULES, file);
    expect(readFileSync(file, 'utf-8')).toBe(RULES);
  });

  it('leaves no temporary file behind for the watcher to trip over', async () => {
    const file = path.join(dir, 'alarms.yaml');
    await saveConfigText(RULES, file);
    expect(readdirSync(dir)).toEqual(['alarms.yaml']);
  });

  it('replaces an existing file rather than appending to it', async () => {
    const file = path.join(dir, 'alarms.yaml');
    writeFileSync(file, 'alarms:\n  - id: old\n    type: pace\n');
    await saveConfigText(RULES, file);
    const back = readFileSync(file, 'utf-8');
    expect(back).toBe(RULES);
    expect(back).not.toContain('id: old');
  });

  it('produces a file the loader reads back as what was meant', async () => {
    // The round trip is the whole promise of the editor: what the "what will
    // run" list showed before the save is what is in force after it.
    const file = path.join(dir, 'alarms.yaml');
    const expected = parseConfig(RULES).config;
    await saveConfigText(RULES, file);
    expect(await loadConfig(file)).toEqual(expected);
  });
});
