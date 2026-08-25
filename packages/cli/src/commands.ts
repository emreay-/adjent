/**
 * The command table.
 *
 * Every command is a pure-ish function of `(ctx, flags)` returning an exit
 * code, with all I/O going through `ctx`. That is what makes the CLI testable
 * without spawning a process or touching a real home directory — the tests
 * inject a Monitor and collect the two streams.
 *
 * **JSON on stdout, everything else on stderr.** A pipe must never receive a
 * progress line, a warning, or a cleared screen, so a consumer can always run
 * `adjent status --json | jq` and get exactly one object.
 */
import {
  EXPLANATIONS,
  EXPLANATION_KEYS,
  PROVENANCE_NOTE,
  DEFAULT_CONFIG,
  PRESET_NAMES,
  PRESET_SUMMARY,
  SCHEMA_VERSION,
  check as checkPredicate,
  fmtDur,
  fmtWhen,
  hasErrors,
  isPresetName,
  parseConfig,
  replayHistory,
  staleOnly,
  toSnapshot,
  type AlarmConfig,
  type AppState,
  type HistorySample,
  type ReplayResult,
  type CheckOptions,
  type Snapshot,
} from '@adjent/core';
import { EXIT, type ExitCode } from './exit.js';
import { parseDuration, parsePercent, type Flags } from './args.js';
import {
  degradationNote,
  renderAgents,
  renderLimits,
  renderStatus,
  renderStatusline,
  wrap,
} from './render.js';

/** The slice of Monitor the CLI needs — small enough for a test to fake. */
export interface MonitorLike {
  tick(): Promise<AppState>;
}

export interface Ctx {
  monitor: MonitorLike;
  machineId: string;
  /** Where the alarm config lives. Injected so tests never read a real home. */
  configPath: string;
  /** Reads a config file. Injected for the same reason. */
  readFile: (path: string) => Promise<string>;
  /** Where recorded utilization history lives. */
  historyPath: string;
  /** Writes into ~/.adjent only. Injected so tests never touch a real home. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** The shipped YAML for a preset, comments intact. */
  readPreset: (name: string) => Promise<string>;
  /** Machine-readable output. Exactly one object per invocation. */
  out: (line: string) => void;
  /** Notes, warnings, degradation. Never parsed by anyone. */
  err: (line: string) => void;
}

export type Command = (ctx: Ctx, flags: Flags) => Promise<ExitCode>;

/** One object per invocation, `schemaVersion` at the top level. */
const emit = (ctx: Ctx, body: Record<string, unknown>): void =>
  ctx.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...body }));

/**
 * Collect a snapshot and decide whether it says anything.
 *
 * A machine with no agent installed is not an error — it is a valid, empty
 * answer — so the snapshot is still emitted and the exit code carries the
 * "nothing to say" signal instead.
 */
async function collect(ctx: Ctx): Promise<{ state: AppState; snapshot: Snapshot; code: ExitCode }> {
  const state = await ctx.monitor.tick();
  const snapshot = toSnapshot(state, { machineId: ctx.machineId });
  const note = degradationNote(snapshot);
  if (note) ctx.err(note);
  const empty = snapshot.backends.length === 0 || snapshot.limits.length === 0;
  return { state, snapshot, code: empty ? EXIT.NO_DATA : EXIT.OK };
}

export const status: Command = async (ctx, flags) => {
  const { state, snapshot, code } = await collect(ctx);
  if (flags.json) emit(ctx, { snapshot });
  else if (!flags.quiet) ctx.out(renderStatus(state));
  return code;
};

export const statusline: Command = async (ctx, flags) => {
  const { state, snapshot, code } = await collect(ctx);
  if (flags.json) {
    const b = snapshot.limits.find((l) => l.bindingLimit) ?? null;
    // The statusline answers one question, so its JSON is the binding limit
    // rather than the whole snapshot — but it is still one object with a
    // version, so a consumer can grow into the full shape later.
    emit(ctx, { bindingLimit: b, text: renderStatusline(state) });
  } else if (!flags.quiet) ctx.out(renderStatusline(state));
  return code;
};

export const limits: Command = async (ctx, flags) => {
  const { state, snapshot, code } = await collect(ctx);
  if (flags.json) emit(ctx, { limits: snapshot.limits, generatedAt: snapshot.generatedAt });
  else if (!flags.quiet) ctx.out(renderLimits(state));
  return code;
};

export const agents: Command = async (ctx, flags) => {
  const { state, snapshot, code } = await collect(ctx);
  if (flags.json) emit(ctx, { agents: snapshot.agents, generatedAt: snapshot.generatedAt });
  else if (!flags.quiet) ctx.out(renderAgents(state, Number.MAX_SAFE_INTEGER));
  // Agents can legitimately be empty on a working install, so this command
  // reports NO_DATA only for the same reason the others do.
  return code;
};

