/** Settings persistence + clamping. All values synthetic. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, coerceSettings, loadSettings, saveSettings } from '../src/settings.js';

describe('settings', () => {
  it('clamps out-of-range values instead of rejecting them', () => {
    const s = coerceSettings({ uiScale: 99, tickIntervalSec: 1, trayThickness: 5, trayStyle: 'nonsense' });
    expect(s.uiScale).toBe(2.0);
    expect(s.tickIntervalSec).toBe(10);
    expect(s.trayThickness).toBe(0.5);
    expect(s.trayStyle).toBe('ring');
  });

  it('a missing or corrupt file degrades to defaults', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adjent-set-'));
    try {
      expect(await loadSettings(path.join(dir, 'nope.json'))).toEqual(DEFAULT_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips through disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adjent-set-'));
    const file = path.join(dir, 'nested', 'settings.json');
    try {
      await saveSettings({ ...DEFAULT_SETTINGS, uiScale: 1.3, widgetEnabled: true }, file);
      const back = await loadSettings(file);
      expect(back.uiScale).toBe(1.3);
      expect(back.widgetEnabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
