/**
 * The looping-subagent demo. Fifteen seconds, from a clean checkout.
 *
 *   pnpm -r build && node scripts/demo-loop.mjs
 *
 * Builds a throwaway home directory containing one Claude session that is
 * working normally and one subagent of it that is repeating itself, then runs
 * the real `adjent status` against it. The alarm you see is produced by the
 * shipped rule engine reading files off disk — nothing here is mocked, and
 * nothing is printed that the product did not decide to print.
 *
 * Everything written is synthetic (CLAUDE.md): invented ids, invented numbers,
 * a made-up project path, and no credentials of any kind. It touches only its
 * own temporary directory and removes it afterwards.
 *
 * WHY THE DEMO CONFIG LOWERS ONE THRESHOLD, spelled out because a demo that
 * quietly tunes itself to succeed is worth nothing: the shipped `anomaly` rule
 * also requires the agent to be burning at least 2 %/h, so a slow harmless loop
 * cannot interrupt you. That figure is *derived* — it needs the exchange-rate
 * fit, which is learned over hours from vendor-reported quota moving against
 * observed spend. A fixture created five seconds ago has no such history, and
 * Claude's quota needs credentials this demo deliberately does not have. So the
 * demo config sets `abs_pct_per_hour: 0` and the other three conditions — turn
 * count, uniform turn size, flat context — do the work. Those three are what
 * detects a loop; the burn floor decides whether the loop is worth your
 * attention.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'packages', 'cli', 'dist', 'main.js');

const NOW = Date.now();
const MIN = 60_000;
const SESSION = '00000000-0000-4000-8000-00000000d3m0';
const PROJECT = '/synthetic/checkout';

/** One assistant turn, as Claude Code writes them. */
const turn = (i, tsMs, tokens) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    requestId: `req_demo_${i}`,
    effort: 'high',
    gitBranch: 'demo',
    message: {
      model: 'model-x',
      usage: {
        input_tokens: tokens.input,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: tokens.cacheRead,
        output_tokens: tokens.output,
      },
      // Adjent never reads this. The demo includes it to make that visible.
      content: [{ type: 'text', text: 'message body — never parsed, never stored' }],
    },
  }) + '\n';

function buildHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'adjent-demo-'));
  const claude = path.join(home, '.claude');
  const slug = path.join(claude, 'projects', 'synthetic-checkout');
  mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  mkdirSync(path.join(slug, SESSION, 'subagents'), { recursive: true });

  writeFileSync(
    path.join(claude, 'sessions', 'demo.json'),
    JSON.stringify({
      pid: process.pid, // our own pid, so the session reads as live
      sessionId: SESSION,
      cwd: PROJECT,
      startedAt: NOW - 40 * MIN,
      version: '0.0.0-demo',
      entrypoint: 'cli',
      name: 'demo-session',
    }),
  );

  // The parent: ordinary work. Turn sizes vary and context grows, which is what
  // a healthy session looks like from the outside.
  let parent = '';
  for (let i = 0; i < 14; i++) {
    parent += turn(`p${i}`, NOW - (14 - i) * MIN, {
      input: 400 + i * 250 + (i % 3) * 900,
      cacheRead: 12_000 + i * 4_500,
      output: 300 + (i % 4) * 220,
    });
  }
  writeFileSync(path.join(slug, `${SESSION}.jsonl`), parent);

  // The subagent: the same request, over and over. Identical turn sizes, and
  // context that never grows — it is not learning anything.
  let sub = '';
  for (let i = 0; i < 14; i++) {
    sub += turn(`s${i}`, NOW - (14 - i) * MIN, { input: 1_200, cacheRead: 48_000, output: 260 });
  }
  writeFileSync(path.join(slug, SESSION, 'subagents', 'agent-researcher.jsonl'), sub);

  // The rule, as it ships in the `fleet` preset — see the note at the top for
  // the one threshold this lowers and why.
  mkdirSync(path.join(home, '.adjent'), { recursive: true });
  writeFileSync(
    path.join(home, '.adjent', 'alarms.yaml'),
    [
      'alarms:',
      '  - id: looping-subagent',
      '    type: anomaly',
      '    window: 15m',
      '    trigger:',
      '      min_turns: 12',
      '      shape_cv: 0.15',
      '      growth_floor: 0.2',
      '      abs_pct_per_hour: 0   # demo only — see scripts/demo-loop.mjs',
      '    cooldown: 30m',
      '    severity: warn',
      'routing:',
      '  info: [console]',
      '  warn: [console]',
      '  critical: [console]',
      '',
    ].join('\n'),
  );

  return home;
}

const home = buildHome();
try {
  console.log('A session working normally, and one subagent of it repeating itself.');
  console.log('Running the real `adjent status` against a synthetic home directory…\n');

  const res = spawnSync(process.execPath, [CLI, 'status'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
    timeout: 60_000,
  });

  if (res.error) {
    console.error(`Could not run the CLI at ${CLI}`);
    console.error('Build first:  pnpm -r build');
    process.exit(1);
  }
  process.stdout.write(res.stdout);
  if (res.stderr.trim()) process.stderr.write(res.stderr);

  // The alarm is delivered by the console sink, so it lands on stdout with the
  // status table. Check for it rather than trusting that it happened.
  const fired = /Looks like a loop/.test(res.stdout);
  console.log('');
  if (fired) {
    console.log('^ The rule read turn metadata only — no message content — and said');
    console.log('  "looks like a loop", not "this is a loop". It is a hypothesis with');
    console.log('  its evidence attached: docs/ALARMS.md § 4.');
  } else {
    console.error('The alarm did not fire. That is a bug — the fixture is built to trip it.');
    console.error('Please open an issue with the output above.');
    process.exit(1);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
