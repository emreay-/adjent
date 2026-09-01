# The Adjent API

Adjent has two consumers: the desktop panel, and whatever you write. This
document is the contract for the second one.

The unit is the **snapshot** — one JSON object describing everything Adjent
knows at an instant. Every surface serves the same shape: the CLI's `--json`
output and the event stream both carry a snapshot, so a consumer learns it once.
(A local HTTP API is a possible third surface; it is not built, and nothing in
this document depends on it.)

## Snapshot

A projection of Adjent's internal state, never an alias for it. The internal
model stays free to change; this shape does not.

```json
{
  "schemaVersion": 1,
  "machineId": "11111111-2222-4333-8444-555555555555",
  "generatedAt": 1700000000000,
  "backends": [
    {
      "id": "claude",
      "displayName": "Claude Code",
      "version": "2.1.0",
      "plan": "demo",
      "rateLimitTier": "demo_tier",
      "health": "ok",
      "healthDetail": null
    }
  ],
  "limits": [
    {
      "backend": "claude",
      "key": "5h",
      "label": "Claude · 5h",
      "windowMinutes": 300,
      "utilization": 32,
      "resetsAt": 1700010800000,
      "severity": null,
      "scope": null,
      "bindingLimit": true,
      "verdict": "on-pace",
      "paceLinePct": 40,
      "exhaustsAt": 1700028800000,
      "burnPctPerHour": 8.1,
      "tokens": { "input": 100, "cacheWrite": 10, "cacheRead": 1000, "output": 50 },
      "observedAt": 1700000000000,
      "provenance": {
        "utilization": "reported",
        "burnPctPerHour": "reported",
        "paceLinePct": "reported",
        "exhaustsAt": "derived",
        "tokens": "exact"
      }
    }
  ],
  "agents": [
    {
      "id": "claude:a1",
      "backend": "claude",
      "label": "demo",
      "projectPath": "/w/demo",
      "gitBranch": "main",
      "model": "model-x",
      "effort": "high",
      "entrypoint": "cli",
      "state": "live",
      "startedAt": 1699996400000,
      "lastActivityAt": 1700000000000,
      "burnPctPerHour": 4.2,
      "tokens": { "input": 100, "cacheWrite": 10, "cacheRead": 1000, "output": 50 },
      "provenance": { "tokens": "exact", "burnPctPerHour": "derived" }
    }
  ],
  "epsilon": 0.5,
  "fitConfidence": "high",
  "provenance": { "epsilon": "derived" }
}
```

*Synthetic values throughout. The **key shape** of this example, its two
`provenance` maps and its `schemaVersion` are asserted against the code by
`packages/core/test/snapshot.contract.test.ts`, so a renamed, added or removed
key fails a test.*

*What that test does **not** cover, so read the rest of this page as prose
rather than as verified fact: the example's values, their types and their
nullability; the command and event tables below; and the meanings in the
exit-code table (it checks only that a row exists for each code). Those are
maintained by hand.*

### Top level

