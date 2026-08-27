# Roadmap, expansion and risks

## Milestones

Sequenced so that the riskiest unknowns die first and every milestone is usable
on its own.

### M0 — Spikes (~1 day)
* ~~Confirm Claude Code and Codex on-disk formats~~ **done** — see
  [DATA-SOURCES.md](DATA-SOURCES.md).
* ~~Can Claude quota be polled headlessly?~~ **Yes, closed positively.**
  `GET /api/oauth/usage` with the OAuth token from `~/.claude/.credentials.json`
  returns `five_hour` / `seven_day` utilization, `resets_at`, and a `limits[]`
  array with per-model scoped windows and severities. Both backends are
  `reported`; the estimation-and-calibration design is dropped entirely.
* Exit criteria: a throwaway script prints live agents + token totals for both
  backends. **Met.**

### M1 — Headless core + CLI (~1 week) — **done**
`packages/core` with both providers, the normalized model, the collection loop,
and `adjent status` printing a table; `adjent watch` streaming events.

Exit criteria: the CLI shows correct agents, models, projects and token totals,
and correct **reported** quota for both backends. No UI at all. This milestone proves the
entire product — a tray is decoration on top of it. **Met**, and gone past: the
CLI also has `--json` on every command, meaningful exit codes, `adjent check`
and a JSONL event stream (see [API.md](API.md)).

### M2 — Tray + panel + threshold alarms (~1 week) — **done**
Electron shell, tray badge, popover panel, native notifications, `threshold`
rules. Packaged installers from CI, unsigned — see [PACKAGING.md](PACKAGING.md).

Exit criteria: installs on a clean Windows and a clean Ubuntu box and notifies at
80%. **Met**; installers are packaged from a tag by `release.yml`.

### M3 — Pace, per-agent burn, cost attribution (~1 week) — **mostly done**
The remaining two rule types, per-turn cost attribution from the price table,
passive derivation of the absolute limit limit, alarm config file with hot
reload, history rollups and sparklines.

Exit criteria: a front-loaded limit fires `pace` before it fires `threshold`; a
looping subagent gets flagged by name. **The first is met**; `pace` and
`agent_burn` both ship, with a hot-reloading config file, a replay engine and
`adjent rules validate|test`. **The second is not**: flagging a looping subagent
needs the `anomaly` rule type, which is not built. History rollups and
sparklines are likewise still outstanding — they are the next milestone's
per-project work in practice.

### M4 — Polish
Per-project rollups, settings UI, autostart, `electron-updater`, code signing.

## Expansion

### More backends
Each is a `ProviderAdapter` plus fixtures — realistically a few hundred lines:
Gemini CLI, Cursor, Aider, GitHub Copilot CLI, Ollama and other local runtimes
(no quota, but agent/model visibility and burn still apply).

### Cost, not just quota
For API-key users, the same cost-unit pipeline maps directly to currency. Budget
alarms ("$40 this week") are then a further rule type over the existing signal.
(The fourth is `anomaly`; budget comes after per-project analytics.)

### Multi-machine / team
The daemon already owns a normalized state snapshot. Expose it over local
HTTP/JSON first (that is also what the panel consumes), then let instances push
to an optional relay so several machines render in one dashboard. Because the
core emits normalized events, this is a new **sink**, not new plumbing.

### Outbound integrations (all sinks)
`webhook` · Slack · ntfy / Pushover · MQTT and Home Assistant · a Prometheus
`/metrics` endpoint for Grafana · OpenTelemetry.

### Inbound: an MCP server
Adjent exposes `get_quota`, `get_agents`, `get_pace` over MCP. Now the agents
themselves can ask how much quota is left and self-throttle: drop effort, switch
model, or defer a big fan-out. This turns a passive notifier into a control
signal, and nothing else in the space does it.

### Advice, and an advisory gate
Once the state is trustworthy, the natural next step is advice:
*"Claude is at 92% with 3h to reset, Codex is at 20% — run this one on Codex"*.

Beyond advice, the planned mechanism is an **advisory gate**: Adjent publishes a
hold/open signal, and a wrapper script or orchestrator the user controls decides
whether to honour it before launching more work. Cooperative by construction —
the decision and the enforcement stay in the user's code.

**Adjent does not pause, stop or signal a process, and no planned work changes
that** (see [What Adjent will not do](../README.md#what-adjent-will-not-do)).
An earlier version of this section said "pause new session spawns" and
"auto-downshift effort", which read as Adjent acting on your agents; that is not
the design and the non-goal below has been narrowed to say so precisely.

### Editor surfaces
`adjent statusline` for Claude Code's `statusLine` setting, and the same one-line
summary in a VS Code status bar item.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Vendor on-disk formats change without notice | High — the whole data layer | Isolated providers, fixture-based parser tests, additive-tolerant parsing, `supportedVersions` range, degrade one provider not the app |
| Claude quota comes from a **private endpoint** | Medium — could 4xx or change shape without notice | Read-only use of the token, never refresh it; treat 401 as back-off-and-wait; defensive parsing with `limits[]` and the named windows as mutual fallbacks; serve the last good snapshot marked stale rather than blanking the panel |
| Adjent touching auth state could break the tools it watches | High — worst possible failure for a passive monitor | Hard rule: never write `.credentials.json`, never run the OAuth refresh flow (it rotates the refresh token). Adjent reads auth, never owns it |
| API-key / Bedrock / Vertex users have no usage endpoint | Low | `quota()` returns `[]`; the panel shows spend, which is the more useful figure under metered billing |
| Reading transcripts touches sensitive source and prompts | High — trust and confidentiality | Metadata-only parsing, message bodies never enter application state, nothing leaves the machine unless a sink is explicitly configured, no telemetry |
| Notification fatigue | Medium — users mute it and the product dies | Hysteresis, cooldowns, edge-triggered thresholds, severity routing, a global quiet-hours switch |
| Watching many JSONL files | Low/Medium — CPU on a dev box | Byte-offset incremental reads, debounce, concurrency cap, idle backoff; target < 1% CPU at rest |
| Electron bundle size / startup | Low | Accepted trade-off; the UI-agnostic core keeps a Tauri port cheap if it ever stops being acceptable |
| Scope creep into a full analytics product | Medium — never ships | M1 is a CLI. If the CLI is not useful, no amount of UI saves it |

## Non-goals (for now)

Historical analytics dashboards, cost optimisation recommendations, **launching
agents or controlling them directly** — Adjent never starts, stops, pauses or
signals a process, and the advisory gate above is cooperative rather than an
exception to this — cloud accounts, mobile, and anything that writes to a
vendor's state directory. Each is a plausible later product; none belongs in the
thing that has to ship first.