export const explain: Command = async (ctx, flags) => {
  const term = flags.positional[0];

  if (!term) {
    if (flags.json) {
      emit(ctx, {
        terms: EXPLANATION_KEYS.map((k) => ({
          term: k,
          title: EXPLANATIONS[k]!.title,
          body: EXPLANATIONS[k]!.body,
          provenance: EXPLANATIONS[k]!.provenance ?? null,
        })),
      });
      return EXIT.OK;
    }
    if (!flags.quiet) {
      ctx.out('Explains any number Adjent shows. Same words as the panel tooltips.\n');
      ctx.out('  adjent explain <term>\n');
      ctx.out('terms: ' + EXPLANATION_KEYS.join(', '));
    }
    return EXIT.OK;
  }

  const e = EXPLANATIONS[term];
  if (!e) {
    ctx.err(`unknown term: ${term}\nterms: ${EXPLANATION_KEYS.join(', ')}`);
    return EXIT.USAGE;
  }
  if (flags.json) {
    emit(ctx, { term, title: e.title, body: e.body, provenance: e.provenance ?? null });
    return EXIT.OK;
  }
  if (!flags.quiet) {
    ctx.out(`\n  ${e.title}\n`);
    ctx.out(wrap(e.body));
    if (e.provenance) ctx.out(`\n  [${e.provenance}] ${PROVENANCE_NOTE[e.provenance]}`);
    ctx.out('');
  }
  return EXIT.OK;
};

/**
 * `adjent check` — the budget gate.
 *
 * The CLI's whole job here is mapping a pure result onto an exit code, which is
 * why the predicate lives in core. The mapping carries the meaning:
 *
 * - **4, not 1**, when a condition fails. The gate answering "no" is Adjent
 *   working correctly; conflating it with an internal error would make a CI
 *   step unable to tell "you are out of budget" from "the tool broke".
 * - **5 only when `--max-age` was given**, and only when staleness is the sole
 *   complaint. A stale reading that also blew the budget is a budget failure —
 *   reporting the freshness problem would hide the real one.
 * - **3 when nothing could be judged.** "I cannot say" is not "yes", and a gate
 *   that passed on no data would open exactly when Adjent had stopped working.
 */
export const check: Command = async (ctx, flags) => {
  const budgetPct = parsePercent(flags.values['budget']);
  const maxUtilizationPct = parsePercent(flags.values['max-utilization']);
  const maxAgeMs = parseDuration(flags.values['max-age']);
  const paceRaw = flags.values['pace'];

  // A flag given but unreadable is a usage error, never a silently ignored
  // condition — a gate that drops a condition it did not understand is worse
  // than one that refuses to run.
  for (const [name, raw, parsed] of [
    ['budget', flags.values['budget'], budgetPct],
    ['max-utilization', flags.values['max-utilization'], maxUtilizationPct],
    ['max-age', flags.values['max-age'], maxAgeMs],
  ] as const) {
    if (raw !== undefined && parsed === null) {
      ctx.err(`--${name}: cannot read ${JSON.stringify(raw)}`);
      return EXIT.USAGE;
    }
  }

  const pace = paceRaw ? paceRaw.split(',').map((p) => p.trim()) : null;
  const VERDICTS = ['on-pace', 'ahead', 'over', 'idle'];
  const unknown = pace?.find((p) => !VERDICTS.includes(p));
  if (unknown !== undefined) {
    ctx.err(`--pace: unknown verdict ${JSON.stringify(unknown)} (one of ${VERDICTS.join(', ')})`);
    return EXIT.USAGE;
  }

  const state = await ctx.monitor.tick();
  const snapshot = toSnapshot(state, { machineId: ctx.machineId });
  const opts: CheckOptions = {
    budgetPct,
    maxUtilizationPct,
    pace,
    backend: flags.values['backend'] ?? null,
    limitKey: flags.values['limit'] ?? null,
    maxAgeMs,
  };
  const result = checkPredicate(snapshot, opts, snapshot.generatedAt);

  if (flags.json) {
    emit(ctx, { ok: result.ok, predicate: result.predicate, evaluated: result.evaluated });
  } else if (!flags.quiet) {
    if (result.noData) {
      ctx.out('no limit to check');
    } else {
      ctx.out(`${result.ok ? 'ok' : 'no'} — ${result.predicate}`);
      for (const e of result.evaluated) {
        const why = e.ok ? '' : `  (${e.failed.join(', ')})`;
        ctx.out(
          `  ${e.ok ? '✓' : '✗'} ${e.label}  ${Math.round(e.utilization)}% used, ` +
            `${Math.round(e.remainingPct)}% left, ${e.verdict}${why}`,
        );
      }
    }
  }

  if (result.noData) {
    // Limit keys are the vendors' own, not a scheme Adjent invents: `session`
    // and `weekly_all` rather than `5h` and `7d`. So a filter that matches
    // nothing is usually a guess at the name, and the useful reply is the list
    // — not "no data", which reads as "you have no quota".
    const note = degradationNote(snapshot);
    if (note) {
      ctx.err(note);
    } else if (snapshot.limits.length > 0) {
      const available = snapshot.limits.map((l) => `${l.backend}/${l.key}`).join(', ');
      ctx.err(`no limit matched. Available: ${available}`);
    } else {
      ctx.err('no limit matched the given filters');
    }
    return EXIT.NO_DATA;
  }
  if (result.ok) return EXIT.OK;
  return staleOnly(result) ? EXIT.STALE : EXIT.PREDICATE_FAILED;
};

