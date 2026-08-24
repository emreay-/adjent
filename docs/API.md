# The Adjent API

Adjent has two consumers: the desktop panel, and whatever you write. This
document is the contract for the second one.

The unit is the **snapshot** — one JSON object describing everything Adjent
knows at an instant. Every surface serves the same shape: the CLI's `--json`
output, the event stream, and the local HTTP API all carry a snapshot, so a
consumer learns it once.

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

*Synthetic values throughout. The same payload is asserted key-by-key by
`packages/core/test/snapshot.contract.test.ts`, so this example cannot drift
from the code without a test failing.*

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
| `adjent watch` | a live loop | *(JSONL — see the event stream)* |

`limits` and `agents` are the sections of `status`, lifted out so a script can
ask for one without parsing past the others. They carry the same objects the
snapshot does, so anything you learn about `snapshot.limits[]` applies.

`statusline --json` answers one question rather than returning the whole
snapshot, and `bindingLimit` is `null` — present, not omitted — when there is no
data. The rendered `text` rides along so a status bar needs no formatter.

`--quiet` prints nothing on any command; the exit code is the whole answer.

## Exit codes

Every CLI command uses one table, so a script can branch on the code without
parsing output. **Fixed from here on** — a new meaning takes a new number.

| Code | Meaning |
| --- | --- |
| 0 | Success. For `check`, the predicate held. |
| 1 | Internal error. |
| 2 | Usage error — unknown command or flag. |
| 3 | No data — no backend detected, or no quota reported. |
| 4 | `check` predicate did not hold. |
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
