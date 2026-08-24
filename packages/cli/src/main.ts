#!/usr/bin/env node
/**
 * adjent — headless CLI.
 *
 * A thin shell: parse argv, build a Monitor, dispatch to the command table in
 * `commands.ts`, set the exit code. Everything worth testing lives behind that
 * table, so the tests never spawn a process (docs/API.md).
 */
import {
  ClaudeProvider,
  CodexProvider,
  ConsoleSink,
  Monitor,
  loadConfig,
  machineId,
} from '@adjent/core';
import { COMMANDS, USAGE, type Ctx } from './commands.js';
import { EXIT, type ExitCode } from './exit.js';
import { parseArgs, parseDuration } from './args.js';
import { renderStatus } from './render.js';

async function makeMonitor(): Promise<Monitor> {
  const config = await loadConfig();
  const monitor = new Monitor({ providers: [new ClaudeProvider(), new CodexProvider()], config });
  monitor.router.register(new ConsoleSink());
  return monitor;
}

/**
 * `watch` is interactive by nature — it clears the screen — so it stays out of
 * the command table until W1.3 gives it a JSONL form. Human mode only.
 */
async function watch(monitor: Monitor, intervalMs: number): Promise<never> {
  for (;;) {
    const state = await monitor.tick();
    console.clear();
    console.log(renderStatus(state));
    console.log(`\n(watch: refreshing every ${Math.round(intervalMs / 1000)}s — Ctrl-C to stop)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;

  const { flags, error } = parseArgs(rest);
  if (error) {
    console.error(error);
    console.error(USAGE);
    process.exitCode = EXIT.USAGE;
    return;
  }
  if (flags.values['help'] === 'true' || name === 'help') {
    console.log(USAGE);
    return;
  }

  if (name === 'watch') {
    const monitor = await makeMonitor();
    const interval = parseDuration(flags.values['interval']) ?? 30_000;
    await watch(monitor, interval);
    return;
  }

  const command = COMMANDS[name];
  if (!command) {
    console.error(`unknown command: ${name}`);
    console.error(USAGE);
    process.exitCode = EXIT.USAGE;
    return;
  }

  // `explain` answers from a static table, so it must not pay for a collection
  // pass — and must work with no vendor installed at all.
  const needsMonitor = name !== 'explain';
  const ctx: Ctx = {
    monitor: needsMonitor ? await makeMonitor() : { tick: async () => { throw new Error('unreachable'); } },
    machineId: await machineId(),
    // stdout carries the answer; stderr carries everything else.
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  };

  process.exitCode = (await command(ctx, flags)) as ExitCode;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = EXIT.INTERNAL_ERROR;
});
