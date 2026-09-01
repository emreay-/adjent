/**
 * The command table, driven with an injected Monitor.
 *
 * No process is spawned and no real home directory is touched: every command
 * is a function of `(ctx, flags)` returning an exit code, with both streams
 * collected. That is the whole reason the table exists as a separate module.
 *
 * The property under test throughout is the one a script depends on:
 * **stdout carries exactly one JSON object and nothing else.** A stray warning
 * on stdout is invisible to a human and fatal to a pipe.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS, type Ctx, type MonitorLike } from '../src/commands.js';
import { parseArgs, parseDuration, parsePercent } from '../src/args.js';
import { EXIT } from '../src/exit.js';
import type { AppState } from '@adjent/core';

const T0 = 1_700_000_000_000;
const H = 3600_000;
const MACHINE = '11111111-2222-4333-8444-555555555555';

function state(over: Partial<AppState> = {}): AppState {
  return {
    generatedAt: T0,
    backends: [
      {
        id: 'claude',
        displayName: 'Claude Code',
        version: '2.1.0',
        plan: 'demo',
        rateLimitTier: null,
        health: 'ok',
        healthDetail: null,
      },
    ],
    agents: [
      {
        id: 'claude:a1',
        backend: 'claude',
        label: 'demo',
        projectPath: '/w/demo',
        gitBranch: 'main',
        model: 'model-x',
        effort: 'high',
        entrypoint: 'cli',
        parentId: null,
        pid: 1,
        state: 'live',
        startedAt: T0 - H,
        lastActivityAt: T0,
        totals: { input: 100, cacheWrite: 0, cacheRead: 1000, output: 50, thinking: 0 },
      },
    ],
    limits: [
      {
        limit: {
          backend: 'claude',
          key: '5h',
          label: 'Claude · 5h',
          windowMinutes: 300,
          utilization: 32,
          resetsAt: T0 + 3 * H,
          severity: null,
          vendorActive: false,
          scope: null,
          source: 'reported',
          observedAt: T0,
        },
        burn: { pctPerHour: 8.1, updatedAt: T0 },
        verdict: 'on-pace',
        paceLinePct: 40,
        exhaustsAt: null,
        binding: true,
        tokens: { input: 100, cacheWrite: 0, cacheRead: 1000, output: 50 },
      },
    ],
    agentBurns: [{ agentId: 'claude:a1', pctPerHour: 4.2, confidence: 'high' }],
    epsilon: 0.5,
    fitConfidence: 'high',
    ...over,
  };
}

const EMPTY: AppState = {
  generatedAt: T0,
  backends: [],
  agents: [],
  limits: [],
  agentBurns: [],
  epsilon: null,
  fitConfidence: 'low',
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  ticks: number;
}

/** Drive one command with a scripted config file. */
async function runWith(
  name: string,
  argv: string[],
  appState: AppState,
  readFile: (p: string) => Promise<string>,
): Promise<Run> {
  return drive(name, argv, appState, readFile);
}

/** Drive one command and collect everything it produced. */
async function run(name: string, argv: string[], appState: AppState = state()): Promise<Run> {
  return drive(name, argv, appState, () => Promise.reject(new Error('no config in this test')));
}

async function drive(
  name: string,
  argv: string[],
  appState: AppState,
  readFile: (p: string) => Promise<string>,
): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let ticks = 0;
  const monitor: MonitorLike = {
    tick: async () => {
      ticks += 1;
      return appState;
    },
  };
  const ctx: Ctx = {
    monitor,
    machineId: MACHINE,
    configPath: '/fake/alarms.yaml',
    historyPath: '/fake/history.jsonl',
    readFile,
    writeFile: async () => {},
    readPreset: (n) => Promise.resolve(`# preset ${n}
alarms: []
`),
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
  };
  const { flags, error } = parseArgs(argv);
  expect(error, `argv did not parse: ${argv.join(' ')}`).toBeNull();
  const code = await COMMANDS[name]!(ctx, flags);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), ticks };
}

