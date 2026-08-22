# Information design

The competitive problem is not data access — the last two docs show the data is
sitting there. It is that existing tools either surface something you cannot act
on, or surface everything and make you study it. Adjent's differentiator is
**editorial**: what gets cut.

So the interface is specified as constraints first, components second. Terms
used below — *primary read*, *hero number*, *token line* — are spec vocabulary
for writing the design down; none of them ever appear on screen. They are
defined in [GLOSSARY.md](GLOSSARY.md).

## Form factor: what the product physically is

Decisions, not options. Each is stated with its reason so it can be revisited
deliberately.

**Adjent is a tray-resident desktop application.** One background process,
started at login, living in the Windows notification area / Linux system tray.
It is not a limit you launch and close — the process is always on, because the
collectors and the alarm engine must run whether or not you are looking.

**Nothing but the tray icon is visible by default.** No taskbar entry, no dock
icon, no limit at rest. The reasoning: Adjent's job is to interrupt you *only*
when something needs deciding. A permanently visible dashboard trains you to
stop seeing it — the alarm engine, not your peripheral vision, is what watches.
The tray icon is the one always-on surface, and it is exactly one arc in one
status colour, so a glance answers "anything wrong?" without a click.

**The panel opens on one click, anchored to the tray icon.** Frameless,
380×560, closes on focus loss like a volume or wifi popover — not a limit you
manage, a question you ask. Left-click opens the panel; right-click a short
menu (pause alarms, pin widget, settings, quit).

**Pinned mode is the "widget", and it is opt-in.** From the tray menu, a
compact always-on-top strip (~340×96) for people who *do* want it permanently
in view — second monitor, streaming, long agent runs. It shows only tier 1½:
verdict, hero, rate, a thin pace bar with the pace line marked as a tick, and
the top agent row when it is hot. Click expands it to the full panel; drag it
anywhere and the position persists. It is deliberately not the default: the
default posture is silence.

**The widget can also carry a taskbar button.** On Windows the tray decides for
itself whether an icon sits on the taskbar or hides in the overflow flyout, and
**an app cannot promote its own icon** — that is a user choice (drag it out of
the overflow, or Settings → Personalization → Taskbar → Other system tray
icons). For anyone who wants a directly clickable taskbar entry rather than a
two-click flyout, the widget runs with `skipTaskbar: false` by default, which
gives exactly that. Settings links straight to the Windows page via
`ms-settings:taskbar`.

**Sizing is a setting, not a constant.** `uiScale` (0.8–2.0) drives the
renderer zoom factor *and* the limit dimensions together, so the panel grows
with its type rather than clipping it. The tray glyph is separate: Windows
fixes the slot at 16 logical px, so "bigger" there means rendering at a higher
scale factor for crispness and letting `trayThickness` (0.18–0.5 of radius)
and `trayStyle` (`ring` | `disc`) use more of the slot. Appearance is a third
setting — auto (follow the OS), light, or dark — applied through Electron's
`nativeTheme.themeSource`, so the existing `prefers-color-scheme` stylesheets
respond with no per-limit theming code. All of it lives in
`~/.adjent/settings.json` and applies live.

**Notifications are native OS toasts, routed by severity.** Windows Action
Center / libnotify — never a custom pop-over limit, so they obey your OS's
do-not-disturb, focus assist, and notification history for free. Severity
routing (from [ALARMS.md](ALARMS.md)): `info` never toasts, it only tints the
tray; `warn` toasts; `critical` toasts persistently. Every toast carries at
most two actions.

### The surfaces, one table

| Surface | Visible | Size | Shows |
| --- | --- | --- | --- |
| Tray icon | always | 16–24 px | one arc, one status colour |
| Toast | on `warn`/`critical` alarms | OS-standard | one alarm, ≤2 actions |
| Pinned widget | opt-in, always-on-top | ~340×96 | verdict · hero · rate · pace bar (+ taskbar button) |
| Panel | on tray click | 380×560 | the full resting surface below |
| Detail views | on click inside panel | in-panel navigation | tiers 3–4 |

## Mockups

All project names and figures below are synthetic.

Layout mockups, not pixel art — spacing and hierarchy are indicative, the
component inventory is normative. The rendered versions live in the design
brief artifact.

### The panel, at rest