/**
 * `adjent rules validate [path]` — prove a config before it has to fire.
 *
 * Authoring alarms has always been possible; knowing what Adjent *understood*
 * has not. Because loading is deliberately lenient, a file can be half-ignored
 * and still work, so the useful output is not "valid/invalid" but the effective
 * rule set: what will actually run, printed next to what was complained about.
 *
 * Warnings do not fail. A warning means "this is ignored", which is worth
 * saying and is not worth breaking a pipeline over; an error means a rule is
 * gone, which is.
 */
const rulesValidate: Command = async (ctx, flags) => {
  const path = flags.positional[1] ?? ctx.configPath;

  let text: string;
  try {
    text = await ctx.readFile(path);
  } catch {
    // A missing file is not invalid — it is how most installs run, on the
    // built-in defaults. Say so and report those as the effective set.
    ctx.err(`no config at ${path} — the built-in defaults are in force`);
    if (flags.json) {
      emit(ctx, { ok: true, path, exists: false, diagnostics: [], effective: DEFAULT_CONFIG });
    } else if (!flags.quiet) {
      ctx.out(renderEffective(DEFAULT_CONFIG));
    }
    return EXIT.OK;
  }

  const { config, diagnostics } = parseConfig(text);
  const failed = hasErrors(diagnostics);

  if (flags.json) {
    emit(ctx, { ok: !failed, path, exists: true, diagnostics, effective: config });
  } else if (!flags.quiet) {
    for (const d of diagnostics) ctx.out(`${d.path}: ${d.level} — ${d.message}`);
    if (diagnostics.length > 0) ctx.out('');
    ctx.out(renderEffective(config));
  }

  return failed ? EXIT.CONFIG_INVALID : EXIT.OK;
};

/** What will actually run, in the same vocabulary the file uses. */
function renderEffective(config: AlarmConfig): string {
  const lines = [`Effective rules (${config.rules.length})`];
  for (const r of config.rules) {
    const bits: string[] = [`${r.id}  [${r.type}]`];
    if (r.type === 'pace') {
      bits.push(`scope ${r.backend}/${r.limit}`, `tolerance ${r.tolerancePp}pp`, `cooldown ${r.cooldownMin}m`);
    } else if (r.type === 'threshold') {
      bits.push(`scope ${r.backend}/${r.limit}`, `levels ${r.levels.join(', ')}`);
    } else {
      bits.push(`window ${r.windowMin}m`, `≥${r.absPctPerHour} %/h`, `cooldown ${r.cooldownMin}m`);
    }
    lines.push('  ' + bits.join('  ·  '));
  }
  lines.push('', 'Routing');
  for (const level of ['info', 'warn', 'critical'] as const) {
    lines.push(`  ${level.padEnd(9)} → ${config.routing[level].join(', ') || '(none)'}`);
  }
  return lines.join('\n');
}

/**
 * `adjent rules test --against <history>` — would this rule have fired?
 *
 * The default history is the user's own recorded past, which is what makes the
 * answer persuasive rather than theoretical: not "this rule is well-formed" but
 * "this rule would have interrupted you four times last week, the quietest
 * stretch being two days".
 *
 * `--rules` reads an alternative file, so a rule can be tried before it is
 * adopted — nothing under ~/.adjent is written.
 */