/** stdout must be exactly one JSON object — the contract a pipe depends on. */
function soleJson(r: Run): Record<string, unknown> {
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  expect(lines, 'stdout carried more than one line').toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------- args
describe('argument parsing', () => {
  it('rejects an unknown flag rather than ignoring it', () => {
    // `--jsn` silently producing human output would feed a parser prose.
    expect(parseArgs(['--jsn']).error).toMatch(/unknown flag/);
  });

  it('accepts a value flag in both spellings', () => {
    expect(parseArgs(['--limit', '7d']).flags.values['limit']).toBe('7d');
    expect(parseArgs(['--limit=7d']).flags.values['limit']).toBe('7d');
  });

  it('refuses a value flag with no value', () => {
    expect(parseArgs(['--limit']).error).toMatch(/needs a value/);
  });

  it('refuses a value attached to a boolean flag', () => {
    expect(parseArgs(['--json=yes']).error).toMatch(/does not take a value/);
  });

  it('stops parsing flags after --', () => {
    expect(parseArgs(['--json', '--', '--not-a-flag']).flags.positional).toEqual(['--not-a-flag']);
  });

  it('reads percentages the way a person writes them', () => {
    expect(parsePercent('20')).toBe(20);
    expect(parsePercent('20%')).toBe(20);
    expect(parsePercent('20.5%')).toBe(20.5);
    expect(parsePercent('twenty')).toBeNull();
  });

  it('reads durations the way a person writes them', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    // A bare number is minutes, which is what a poll interval usually means.
    expect(parseDuration('30')).toBe(1_800_000);
    expect(parseDuration('soon')).toBeNull();
  });
});

// ------------------------------------------------------------------ the pipe
describe('--json is a pipe contract', () => {
  for (const name of ['status', 'statusline', 'limits', 'agents']) {
    it(`${name} --json writes exactly one JSON object to stdout`, async () => {
      const r = await run(name, ['--json']);
      const obj = soleJson(r);
      expect(obj['schemaVersion']).toBe(1);
      expect(r.code).toBe(EXIT.OK);
    });
  }

  it('explain --json writes one object without collecting anything', async () => {
    const r = await run('explain', ['--json', 'hero']);
    expect(soleJson(r)['term']).toBe('hero');
    expect(r.ticks, 'explain answered from a static table, so it must not tick').toBe(0);
  });

  it('puts the degradation note on stderr, never on stdout', async () => {
    const r = await run('status', ['--json'], EMPTY);
    // Still valid JSON — an empty machine is an answer, not a failure.
    const obj = soleJson(r);
    expect((obj['snapshot'] as { limits: unknown[] }).limits).toEqual([]);
    expect(r.stderr).toMatch(/no backend detected/);
    expect(r.code).toBe(EXIT.NO_DATA);
  });

  it('reports no-data when a backend exists but reports no quota', async () => {
    const r = await run('status', ['--json'], { ...state(), limits: [] });
    expect(r.code).toBe(EXIT.NO_DATA);
    expect(r.stderr).toMatch(/no quota reported/);
  });

  it('names an unhealthy backend on stderr', async () => {
    const degraded = state({
      backends: [{ ...state().backends[0]!, health: 'degraded', healthDetail: 'format drift' }],
    });
    const r = await run('status', ['--json'], degraded);
    expect(r.stderr).toMatch(/claude: degraded — format drift/);
  });

  it('emits nothing at all under --quiet', async () => {
    const r = await run('status', ['--quiet']);
    expect(r.stdout).toBe('');
    expect(r.code).toBe(EXIT.OK);
  });
});