```
┌──────────────────────────────────────┐
│  Adjent                       4 live │
├──────────────────────────────────────┤
│  ▲ AHEAD OF PACE                     │
│                                      │
│  72%  +20 %/h          Claude · 5h   │
│                     resets in 2h 30m │
│  100 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄✕┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│      │         ╭╌╌╌╯ 20:24, 1h 06m   │
│      │    ●72%╌╯       early         │
│      │   ╭─╯       ╱╱╱               │
│      │ ╭─╯    ╱╱╱╱╱                  │
│      │╭╯ ╱╱╱╱╱                       │
│      ╰┴─────────┴────────────┴────   │
│      16:30    now 19:00   21:30 ↺    │
│                                      │
│  15.0M tokens · 13.5M cached · 1.0M  │
├──────────────────────────────────────┤
│  ● Claude · 7d · Opus   76% ⚠ next   │
│  ● Claude · 7d · all    23%          │
│  ● Codex  · 7d          17%          │
├──────────────────────────────────────┤
│  ▲ demo-api   opus-5·xhigh ≈12.0%/h │
│  ● adjent      opus-5·high   ≈5.0%/h │
│  ● demo-web   gpt-5.6·med   ≈3.0%/h │
│  · demo-cli  idle 14m           —  │
└──────────────────────────────────────┘
```

Top to bottom is exactly the three-second read: verdict → hero → chart → token
line → other windows → agent rows. Nothing else is present at rest.

### Tray icon states

```
   ◔ green      ◑ amber        ◕ red         ◌ grey
   on pace      ahead of       over /        no session /
                pace           exhausting    all idle
```

The arc's fill is the binding limit's utilization; its colour is the verdict.
Fill says how much, colour says whether that is a problem — 70% six hours into
a weekly limit draws a mostly-full *green* arc.

### Toasts (native, so styling is the OS's; content is ours)

```
 warn ────────────────────────────────┐        critical ─────────────────────────────┐
│ ▲ Adjent — Ahead of pace            │       │ ■ Adjent — Opus weekly at 95%        │
│ Claude 5h at 72% with 2h 30m left.  │       │ Projected to run out 1d 09h before   │
│ At this rate it runs out at 20:24.  │       │ reset. demo-api is 67% of the burn. │
│                                     │       │                                      │
│ [ Open panel ]      [ Snooze 1h ]   │       │ [ Open panel ]  [ Pause demo-api* ] │
└─────────────────────────────────────┘       └──────────────────────────────────────┘
```

Copy follows the alarm grammar: what happened, then what it means, then at most
two actions. `info` alarms never produce a toast. (*Pause-agent is an M4+
action — until then the second button is `Snooze`.)

### Pinned widget (opt-in)

```
┌────────────────────────────────────┐
│ ▲ 72%  +20 %/h        Claude · 5h  │
│ ▂▂▃▃▄▅▆█ ┄┄┄┄┄┄┄┄┄┄┄ ↺ 2h 30m      │
│ ▲ demo-api            ≈12.0 %/h   │
└────────────────────────────────────┘
```

The third row appears only when an agent trips the `agent_burn` rule —
otherwise the widget is two rows. Click anywhere → full panel.

## The one question

Every element on the resting surface must help answer:

> **Should I change what I am doing right now?**

If an element cannot change that answer, it is history. History lives behind a
click. This single rule is what keeps the panel from becoming a dashboard.

## Hard budget at rest

| Surface | Budget |
| --- | --- |
| Tray icon | one arc, one status colour. Nothing else — no text badge. |
| **Primary read** | verdict chip · hero % · rate · reset countdown · the chart — **≤4 numbers** |
| Token line | one line: exact tokens this limit, split by kind |
| Other windows | ≤3, one collapsed line each |
| Agent rows | ≤4, sorted by burn |
| Charts | exactly 1 |

The budget is a component list, not a guideline. If a new feature needs a fifth
number in the primary read, something else has to earn its way off it first.

## The three-second read

The panel is designed to be read in one downward glance, in this order:

1. **Verdict chip** — an icon, a word and a colour: `✓ On pace` / `▲ Ahead of
   pace` / `■ Over`. Colour never carries the meaning alone; the word does.
