# Roadmap, expansion and risks

## Public WIP preparation — current priority

The source can be useful before all expansion work is complete. Before changing
visibility, finish the history and remote-log review in [PUBLICATION.md](PUBLICATION.md),
verify the synthetic demos and working-file hygiene, and configure private
security reporting. Preserve the detailed design explanations below while keeping
implementation status explicit.

The first tester milestone is fresh Windows/Linux validation: tray, notifications,
scaling, keyboard use, shutdown/restart, and startup/idle behavior with large
synthetic histories. A built installer is not proof of every OS integration.

## Agent and orchestrator direction

Adjent is for both humans and agents. The tray gives people situational
awareness and a place to inspect decisions; the headless interfaces provide
observations and advisory signals for orchestrating AI work. Increasingly
autonomous callers are a central future audience. Human supervision is an
option a workflow can retain, not a requirement for every decision.

**Available now:** normalized snapshots, a JSONL event stream, budget checks,
rule replay and the cooperative hold/open gate. These already support
orchestration without the desktop. See [API.md](API.md) for the implemented
contract and its limitations.

**Next priorities:** validate complete headless workflows with synthetic
scenarios covering stale or missing quota, provider failure, uncertain burn
estimates, holds and explicit release. Expand worked integration examples so
callers can see the evidence and reason for each decision. Improve estimation
validation alongside these workflows: an automated caller needs trustworthy
units and uncertainty just as much as a person does.

**Future direction:** agent-native access through MCP, richer advisory
capacity signals and coordination across providers and machines. Callers can
use these to decide when to schedule work, change model or effort, or involve a
person. These are design directions, not shipped capabilities or delivery
commitments. Scheduling and enforcement remain in the caller; Adjent supplies
the shared evidence and advisory contracts.

## Milestones

Sequenced so that the riskiest unknowns die first and every milestone is usable
on its own. Time estimates below record the original sequencing, not current
delivery commitments.

### M0 — Spikes (~1 day)
* ~~Confirm Claude Code and Codex on-disk formats~~ **done** — see
  [DATA-SOURCES.md](DATA-SOURCES.md).
* ~~Can Claude quota be polled headlessly?~~ **Yes, closed positively.**
  `GET /api/oauth/usage` with the OAuth token from `~/.claude/.credentials.json`
  returns `five_hour` / `seven_day` utilization, `resets_at`, and a `limits[]`
  array with per-model scoped windows and severities. Both backends are
  `reported`; estimating the account's hero percentage is unnecessary. The
  learned exchange-rate model remains essential for per-agent attribution.
* Exit criteria: a throwaway script prints live agents + token totals for both
  backends. **Met.**

### M1 — Headless core + CLI (~1 week) — **done**
`packages/core` with both providers, the normalized model, the collection loop,
and `adjent status` printing a table; `adjent watch` streaming events.

Exit criteria: the CLI shows correct agents, models, projects and token totals,
and correct **reported** quota for both backends. No UI at all. This milestone proves the
shared core and the machine-facing product; the tray adds the human-facing
experience. **Met**, and gone past: the
CLI also has `--json` on every command, meaningful exit codes, `adjent check`
and a JSONL event stream (see [API.md](API.md)).

### M2 — Tray + panel + threshold alarms (~1 week) — **done**
Electron shell, tray badge, popover panel, native notifications, `threshold`
rules. Packaged installers from CI, unsigned — see [PACKAGING.md](PACKAGING.md).

Exit criteria: installs on a clean Windows and a clean Ubuntu box and notifies at
80% in a synthetic test scenario. **Implementation is present**; tag builds
produce draft artifacts. Fresh-install and notification validation remain gates
for each release candidate, rather than a claim established by unit tests.

### M3 — Pace, per-agent burn, cost attribution (~1 week) — **mostly done**
Pace and per-agent rules, token consumption priced through a learned exchange
rate, passive derivation of allowance size, hot-reloading configuration, history
rollups and sparklines. The price table is a prior, not an assumed mapping from
subscription quota to a currency bill.

Exit criteria: a front-loaded limit fires `pace` before it fires `threshold`; a
looping subagent gets flagged by name. **The first is met**; `pace` and
`agent_burn` both ship, with a hot-reloading config file, a replay engine and
`adjent rules validate|test`. **The second now has an implementation**: `anomaly`
detects repeated turn metadata, including at subagent level, and the synthetic
demo exercises it. This is evidence of a possible loop, not semantic proof.
Utilization history/charts ship; broader per-project analytics and dedicated
sparklines remain expansion work.

### M4 — Polish
Settings UI, appearance controls and the pinned widget are present. Broader
per-project rollups, autostart integration, `electron-updater` and signing remain
work to evaluate. Prioritize first-run clarity, large-history performance, runtime
updates and packaged-app validation before expanding distribution.

### Estimation validation