// ------------------------------------------------------------------ payloads
describe('json payloads', () => {
  it('status carries the whole snapshot', async () => {
    const snap = soleJson(await run('status', ['--json']))['snapshot'] as Record<string, unknown>;
    expect(snap['machineId']).toBe(MACHINE);
    expect((snap['limits'] as unknown[]).length).toBe(1);
    expect((snap['agents'] as unknown[]).length).toBe(1);
  });

  it('statusline answers one question, not the whole snapshot', async () => {
    const obj = soleJson(await run('statusline', ['--json']));
    const binding = obj['bindingLimit'] as Record<string, unknown>;
    expect(binding['bindingLimit']).toBe(true);
    expect(binding['key']).toBe('5h');
    // The rendered line rides along so a status bar needs no formatter.
    expect(obj['text']).toContain('32%');
  });

  it('statusline reports a null binding limit rather than omitting the key', async () => {
    const obj = soleJson(await run('statusline', ['--json'], EMPTY));
    expect(obj).toHaveProperty('bindingLimit');
    expect(obj['bindingLimit']).toBeNull();
  });

  it('limits and agents carry the published shape, not the internal one', async () => {
    const l = (soleJson(await run('limits', ['--json']))['limits'] as Record<string, unknown>[])[0]!;
    expect(l).toHaveProperty('bindingLimit');
    expect(l).toHaveProperty('burnPctPerHour');
    expect(l).not.toHaveProperty('binding');

    const a = (soleJson(await run('agents', ['--json']))['agents'] as Record<string, unknown>[])[0]!;
    expect(a).toHaveProperty('provenance');
    expect(a['burnPctPerHour']).toBe(4.2);
  });

  it('never leaks a placeholder model through the CLI', async () => {
    const withPlaceholder = state({ agents: [{ ...state().agents[0]!, model: 'gpt-unknown' }] });
    const a = (
      soleJson(await run('agents', ['--json'], withPlaceholder))['agents'] as Record<string, unknown>[]
    )[0]!;
    expect(a['model']).toBeNull();

    const human = await run('agents', [], withPlaceholder);
    expect(human.stdout).not.toContain('gpt-unknown');
    // The absence of the placeholder is only half of it: assert what IS shown,
    // or a renderer that dropped the column entirely would pass this test.
    expect(human.stdout).toContain('—');
  });
});

// -------------------------------------------------------------------- human
describe('human output', () => {
  it('status leads with the verdict and the binding limit', async () => {
    const r = await run('status', []);
    expect(r.stdout).toMatch(/On pace — Claude · 5h at 32%/);
    expect(r.stdout).toContain('Quota limits');
    expect(r.stdout).toContain('Agents');
  });

  it('gives every limit its own token count, not just the binding one', async () => {
    const two = state();
    two.limits.push({
      ...two.limits[0]!,
      limit: { ...two.limits[0]!.limit, key: '7d', label: 'Claude · 7d', utilization: 8 },
      binding: false,
      tokens: null,
    });
    const r = await run('limits', [], two);
    // 1150 tokens renders as 1.1k — (1.15).toFixed(1) is "1.1" in binary
    // floating point — and the uncounted limit gets an em dash.
    expect(r.stdout).toContain('1.1k tok');
    expect(r.stdout).toContain('— tok');
  });

  it('orders limits binding-first, then by urgency', async () => {
    const three = state();
    three.limits[0]!.binding = false;
    three.limits.push(
      {
        ...three.limits[0]!,
        limit: { ...three.limits[0]!.limit, key: 'bind', label: 'BINDING' },
        binding: true,
      },
      {
        ...three.limits[0]!,
        limit: { ...three.limits[0]!.limit, key: 'risky', label: 'RISKY', utilization: 5 },
        binding: false,
        // Runs out before it resets, so it outranks a fuller but flat limit.
        exhaustsAt: T0 + 60_000,
      },
    );
    const r = await run('limits', [], three);
    const at = (s: string) => r.stdout.indexOf(s);
    expect(at('BINDING')).toBeLessThan(at('RISKY'));
    expect(at('RISKY')).toBeLessThan(at('Claude · 5h'));
  });

  it('says "idle", not a duration, when there is no activity time', async () => {
    const noTime = state({
      agents: [{ ...state().agents[0]!, state: 'idle', lastActivityAt: 0 }],
      agentBurns: [],
    });
    const r = await run('agents', [], noTime);
    expect(r.stdout).toContain('idle');
    expect(r.stdout, 'printed a duration from a missing timestamp').not.toMatch(/\b\d{3,}d\b/);
  });

  /**
   * The panel got this fix on 2026-08-27 and the CLI did not, so `adjent
   * agents` went on printing a row per session all reading the same project
   * name. The logic now lives in core; this asserts the CLI actually uses it.
   */
  it('tells two sessions in one project apart', async () => {
    const base = state().agents[0]!;
    const crowded = state({
      agents: [
        { ...base, id: 'claude:s1', label: 'refactor-pass', projectPath: '/w/adjent' },
        { ...base, id: 'claude:s2', label: 'docs-sweep', projectPath: '/w/adjent' },
        { ...base, id: 'claude:s3', label: 'solo', projectPath: '/w/other' },
      ],
      agentBurns: [],
    });
    const r = await run('agents', [], crowded);

    expect(r.stdout).toContain('refactor-pass');
    expect(r.stdout).toContain('docs-sweep');
    // The uncrowded project keeps its bare name.
    expect(r.stdout).toContain('other');
    expect(r.stdout).not.toContain('other · solo');
  });

  it('explain rejects an unknown term with a usage code', async () => {
    const r = await run('explain', ['nonsense']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/unknown term/);
    expect(r.stdout).toBe('');
  });

  it('explain with no term lists what can be asked', async () => {
    const r = await run('explain', []);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('terms:');
  });
});