2. **Hero number** — vendor-reported utilization of the *binding* limit, with
   its rate of change beside it: `72%  +20 %/h`. Exactly one per view, and it
   is always that metric — see [The hero number, exactly](#the-hero-number-exactly).
3. **The pace chart** — see below. If the read stops here, it has still worked.

Only then: the other windows, one line each; then live agents; then alarms.

## The hero number, exactly

Everything above says "the hero number" as if it were obvious which one that is.
It is not, so this section names it and rules out the alternatives.

> **The hero number is $u$ — the vendor-reported utilization percentage of the
> binding limit.** Nothing else.

Two properties make it the right choice, and both are disqualifying for the
alternatives.

**It is measured, not derived.** It is the one figure that survives total failure
of the modelling layer. If the fit never converges, if $\hat{\mathbf{w}}$ is
garbage, if the token parser breaks on a format change — the hero number is still
correct, because it is read from the vendor and passed through untouched. The
number a monitoring tool leads with has to be the one it is most sure of.

**It is a level, not a rate or a total.** A level is the only kind of number that
is interpretable alone. `28 %/h` is unremarkable at 5% used and an emergency at
90%. `15.0M tokens` means nothing without a denominator. A percentage of a
limit carries its own scale.

### Every metric we have, and its job

| Metric | Provenance | Role |
| --- | --- | --- |
| **$u$ of the binding limit** | vendor-reported | **the hero number** |
| $u$ of the other windows | vendor-reported | collapsed to one line each, below the chart |
| $r$ — limit burn rate | measured (from $u$ alone) | printed beside the hero; it is the hero's *modifier*, not a rival |
| Reset countdown | vendor-reported | printed beside the hero |
| Verdict — on / ahead / over | measured (from $u$ vs the pace line) | the chip above the hero |
| Exhausts-at | projected from $r$ | the chart's forward marker, and the alarm text |
| Tokens by kind | exact, from transcripts | the token line |
| $r_a$ — per-agent burn | **derived** | the agent rows |
| Exchange rate, absolute limit size | **derived** | one click in |
| $\varepsilon$ — confidence | derived | a mark next to derived figures only |
| USD | derived | hidden by default on a subscription |
| Turn counts, session counts, tool calls | exact | not shown; they are activity, not consumption |

Note what that table does *not* contain: any derived quantity above the fold as a
headline. Derived numbers earn the agent rows and the detail views, never the
hero slot.

### Why not the plausible alternatives

**Time to exhaustion** is the most *actionable* single number we have, and it was
tempting. It is disqualified because it does not always exist: when burn is at or
near zero it is infinite, and a hero figure that sometimes reads `∞` or blanks
out is not a hero figure. It also inherits every error in $r$. It stays as the
chart's forward marker and the alarm text, where an occasional "not projected to
exhaust" reads naturally.

**Burn rate** is a rate without a level — see above.

**Absolute tokens** have no denominator, and the raw total is dominated by cache
reads, which are the cheapest thing in the mix. It is a receipt, not a verdict.

**Pace delta** ($u$ minus where the pace line sits) is a genuinely good number,
but you need $u$ to interpret it, so it would cost two numbers to say what one
says. It is encoded in the chart as the gap to the diagonal, and in the verdict
chip as a word.

**USD** prices a quantity a subscriber does not hold.

### Choosing the binding limit

The hero shows one limit out of several, so which one is binding has to be
decided every poll. For each limit $i$, with burn rate $r_i$:

$$T_i = \frac{100 - u_i}{r_i} \quad \text{(time to exhaustion; } \infty \text{ if } r_i \le 0)
\qquad R_i = \text{time until } i \text{ resets}$$

A limit can only stop you if it runs out before it resets — that is, if
$T_i < R_i$. So:

1. **If the vendor names it, use that.** Claude's `limits[]` carries `is_active`
   on the limit currently binding. Vendor-reported beats anything we compute.
2. Otherwise, among windows with $T_i < R_i$, take the one with the **smallest
   $T_i$** — the one that stops you soonest.
3. If no limit is projected to run out, nothing is binding. Fall back to the
   **highest $u_i$**, which is the conventional "how am I doing" answer and
   cannot mislead when nothing is at risk.

This is why the fullest limit is not automatically the hero. A weekly limit at
76% with six days left has a large $R$ and loses to a 5-hour limit at 60% with
forty minutes left.

### The hero must hold still

A hero number that flips between windows on alternate polls is worse than a
wrong one — it reads as instability in the tool rather than in your usage. So the
selection is hysteretic: a challenger limit must win the test above for **three
consecutive polls** before it takes the slot, and the outgoing limit stays
visible in the collapsed list. Window rollovers are exempt: when a limit resets,
its claim genuinely vanishes and the switch is immediate.

## The one chart: burn against the pace line

A single series — utilization against elapsed time in the current limit — with
the linear pace line drawn behind it and the burn projected forward.

```
100% ┤─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ✕ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
     │                  ╭╌╌╌╯ 20:24 · 1h 06m early
     │           ● 72% ─╯
     │       ╭───╯                    ╌╌╌╌ projection
     │   ╭───╯              ╱╱╱╱╱╱    ──── measured
     │ ╭─╯          ╱╱╱╱╱╱╱╱          ╱╱╱╱ on-pace line
     │╭╯   ╱╱╱╱╱╱╱╱╱
     ╰┴──────────────────────────────────────────────┴
      16:30              now 19:00              21:30 reset
```

Everything about the design follows from one property: **the gap between the
curve and the diagonal is the insight, and it is visible without reading a
number.** Above the line, you are burning too fast. That is the whole product in
one glance, and it is the thing percentage-only tools cannot show.

The dotted projection extends the current rate to 100%. If it crosses before the
right edge, you run out before the limit resets — and the crossing is marked
where it lands. A reader who never looks at a single digit still gets the answer.

### Chart spec

* **Form** — area + line, one series. No legend (the title names it); the
  reference line is directly labeled.
* **Marks** — 2px line; area fill at low alpha of the same status hue; the
  current point gets an ≥8px marker with a 2px surface ring and a direct label.
  Nothing else is labeled — never a number on every point.
* **Reference line** — the on-pace diagonal in recessive ink, hatched or dashed,
  labeled once at its right end.
* **Projection** — dotted continuation in the same status hue at reduced alpha,
  visually distinct from measured data. It is a forecast and must never be
  mistaken for a reading.
* **Colour** — the status palette (`good #0ca30c` / `warning #fab219` /
  `critical #d03b3b`), fixed, never themed, never reused for anything else.
  Validated for CVD separation; `warning` sits below 3:1 on a light surface by
  design, which is why the verdict word and direct labels carry the meaning and
  the hero figure stays in text ink, never in a status colour.
* **Chrome** — no gridlines, no y-axis ticks. A faint baseline, the limit start
  at the left edge and the reset time at the right. That is all the frame a
  five-hour limit needs.
* **Interaction** — crosshair and tooltip on hover, giving the timestamp,
  utilization, and the tokens consumed in that bucket.
* **Dark mode** — selected, not flipped. Status steps are mode-invariant and
  clear 3:1 on the dark surface; the area alpha and the recessive ink are
  re-picked for it.

## The numbers, and which unit each one wears

Three quantities with three different provenances. Keeping them visually distinct
is not pedantry — conflating measured with derived is how a monitoring tool
loses trust permanently.

| Quantity | Provenance | Where it appears |
| --- | --- | --- |
| **Utilization %** and its rate | polled, measured | hero figure, chart, every alarm |
| **Tokens** | exact, from transcripts | the token line; full per-model breakdown on click |
| **Exchange rate, absolute limit, per-agent %/h** | derived from the fit | shown with `≈`, plus a confidence dot |
| **USD** | derived | **hidden by default** on subscription auth; primary on API-key auth |

At rest, only the first two lines are on screen. The exchange rate is one click
away, because it explains the model rather than changing what you do next:

```
72%   +20 %/h   resets 2h 30m              ← measured
15.0M tokens · 13.5M cached · 1.0M out     ← exact

  ── click the limit ──
≈ 1% ≈ 62k Opus output, or 3.1M cache reads   ← derived, per kind
```

The exchange rate is quoted **per kind, never blended**. A single "tokens per
point" figure hides a ~50× spread between cache reads and output tokens, so it
reads as precision while being close to meaningless.

## Per-agent rows

Four rows maximum at rest, sorted by current burn, not alphabetically — the
noisy one is always at the top where it will be seen.

Each row: a status dot, the project name, the model and effort, and the number
that matters — **the agent's share of the limit per hour**, in the same unit as
the hero figure.

```
▲  demo-api      opus-5 · xhigh    ≈12.0 %/h
✓  adjent         opus-5 · high      ≈5.0 %/h
✓  demo-web      gpt-5.6-sol · med  ≈3.0 %/h
·  demo-cli     idle 14m                 —
```

`≈12.0 %/h` is only expressible because of the learned exchange rate, and it is
the line that makes the tool worth opening. "This agent wrote 900k tokens" is a
fact; "this agent is eating 16% of your five-hour limit every hour" is a
decision.

The rows should also roughly **add up to the hero rate** — 12.0 + 4.1 + 3.4 ≈ 24
here — once the hero rate is corrected for tokens aging out of the rolling
limit (early in a limit, as in this example, nothing has aged out yet and the
two match directly). That is not decoration: the vendor-reported side and the
per-agent side are computed by completely different routes, so their agreement is
a free, continuous check — see [the free consistency
check](GLOSSARY.md#the-free-consistency-check). When they drift apart, confidence
drops and the UI says so.

### Agent rows have their own detail

Hovering an agent row shows that agent rather than a generic definition:
directory, branch, session name, backend and entrypoint, when it started, when
it last took a turn, its derived burn, and its token split. The **directory in
full** is the point — sibling worktrees of the same repository share a folder
name, so `adjent` and `adjent-core` are only distinguishable by path.

## Progressive disclosure

| Tier | Surface | Contains |
| --- | --- | --- |
| 1 | Tray icon | verdict, as an arc and a colour |
| 1½ | Pinned widget (opt-in) | verdict · hero · rate · pace bar |
| 2 | Panel, at rest | verdict · hero · chart · other windows · agent rows |
| 3 | Click a limit | that limit's history, token breakdown by model and kind |
| 4 | Click an agent | its session timeline, subagent tree, per-turn tokens |
| 4½ | Notifications | the durable alarm log, grouped by day — toasts vanish, this does not |
| 5 | Settings | interface size, tray glyph, widget/taskbar, poll cadence, pause alarms; alarm rules and sinks in `~/.adjent/alarms.yaml` |

Nothing from tier 3 or below is ever promoted to the resting surface "because it
is interesting". Interesting is not the bar; *actionable right now* is.

## Hover explanations

Clarity is the design goal, so nothing on the panel should require guessing
what it means. Every metric carries a hover explanation: what it is, what it
means for a decision, and — explicitly — whether it is **measured**, **exact**,
or **derived**.

* The copy lives in **one place**, `packages/core/src/explain.ts`, condensed
  from this doc set. The panel, the widget and `adjent explain <term>` all read
  the same table, so a wrong explanation is fixed once.
* Explainable elements carry a dotted underline on hover, so the help is
  discoverable rather than hidden.
* Tooltips appear after a short delay, are keyed to the *current* context —
  a stale Codex reading explains staleness, a scoped limit explains scoping —
  and clamp to the panel edge so nothing is cut off.
* The provenance tag is part of the tooltip, not decoration: it is how a reader
  learns that `≈12.0 %/h` is a model output and `72%` is not.
* The widget uses native titles instead of the tooltip layer: the strip is too
  small to overlay without covering what it explains.

## Notifications view

Native toasts are transient by design — they respect do-not-disturb and get out
of the way. That makes them a poor record, so every alarm is also appended to
`~/.adjent/alarms.jsonl` and rendered in a notifications view behind the bell in
the panel header.

* Newest first, grouped by day (*Today* / *Yesterday* / date), each row carrying
  a severity stripe, the alarm's title and body verbatim, and the time it fired.
* An unread dot sits on the bell when the newest alarm postdates the last time
  the view was opened.
* It survives restarts and outlives the toast, which is the whole point: the
  reason a limit was hit at 02:00 should still be readable at 09:00.
* **Clear** empties the log — an explicit user action, never automatic.
* **Hovering a row reveals the full state at fire time**: the limit and how
  full it was then, burn rate against the pace line, runway left, projected
  exhaustion — and the agents that were running, each with its **full project
  directory**, branch, model, effort and derived share. A notification read the
  next morning should answer "what was I doing?" without the reader
  reconstructing it.

## Copy rules

* Name things the way a person would: "resets in 2h 30m", not `resets_at`.
* Rates always carry their unit and period: `+20 %/h`, never a bare `6.2`.
* Derived values always carry `≈`. Measured values never do.
* An alarm says what happened and what it means, in that order: *"Ahead of pace —
  72% used with 2h 30m left. At this rate the limit runs out at 20:24."*
* Never an apology, never a raw field name, never an emoji as a section marker.
