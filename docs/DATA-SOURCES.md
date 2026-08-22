# Data Sources

Format investigation notes. Vendor formats are undocumented and unstable.
All account examples below are synthetic replacements of private observations.

## Claude Code — `~/.claude/`

### Live sessions — `sessions/<pid>.json`
```json
{"pid":12345,"sessionId":"demo-session","cwd":"/work/demo",
 "startedAt":1700000000000,"version":"2.1.0","entrypoint":"cli",
 "kind":"interactive","name":"demo-session","nameSource":"derived"}
```
This is the **agent inventory**. One file per running process.
Liveness = the pid is alive *and* `procStart` matches (guards against pid reuse).
`entrypoint` distinguishes CLI / VS Code / SDK. `name` gives a human label for free.

### Transcripts — `projects/<path-slug>/<sessionId>.jsonl`
One JSON object per line. Assistant lines carry everything we need:

| Field | Use |
| --- | --- |
| `message.model` | e.g. `claude-opus-5` — the **model in use**, per turn |
| `message.usage.input_tokens` | billed input |
| `message.usage.cache_creation_input_tokens` | cache writes (priced above input) |
| `message.usage.cache_read_input_tokens` | cache reads (priced far below input) |
| `message.usage.output_tokens` | billed output (incl. `output_tokens_details.thinking_tokens`) |
| `message.usage.service_tier`, `speed` | tier context |
| `effort` | reasoning effort for the turn |
| `cwd`, `gitBranch` | **project attribution** |
| `timestamp`, `requestId`, `uuid` | ordering + dedup key |
| `isSidechain` | true for subagent turns |

Subagent and workflow transcripts live under
`projects/<slug>/<sessionId>/subagents/workflows/wf_*/agent-*.jsonl` —
this gives per-subagent attribution, which is what makes the *per-agent burn*
alarm meaningful.

### History rollup — `stats-cache.json`
`dailyActivity[] = {date, messageCount, sessionCount, toolCallCount}`.
Cheap backfill for the history chart on first run. Not token-accurate.

### Token counts are exact, not sampled
Every assistant turn carries a complete `usage` block, and `requestId` makes
dedup trivial. An invented seven-day total illustrates the counting process:

```
turns                                  1,200
input_tokens                           48,000
cache_creation_input_tokens       2,400,000
cache_read_input_tokens          12,000,000
output_tokens                      360,000
```

These are the same numbers the billing system uses. There is no estimation
anywhere in the token pipeline.

Cost is *not* stored in transcripts, but Claude Code computes it and will hand it
over in headless mode — `claude -p --output-format json` returns `total_cost_usd`
plus a `modelUsage` map with per-model `costUSD`, `contextWindow` and
`maxOutputTokens`. That confirms a price-table normalization is exactly what the
vendor does, so Adjent can compute the same figure from the transcript alone,
offline, for every historical turn.

### Quota — not on disk, but **pollable**
Nothing in `~/.claude` records rate-limit state. However, `~/.claude/.credentials.json`
holds an OAuth token, and the CLI binary references `GET /api/oauth/usage` on
`api.anthropic.com`. Synthetic example of the observed response shape:

```json
{"five_hour": {"utilization": 35, "resets_at": "2024-01-15T15:00:00Z"},
 "seven_day": {"utilization": 20, "resets_at": "2024-01-20T10:00:00Z"},
 "limits": [
   {"kind":"session", "group":"session", "percent":35, "severity":"normal",
    "resets_at":"2024-01-15T15:00:00Z"},
   {"kind":"weekly_all", "group":"weekly", "percent":20, "severity":"normal",
    "resets_at":"2024-01-20T10:00:00Z"},
   {"kind":"weekly_scoped", "group":"weekly", "percent":75, "severity":"warning",
    "scope":{"model":{"display_name":"Model X"}}, "is_active":true}],
 "extra_usage": {"is_enabled": false},
 "spend": {"used": {"amount_minor": 100, "currency": "USD"}}}
```

This is **reported quota, structurally equivalent to Codex's** — and richer:
`limits[]` carries per-model scoped windows with a server-assigned `severity` and
an `is_active` flag marking which limit is currently binding.

`.credentials.json` also carries `subscriptionType` (synthetic example: `demo-plan`) and
`rateLimitTier` (e.g. `demo-tier`) — plan identification for free.

**What polling costs.** This is a metadata endpoint, not a model call — the same
call Claude Code's own `/usage` view makes. No inference happens, so:

| Cost dimension | Reality |
| --- | --- |
| Quota / tokens | **none** — nothing appears in usage |
| Money | none — subscription auth, no metered billing on this path |
| Rate-limit risk | the real cost: a private endpoint with unknown 429 thresholds — hence the cap below |
| Latency | one round-trip, ~100–300 ms; irrelevant at our cadence |
| Freshness | server-side truth at poll time; the poll cadence is the staleness bound |

Contrast with what Adjent deliberately does **not** use: querying usage through a
headless `claude -p` call returns similar data but runs a real model turn to get
it. A synthetic probe costing 0.01 units, repeated 60 times, would consume
0.60 units just to observe usage. Poll the
endpoint, never the CLI.

**Rules for using this endpoint** (see [ARCHITECTURE.md](ARCHITECTURE.md#claude--reported)):
read the token, never write it; never run the refresh flow; treat `401` as
"back off and wait for Claude Code to refresh"; poll at most once a minute, and
only while a session is live or the panel is open.

**Caveat:** this is a private endpoint, not public API surface. It is not
documented and carries no compatibility promise. Adjent must treat a shape change
or a 4xx as a normal, expected condition — see "Drift policy" below.

## Codex — `~/.codex/`

### Quota — **AUTHORITATIVE, ON DISK**
Session rollouts embed the server's own rate-limit payload:
```json
{"rate_limits":{
  "limit_id":"codex",
  "primary":{"used_percent":25,"window_minutes":10080,"resets_at":1700345600},
  "secondary":null,
  "credits":{"has_credits":false,"unlimited":false,"balance":"10"},
  "plan_type":"demo-plan","rate_limit_reached_type":null}}
```
`window_minutes` 10080 = the weekly window; a 5-hour window appears as 300.
`used_percent` + `resets_at` is exactly the input the alarm engine needs — no
estimation, no calibration. Take the **most recent** such record across all
rollouts as current truth.

**What reading it costs: zero everything.** There is no query — Codex's client
receives this payload on every API response it makes and writes it to disk as a
side effect. Adjent does a local file read: no network, no auth exposure, no
rate-limit risk.

The trade is **freshness**: the record is only as recent as Codex's last API
activity. While a Codex agent is running that is seconds old; when Codex is idle
it is frozen at the last turn. Acceptable, because utilization only *rises* when
Codex is active — an idle backend's stale reading is still correct, except for
aging-out on the rolling window. The panel therefore shows the record's
timestamp ("as of 14:32") when it is stale rather than pretending it is live.

**The two mechanisms compared** — both land in the same `quota()` provider call;
only the freshness timestamp and provenance tag differ:

| | Claude | Codex |
| --- | --- | --- |
| Mechanism | poll a private HTTPS endpoint | read vendor payload from local disk |
| Quota cost | zero | zero |
| Network | ≤ 1 request/min | none |
| Fresh when idle | yes | no — frozen at last activity |
| Failure mode | 401/429/shape change → serve last snapshot marked stale | format drift → same degradation path |

### Sessions — `sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`
Append-only. Tail by byte offset. Carries turn events, token usage and the
`rate_limits` payload above.

### Thread index — `session_index.jsonl`
`{id, thread_name, updated_at}` — human-readable names for the UI, cheaply.

### State DBs (SQLite, read-only, WAL)
| File | Tables of interest |
| --- | --- |
| `state_5.sqlite` | `threads`, `projects`, `project_roots`, `thread_spawn_edges` (parent→child agent tree), `thread_sections` |
| `thread_history_1.sqlite` | `thread_turns`, `thread_items` |
| `logs_2.sqlite` | `logs` |

Open with `mode=ro` + `immutable=0` so WAL readers don't disturb the writer.

### Model catalog — `models_cache.json`
`{slug, display_name, description, default_reasoning_level, supported_reasoning_levels[]}`
— use for pretty model names and effort labels instead of hardcoding.

### Other
`config.toml` (active model/profile), `version.json` (client version),
`auth.json` (**never read; presence only** — it holds credentials).

## Drift policy

Both layouts are internal implementation details of vendor tools and will change.

1. Every provider ships **fixture files** (redacted real lines) and parser tests.
2. Parsers are **additive-tolerant**: unknown fields ignored, missing optional
   fields yield `null`, never a throw.
3. Each provider declares a `supportedVersions` range; outside it Adjent shows a
   "format may have changed" badge and keeps serving whatever still parses.
4. A parse failure degrades one provider, never the app.