// ------------------------------------------------------------------- check
/**
 * `check` is what a CI step gates on, so the mapping from result to exit code
 * is the contract — not the wording. The distinctions under test are the ones
 * a script branches on: "no" (4) is not "broken" (1), and neither is "I cannot
 * say" (3).
 */
describe('check maps a predicate onto an exit code', () => {
  const used = (pct: number) => {
    const s = state();
    s.limits[0]!.limit.utilization = pct;
    return s;
  };

  it('exits 0 when the predicate holds', async () => {
    const r = await run('check', ['--budget', '20%'], used(40));
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/^ok —/m);
  });

  it('exits 4 — not 1 — when it does not', async () => {
    const r = await run('check', ['--budget', '70%'], used(40));
    expect(r.code).toBe(EXIT.PREDICATE_FAILED);
    expect(r.stdout).toMatch(/^no —/m);
  });

  it('answers the acceptance case: 100% budget, used versus fresh', async () => {
    expect((await run('check', ['--budget', '100%'], used(1))).code).toBe(EXIT.PREDICATE_FAILED);
    expect((await run('check', ['--budget', '100%'], used(0))).code).toBe(EXIT.OK);
  });

  it('exits 3 when there is nothing to judge', async () => {
    const r = await run('check', ['--budget', '20%'], EMPTY);
    expect(r.code).toBe(EXIT.NO_DATA);
    expect(r.stderr).toMatch(/no backend detected/);
  });

  it('exits 3 when a filter matches no limit', async () => {
    const r = await run('check', ['--limit', 'nonexistent']);
    expect(r.code).toBe(EXIT.NO_DATA);
    expect(r.stderr).toMatch(/no limit matched/);
  });

  it('exits 5 only when staleness is the sole complaint', async () => {
    const stale = state();
    stale.limits[0]!.limit.observedAt = T0 - 60 * 60_000;
    expect((await run('check', ['--max-age', '10m'], stale)).code).toBe(EXIT.STALE);

    // Stale and over budget is a budget failure: reporting freshness would
    // hide the problem that actually matters.
    stale.limits[0]!.limit.utilization = 99;
    expect((await run('check', ['--budget', '50%', '--max-age', '10m'], stale)).code).toBe(
      EXIT.PREDICATE_FAILED,
    );
  });

  it('ignores staleness entirely when --max-age was not given', async () => {
    const stale = state();
    stale.limits[0]!.limit.observedAt = T0 - 60 * 60_000;
    expect((await run('check', ['--budget', '20%'], stale)).code).toBe(EXIT.OK);
  });

  it('refuses a condition it cannot read rather than dropping it', async () => {
    // Silently ignoring an unparseable threshold would leave a gate that looks
    // configured and enforces nothing.
    const r = await run('check', ['--budget', 'loads']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/--budget: cannot read/);
    expect(r.ticks, 'a usage error must not cost a collection pass').toBe(0);
  });

  it('refuses an unknown verdict', async () => {
    const r = await run('check', ['--pace', 'fine']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/unknown verdict/);
  });

  it('says nothing at all under --quiet', async () => {
    const r = await run('check', ['--budget', '70%', '--quiet'], used(40));
    expect(r.stdout).toBe('');
    expect(r.code).toBe(EXIT.PREDICATE_FAILED);
  });

  it('emits one object under --json, and still sets the code', async () => {
    const r = await run('check', ['--budget', '70%', '--json'], used(40));
    const obj = soleJson(r);
    expect(obj['ok']).toBe(false);
    expect(obj['predicate']).toContain('at least 70%');
    const evaluated = obj['evaluated'] as Record<string, unknown>[];
    expect(evaluated[0]!['failed']).toEqual(['budget']);
    expect(evaluated[0]!['remainingPct']).toBe(60);
    expect(r.code).toBe(EXIT.PREDICATE_FAILED);
  });

  it('names which condition failed in human output', async () => {
    const r = await run('check', ['--max-utilization', '10'], used(90));
    expect(r.stdout).toContain('max-utilization');
    expect(r.stdout).toContain('90% used');
  });
});

