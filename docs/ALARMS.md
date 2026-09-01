# Alarms

The alarm engine is a **pure function**:

```ts
evaluate(state: AppState, rules: Rule[], memory: FireLog, now: number): Alarm[]
```

No I/O, no timers, no side effects. That makes the whole feature testable against
synthetic timelines, which matters because alarm bugs are silent — a rule that
never fires looks identical to a quiet day.

Four rule types cover everything requested.

## 1. `pace` — linear burn model

Quota in a limit whose period is `W`, resetting at `T_reset`, should be consumed
linearly. Elapsed fraction:

```
e = (now - (T_reset - W)) / W        // 0 → 1 across the limit
```

Fire when actual usage runs ahead of the line:

```
used% > e·100 + tolerance_pp
```

Also fire on **projected exhaustion**. With burn rate `b` (percent per minute,
EWMA over the last 15 min):

```
T_exhaust = now + (100 - used%) / b
fire if T_exhaust < T_reset - lead_time
```

Severity scales with the overshoot in percentage points. This is the rule the
user described: *"at hour two of a five-hour limit, expect ≤40%."*

Two guards keep it from becoming noise: **hysteresis** (clear only once usage
falls `tolerance_pp/2` back under the line) and a **cooldown** per rule.

## 2. `threshold` — constant model

Edge-triggered crossings of configured levels, per limit, per backend or across
all of them.

* Fires once per level per limit occupancy — crossing 50% does not re-fire when
  usage oscillates around 50%.
* **Rearms on limit reset** (detected by `resets_at` moving forward), so a new
  5-hour limit gives a fresh set of 25/50/80/95 notifications.
* **At most one alarm per limit per evaluation.** When several levels are
  crossed at once — a jump from 20% to 96%, or the app starting up against an
  already-full limit — every crossed level is armed but only the **highest** is
  announced. 95% already implies 25/50/80, and it carries the most severe
  routing, so the rest are pure noise.
* **First sight is not a crossing.** A limit observed for the first time
  already past a level did not cross it while we were watching, and saying it
  did would be false. Adjent arms silently instead — unless the level is a
  `warn` or `critical` one, where silence is worse than an imperfect message, and
  then it says what is actually true: *"Codex · 7d is already at 100%"*.

  This distinction needs `firedLevels[key] === undefined` to mean "never
  observed", so the reset path empties the array rather than deleting the key.

## 3. `agent_burn` — per-agent model

