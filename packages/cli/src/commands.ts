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
  toSnapshot,
  type AppState,
  type Snapshot,
} from '@adjent/core';
import { EXIT, type ExitCode } from './exit.js';
import type { Flags } from './args.js';
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

export const COMMANDS: Record<string, Command> = {
  status,
  statusline,
  limits,
  agents,
  explain,
};

export const USAGE = `usage: adjent <command> [options]

  status                one snapshot: limits, backends, agents
  limits                quota limits, binding first then by urgency
  agents                every live and idle session, most expensive first
  statusline            one line, for Claude Code's statusLine setting
  explain <term>        plain-language definition of any metric shown
  watch                 continuous loop with alarms

options:
  --json                machine-readable output on stdout (see docs/API.md)
  --quiet               print nothing; the exit code is the answer

exit codes: 0 ok · 2 usage · 3 no data — full table in docs/API.md`;