/**
 * One collection pass per invocation.
 *
 * `status` used to tick twice so burn and dedup state existed. For a person
 * that is invisible; for a scripted consumer it doubles latency and re-reads
 * every transcript. It is unnecessary because the assessor's burn tracks are
 * persisted and restored, so a warm store already has the samples an EWMA
 * needs — the second tick was recomputing what was on disk.
 *
 * A counting stub is the only honest way to assert this: the cost is invisible
 * in the output.
 */
describe('collection cost', () => {
  for (const [name, argv] of [
    ['status', []],
    ['status', ['--json']],
    ['limits', ['--json']],
    ['agents', ['--json']],
    ['statusline', ['--json']],
    ['check', ['--budget', '10%']],
  ] as const) {
    it(`${name} ${argv.join(' ')} collects exactly once`, async () => {
      const r = await run(name, [...argv]);
      expect(r.ticks).toBe(1);
    });
  }

  it('explain never collects at all', async () => {
    // It answers from a static table, so it must work with nothing installed.
    expect((await run('explain', ['hero'])).ticks).toBe(0);
    expect((await run('explain', [])).ticks).toBe(0);
  });

  it('a usage error costs no collection pass', async () => {
    expect((await run('check', ['--budget', 'loads'])).ticks).toBe(0);
    expect((await run('check', ['--pace', 'fine'])).ticks).toBe(0);
  });

  it('reports the burn a warm store already knows about', async () => {
    // The state a restored assessor yields: burn present on the first tick.
    const r = await run('status', ['--json']);
    const snap = soleJson(r)['snapshot'] as { limits: Record<string, unknown>[] };
    expect(snap.limits[0]!['burnPctPerHour']).toBe(8.1);
    expect(r.ticks).toBe(1);
  });

  it('reports null rather than inventing a burn on a cold store', async () => {
    // Nothing measured yet is an honest null, not a zero and not a guess.
    const cold = state();
    cold.limits[0]!.burn = null;
    cold.agentBurns = [];
    const snap = soleJson(await run('status', ['--json'], cold))['snapshot'] as {
      limits: Record<string, unknown>[];
      agents: Record<string, unknown>[];
    };
    expect(snap.limits[0]!['burnPctPerHour']).toBeNull();
    expect(snap.agents[0]!['burnPctPerHour']).toBeNull();
    // And no provenance entry, since Adjent produced no such number.
    expect(snap.limits[0]!['provenance']).not.toHaveProperty('burnPctPerHour');
  });
});

// -------------------------------------------------------------- rules validate
/**
 * `rules validate` exists because loading is lenient: a file can be
 * half-ignored and still work. So the useful output is not a verdict but the
 * *effective* rule set — what will actually run — printed beside what was
 * complained about.
 */
