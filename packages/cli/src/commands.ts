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
  SCHEMA_VERSION,
  check as checkPredicate,
  staleOnly,
  toSnapshot,
  type AppState,
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
    ctx.err(degradationNote(snapshot) ?? 'no limit matched the given filters');
    return EXIT.NO_DATA;
  }
  if (result.ok) return EXIT.OK;
  return staleOnly(result) ? EXIT.STALE : EXIT.PREDICATE_FAILED;
};

export const COMMANDS: Record<string, Command> = {
  status,
  statusline,
  limits,
  agents,
  explain,
  check,
};

export const USAGE = `usage: adjent <command> [options]

  status                one snapshot: limits, backends, agents
  limits                quota limits, binding first then by urgency
  agents                every live and idle session, most expensive first
  statusline            one line, for Claude Code's statusLine setting
  explain <term>        plain-language definition of any metric shown
  check                 budget gate for scripts; the exit code is the answer
  watch                 continuous loop with alarms

options:
  --json                machine-readable output on stdout (see docs/API.md)
  --quiet               print nothing; the exit code is the answer

check options:
  --budget <pct>        at least this share of the limit must remain
  --max-utilization <pct>   utilization must be at most this
  --pace <verdict,...>  acceptable verdicts (on-pace, ahead, over, idle)
  --backend <id>        narrow to one vendor
  --limit <key>         narrow to one limit, instead of the binding one
  --max-age <dur>       reject a reading older than this (90s, 15m, 2h)

exit codes: 0 ok · 2 usage · 3 no data — full table in docs/API.md`;