Complete the vendor-scoped gross-consumption consistency check described in
[GLOSSARY.md](GLOSSARY.md#the-free-consistency-check). The current displayed
residual is a net-rate heuristic; mixed-vendor percentages and aging-out require
matching units and intervals. Preserve attribution tests because a total alone
cannot detect tokens assigned to the wrong parent.

## Expansion

### More backends
Each centers on a `ProviderAdapter` plus synthetic fixtures, backend registration
and labels; complexity depends on the vendor format:
Gemini CLI, Cursor, Aider, GitHub Copilot CLI, Ollama and other local runtimes
(no quota, but agent/model visibility and burn still apply).

### Cost, not just quota
For API-key users, the same cost-unit pipeline maps directly to currency. Budget
alarms ("$40 this week") are then a further rule type over the existing signal.
(The fourth is `anomaly`; budget comes after per-project analytics.)

### Multi-machine / team
The daemon already owns a normalized state snapshot. Expose it over local
HTTP/JSON first (a proposed additional surface; the panel currently uses IPC), then let instances push
to an optional relay so several machines render in one dashboard. Because the
core emits normalized events, this is a new **sink**, not new plumbing.

### Outbound integrations (all sinks)
`webhook` · Slack · ntfy / Pushover · MQTT and Home Assistant · a Prometheus
`/metrics` endpoint for Grafana · OpenTelemetry.

### Inbound: an MCP server
A future MCP server could expose `get_quota`, `get_agents`, `get_pace`. Then agents
themselves can ask how much quota is left and self-throttle: drop effort, switch
model, or defer a big fan-out. This would give agents a native tool interface
to the orchestration signals already available through the CLI, while leaving
enforcement to the caller. No MCP server ships today.

### Advice, and an advisory gate
Once the state is trustworthy, the natural next step is advice:
For a synthetic illustration: *"Claude is at 85% with 2h to reset, Codex is at
15% — consider running this one on Codex."* The workload's requirements still
determine whether switching is appropriate.

Beyond advice, the implemented mechanism is an **advisory gate**: Adjent publishes a
hold/open signal, and a wrapper script or orchestrator the user controls decides
whether to honour it before launching more work. Cooperative by construction —
the decision and the enforcement stay in the user's code. `adjent gate` and
`adjent check` expose the signal; rule-driven holds require `actions.enabled`,
which defaults off. See [the contract](API.md#the-gate).

**Adjent does not pause, stop or signal a process, and no planned work changes
that** (see [What Adjent will not do](../README.md#what-adjent-will-not-do)).
An earlier version of this section said "pause new session spawns" and
"auto-downshift effort", which read as Adjent acting on your agents; that is not
the design and the non-goal below has been narrowed to say so precisely.

### Editor surfaces
`adjent statusline` already supports Claude Code's `statusLine` setting. A
VS Code status bar item could reuse the same one-line summary as future work.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Vendor on-disk formats change without notice | High — the whole data layer | Isolated providers, fixture-based parser tests, additive-tolerant parsing, `supportedVersions` range, degrade one provider not the app |
| Claude quota comes from a **private endpoint** | Medium — could 4xx or change shape without notice | Read-only use of the token, never refresh it; treat 401 as back-off-and-wait; defensive parsing with `limits[]` and the named windows as mutual fallbacks; serve the last good snapshot marked stale rather than blanking the panel |
| Adjent touching auth state could break the tools it watches | High — worst possible failure for a passive monitor | Hard rule: never write `.credentials.json`, never run the OAuth refresh flow (it rotates the refresh token). Adjent reads auth, never owns it |
| API-key / Bedrock / Vertex users have no usage endpoint | Low | `quota()` returns `[]`; a currency-spend view is planned, not currently implemented |
| Reading transcripts touches sensitive source and prompts | High — trust and confidentiality | Metadata-only parsing, message bodies never enter application state, no message-content export or telemetry; Claude quota uses an authenticated endpoint, configured sinks receive alarms |
| Notification fatigue | Medium — users mute it and the product dies | Hysteresis, cooldowns, edge-triggered thresholds, severity routing, a global pause switch; evaluate richer quiet-hours support |
| Watching many JSONL files | Low/Medium — CPU on a dev box | Bounded byte-offset reads and request deadlines; debounce/idle backoff remain design options, target < 1% CPU at rest needs measurement |
| Electron bundle size / startup | Low | Accepted trade-off; the UI-agnostic core keeps a Tauri port cheap if it ever stops being acceptable |
| Scope creep into a full analytics product | Medium — never ships | M1 is a CLI. If the CLI is not useful, no amount of UI saves it |

## Non-goals (for now)

Historical analytics dashboards, cost optimisation recommendations, **launching
agents or controlling them directly** — Adjent never starts, stops, pauses or
signals a process, and the advisory gate above is cooperative rather than an
exception to this — cloud accounts, mobile, and anything that writes to a
vendor's state directory. Analytics and additional surfaces are possible later
products; direct process control and vendor writes remain outside Adjent's
boundaries, not deferred capabilities.
