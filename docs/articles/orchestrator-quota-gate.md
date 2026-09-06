# Giving an agent orchestrator a quota gate

Before launching another coding worker, an orchestrator needs to distinguish
“there is headroom,” “defer this,” and “the monitor cannot tell.” A single
percentage without a timestamp cannot express all three.

[Adjent](../../README.md) exposes this decision through a headless CLI. It runs
without Electron or someone watching the tray. The caller owns scheduling,
enforcement and whether to ask a human for help.

## Ask for remaining capacity and freshness together

From a built source checkout:

```sh
node packages/cli/dist/main.js check --backend codex --budget 20% --max-age 10m --json
```

This requires at least 20% remaining in every limit selected by the backend
scope, with readings no older than ten minutes. Without an explicit scope,
`check` evaluates the binding limit. A backend can expose several limits; passing
one while another is exhausted is insufficient.

These invented readings illustrate the outcomes:

| Observation | Result |
| --- | --- |
| 58% used, fresh, gate open | Exit 0: predicate holds. |
| 88% used, fresh | Exit 4: insufficient headroom. |
| 58% used, 30 minutes old | Exit 5 when staleness is the only failure. |
| No usable quota reading | Exit 3: no data. |
| Advisory gate held | Exit 4, even if there is no quota reading. |

A snapshot generated now can contain an old quota observation. Check the
vendor observation time, not just the time the snapshot was assembled. Passing
a headroom check is not a reservation: concurrent workers can spend the same
capacity, and the next task may cost more than expected.

## Branch on the contract, not the printed sentence

This cross-platform Node example classifies the result. Run it from the repo
root after building; the CLI collects configured local providers and may query
Claude quota even though this predicate selects Codex. It launches no worker:

```js
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  'packages/cli/dist/main.js', 'check',
  '--backend', 'codex', '--budget', '20%', '--max-age', '10m', '--quiet',
], { stdio: 'inherit' });

if (result.error || result.signal) throw new Error('Quota check did not finish');
switch (result.status) {
  case 0: console.log('Eligible for scheduling; apply the remaining task policy.'); break;
  case 4: console.log('Defer: budget predicate failed or advisory gate is held.'); break;
  case 3: console.log('Defer: no quota evidence is available.'); break;
  case 5: console.log('Defer: wait for a fresher quota observation.'); break;
  default: throw new Error(`Quota check failed with exit ${result.status}`);
}
```

Save this as an `.mjs` file to run with Node. Exit 2 is a usage error and exit 1
is an internal error; neither should be interpreted as a routine quota decision.
For a completely isolated example, run `node scripts/demo-discovery.mjs` instead.

## An explicit hold carries a different kind of evidence

Quota can be plentiful while a workflow should pause for review. The advisory
gate expresses that independently:

```sh
node packages/cli/dist/main.js gate hold --reason "review demo worker" --until 30m
node packages/cli/dist/main.js gate status --json
node packages/cli/dist/main.js gate release
```

These commands change Adjent's gate in your monitor directory. The synthetic
demo runs equivalent commands inside a disposable home. `check` already
consults the gate; JSON output includes `gateHeld` when callers need to
distinguish a hold from a quota failure.

The gate is cooperative. An unreadable gate file reads as open, an expired hold
expires without a write, and a rule can hold only when automatic actions are
enabled. Rules never release automatically; release belongs to the caller's
policy. If your workflow needs durable authorization or capacity reservations,
implement those in the orchestrator alongside these observations.

The [API contract](../API.md) covers payloads, freshness, scopes and every exit
code. The [alarm design](../ALARMS.md#delivery) explains how optional rule
actions can publish a hold. Together they support human supervision today and
agent-driven decisions without a mandatory human step.
