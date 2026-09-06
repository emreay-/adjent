# Detecting looping coding agents from metadata

A worker can repeat a cheap request many times without crossing a high-burn
threshold. That makes “how much did it spend?” an incomplete way to notice a
stuck coding agent.

[Adjent](../../README.md) adds a second question: **does the recent sequence of
requests have a suspiciously repetitive shape?** Its anomaly rule uses token
counts and timing, without retaining message content.

## Four observations, one hypothesis

Over a lookback period, the rule checks:

| Observation | Why it helps |
| --- | --- |
| Enough turns | A small sample says little about repetition. |
| Little variation in turn size | Nearly identical requests often produce similar token totals. |
| Few increases in cache-read counts | A flat sequence is a proxy for context that is not growing. |
| Enough estimated agent burn | Avoid interrupting for repetition that costs very little. |

All four conditions must hold. Turn-size variation uses standard deviation
divided by the mean, called the coefficient of variation. This makes the
comparison relative to typical turn size. Context growth is a fraction of
successive turns with increased cache reads; it is not a semantic measure of
learning or progress.

The resulting message is deliberately **“Looks like a loop.”** Legitimate batch
work can have the same shape. A stuck agent that changes its token counts can
escape the rule entirely. An alarm gives a person or orchestrator evidence to
investigate; it does not certify failure.

## Why a subagent needs its own detection sequence

Imagine a parent doing varied work while its researcher repeats one request.
Merge the two sequences and the healthy parent's variation can conceal the
researcher's repetition.

Adjent therefore separates workers for anomaly detection. Their spend still
rolls up once to the parent session, which remains one row in the panel. The
alarm names the session and describes a subagent as the suspected offender.
Detection identity and accounting identity serve different purposes.

## Try the real rule with synthetic files

From a built source checkout:

```sh
node scripts/demo-loop.mjs
```

For full setup, see the [walkthrough](README.md#reproduce-it). The demo creates
a temporary home containing a healthy parent and a subagent with 14 uniform
turns in a 15-minute lookback. It runs the actual CLI and asserts that the
shipped rule engine emits the loop alarm. All paths, identifiers and usage
figures in the fixture are invented; it contains no credentials.

The fixture changes one important condition: `abs_pct_per_hour` is zero.
Estimated burn requires a learned exchange rate, and a fresh fixture does not
have one. Removing this floor lets the demo demonstrate the other three
conditions. In the production preset the floor is retained; during cold start
the absence of an estimated rate can keep the rule silent.

“Turn” also needs care: here a ledger row is one API call. Tool round-trips can
produce several rows during one conversational turn.

## Decide what happens after the alarm

A person can inspect the task. An orchestrator can consume alarm events from
`adjent watch --json` and apply its own response policy. Configured rule actions
can hold an advisory gate when automation is explicitly enabled. Adjent itself
never stops or signals a worker.

Read the [full anomaly rule](../ALARMS.md#4-anomaly--turn-shape-model) for the
equation, thresholds and limitations, and [the quota-gate article](orchestrator-quota-gate.md)
for the machine-facing decision boundary.