describe('rules validate', () => {
  const GOOD = `
alarms:
  - id: pace-any
    type: pace
    tolerance_pp: 15
    cooldown: 20m
routing:
  warn: [tray, toast]
`;
  const TYPO = `
alarms:
  - id: pace-any
    type: pace
    tolerence_pp: 15
`;
  const BROKEN = `
alarms:
  - id: a
    type: teleport
`;

  /** Run with a scripted config file rather than a real home directory. */
  const withFile = (content: string | null, argv: string[] = ['validate']) =>
    runWith(
      'rules',
      argv,
      state(),
      content === null
        ? () => Promise.reject(new Error('ENOENT'))
        : () => Promise.resolve(content),
    );

  it('exits 0 and prints the effective set for a valid file', async () => {
    const r = await withFile(GOOD);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('Effective rules (1)');
    expect(r.stdout).toContain('pace-any');
    // The effective set is the point: it shows the value that will be used.
    expect(r.stdout).toContain('tolerance 15pp');
    expect(r.stdout).toContain('tray, toast');
  });

  it('exits 6 on a file with an error', async () => {
    const r = await withFile(BROKEN);
    expect(r.code).toBe(EXIT.CONFIG_INVALID);
    expect(r.stdout).toContain('alarms[0].type: error');
  });

  it('exits 0 on warnings, and still prints them', async () => {
    // A warning means "this is ignored" — worth saying, not worth breaking a
    // pipeline over.
    const r = await withFile(TYPO);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('alarms[0].tolerence_pp: warn');
    // And the effective set shows the default that silently took over.
    expect(r.stdout).toContain('tolerance 10pp');
  });

  it('formats a diagnostic as path, level, message', async () => {
    const r = await withFile(`
alarms:
  - id: a
    type: pace
    tolerance_pp: ten
`);
    expect(r.stdout).toMatch(/alarms\[0\]\.tolerance_pp: error — expected a number, got "ten"/);
  });

  it('treats a missing file as the defaults, not as invalid', async () => {
    // Most installs run on the built-in rules; that is not an error state.
    const r = await withFile(null);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stderr).toContain('built-in defaults');
    expect(r.stdout).toContain('Effective rules (3)');
  });

  it('emits one object under --json, with diagnostics and the effective set', async () => {
    const r = await withFile(BROKEN, ['validate', '--json']);
    const obj = soleJson(r);
    expect(obj['ok']).toBe(false);
    expect(obj['exists']).toBe(true);
    const diags = obj['diagnostics'] as Record<string, unknown>[];
    expect(diags[0]).toMatchObject({ level: 'error', path: 'alarms[0].type' });
    const eff = obj['effective'] as { rules: unknown[]; routing: unknown };
    expect(eff.rules.length).toBeGreaterThan(0);
    expect(eff.routing).toBeDefined();
    expect(r.code).toBe(EXIT.CONFIG_INVALID);
  });

  it('reads a path given on the command line', async () => {
    const seen: string[] = [];
    const r = await runWith('rules', ['validate', '/tmp/custom.yaml'], state(), (p) => {
      seen.push(p);
      return Promise.resolve(GOOD);
    });
    expect(seen).toEqual(['/tmp/custom.yaml']);
    expect(r.code).toBe(EXIT.OK);
  });

  it('never collects: validating a config needs no vendor installed', async () => {
    expect((await withFile(GOOD)).ticks).toBe(0);
  });

  it('rejects an unknown subcommand', async () => {
    expect((await withFile(GOOD, ['explode'])).code).toBe(EXIT.USAGE);
    expect((await withFile(GOOD, [])).code).toBe(EXIT.USAGE);
  });
});

// ------------------------------------------------------------------ rules test
/**
 * `rules test` answers "would this have fired?" against the user's own recorded
 * past. The persuasive part is not that a rule is well-formed but that it would
 * have interrupted you four times last week — so the timeline, the counts and
 * the quiet stretch are all part of the contract.
 */
