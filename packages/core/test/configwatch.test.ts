/**
 * Hot reload, against a real temp directory and real writes.
 *
 * A mocked filesystem would prove nothing here: the interesting cases are all
 * filesystem behaviour — an editor renaming over the file, one save arriving as
 * several events, a file that briefly does not exist mid-rename.
 *
 * The rule the whole design turns on: **a broken file keeps the running
 * config.** Reverting to defaults would quietly replace someone's tuned rules
 * with rules they never chose, at the exact moment they are editing and not
 * looking at the tray.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ConfigWatcher } from '../src/rules/watch.js';
import type { AlarmConfig, Diagnostic } from '../src/rules/config.js';

let dir: string;
let file: string;
let watcher: ConfigWatcher | null = null;

const VALID = (levels: number[]): string => `
alarms:
  - id: steps
    type: threshold
    levels: [${levels.join(', ')}]
`;
const BROKEN = 'alarms:\n  - id: a\n    type: teleport\n';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adjent-watch-'));
  file = path.join(dir, 'alarms.yaml');
});
afterEach(() => {
  watcher?.close();
  watcher = null;
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  configs: AlarmConfig[];
  invalid: Diagnostic[][];
}

/** Start a watcher with a short debounce and collect what it emits. */
function start(debounceMs = 20): Seen {
  const seen: Seen = { configs: [], invalid: [] };
  watcher = new ConfigWatcher(file, debounceMs);
  watcher.on('config', (c: AlarmConfig) => seen.configs.push(c));
  watcher.on('invalid', (d: Diagnostic[]) => seen.invalid.push(d));
  return seen;
}

/** Wait for the debounce plus filesystem latency, without a fixed long sleep. */
const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('reloading', () => {
  it('picks up an edit without a restart', async () => {
    writeFileSync(file, VALID([25, 50]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, VALID([80, 95]));
    await settle();

    expect(seen.configs).toHaveLength(1);
    const rule = seen.configs[0]!.rules[0]!;
    expect(rule.type === 'threshold' && rule.levels).toEqual([80, 95]);
  });

  it('survives an editor that renames over the file', async () => {
    // Most editors write a temp file and rename. A watch on the file itself
    // follows the old inode and goes deaf; this is the case that catches it.
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    const tmp = path.join(dir, 'alarms.yaml.tmp');
    writeFileSync(tmp, VALID([90]));
    renameSync(tmp, file);
    await settle();

    expect(seen.configs.length).toBeGreaterThanOrEqual(1);
    const last = seen.configs[seen.configs.length - 1]!.rules[0]!;
    expect(last.type === 'threshold' && last.levels).toEqual([90]);
  });

  it('reloads twice in a row', async () => {
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, VALID([50]));
    await settle();
    writeFileSync(file, VALID([75]));
    await settle();

    expect(seen.configs).toHaveLength(2);
  });

  it('creates-then-loads a config that did not exist at startup', async () => {
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, VALID([60]));
    await settle();

    expect(seen.configs).toHaveLength(1);
  });
});

describe('not reloading', () => {
  it('says nothing when the file is rewritten unchanged', async () => {
    // Editors touch files without changing them, and one save arrives as
    // several events. Re-applying identical text would re-arm every threshold.
    const text = VALID([25, 50]);
    writeFileSync(file, text);
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, text);
    writeFileSync(file, text);
    await settle();

    expect(seen.configs).toEqual([]);
  });

  it('emits once for a burst of writes, not once per event', async () => {
    writeFileSync(file, VALID([25]));
    const seen = start(50);
    await watcher!.prime();
    watcher!.start();

    for (const l of [[30], [40], [50]]) writeFileSync(file, VALID(l));
    await settle(300);

    expect(seen.configs).toHaveLength(1);
    const rule = seen.configs[0]!.rules[0]!;
    expect(rule.type === 'threshold' && rule.levels).toEqual([50]);
  });

  it('keeps the running rules when the file is deleted', async () => {
    // A missing file is not an instruction to stop alarming.
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    unlinkSync(file);
    await settle();

    expect(seen.configs).toEqual([]);
    expect(seen.invalid).toEqual([]);
  });
});

describe('a file with an error in it', () => {
  it('reports the problem and does not emit a config', async () => {
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, BROKEN);
    await settle();

    // The running config stands: no `config` event means nothing was replaced.
    expect(seen.configs).toEqual([]);
    expect(seen.invalid).toHaveLength(1);
    expect(seen.invalid[0]![0]).toMatchObject({ level: 'error', path: 'alarms[0].type' });
  });

  it('reports invalid YAML the same way', async () => {
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, 'alarms: [\n  - id: a\n   type: broken\n');
    await settle();

    expect(seen.configs).toEqual([]);
    expect(seen.invalid).toHaveLength(1);
  });

  it('recovers when the file is fixed', async () => {
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, BROKEN);
    await settle();
    writeFileSync(file, VALID([95]));
    await settle();

    expect(seen.invalid).toHaveLength(1);
    expect(seen.configs).toHaveLength(1);
    const rule = seen.configs[0]!.rules[0]!;
    expect(rule.type === 'threshold' && rule.levels).toEqual([95]);
  });

  it('accepts a file whose only problems are warnings', async () => {
    // A typo costs a setting, not the whole config — it must still load.
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();

    writeFileSync(file, 'alarms:\n  - id: a\n    type: pace\n    tolerence_pp: 15\n');
    await settle();

    expect(seen.invalid).toEqual([]);
    expect(seen.configs).toHaveLength(1);
  });
});

describe('shutting down', () => {
  it('stops emitting once closed', async () => {
    writeFileSync(file, VALID([25]));
    const seen = start();
    await watcher!.prime();
    watcher!.start();
    watcher!.close();

    writeFileSync(file, VALID([90]));
    await settle();

    expect(seen.configs).toEqual([]);
  });

  it('can be closed twice without complaint', () => {
    start();
    watcher!.close();
    expect(() => watcher!.close()).not.toThrow();
  });
});
