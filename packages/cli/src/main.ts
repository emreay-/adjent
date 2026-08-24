#!/usr/bin/env node
/**
 * adjent — headless CLI.
 *
 * A thin shell: parse argv, build a Monitor, dispatch to the command table in
 * `commands.ts`, set the exit code. Everything worth testing lives behind that
 * table or in `watch.ts`, so the tests never spawn a process (docs/API.md).
 */
import {
  ClaudeProvider,
  CodexProvider,
  ConsoleSink,
  Monitor,
  configPath,
  loadConfig,
  storeDir,
  machineId,
  type Alarm,
} from '@adjent/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMANDS, USAGE, type Ctx } from './commands.js';
import { EXIT, type ExitCode } from './exit.js';
import { parseArgs, parseDuration } from './args.js';
import { renderStatus } from './render.js';
import { WatchStream, realSleep, runWatchLoop } from './watch.js';

const DEFAULT_INTERVAL_MS = 30_000;
/** A quiet stream still says "alive" this often, so silence is not ambiguous. */
const HEARTBEAT_MULTIPLE = 10;

async function makeMonitor(withConsoleSink: boolean): Promise<Monitor> {
  const config = await loadConfig();
  const monitor = new Monitor({ providers: [new ClaudeProvider(), new CodexProvider()], config });
  // The console sink prints alarms as prose. In JSONL mode that would put
  // unparseable text on the same stream as the events, so it is left off.
  if (withConsoleSink) monitor.router.register(new ConsoleSink());
  return monitor;
}

/** Human `watch`: a cleared screen and the same view `status` renders. */
async function watchHuman(monitor: Monitor, intervalMs: number): Promise<never> {
  for (;;) {
    const state = await monitor.tick();
    console.clear();
    console.log(renderStatus(state));
    console.log(`\n(watch: refreshing every ${Math.round(intervalMs / 1000)}s — Ctrl-C to stop)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * JSONL `watch`. Lines are written straight to the fd rather than buffered, so
 * a reader blocked on `read` wakes on the event rather than on a flush.
 */
async function watchJson(monitor: Monitor, intervalMs: number, id: string): Promise<void> {
  const stream = new WatchStream((line) => process.stdout.write(line + '\n'), {
    machineId: id,
    heartbeatMs: intervalMs * HEARTBEAT_MULTIPLE,
  });

  monitor.on('alarm', (a: Alarm) => stream.alarm(a, Date.now()));

  const { done, stop } = runWatchLoop({
    tick: () => monitor.tick(),
    stream,
    intervalMs,
    now: () => Date.now(),
    sleep: realSleep,
  });

  // Ctrl-C is the normal way to stop a stream, so it is a success: exit 0 once
  // the current line is out, never a truncated object.
  const onSignal = (): void => {
    process.exitCode = EXIT.OK;
    stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await done;
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
    const interval = parseDuration(flags.values['interval']);
    if (flags.values['interval'] !== undefined && interval === null) {
      console.error(`--interval: cannot read ${JSON.stringify(flags.values['interval'])}`);
      process.exitCode = EXIT.USAGE;
      return;
    }
    const ms = interval ?? DEFAULT_INTERVAL_MS;
    const monitor = await makeMonitor(!flags.json);
    if (flags.json) await watchJson(monitor, ms, await machineId());
    else await watchHuman(monitor, ms);
    return;
  }

  const command = COMMANDS[name];
  if (!command) {
    console.error(`unknown command: ${name}`);
    console.error(USAGE);
    process.exitCode = EXIT.USAGE;
    return;
  }

  // `explain` and `rules` answer without collecting, so neither pays for a
  // collection pass — and both must work with no vendor installed at all.
  const needsMonitor = name !== 'explain' && name !== 'rules';
  const ctx: Ctx = {
    monitor: needsMonitor
      ? await makeMonitor(true)
      : {
          tick: async () => {
            throw new Error('unreachable');
          },
        },
    machineId: await machineId(),
    configPath: configPath(),
    historyPath: join(storeDir(), 'history.jsonl'),
    readFile: (p) => readFile(p, 'utf-8'),
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
