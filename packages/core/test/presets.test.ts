/**
 * The presets are the first thing a new user sees, and the file is the
 * documentation — so a preset that fails to parse would teach the wrong schema
 * *and* silently fall back to defaults, which is the worst of both.
 *
 * This enumerates the directory rather than a hardcoded list, so a preset
 * added without a test cannot ship.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasErrors, parseConfig } from '../src/rules/config.js';
import { PRESET_NAMES, PRESET_SUMMARY, isPresetName } from '../src/rules/presets.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
const files = readdirSync(DIR).filter((f) => f.endsWith('.yaml'));
const read = (f: string): string => readFileSync(path.join(DIR, f), 'utf-8');

describe('every shipped preset', () => {
  it('is enumerated by PRESET_NAMES, with no file left behind', () => {
    expect(files.map((f) => f.replace(/\.yaml$/, '')).sort()).toEqual([...PRESET_NAMES].sort());
  });

  for (const file of files) {
    describe(file, () => {
      it('parses with no errors', () => {
        const { diagnostics } = parseConfig(read(file));
        // Print the offending paths if this ever fails — a bare boolean here
        // would send someone hunting.
        expect(diagnostics.filter((d) => d.level === 'error').map((d) => `${d.path}: ${d.message}`)).toEqual([]);
        expect(hasErrors(diagnostics)).toBe(false);
      });

      it('parses with no warnings either', () => {
        // A preset is the example everyone copies. It must not model a typo,
        // a deprecated key, or an unsorted level list.
        const { diagnostics } = parseConfig(read(file));
        expect(diagnostics.map((d) => `${d.path}: ${d.message}`)).toEqual([]);
      });

      it('actually yields rules rather than falling back to defaults', () => {
        const { config } = parseConfig(read(file));
        expect(config.rules.length).toBeGreaterThan(0);
        // Every rule keeps its id, which is what the fire log and the replay
        // report against.
        for (const r of config.rules) expect(r.id).toMatch(/\S/);
      });

      it('keeps its comments, because the file is the documentation', () => {
        const text = read(file);
        expect(text).toMatch(/^#/m);
        // Not merely a header: the rules themselves are explained.
        expect(text.split('\n').filter((l) => l.trim().startsWith('#')).length).toBeGreaterThan(4);
      });

      it('has a summary a chooser can show', () => {
        const name = file.replace(/\.yaml$/, '');
        expect(isPresetName(name)).toBe(true);
        expect(PRESET_SUMMARY[name as never]).toMatch(/\S/);
      });
    });
  }
});

describe('the presets differ in ways that matter', () => {
  const rulesOf = (f: string) => parseConfig(read(f)).config.rules;

  it('conservative interrupts less than default', () => {
    const d = rulesOf('default.yaml').find((r) => r.type === 'threshold')!;
    const c = rulesOf('conservative.yaml').find((r) => r.type === 'threshold')!;
    expect(c.type === 'threshold' && d.type === 'threshold').toBe(true);
    if (c.type === 'threshold' && d.type === 'threshold') {
      expect(c.levels.length).toBeLessThan(d.levels.length);
      expect(Math.min(...c.levels)).toBeGreaterThan(Math.min(...d.levels));
    }
  });

  it('weekly-guard watches the long limit with a long lead', () => {
    const pace = rulesOf('weekly-guard.yaml').find((r) => r.type === 'pace')!;
    expect(pace.type === 'pace' && pace.limit).toBe('7d');
    // A day's warning, not forty minutes: a weekly limit cannot be waited out.
    if (pace.type === 'pace') expect(pace.exhaustionLeadMin).toBeGreaterThanOrEqual(24 * 60);
  });

  it('fleet reacts to a single agent faster than default does', () => {
    const d = rulesOf('default.yaml').find((r) => r.type === 'agent_burn')!;
    const f = rulesOf('fleet.yaml').find((r) => r.type === 'agent_burn')!;
    if (d.type === 'agent_burn' && f.type === 'agent_burn') {
      expect(f.windowMin).toBeLessThan(d.windowMin);
      expect(f.cooldownMin).toBeLessThan(d.cooldownMin);
      // With many agents the median is meaningful, so a smaller multiple is
      // real signal rather than noise.
      expect(f.relToMedian).toBeLessThan(d.relToMedian);
    }
  });

  it('ci-gate pops nothing up', () => {
    const { config } = parseConfig(read('ci-gate.yaml'));
    expect(config.routing.info).toEqual([]);
    expect(config.routing.warn).toEqual([]);
    expect(config.routing.critical).not.toContain('toast');
  });
});