Per-agent burn `b_i` = **share of the limit consumed per hour**, from the agent's
token stream priced through the learned exchange rate (see
[ARCHITECTURE.md](ARCHITECTURE.md#the-exchange-rate--tokens-per-percentage-point)).
Expressing it in `%/h` puts it in the same unit as every other alarm and as the
hero figure, so one threshold means the same thing everywhere.

Fire when any of:

* `b_i > rel_to_median × median(b)` across live agents — a runaway relative to
  what "normal" looks like right now;
* `b_i / Σb > share_pct` — one agent is eating the limit;
* `b_i > abs_pct_per_hour` — a hard floor so a single agent running alone can
  still trip the alarm (the median test is blind to that case).

The absolute floor exists specifically because a lone looping agent has no peers
to look abnormal against.

## 4. `anomaly` — turn-shape model

The other three ask *how much*. This one asks *what does the work look like* —
which is how it catches a worker that is cheap per turn and ruinous over an
hour, and it is the only rule here that no comparable tool ships.

Over a lookback window $	au$ (default 15 m), per worker, from usage events
alone:

* $n$ — turns in the window;
* $cv$ — the coefficient of variation of per-turn total tokens: standard
  deviation over mean, so it means the same thing for a worker averaging 2k
  tokens and one averaging 200k;
* $growth$ — the fraction of consecutive turns whose cache reads increased.

It fires when **all four** hold:

$$n \ge 	ext{min\_turns} \;\wedge\; cv < 	ext{shape\_cv} \;\wedge\; growth < 	ext{growth\_floor} \;\wedge\; b \ge 	ext{abs\_pct\_per\_hour}$$

Each condition alone has an innocent reading — a long run of turns is a big
task, uniform sizes happen in batch work, flat context happens right after a
compaction, and a high burn rate is just a busy agent. Together they are the
signature of a worker re-sending nearly the same request. A healthy session
accumulates context, so `growth` trends high; a fixed-point loop plateaus or
sawtooths.

**A worker is an agent, or one subagent of it.** This is the one place Adjent
distinguishes them, and it is why: a looping subagent's uniform turns
interleaved with its parent's varied ones look like neither. The distinction is
for detection only — the subagent never becomes a row, a count or a total, and
the alarm names the *session*, describing the offender as "a subagent of" it.
See [GLOSSARY § Sessions and their subagents](GLOSSARY.md#sessions-and-their-subagents).

**Reproducing it.** `node scripts/demo-loop.mjs` builds a synthetic home
directory holding a healthy session and a looping subagent of it, and runs the
real `adjent status` against it — see [the README](../README.md#see-it-catch-a-loop).
The script's header explains the one threshold its config disables and why.

**What it cannot see.** Adjent reads metadata, never message content. So a
*semantic* loop — one that keeps rephrasing, retrying different approaches, or
otherwise varies its token counts while making no progress — is invisible to
this rule, and no amount of tuning will surface it. The rule detects
repetition of *shape*, and the copy it produces is a hypothesis rather than a
verdict: **"Looks like a loop"**, with the numbers that prompted it, for you to
judge.

Two consequences worth knowing before you tune it:

* A ledger row is one API call, not one conversational turn. A turn with tool
  round-trips writes several, so `min_turns` is reached sooner than the phrase
  suggests.
* The burn floor reads the *agent's* rate, because a subagent's spend is not
  priced separately. Until the exchange-rate fit has bootstrapped for that
  vendor there is no rate at all, and the rule stays silent — the same
  cold-start behaviour as `agent_burn`.

## Configuration

Declarative, hot-reloaded from `~/.adjent/alarms.yaml`. Edit it in your own
editor, or in the panel under **Settings → Alarm rules**, which is the same file
with the diagnostics and the effective rule set shown live beside it — see
[UI.md § Editing the rules](UI.md#editing-the-rules). Both paths are equivalent:
the file is watched, so a save applies without a restart either way.

```yaml
alarms:
  - id: pace-any
    type: pace
    scope: { backend: any, limit: any }
    tolerance_pp: 10
    project_exhaustion_lead: 45m
    cooldown: 20m
    severity: warn

  - id: steps
    type: threshold
    scope: { backend: any, limit: any }
    levels: [25, 50, 80, 95]
    severity: { 25: info, 50: info, 80: warn, 95: critical }

  - id: runaway-agent
    type: agent_burn
    window: 10m
    trigger:
      rel_to_median: 4.0
      share_pct: 60
      abs_pct_per_hour: 8.0
    cooldown: 15m
    actions: [notify, highlight]

  - id: looping-subagent
    type: anomaly
    window: 15m
    trigger:
      min_turns: 12
      shape_cv: 0.15
      growth_floor: 0.2
      abs_pct_per_hour: 2.0
    cooldown: 30m
    severity: warn

routing:
  info:     [tray]
  warn:     [tray, toast]
  critical: [tray, toast]
```

`scope`, `severity` and `routing` are separate axes on purpose: adding a Slack or
ntfy destination later is a routing-table edit, not a rule change.

**A routing table can only name a sink this installation can build.** `webhook`
needs `alarmWebhookUrl` in `~/.adjent/settings.json`; until it is set, the sink
does not exist, so it is deliberately absent from the shipped presets rather
than routed into nothing. Add it once the URL is configured:

```yaml
  critical: [tray, toast, webhook]
```

If a routing table names a sink that is not registered, Adjent says so — once,
on stderr in the CLI and as a notification in the tray app — instead of dropping
the alarm silently. An unknown name (a typo) is additionally reported by
`adjent rules validate`. This matters more than it sounds: an alarm you believe
is armed and which goes nowhere is worse than one you never configured.

## What an alarm carries

The body stays short enough to fit a toast, so every alarm also captures an
`AlarmContext` snapshot of the moment it fired — the notifications view reveals
it on hover, which is what makes a notification read hours later still explain
itself:

| Field | Why it is worth keeping |
| --- | --- |
| `limitLabel`, `utilization` | which limit, and how full it was *then* — not now |
| `burnPctPerHour`, `paceLinePct` | how fast, against where even spending would have been |
| `resetsAt`, `exhaustsAt` | how much runway was left, and whether it was projected to run out first |
| `plan` | which tier the limit belonged to |
| `agents[]` | **what you were actually doing**: project directory (full path, not just the folder name — two checkouts of one repo are indistinguishable otherwise), git branch, model, effort, derived %/h and token total, most expensive first |
| `fitConfidence` | how much to trust the derived figures in the snapshot |

For an `agent_burn` or `anomaly` alarm the snapshot narrows to the offending
agent; for limit alarms it lists the top few contributors. The snapshot is written into
`~/.adjent/alarms.jsonl` with the alarm, so it survives restarts.

## Delivery

**An alarm tells you something; it never does anything to your agents.** Adjent
does not start, stop, pause or signal a process — see
[What Adjent will not do](../README.md#what-adjent-will-not-do).

The one thing a rule may do besides telling you is **hold the advisory gate**:

```yaml
  - id: stop-the-fleet
    type: threshold
    levels: [95]
    severity: { 95: critical }
    actions: [hold]
```

That writes `held` into `~/.adjent/gate.json`. Nothing is signalled and nothing
is stopped; a wrapper script or orchestrator *you* control reads it — with
`adjent gate status`, or `adjent check`, both of which exit 4 when the gate is
held — and decides what to do. See [API.md](API.md#the-gate) for the contract.

Three properties of that path, each deliberate:

* **It is off unless you turn it on.** `actions.enabled` in
  `~/.adjent/settings.json` defaults to `false`, and a rule naming `actions:
  [hold]` does nothing until it is `true`. Automation that can hold your work
  should be something you enabled, not something you discover.
* **The switch governs automation, not you.** `adjent gate hold` always works;
  it is your machine and your decision.
* **A rule may hold, never release.** Releasing is a human act — a rule that
  could release the gate could undo a hold you put there deliberately. It also
  will not overwrite a hold that is already in place, so the reason you gave
  survives.

Alarms are emitted onto the bus; **sinks** consume them. **Shipped today:**
`tray` and `toast` (desktop shell), `console` (CLI), and `webhook` (core, once
`alarmWebhookUrl` is set). `prometheus`, `mqtt` and `slack` are *intended*, not
built — they are the same interface, which is the point of the abstraction, but
naming one in a routing table today reports it as unroutable.

```ts
interface Sink { id: string; deliver(alarm: Alarm): Promise<void> }
```

## Testing

Each rule gets a table of synthetic timelines with expected fire/no-fire output:
a steady 5-hour limit that must stay silent; a front-loaded one that must fire
`pace` at minute 40; oscillation around 50% that must fire `threshold` once; a
limit reset that must rearm; a single looping agent that must trip the absolute
floor but not the median test. These tests are the spec.
