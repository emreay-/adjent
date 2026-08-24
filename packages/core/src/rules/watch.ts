/**
 * Hot reload for `alarms.yaml`.
 *
 * ARCHITECTURE.md and ALARMS.md both promise this; the config was in fact read
 * once at startup, so tuning a rule meant restarting the app — which for a tray
 * app means losing the burn history that makes its numbers meaningful.
 *
 * Three things make this harder than `fs.watch` plus a re-read:
 *
 * 1. **Editors do not write in place.** Most write a temp file and rename over
 *    the target, which fires `rename` and leaves the original inode — and the
 *    original watch — pointing at nothing. The watch has to be re-armed.
 * 2. **A save is several events.** Writing a file commonly emits two or three
 *    `change` events, and re-parsing on each would re-arm alarms repeatedly.
 *    Hence the debounce.
 * 3. **A broken file must not silence the alarms.** Reverting to defaults on a
 *    syntax error would quietly replace someone's tuned rules with rules they
 *    never chose, at exactly the moment they are editing and not looking. The
 *    running config is kept, and the problem is reported once.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { parseConfig, type AlarmConfig, type Diagnostic } from './config.js';

/** How long to wait for an editor to finish before re-reading. */
const DEBOUNCE_MS = 250;
/** How long after a rename before re-arming; the file may not exist yet. */
const REARM_MS = 100;

export interface ConfigWatcherEvents {
  /** A new, valid config. The caller applies it. */
  config: (config: AlarmConfig) => void;
  /** The file changed but could not be used. The running config still stands. */
  invalid: (diagnostics: Diagnostic[]) => void;
}

/**
 * Watches one file and emits `config` or `invalid`.
 *
 * Watches the *directory*, not the file: a rename-in-place replaces the inode,
 * and a file watch follows the inode rather than the name. Directory watching
 * is the only way to see an editor's save as a change to `alarms.yaml`.
 */
export class ConfigWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastText: string | null = null;
  private closed = false;

  constructor(
    private readonly file: string,
    private readonly debounceMs: number = DEBOUNCE_MS,
  ) {
    super();
  }

  start(): void {
    this.closed = false;
    this.arm();
  }

  private arm(): void {
    if (this.closed) return;
    this.watcher?.close();
    this.watcher = null;
    try {
      const dir = path.dirname(this.file);
      const base = path.basename(this.file);
      this.watcher = fsWatch(dir, (eventType, name) => {
        if (name !== null && name !== base) return;
        this.schedule();
        // A rename detaches the watch from whatever it was following, so take
        // it from the top rather than silently going deaf.
        if (eventType === 'rename') setTimeout(() => this.arm(), REARM_MS);
      });
      // A watch that dies must not take the app with it, and must not leave
      // the caller believing reload still works.
      this.watcher.on('error', () => setTimeout(() => this.arm(), REARM_MS));
    } catch {
      /* directory missing: nothing to watch yet, and that is not an error */
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, this.debounceMs);
  }

  /** Read, parse, and emit. Exposed so a test need not wait on a watcher. */
  async reload(): Promise<void> {
    if (this.closed) return;
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf-8');
    } catch {
      // Deleted, or mid-rename. Keep running on what we have: a missing file
      // is not an instruction to stop alarming.
      return;
    }

    // Editors touch files without changing them, and several events arrive per
    // save. Re-applying identical text would re-arm every threshold.
    if (text === this.lastText) return;
    this.lastText = text;

    const { config, diagnostics } = parseConfig(text);
    const errors = diagnostics.filter((d) => d.level === 'error');
    if (errors.length > 0) {
      this.emit('invalid', diagnostics);
      return;
    }
    this.emit('config', config);
  }

  /** Prime from the file on disk without emitting — the startup baseline. */
  async prime(): Promise<void> {
    try {
      this.lastText = await fs.readFile(this.file, 'utf-8');
    } catch {
      this.lastText = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
