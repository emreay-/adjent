/**
 * Binary smoke test: does the thing we ship actually run?
 *
 * Everything else in CI proves the modules compile and the units behave. This
 * runs the built CLI as a user would — a real process, a real home directory,
 * real vendor files on disk — and checks the payload it prints. The difference
 * matters: a broken entry point, a bad import specifier, a missing `bin` field
 * or a file the bundle forgot to copy all pass the unit suite and fail here.
 *
 * The fixture home is GENERATED rather than checked in, for two reasons:
 *   - timestamps. Agent liveness and the 48-hour ledger are relative to now, so
 *     a checked-in fixture would quietly decay into "no data" and this test
 *     would keep passing while asserting nothing.
 *   - CLAUDE.md. Nothing here comes from a real machine: synthetic ids, invented
 *     numbers, zeroed paths, and no credentials file at all — which also means
 *     no token, so the quota endpoint is never called and CI stays offline.
 *
 * Run: node packages/cli/test/smoke.mjs
 * Exits 0 on success, 1 with a reason on failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'main.js');

const NOW = Date.now();
const MIN = 60_000;

// --------------------------------------------------------------------- fixture
function buildHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'adjent-smoke-'));

  // ~/.claude — one live session with one turn. No .credentials.json: absent
  // credentials mean no token, no quota request, and a null plan, which is a
  // state the app must handle anyway.
  const claude = path.join(home, '.claude');
  mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  mkdirSync(path.join(claude, 'projects', 'synthetic-project'), { recursive: true });
  writeFileSync(
    path.join(claude, 'sessions', 'smoke.json'),
    JSON.stringify({
      pid: process.pid, // our own pid, so the session reads as live on any OS
      sessionId: '00000000-0000-4000-8000-000000000001',
      cwd: '/synthetic/project',
      startedAt: NOW - 30 * MIN,
      version: '0.0.0-synthetic',
      entrypoint: 'cli',
      name: 'smoke-session',
    }),
  );
  writeFileSync(
    path.join(claude, 'projects', 'synthetic-project', '00000000-0000-4000-8000-000000000001.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - 5 * MIN).toISOString(),
      requestId: 'req_smoke_0001',
      effort: 'high',
      gitBranch: 'synthetic-branch',
      message: {
        model: 'model-x',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 50_000,
          output_tokens: 700,
          output_tokens_details: { thinking_tokens: 150 },
        },
        content: [{ type: 'text', text: 'BODY THAT MUST NEVER LEAVE THE PARSER' }],
      },
    }) + '\n',
  );

  // ~/.codex — one rollout under today's date directory.
  const codex = path.join(home, '.codex');
  const d = new Date(NOW);
  const day = path.join(
    codex,
    'sessions',
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  );
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(codex, 'session_index.jsonl'),
    JSON.stringify({ id: '00000000-0000-4000-8000-000000000002', cwd: '/synthetic/project' }) + '\n',
  );
  writeFileSync(
    path.join(day, 'rollout-2024-01-01T00-00-00-00000000-0000-4000-8000-000000000002.jsonl'),
    JSON.stringify({
      timestamp: new Date(NOW - 4 * MIN).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 200_000,
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 10_000,
            output_tokens: 300,
            reasoning_output_tokens: 40,
          },
        },
      },
    }) + '\n',
  );

  return home;
}

// -------------------------------------------------------------------- validate
/**
 * The W0.2 key set. Deliberately written out here rather than imported from
 * core: importing the shape from the code under test would make this agree with
 * itself by construction, which is the failure mode the whole step exists to
 * avoid.
 */
const REQUIRED_TOP = ['schemaVersion', 'machineId', 'generatedAt', 'backends', 'limits', 'agents'];