const rulesTest: Command = async (ctx, flags) => {
  const historyPath = flags.values['against'] ?? ctx.historyPath;
  const rulesPath = flags.values['rules'] ?? ctx.configPath;

  let config = DEFAULT_CONFIG;
  try {
    const parsed = parseConfig(await ctx.readFile(rulesPath));
    config = parsed.config;
    // A rule that will be dropped cannot be tested; say so rather than
    // reporting an empty timeline for it.
    for (const d of parsed.diagnostics.filter((x) => x.level === 'error')) {
      ctx.err(`${d.path}: ${d.message}`);
    }
  } catch {
    ctx.err(`no rules at ${rulesPath} — testing the built-in defaults`);
  }

  let samples: HistorySample[];
  try {
    samples = parseHistory(await ctx.readFile(historyPath));
  } catch {
    ctx.err(`cannot read history at ${historyPath}`);
    return EXIT.NO_DATA;
  }
  if (samples.length === 0) {
    ctx.err(`no usable samples in ${historyPath}`);
    return EXIT.NO_DATA;
  }

  const result = replayHistory(samples, config.rules, {
    // History records the key but never the window length, so the caller has
    // to supply it. These are the windows the two vendors actually publish.
    windowMinutes: WINDOW_MINUTES,
    defaultWindowMinutes: 300,
  });

  if (flags.json) {
    emit(ctx, {
      alarms: result.alarms,
      byRule: result.byRule,
      notEvaluable: result.notEvaluable,
      samples: result.samples,
      from: result.from,
      to: result.to,
      longestSilenceMs: result.longestSilenceMs,
    });
  } else if (!flags.quiet) {
    ctx.out(renderReplay(result));
  }

  return EXIT.OK;
};

/** Windows the vendors publish, by the key history stores them under. */
const WINDOW_MINUTES: Record<string, number> = {
  'claude:session': 300,
  'claude:weekly_all': 10_080,
  'codex:codex:5h': 300,
  'codex:codex:7d': 10_080,
};

/** JSONL in, samples out. A torn line is skipped, never fatal. */
function parseHistory(text: string): HistorySample[] {
  const out: HistorySample[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const d = JSON.parse(line) as Partial<HistorySample>;
      if (typeof d.t === 'number' && typeof d.w === 'string' && typeof d.u === 'number') {
        out.push({ t: d.t, w: d.w, u: d.u });
      }
    } catch {
      /* one torn line is not a corrupt file */
    }
  }
  return out;
}

const SEVERITY_MARK: Record<string, string> = { info: '·', warn: '▲', critical: '■' };

function renderReplay(r: ReplayResult): string {
  const lines: string[] = [];
  const span =
    r.from !== null && r.to !== null
      ? `${r.samples} samples over ${fmtDur(r.to - r.from)}`
      : `${r.samples} samples`;
  lines.push(`Replayed ${span}`, '');

  if (r.alarms.length === 0) {
    lines.push('  (no alarms)');
  } else {
    for (const { alarm, sample } of r.alarms) {
      const mark = SEVERITY_MARK[alarm.severity] ?? '·';
      // Say *why* it fired. A pace rule has two triggers, and showing the pace
      // line for the other one reads as a bug: "4% (pace line 34%)" looks
      // impossible until you know the alarm was about projected exhaustion.
      const c = alarm.context;
      const early = c?.exhaustsAt != null && c.resetsAt != null && c.exhaustsAt < c.resetsAt;
      const at = early
        ? ` (runs out ${fmtWhen(c.exhaustsAt as number, alarm.firedAt)})`
        : c?.paceLinePct != null
          ? ` (pace line ${Math.round(c.paceLinePct)}%)`
          : '';
      lines.push(
        `  ${fmtWhen(alarm.firedAt, r.to ?? alarm.firedAt)}  ${mark} ${alarm.severity.padEnd(8)} ` +
          `${alarm.ruleId.padEnd(14)} ${sample.w} at ${Math.round(sample.u)}%${at}`,
      );
    }
  }

  lines.push('', 'By rule');
  for (const [id, n] of Object.entries(r.byRule)) {
    lines.push(`  ${id.padEnd(16)} ${String(n).padStart(4)} ${n === 1 ? 'alarm' : 'alarms'}`);
  }
  if (r.longestSilenceMs !== null) {
    // The number that says whether a rule is usable or merely correct.
    lines.push('', `Longest quiet stretch between alarms: ${fmtDur(r.longestSilenceMs)}`);
  }

  if (r.notEvaluable.length > 0) {
    lines.push('', 'Not evaluated');
    for (const n of r.notEvaluable) {
      lines.push(`  ${n.ruleId.padEnd(16)} [${n.type}] ${n.reason}`);
    }
  }
  return lines.join('\n');
}