describe('rules test', () => {
  const T = 1_700_000_000_000 - (1_700_000_000_000 % (5 * 3600_000));

  /** Utilization climbing from `from` to `to` over `n` samples. */
  const history = (n: number, from: number, to: number, stepMs = 5 * 60_000): string =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        t: T + i * stepMs,
        w: 'claude:session',
        u: from + ((to - from) * i) / Math.max(1, n - 1),
      }),
    ).join('\n');

  const PACE_ONLY = `
alarms:
  - id: pace-any
    type: pace
    tolerance_pp: 10
    cooldown: 20m
`;

  /** Serve a rules file and a history file by path. */
  const files = (rules: string, hist: string) => (p: string) =>
    p.includes('history') || p.includes('.jsonl')
      ? Promise.resolve(hist)
      : Promise.resolve(rules);

  it('prints a timeline for a front-loaded limit', async () => {
    const r = await runWith('rules', ['test'], state(), files(PACE_ONLY, history(13, 0, 80)));
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('Replayed 13 samples');
    expect(r.stdout).toContain('pace-any');
    expect(r.stdout).toContain('claude:session at');
    expect(r.stdout).toContain('By rule');
  });

  it('says so plainly when a rule would never have fired', async () => {
    const r = await runWith('rules', ['test'], state(), files(PACE_ONLY, history(20, 2, 4)));
    expect(r.stdout).toContain('(no alarms)');
    // A zero here means "ran, and stayed quiet" — the rule was genuinely asked.
    expect(r.stdout).toMatch(/pace-any\s+0 alarms/);
  });

  it('names the rules history cannot answer for, rather than reporting silence', async () => {
    const r = await runWith(
      'rules',
      ['test'],
      state(),
      files(
        `
alarms:
  - id: runaway
    type: agent_burn
    window: 10m
`,
        history(20, 0, 90),
      ),
    );
    expect(r.stdout).toContain('Not evaluated');
    expect(r.stdout).toContain('runaway');
    expect(r.stdout).toContain('per-agent');
  });

  it('reports the longest quiet stretch, which says whether a rule is usable', async () => {
    const r = await runWith('rules', ['test'], state(), files(PACE_ONLY, history(60, 0, 99)));
    if (r.stdout.includes('Longest quiet stretch')) {
      expect(r.stdout).toMatch(/Longest quiet stretch between alarms: \d+/);
    }
  });

  it('tests an alternative rules file without touching the live one', async () => {
    // The point of --rules: try a rule before adopting it.
    const seen: string[] = [];
    const r = await runWith('rules', ['test', '--rules', '/tmp/candidate.yaml'], state(), (p) => {
      seen.push(p);
      return Promise.resolve(p.includes('candidate') ? PACE_ONLY : history(13, 0, 80));
    });
    expect(seen).toContain('/tmp/candidate.yaml');
    expect(seen).not.toContain('/fake/alarms.yaml');
    expect(r.code).toBe(EXIT.OK);
  });

  it('reads the history file named by --against', async () => {
    const seen: string[] = [];
    await runWith('rules', ['test', '--against', '/tmp/past.jsonl'], state(), (p) => {
      seen.push(p);
      return Promise.resolve(p.endsWith('.jsonl') ? history(13, 0, 80) : PACE_ONLY);
    });
    expect(seen).toContain('/tmp/past.jsonl');
  });

  it('emits one object under --json carrying the whole result', async () => {
    const r = await runWith(
      'rules',
      ['test', '--json'],
      state(),
      files(PACE_ONLY, history(13, 0, 80)),
    );
    const obj = soleJson(r);
    expect(obj['samples']).toBe(13);
    expect(obj).toHaveProperty('byRule');
    expect(obj).toHaveProperty('notEvaluable');
    expect(Array.isArray(obj['alarms'])).toBe(true);
  });

  it('exits 3 when there is no history to replay', async () => {
    const r = await runWith('rules', ['test'], state(), (p) =>
      p.endsWith('.jsonl') ? Promise.reject(new Error('ENOENT')) : Promise.resolve(PACE_ONLY),
    );
    expect(r.code).toBe(EXIT.NO_DATA);
    expect(r.stderr).toContain('cannot read history');
  });

  it('exits 3 on a history file with nothing usable in it', async () => {
    const r = await runWith('rules', ['test'], state(), files(PACE_ONLY, 'not json\n{"nope":1}\n'));
    expect(r.code).toBe(EXIT.NO_DATA);
    expect(r.stderr).toContain('no usable samples');
  });

  it('skips a torn line instead of failing the whole replay', async () => {
    const good = history(13, 0, 80);
    const torn = good.split('\n').slice(0, 6).join('\n') + '\n{"t":broken\n' + good.split('\n').slice(6).join('\n');
    const r = await runWith('rules', ['test'], state(), files(PACE_ONLY, torn));
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('Replayed 13 samples');
  });

  it('warns when a rule in the file will be dropped before it can be tested', async () => {
    const r = await runWith(
      'rules',
      ['test'],
      state(),
      files('alarms:\n  - id: a\n    type: teleport\n', history(13, 0, 80)),
    );
    expect(r.stderr).toContain('unknown rule type');
  });

  it('never collects: replay reads files, not vendors', async () => {
    const r = await runWith('rules', ['test'], state(), files(PACE_ONLY, history(13, 0, 80)));
    expect(r.ticks).toBe(0);
  });
});

