/**
 * Config diagnostics.
 *
 * `loadConfig` is deliberately lenient: a broken file degrades to defaults,
 * never to silence, because an alarm engine that quietly stops alarming is the
 * worst failure available to it. The cost of that leniency is that a typo
 * costs you a rule and says nothing — which is what these diagnostics are for.
 *
 * The invariant running through this file: **reporting must never change what
 * runs.** Every test that asserts a diagnostic also asserts the config is what
 * the lenient path would have produced.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, hasErrors, parseConfig, type Diagnostic } from '../src/rules/config.js';

const at = (d: Diagnostic[], path: string): Diagnostic | undefined => d.find((x) => x.path === path);
const paths = (d: Diagnostic[]): string[] => d.map((x) => x.path);

describe('a healthy file', () => {
  it('reports nothing at all', () => {
    const { config, diagnostics } = parseConfig(`
alarms:
  - id: pace-any
    type: pace
    scope: { backend: any, limit: any }
    tolerance_pp: 10
    cooldown: 20m
  - id: steps
    type: threshold
    levels: [25, 50, 80, 95]
    severity: { 25: info, 50: info, 80: warn, 95: critical }
routing:
  info: [tray]
  warn: [tray, toast]
`);
    expect(diagnostics).toEqual([]);
    expect(config.rules.map((r) => r.id)).toEqual(['pace-any', 'steps']);
  });
});

describe('typos, which is most of the value', () => {
  it('catches a misspelled key instead of silently ignoring it', () => {
    // The 2am mistake: the rule loads, the setting does nothing.
    const { config, diagnostics } = parseConfig(`
alarms:
  - id: pace-any
    type: pace
    tolerence_pp: 25
`);
    const d = at(diagnostics, 'alarms[0].tolerence_pp');
    expect(d?.level).toBe('warn');
    expect(d?.message).toContain('unknown key');
    expect(d?.message).toContain('tolerance_pp');
    // Still loads, still uses the default — reporting changed nothing.
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]).toMatchObject({ id: 'pace-any', tolerancePp: 10 });
  });

  it('catches an unknown key inside scope and trigger too', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: pace
    scope: { backned: claude }
  - id: b
    type: agent_burn
    trigger: { share_pct: 60, shrae_pct: 70 }
`);
    expect(paths(diagnostics)).toContain('alarms[0].scope.backned');
    expect(paths(diagnostics)).toContain('alarms[1].trigger.shrae_pct');
  });

  it('does not complain about keys a rule type legitimately has', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: burn
    type: agent_burn
    window: 10m
    cooldown: 15m
    trigger: { rel_to_median: 4, share_pct: 60, abs_pct_per_hour: 8 }
`);
    expect(diagnostics).toEqual([]);
  });
});

describe('values that are the wrong shape', () => {
  it('reports a number written as a word', () => {
    const { config, diagnostics } = parseConfig(`
alarms:
  - id: a
    type: pace
    tolerance_pp: ten
`);
    expect(at(diagnostics, 'alarms[0].tolerance_pp')).toMatchObject({ level: 'error' });
    expect(at(diagnostics, 'alarms[0].tolerance_pp')?.message).toContain('expected a number');
    expect(config.rules[0]).toMatchObject({ tolerancePp: 10 });
  });

  it('accepts every duration spelling the loader accepts', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: pace
    cooldown: 20m
  - id: b
    type: pace
    cooldown: 1h
  - id: c
    type: pace
    cooldown: 45
`);
    expect(diagnostics).toEqual([]);
  });

  it('reports a duration it cannot read', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: pace
    cooldown: soon
`);
    expect(at(diagnostics, 'alarms[0].cooldown')?.level).toBe('error');
  });
});

describe('rules that will be dropped', () => {
  it('reports an unknown type and says the rule is ignored', () => {
    const { config, diagnostics } = parseConfig(`
alarms:
  - id: a
    type: teleport
`);
    const d = at(diagnostics, 'alarms[0].type');
    expect(d?.level).toBe('error');
    expect(d?.message).toContain('ignored');
    // No rules survived, so the defaults stand — the documented behaviour.
    expect(config.rules).toEqual(DEFAULT_CONFIG.rules);
  });

  it('reports a rule with no id', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - type: pace
`);
    expect(at(diagnostics, 'alarms[0].id')?.level).toBe('error');
  });

  it('keeps the good rule and reports only the bad one', () => {
    // The acceptance case.
    const { config, diagnostics } = parseConfig(`
alarms:
  - id: good
    type: pace
    tolerance_pp: 15
  - id: bad
    type: nonsense
`);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]).toMatchObject({ id: 'good', tolerancePp: 15 });
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe('alarms[1].type');
  });
});

describe('problems that are invisible at runtime', () => {
  it('reports a duplicate id, because the fire log keys on it', () => {
    // Two rules with one id silently share cooldown state.
    const { diagnostics } = parseConfig(`
alarms:
  - id: same
    type: pace
  - id: same
    type: threshold
`);
    expect(at(diagnostics, 'alarms[1].id')).toMatchObject({ level: 'error' });
    expect(at(diagnostics, 'alarms[1].id')?.message).toContain('duplicate');
  });

  it('reports unsorted levels, which would announce out of order', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: threshold
    levels: [80, 25, 95]
`);
    const d = at(diagnostics, 'alarms[0].levels');
    expect(d?.level).toBe('warn');
    expect(d?.message).toContain('[25,80,95]');
  });

  it('reports empty levels and says the defaults are used', () => {
    const { config, diagnostics } = parseConfig(`
alarms:
  - id: a
    type: threshold
    levels: []
`);
    expect(at(diagnostics, 'alarms[0].levels')?.message).toContain('default');
    expect(config.rules[0]).toMatchObject({ levels: [25, 50, 80, 95] });
  });

  it('flags the deprecated window key as a scope', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: pace
    scope: { window: 7d }
`);
    const d = at(diagnostics, 'alarms[0].scope.window');
    expect(d?.level).toBe('warn');
    expect(d?.message).toContain('limit');
  });

  it('does not flag window on agent_burn, where it is a time span', () => {
    // GLOSSARY: `window` survives for a duration, not for a scope.
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: agent_burn
    window: 10m
`);
    expect(diagnostics).toEqual([]);
  });
});

describe('the file as a whole', () => {
  it('reports invalid YAML without throwing, and still yields defaults', () => {
    const { config, diagnostics } = parseConfig('alarms: [\n  - id: a\n   type: broken\n');
    expect(hasErrors(diagnostics)).toBe(true);
    expect(diagnostics[0]!.path).toBe('$');
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('reports an empty file as a warning, not an error', () => {
    const { config, diagnostics } = parseConfig('');
    expect(diagnostics[0]).toMatchObject({ level: 'warn', path: '$' });
    expect(hasErrors(diagnostics)).toBe(false);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('reports a top-level list, which is a common shape mistake', () => {
    const { diagnostics } = parseConfig('- id: a\n  type: pace\n');
    expect(at(diagnostics, '$')?.level).toBe('error');
  });

  it('reports an unknown top-level key', () => {
    const { diagnostics } = parseConfig('alarms: []\nrouteing:\n  info: [tray]\n');
    expect(at(diagnostics, '$.routeing')?.level).toBe('warn');
  });

  it('reports routing that is not a list of sinks', () => {
    const { diagnostics } = parseConfig('alarms: []\nrouting:\n  warn: tray\n');
    expect(at(diagnostics, '$.routing.warn')?.level).toBe('error');
  });

  it('separates errors from warnings', () => {
    const { diagnostics } = parseConfig(`
alarms:
  - id: a
    type: pace
    tolerence_pp: 5
  - id: b
    type: nope
`);
    expect(hasErrors(diagnostics)).toBe(true);
    expect(diagnostics.filter((d) => d.level === 'warn')).toHaveLength(1);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(1);
  });
});