function validate(envelope) {
  const problems = [];
  const has = (o, k) => o !== null && typeof o === 'object' && k in o;

  // `adjent status` returns `{ schemaVersion, snapshot }` (docs/API.md § Commands);
  // the snapshot inside is the documented shape every surface shares.
  if (!has(envelope, 'snapshot')) {
    problems.push('missing `snapshot` — `adjent status --json` returns `{ snapshot }`');
    return problems;
  }
  if (typeof envelope.schemaVersion !== 'number') problems.push('envelope schemaVersion is not a number');
  const payload = envelope.snapshot;
  if (has(payload, 'schemaVersion') && payload.schemaVersion !== envelope.schemaVersion) {
    problems.push('envelope and snapshot disagree about schemaVersion');
  }

  for (const k of REQUIRED_TOP) if (!has(payload, k)) problems.push(`missing top-level key \`${k}\``);
  if (problems.length > 0) return problems; // everything below would just echo it

  if (typeof payload.schemaVersion !== 'number') problems.push('schemaVersion is not a number');
  if (typeof payload.machineId !== 'string' || payload.machineId === '') problems.push('machineId is empty');
  if (!Array.isArray(payload.agents)) problems.push('agents is not an array');
  if (!Array.isArray(payload.limits)) problems.push('limits is not an array');
  if (!Array.isArray(payload.backends)) problems.push('backends is not an array');

  // The fixture puts a live Claude session on disk. If the binary cannot see it,
  // the payload is well-formed and worthless — which is exactly the state a
  // shape-only check would wave through.
  if (Array.isArray(payload.agents) && payload.agents.length === 0) {
    problems.push('no agents parsed from the fixture home — the binary read nothing');
  }
  const agent = Array.isArray(payload.agents) ? payload.agents[0] : null;
  if (agent) {
    for (const k of ['id', 'backend', 'model', 'projectPath', 'state']) {
      if (!has(agent, k)) problems.push(`agent is missing \`${k}\``);
    }
    if (agent.model === 'gpt-unknown' || agent.model === 'unknown') {
      problems.push(`agent.model is the placeholder \`${agent.model}\` (W3.1)`);
    }
  }

  // Hard rule 2: metadata only. The fixture plants a message body specifically
  // so this assertion has something to catch.
  if (JSON.stringify(envelope).includes('MUST NEVER LEAVE THE PARSER')) {
    problems.push('message content leaked into the payload — hard rule 2');
  }

  return problems;
}

// ------------------------------------------------------------------------ run
function runCli(home) {
  const res = spawnSync(process.execPath, [CLI, 'status', '--json'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() reads this
      ADJENT_HOME: undefined,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return res;
}

function fail(msg, extra) {
  console.error(`smoke: FAIL — ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

const home = buildHome();
let exitCode = 0;
try {
  const res = runCli(home);

  if (res.error) fail(`could not run the built CLI at ${CLI}`, String(res.error));
  // 0 = fine, 3 = no data. Anything else means the binary broke.
  if (res.status !== 0 && res.status !== 3) {
    fail(`exited ${res.status}`, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }

  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch (e) {
    fail('stdout was not JSON — something wrote to the payload stream', `stdout:\n${res.stdout}`);
  }

  const problems = validate(payload);
  if (problems.length > 0) {
    fail(`the payload is not the documented contract:\n  - ${problems.join('\n  - ')}`, `stdout:\n${res.stdout}`);
  }

  // Self-test: prove the validator has teeth. A check that cannot fail is worse
  // than no check, because it reads as coverage. This is the "deliberately
  // broken fixture" the item asks for, applied to the payload rather than to
  // the files, so it cannot itself depend on parser behaviour.
  const broken = JSON.parse(JSON.stringify(payload));
  delete broken.snapshot.schemaVersion;
  broken.snapshot.machineId = '';
  if (validate(broken).length === 0) fail('the validator accepted a snapshot missing schemaVersion — it is vacuous');

  const unwrapped = JSON.parse(JSON.stringify(payload.snapshot));
  if (validate(unwrapped).length === 0) fail('the validator accepted a payload with no envelope — it is vacuous');

  const empty = JSON.parse(JSON.stringify(payload));
  empty.snapshot.agents = [];
  if (validate(empty).length === 0) fail('the validator accepted a payload with no agents — it is vacuous');

  const leaked = JSON.parse(JSON.stringify(payload));
  leaked.snapshot.note = 'BODY THAT MUST NEVER LEAVE THE PARSER';
  if (validate(leaked).length === 0) fail('the validator did not catch leaked message content — it is vacuous');

  // And the same check driven through the real binary: a home with no vendor
  // data must be REJECTED. Without this, a parser that silently returned
  // nothing would still produce a well-formed payload and pass every assertion
  // above. This is the "deliberately broken fixture" the item asks for.
  const emptyHome = mkdtempSync(path.join(tmpdir(), 'adjent-smoke-empty-'));
  try {
    const res2 = runCli(emptyHome);
    if (res2.error) fail('could not run the CLI against the empty fixture', String(res2.error));
    let payload2 = null;
    try {
      payload2 = JSON.parse(res2.stdout);
    } catch {
      payload2 = null; // unparseable is itself a rejection
    }
    if (payload2 !== null && validate(payload2).length === 0) {
      fail('a home with no vendor data passed validation — the smoke step cannot fail, so it proves nothing');
    }
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }

  const snap = payload.snapshot;
  console.log(
    `smoke: ok — ${snap.agents.length} agent(s), ${snap.limits.length} limit(s), schemaVersion ${snap.schemaVersion}`,
  );
} catch (e) {
  console.error('smoke: FAIL — unexpected error');
  console.error(e);
  exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(exitCode);
