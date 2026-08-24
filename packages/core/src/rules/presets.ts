/**
 * Starting rule sets.
 *
 * The YAML is shipped verbatim, **comments and all**, because the file itself
 * is the documentation a person will actually read. A preset that arrived as a
 * generated dump of parsed rules would teach nothing about the schema and
 * would be worse than no preset.
 *
 * Read from disk rather than embedded as strings so the `.yaml` files stay the
 * single source of truth — the same bytes are what the tests parse and what
 * `rules init` writes.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRESET_NAMES = ['default', 'conservative', 'weekly-guard', 'fleet', 'ci-gate'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const PRESET_SUMMARY: Record<PresetName, string> = {
  default: "Adjent's built-in rules: pace, four thresholds, and a runaway-agent check.",
  conservative: 'Two high thresholds and long cooldowns — told once, late, rather than often.',
  'weekly-guard': "Watches the 7-day limit with a day's lead. \"Don't burn the week by Tuesday.\"",
  fleet: 'Per-agent detection tuned for four to ten agents at once; sparse whole-limit steps.',
  'ci-gate': 'Near-silent, to pair with `adjent check` in a script.',
};

export const isPresetName = (name: string): name is PresetName =>
  (PRESET_NAMES as readonly string[]).includes(name);

/**
 * Where the `.yaml` files live at runtime.
 *
 * `dist/rules/presets.js` → `dist/presets/`, populated by the build's copy
 * step. Resolved from this module's own URL rather than the process's working
 * directory, which is wherever the user happened to be standing.
 */
export const presetsDir = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');

/** The preset's YAML exactly as shipped — comments included. */
export async function readPreset(name: PresetName, dir: string = presetsDir()): Promise<string> {
  return fs.readFile(path.join(dir, `${name}.yaml`), 'utf-8');
}