| Field | Meaning |
| --- | --- |
| `schemaVersion` | The contract version. See [Compatibility](#compatibility). |
| `machineId` | Opaque per-installation UUID. See [machineId](#machineid). |
| `generatedAt` | Epoch ms when Adjent assembled this snapshot. |
| `backends[]` | One per vendor Adjent detected, whether healthy or not. |
| `limits[]` | Every quota limit reported, across all vendors. |
| `agents[]` | Every session Adjent can see, live, idle or recently ended. |
| `epsilon` | Consistency residual, %/h. Null before the fit has an opinion. |
| `fitConfidence` | `low` / `medium` / `high` for the binding limit's vendor. |

### Times and numbers

* **All timestamps are epoch milliseconds**, and `null` means *unknown* — never
  `0`. An agent with `"lastActivityAt": null` has never been observed taking a
  turn; it has not been idle since 1970.
* **Utilization is a percentage**, 0–100, as the vendor reports it. It can
  exceed 100 if a vendor says so; do not clamp it on Adjent's behalf.
* **Burn rates are percentage points per hour** (`%/h`), never tokens per
  second and never a fraction.
* `tokens` counts **billable kinds only**. Thinking tokens are already inside
  `output` for both vendors, so listing them separately would double them.

### `limits[]`

`bindingLimit` marks the one limit that will stop you first — not necessarily
the fullest one. 84% of a weekly limit with six days left is less urgent than
60% of a five-hour limit with forty minutes left. Exactly one limit carries
`true` when any limit is present. The selection rule, including its hysteresis,
is in [UI.md](UI.md#choosing-the-binding-limit).

**If you are automating one decision, read the limit with `bindingLimit: true`.**

`observedAt` is when the *vendor's* reading was taken, which is not
`generatedAt`. Codex publishes quota inside session rollouts, so its readings
freeze while Codex is idle: a snapshot taken now can legitimately carry an
hour-old Codex reading. Compare the two if freshness matters to you.

`tokens` is counted from transcripts and **does not reconcile with
`utilization`**, by design. The vendor meters a weighted mix of kinds and
models; what relates 10.2M tokens to 46% is the fitted exchange rate, not
arithmetic. Treat them as answers to different questions: *where did it go*
versus *how full is it*.

### `agents[]`

`model` is `null` when no turn has yet named one. Providers write an internal
placeholder in that case so the ledger has a bucket key; the placeholder never
crosses this boundary. Render "unknown", not the raw value you did not receive.

`burnPctPerHour` is `null` when the fit has nothing to say — no fit yet for that
agent's vendor, or a rate below the reporting floor. **Null does not mean zero**,
and it does not mean the agent stopped: check `state` for that.

### Provenance

Every object carrying numbers also carries a `provenance` map, keyed by that
object's own numeric field names:

| Value | Meaning | How to render |
| --- | --- | --- |
| `reported` | The vendor said it, or it follows from what the vendor said. | Plain. |
| `exact` | Counted from transcripts on this machine. | Plain. |
| `derived` | A model output — it came out of the exchange-rate fit. | Prefix `≈`. |

This is **data, not decoration**. A consumer decides how to render from the map;
it never string-matches a `≈` out of a formatted value, and it never has to
guess whether a number was measured or modelled.

A field absent from the map has no provenance because Adjent did not produce
it — `burnPctPerHour: null` carries no `burnPctPerHour` entry. Absence of a key
is therefore meaningful, and iterating the map is safe: every key in it names a
field that is present.

### `machineId`

A random UUID minted once into `~/.adjent/machine.json` and stable thereafter.

It is deliberately **not** derived from a hostname, user name or MAC address. A
snapshot can leave the machine that produced it — piped into an orchestrator,
posted to a relay, pasted into an issue — and a derived id would let anyone
holding a payload work out whose machine it came from. That is precisely the
property a metadata-only tool must not have.

Consequences worth knowing:

* Deleting `~/.adjent/machine.json` produces a *new* machine as far as any
  consumer is concerned. Adjent re-mints rather than failing, including from a
  corrupt file, because an unreadable id must never be the reason the app
  cannot report anything.
* It identifies an **installation**, not a person or a host. Two accounts on one
  machine are two installations; one account restored to new hardware is the
  same installation.

## Compatibility

**Within a `schemaVersion`, changes are additive only.**

* New fields may appear at any time. **Consumers must ignore unknown fields** —
  that is what makes additive change safe, and a consumer that rejects unknown
  keys will break on a patch release.
* No field is removed, renamed, or has its type changed without bumping
  `schemaVersion`.
* A field's *meaning* will not change under you either. If the honest answer
  changes shape, it arrives as a new field beside the old one.
* A bump lands with a migration note in this document, in the same commit.

Field names follow [GLOSSARY.md](GLOSSARY.md) exactly — `utilization`,
`bindingLimit`, `burnPctPerHour`. No synonyms enter the API, because a synonym
in a published payload is permanent.

## Commands

Every command takes `--json`. Without it you get human output; with it you get
one object on stdout and nothing else.

| Command | Answers | `--json` payload |
| --- | --- | --- |
| `adjent status` | everything at once | `{ snapshot }` |
| `adjent limits` | how full each limit is | `{ limits[], generatedAt }` |
| `adjent agents` | what is running and what it costs | `{ agents[], generatedAt }` |
| `adjent statusline` | one line for a status bar | `{ bindingLimit, text }` |
| `adjent explain <term>` | what a number means | `{ term, title, body, provenance }` |
| `adjent check` | may I start more work? | `{ ok, predicate, evaluated[] }` |
| `adjent watch` | a live loop | *(JSONL — see the event stream)* |
| `adjent rules init [--preset <name>] [path]` | write a starting `alarms.yaml` | `{ ok, preset, path, bytes }` |
| `adjent rules validate` | is my config well-formed? | `{ ok, path, exists, diagnostics[], effective }` |
| `adjent rules test` | would my rules have fired against my own history? | `{ alarms[], byRule, notEvaluable[], samples, from, to, longestSilenceMs }` |
| `adjent rules presets` | what starting points exist | `{ presets[] }` — each `{ name, summary }` |

`limits` and `agents` are the sections of `status`, lifted out so a script can
ask for one without parsing past the others. They carry the same objects the
snapshot does, so anything you learn about `snapshot.limits[]` applies.

`statusline --json` answers one question rather than returning the whole
snapshot, and `bindingLimit` is `null` — present, not omitted — when there is no
data. The rendered `text` rides along so a status bar needs no formatter.

`--quiet` prints nothing on any command; the exit code is the whole answer.

### `adjent check` — the budget gate

```
adjent check [--budget <pct>] [--max-utilization <pct>] [--pace <verdict,...>]
             [--backend <id>] [--limit <key>] [--max-age <dur>] [--json] [--quiet]
```

`--budget 20%` means **"at least 20% of the limit must remain"** — that is,
utilization at most 80. It is phrased as headroom rather than usage because
that is the question being asked: *do I have room to start something?*

Scope is **the binding limit** unless `--limit` or `--backend` narrows it. When
several limits are in scope, **the predicate must hold for all of them** — a
gate that passed because *one* limit had room would green-light work the weekly
limit cannot afford.

Every condition given must hold. `--max-age` is the only one that is ignored
when absent: what counts as too old is the caller's business.

```sh
# Only start the batch if a fifth of the week's budget is still there.
adjent check --budget 20% --limit 7d --quiet || exit 0

# Refuse to act on a reading older than ten minutes.
adjent check --budget 20% --max-age 10m --quiet
```

Exit codes carry the answer: **0** it holds, **4** it does not, **5** the only
problem was staleness, **3** there was nothing to judge, **2** a condition could
not be read. A flag Adjent cannot parse is a usage error rather than a silently
dropped condition — a gate that looks configured and enforces nothing is worse
than one that refuses to run.

## The event stream

`adjent watch --json` writes **JSONL**: one object per line, flushed as it
happens. A reader blocked on `read` wakes on the event, not on a buffer flush.

```sh
adjent watch --json | while read -r line; do
  jq -r 'select(.type == "alarm") | .alarm.title' <<< "$line"
done
```

Three line types, each carrying `schemaVersion`, `type` and `at`:

| `type` | Payload | When |
| --- | --- | --- |
| `state` | `snapshot`, `changed` | something actionable changed, or a heartbeat |
| `alarm` | `alarm` | a rule fired |
| `error` | `backend`, `detail` | a collection pass failed |

**A `state` line is not emitted every tick.** Ticking every 30 seconds and
publishing each one would produce a line a minute per machine whether or not
anything happened, leaving every consumer to diff the stream themselves. So a
line is published when something you could act on has changed — a limit's
utilization to the nearest point, the set of live agents, or a backend's health
— and otherwise only on a heartbeat, so that a quiet stream stays
distinguishable from a dead process.

`changed` tells you which kind you are looking at: `true` for a real change,
`false` for a heartbeat. The first line after attaching is always sent, so you
have a baseline before any change can mean anything.

Growing token counts are deliberately *not* a change. They climb continuously,
and treating them as events would republish the snapshot every tick — which is
the behaviour this design exists to avoid.

`--interval <dur>` sets the poll period (`90s`, `2m`); the heartbeat is ten
intervals. Ctrl-C exits **0** after the line in flight, never a truncated
object. An `error` line never ends the stream — one failing backend degrades
itself, not the app.

## The gate

The one thing Adjent offers beyond answers: a **hold/open signal an
orchestrator reads before starting more work**.

It is advisory by construction. Adjent writes `~/.adjent/gate.json` and does
nothing else — it starts no process, stops none, and signals none. Your wrapper
reads the signal and decides. See
[What Adjent will not do](../README.md#what-adjent-will-not-do).

```sh
adjent gate status              # exit 0 open, 4 held
adjent gate hold --reason "deploying" --until 2h
adjent gate release
```

`gate status --json` is one object:

```json
{
  "schemaVersion": 1,
  "held": true,
  "reason": "deploying",
  "until": 1700000000000,
  "at": 1699999000000,
  "source": "human",
  "ruleId": null
}
```

`schemaVersion` is the **gate's own**, not the snapshot's: the two are read by
different consumers and have no reason to move together. `source` is `human` or
`rule`, and `ruleId` names the rule when one set it.

### Queueing work instead of launching it

The whole point, in a shell:

```sh
#!/bin/sh
# Start a worker only if there is both quota and permission.
if ! adjent check --budget 15% --limit weekly_all; then
  echo "not enough quota — queueing" >&2
  exit 0
fi
exec ./run-worker.sh
```

`check` consults the gate itself, so that one call covers both: a held gate
fails the predicate regardless of how much quota is left. To ask only about the
gate — for work that is not quota-bound at all — use `adjent gate status`.

Three behaviours a script author should be able to rely on:

* **A held gate answers even when there is no quota data.** `check` returns
  *no*, not *I cannot say*, which is the case an orchestrator most needs an
  answer in.
* **An unreadable gate file reads as open.** Failing closed would halt your
  fleet because a JSON file got truncated; the signal is advisory, and one that
  cannot be read has nothing to advise.
* **`--until` expires on its own.** An expired hold reads as open without
  anything having to rewrite the file, so reading never requires write access.

A rule can set the gate too — `actions: [hold]` in `alarms.yaml` — but only
when `settings.actions.enabled` is `true`, which it is not by default. That
switch governs automation, never you: `adjent gate hold` always works. A rule
may hold and never release. See [ALARMS.md](ALARMS.md#delivery).

## Exit codes

Every CLI command uses one table, so a script can branch on the code without
parsing output. **Fixed from here on** — a new meaning takes a new number.

| Code | Meaning |
| --- | --- |
| 0 | Success. For `check`, the predicate held. |
| 1 | Internal error. |
| 2 | Usage error — unknown command or flag. |
| 3 | No data — no backend detected, or no quota reported. |
| 4 | `check` predicate did not hold, **or the gate is held**. Also `gate status` when held. |
| 5 | Data staler than `--max-age`, and only when that flag was given. |
| 6 | Config invalid (`rules validate`). |

Three of these deserve a note, because the distinctions are the point:

* **3 is not an error.** A machine with no agent installed reports code 3 and a
  valid, empty snapshot. Treat it as "nothing to say", not as a failure.
* **4 is not an error either.** `check` answering *no* is a successful
  evaluation, which is why it is separate from 1. A CI step that treats any
  non-zero code as breakage will misread a working budget gate.
* **5 only ever appears when you asked for it.** Without `--max-age`, stale data
  is returned with its `observedAt` and no complaint — deciding what counts as
  too old is the caller's business, not Adjent's.
* **4 covers the gate deliberately.** A held gate is not a new kind of outcome:
  to a caller asking "may I start work?" it is the same *no* a failed budget
  is. Reusing the code is a restatement of an existing meaning rather than a
  new one, which is what "fixed from here on" requires. `check --json`
  distinguishes the two with `gateHeld`, for callers that care why.

**JSON on stdout, everything else on stderr.** A pipe never receives a progress
line, a warning or a cleared screen, and `--json` implies non-interactive
output. Degradation notes go to stderr *and* set the exit code, so a consumer
reading only stdout still gets valid JSON and still knows something was wrong.

## What is never in a payload

Adjent is metadata-only, and that is enforced at the parser rather than
promised here: prompts, completions, file contents and tool arguments are
discarded at read time and never enter application state. No API surface can
emit them because nothing upstream retains them.

Paths *are* included — `projectPath` is the point of per-project attribution —
so a snapshot does describe your directory layout. If you are shipping payloads
somewhere, that is the field to think about.