// ------------------------------------------------------------------ rules init
/**
 * `rules init` is the only destructive thing the CLI can do, and what it would
 * destroy is a config someone tuned. So the refusal to overwrite is tested as
 * carefully as the write.
 */
describe('rules init', () => {
  interface InitRun extends Run {
    written: { path: string; content: string }[];
  }

  /** Drive init with a scripted filesystem, capturing what would be written. */
  async function init(argv: string[], existing: string | null = null): Promise<InitRun> {
    const written: { path: string; content: string }[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let ticks = 0;
    const ctx: Ctx = {
      monitor: {
        tick: async () => {
          ticks += 1;
          return state();
        },
      },
      machineId: MACHINE,
      configPath: '/fake/alarms.yaml',
      historyPath: '/fake/history.jsonl',
      readFile: () => (existing === null ? Promise.reject(new Error('ENOENT')) : Promise.resolve(existing)),
      writeFile: async (path, content) => {
        written.push({ path, content });
      },
      readPreset: (name) => Promise.resolve(`# preset ${name}\nalarms:\n  - id: a\n    type: pace\n`),
      out: (l) => stdout.push(l),
      err: (l) => stderr.push(l),
    };
    const { flags, error } = parseArgs(argv);
    expect(error).toBeNull();
    const code = await COMMANDS['rules']!(ctx, flags);
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), ticks, written };
  }

  it('writes the default preset when none is named', async () => {
    const r = await init(['init']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.written).toHaveLength(1);
    expect(r.written[0]!.path).toBe('/fake/alarms.yaml');
    expect(r.written[0]!.content).toContain('preset default');
  });

  it('writes the preset verbatim, comments and all', async () => {
    // The file is the documentation; a re-serialised dump would teach nothing.
    const r = await init(['init', '--preset', 'fleet']);
    expect(r.written[0]!.content.startsWith('# preset fleet')).toBe(true);
  });

  it('refuses to overwrite an existing config, and writes nothing', async () => {
    const r = await init(['init'], 'alarms: []\n');
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.written).toEqual([]);
    expect(r.stderr).toContain('--force');
  });

  it('overwrites when explicitly told to', async () => {
    const r = await init(['init', '--force'], 'alarms: []\n');
    expect(r.code).toBe(EXIT.OK);
    expect(r.written).toHaveLength(1);
  });

  it('rejects an unknown preset and lists the real ones', async () => {
    const r = await init(['init', '--preset', 'aggressive']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.written).toEqual([]);
    expect(r.stderr).toContain('unknown preset');
    expect(r.stderr).toContain('weekly-guard');
  });

  it('writes to a path given on the command line', async () => {
    const r = await init(['init', '/tmp/elsewhere.yaml']);
    expect(r.written[0]!.path).toBe('/tmp/elsewhere.yaml');
  });

  it('tells you what to do next', async () => {
    const r = await init(['init']);
    expect(r.stdout).toContain('rules validate');
    expect(r.stdout).toContain('rules test');
  });

  it('emits one object under --json', async () => {
    const r = await init(['init', '--json', '--preset', 'ci-gate']);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj['preset']).toBe('ci-gate');
    expect(obj['ok']).toBe(true);
  });

  it('never collects: writing a config needs no vendor installed', async () => {
    expect((await init(['init'])).ticks).toBe(0);
  });

  it('lists the presets with what each is for', async () => {
    const r = await init(['presets']);
    expect(r.code).toBe(EXIT.OK);
    for (const name of ['default', 'conservative', 'weekly-guard', 'fleet', 'ci-gate']) {
      expect(r.stdout).toContain(name);
    }
  });
});
