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
    expect(s.trayStyle).toBe('robot');
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

describe('explanations', () => {
  it('every UI tip key resolves and is written to the copy rules', async () => {
    const { EXPLANATIONS, EXPLANATION_KEYS, PROVENANCE_NOTE, explain } = await import('../src/explain.js');
    // Keys referenced by the panel/widget renderers must all exist.
    const used = [
      'hero', 'binding', 'burnRate', 'resets', 'verdict', 'paceLine', 'chart',
      'exhausts', 'tokens', 'agentBurn', 'otherLimits', 'scoped', 'stale',
      'confidence', 'epsilon', 'effort', 'model', 'idle', 'liveCount',
    ];
    for (const k of used) expect(EXPLANATION_KEYS, k).toContain(k);

    for (const [key, e] of Object.entries(EXPLANATIONS)) {
      expect(e.title.length, key).toBeGreaterThan(3);
      expect(e.body.length, key).toBeGreaterThan(40);
      // No raw field names leaking into user-facing copy (docs/UI.md copy rules).
      expect(e.body, key).not.toMatch(/resets_at|used_percent|window_minutes/);
      if (e.provenance) expect(PROVENANCE_NOTE[e.provenance]).toBeTruthy();
    }
    expect(explain('nope')).toBeNull();
  });

  it('theme is clamped to the three valid values', async () => {
    const { coerceSettings } = await import('../src/settings.js');
    expect(coerceSettings({ theme: 'light' }).theme).toBe('light');
    expect(coerceSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(coerceSettings({ theme: 'neon' }).theme).toBe('system');
    expect(coerceSettings({}).theme).toBe('system');
  });
});

describe('vendorDisplay', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.vendorDisplay).toBe('none');
  });

  it('accepts the two modes that mean something', () => {
    expect(coerceSettings({ vendorDisplay: 'name' }).vendorDisplay).toBe('name');
    expect(coerceSettings({ vendorDisplay: 'icon' }).vendorDisplay).toBe('icon');
  });

  it('falls back to off for anything else', () => {
    // A value from a newer version, or a typo, must not leave the panel
    // rendering a mode it has no markup for.
    expect(coerceSettings({ vendorDisplay: 'logos' }).vendorDisplay).toBe('none');
    expect(coerceSettings({ vendorDisplay: 3 }).vendorDisplay).toBe('none');
    expect(coerceSettings({}).vendorDisplay).toBe('none');
  });
});