/**
 * `adjent rules init [--preset <name>] [--force]`.
 *
 * Writes `~/.adjent/alarms.yaml` — Adjent's own directory, so this is the one
 * place writing is allowed (README rule 1 is about *vendor* directories).
 *
 * The preset is copied verbatim, comments and all, because the file is the
 * documentation a person will actually read. Dumping parsed rules back out as
 * YAML would strip exactly the part that teaches the schema.
 */
const rulesInit: Command = async (ctx, flags) => {
  const name = flags.values['preset'] ?? 'default';
  if (!isPresetName(name)) {
    ctx.err(`unknown preset: ${name}`);
    ctx.err('available:');
    for (const p of PRESET_NAMES) ctx.err(`  ${p.padEnd(14)} ${PRESET_SUMMARY[p]}`);
    return EXIT.USAGE;
  }

  const target = flags.positional[1] ?? ctx.configPath;
  const force = flags.values['force'] === 'true';

  // Never clobber a config someone has tuned. This is the one destructive
  // thing the CLI can do, and the cost of getting it wrong is their rules.
  if (!force) {
    let exists = false;
    try {
      await ctx.readFile(target);
      exists = true;
    } catch {
      /* absent is the normal case */
    }
    if (exists) {
      ctx.err(`${target} already exists — pass --force to overwrite it`);
      return EXIT.USAGE;
    }
  }

  const yaml = await ctx.readPreset(name);
  await ctx.writeFile(target, yaml);

  if (flags.json) {
    emit(ctx, { ok: true, preset: name, path: target, bytes: yaml.length });
  } else if (!flags.quiet) {
    ctx.out(`wrote ${target}  (preset: ${name})`);
    ctx.out(PRESET_SUMMARY[name]);
    ctx.out('');
    ctx.out('Next: `adjent rules validate` to see what Adjent understood,');
    ctx.out('      `adjent rules test` to see what it would have done last week.');
  }
  return EXIT.OK;
};

/** `adjent rules presets` — what can be chosen, and what each is for. */
const rulesPresets: Command = async (ctx, flags) => {
  if (flags.json) {
    emit(ctx, { presets: PRESET_NAMES.map((p) => ({ name: p, summary: PRESET_SUMMARY[p] })) });
  } else if (!flags.quiet) {
    for (const p of PRESET_NAMES) ctx.out(`  ${p.padEnd(14)} ${PRESET_SUMMARY[p]}`);
  }
  return EXIT.OK;
};

/** `rules` is a group, so it dispatches on its first positional. */
export const rules: Command = async (ctx, flags) => {
  const sub = flags.positional[0];
  if (sub === 'validate') return rulesValidate(ctx, flags);
  if (sub === 'test') return rulesTest(ctx, flags);
  if (sub === 'init') return rulesInit(ctx, flags);
  if (sub === 'presets') return rulesPresets(ctx, flags);
  ctx.err(sub ? `unknown subcommand: rules ${sub}` : 'usage: adjent rules <init|validate|test|presets>');
  return EXIT.USAGE;
};

export const COMMANDS: Record<string, Command> = {
  status,
  statusline,
  limits,
  agents,
  explain,
  check,
  rules,
};

export const USAGE = `usage: adjent <command> [options]

  status                one snapshot: limits, backends, agents
  limits                quota limits, binding first then by urgency
  agents                every live and idle session, most expensive first
  statusline            one line, for Claude Code's statusLine setting
  watch                 continuous loop; --json streams JSONL events
  check                 budget gate for scripts; the exit code is the answer
  explain <term>        plain-language definition of any metric shown

  rules init            write ~/.adjent/alarms.yaml from a preset
  rules validate [path] check alarms.yaml and print what will actually run
  rules test            replay rules against recorded history
  rules presets         list the presets and what each is for

options:
  --json                machine-readable output on stdout (see docs/API.md)
  --quiet               print nothing; the exit code is the answer

check:
  --budget <pct>        at least this share of the limit must remain
  --max-utilization <pct>   utilization must be at most this
  --pace <verdict,...>  acceptable verdicts (on-pace, ahead, over, idle)
  --backend <id>        narrow to one vendor
  --limit <key>         narrow to one limit, instead of the binding one
  --max-age <dur>       reject a reading older than this (90s, 15m, 2h)

watch:
  --interval <dur>      poll period (default 30s)

rules init:
  --preset <name>       default | conservative | weekly-guard | fleet | ci-gate
  --force               overwrite an existing alarms.yaml

rules test:
  --against <file>      history JSONL to replay (default ~/.adjent/history.jsonl)
  --rules <file>        rules to test, instead of the live alarms.yaml

exit codes: 0 ok · 2 usage · 3 no data — full table in docs/API.md`;
