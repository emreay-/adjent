# Alarms

The alarm engine is a **pure function**:

```ts
evaluate(state: AppState, rules: Rule[], memory: FireLog, now: number): Alarm[]
```

No I/O, no timers, no side effects. That makes the whole feature testable against
synthetic timelines, which matters because alarm bugs are silent — a rule that
never fires looks identical to a quiet day.

Three rule types cover everything requested.

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

## Configuration

Declarative, hot-reloaded from `~/.adjent/alarms.yaml`:

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

routing:
  info:     [tray]
  warn:     [tray, toast]
  critical: [tray, toast, webhook]
```

`scope`, `severity` and `routing` are separate axes on purpose: adding a Slack or
ntfy destination later is a routing-table edit, not a rule change.

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
| `agents[]` | **what you were actually doing**: project, git branch, model, effort, derived %/h and token total, most expensive first |
| `fitConfidence` | how much to trust the derived figures in the snapshot |

For an `agent_burn` alarm the snapshot narrows to the offending agent; for
limit alarms it lists the top few contributors. The snapshot is written into
`~/.adjent/alarms.jsonl` with the alarm, so it survives restarts.

## Delivery

Alarms are emitted onto the bus; **sinks** consume them. The tray/toast sink
ships first; `webhook`, `prometheus`, `mqtt` and `slack` are the same interface.

```ts
interface Sink { id: string; deliver(alarm: Alarm): Promise<void> }
```

## Testing

Each rule gets a table of synthetic timelines with expected fire/no-fire output:
a steady 5-hour limit that must stay silent; a front-loaded one that must fire
`pace` at minute 40; oscillation around 50% that must fire `threshold` once; a
limit reset that must rearm; a single looping agent that must trip the absolute
floor but not the median test. These tests are the spec.
