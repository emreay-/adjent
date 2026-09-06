# Data Sources

These notes preserve the format investigation and the reasoning behind the
reader design. The formats are **undocumented and unstable** — see "Drift policy"
at the bottom. Field shapes are observations, not a vendor compatibility promise.
All example identifiers, paths, timestamps, plan labels and account figures are
synthetic; the examples are not recorded responses or evidence of measured performance.

## Claude Code — `~/.claude/`

### Live sessions — `sessions/<pid>.json`
```json
{"pid":12345,"sessionId":"demo-session","cwd":"/work/demo",
 "startedAt":1700000000000,"version":"2.1.0","entrypoint":"cli",
 "kind":"interactive","name":"demo-session","nameSource":"derived"}
```
This is the **agent inventory**. One file per running process.
The intended robust liveness check is PID existence *and* matching process start
time, which guards against PID reuse. The current provider checks PID existence
and recent transcript activity; start-time matching is not yet implemented.
`entrypoint` distinguishes CLI / VS Code / SDK. `name` gives a human label for free.

### Transcripts — `projects/<path-slug>/<sessionId>.jsonl`
One JSON object per line. Assistant lines carry everything we need:

| Field | Use |
| --- | --- |
| `message.model` | e.g. `model-x` — the **model in use**, per turn |
| `message.usage.input_tokens` | billed input |
| `message.usage.cache_creation_input_tokens` | cache writes (priced above input) |
| `message.usage.cache_read_input_tokens` | cache reads (priced far below input) |
| `message.usage.output_tokens` | billed output (incl. `output_tokens_details.thinking_tokens`) |
| `message.usage.service_tier`, `speed` | potential tier context; not retained by the current parser |
| `effort` | reasoning effort for the turn |
| `cwd`, `gitBranch` | **project attribution** |
| `timestamp`, `requestId`, `uuid` | ordering + dedup key |
| `isSidechain` | true for subagent turns |

Subagent and workflow transcripts live under
`projects/<slug>/<sessionId>/subagents/workflows/wf_*/agent-*.jsonl` —
this gives per-subagent attribution, which helps detect a repeating worker.
Tokens roll up to the parent session exactly once; relative subagent identifiers
are detection labels, not additional top-level agent rows.

### History rollup — `stats-cache.json`
`dailyActivity[] = {date, messageCount, sessionCount, toolCallCount}`.
A possible cheap activity backfill for first run, but not token-accurate and not
an account utilization history. This was investigated; the current chart uses
Adjent's own recorded quota samples rather than this vendor cache.

### Token counts are exact, not sampled
Usage-bearing assistant records supply counters, and `requestId` provides a
deduplication key. To illustrate the difference between counting and estimating,
consider this invented seven-day total from a synthetic transcript set:

```
turns                                  1,200
input_tokens                           48,000
cache_creation_input_tokens       2,400,000
cache_read_input_tokens          12,000,000
output_tokens                      360,000
```

Adding these available counters is exact arithmetic, not sampling or a fit.
That does not prove complete account coverage: missing files, delayed catch-up,
unsupported records or another device can leave local totals incomplete.
Thinking counts are treated as a subset where the vendor includes them in output;
adding thinking to output again would double-count those tokens.

Cost is *not* the same thing as the token counters. The format investigation also
identified Claude Code's headless JSON cost output: `claude -p --output-format json`
can expose `total_cost_usd`
plus a `modelUsage` map with per-model `costUSD`, `contextWindow` and
`maxOutputTokens`. This motivates offline price-table normalization: token
kinds and models can be assigned weights without issuing a model call. It is not
a guarantee that a locally computed price equals subscription quota, and Adjent
does not implement currency billing or run this command to poll quota.

### Quota — not on disk, but **pollable**
The current adapter obtains quota from the endpoint rather than a local quota
record. `~/.claude/.credentials.json`
holds an OAuth token, and the CLI binary references `GET /api/oauth/usage` on
`api.anthropic.com`. A synthetic example of the observed response shape:

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
an `is_active` flag marking which limit is currently binding for that vendor. The parser prefers usable
`limits[]` entries and falls back to named `five_hour`/`seven_day` fields.
`extra_usage` and `spend` are documented for possible future use, not consumed
as a currency-billing feature.

`.credentials.json` also carries `subscriptionType` (synthetic example: `demo-plan`) and
`rateLimitTier` (synthetic example: `demo-tier`) — plan identification for free.

**What polling costs.** This is a metadata endpoint, not a model call — the same
kind of information a usage view needs. Adjent sends no inference prompt.
The distinction matters even though a private endpoint provides no contractual
guarantee about future availability, billing or rate limits:

| Cost dimension | Reality |
| --- | --- |
| Quota / tokens | No inference requested; do not assume a vendor guarantee about private-endpoint accounting |
| Money | Uses existing subscription authentication; this is not a metered model request |
| Rate-limit risk | the real cost: a private endpoint with unknown 429 thresholds — hence the cap below |
| Latency | Network-dependent; a five-second deadline bounds the complete request |
| Freshness | Server observation on a successful poll; failures preserve the old timestamp |

Contrast with what Adjent deliberately does **not** use: querying usage through a
headless `claude -p` call returns similar data but runs a real model turn to get
it. For a synthetic cost example, a probe costing 0.01 units repeated 60 times
would consume 0.60 units just to observe usage. A monitor should not create that
workload. Adjent polls the metadata endpoint, never the model CLI.

**Rules for using this endpoint** (see [ARCHITECTURE.md](ARCHITECTURE.md#claude--reported)):
read the token, never write it; never run the refresh flow; treat `401` as
"back off and wait for Claude Code to refresh". Polls are at least a minute apart;
`401` and `429` trigger five minutes of backoff. The original design aimed to
poll only with live sessions or an open panel; current collection also polls
while idle. Redirects are rejected and the deadline includes reading the body.
No credential is written, rotated or refreshed by Adjent.

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
rollouts as the newest available observation, with its original timestamp.

**What reading it costs: local I/O, no network request.** There is no query — Codex's client
receives this payload on every API response it makes and writes it to disk as a
side effect. Adjent does a local file read: no network, no auth exposure, no
rate-limit risk.

The trade is **freshness**: the record is only as recent as Codex's last API
activity. While a Codex agent is running that is seconds old; when Codex is idle
it is frozen at the last turn. Local inactivity does not prove the account is
unchanged: another device may spend quota, and old usage can age out of a rolling
window. A stale reading remains useful context, but is not current account truth. The panel therefore shows the record's
timestamp ("as of 14:32") when it is stale rather than pretending it is live.

**The two mechanisms compared** — both land in the same `quota()` provider call;
the collection mechanism and freshness differ; both quota values are reported:

| | Claude | Codex |
| --- | --- | --- |
| Mechanism | poll a private HTTPS endpoint | read vendor payload from local disk |
| Inference requested by Adjent | none | none |
| Network | ≤ 1 request/min | none |
| Fresh when idle | after a successful poll | no — frozen at last local activity |
| Failure mode | 401/429/shape change → serve last snapshot marked stale | format drift → same degradation path |

### Sessions — `sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`
Append-only. Tail by byte offset. Carries turn events, token usage and the
`rate_limits` payload above.

**The model may not be on the usage lines.** Token counts arrive on `event_msg` /
`response_item` lines, which may name no model; the model and reasoning effort live
on `turn_context.payload.{model,effort}`, written once per turn context near
the top of the rollout, with copies under `world_state.payload.state.model` and
`session_meta.payload.base_instructions.provenance.model`. A reader that parses
only usage lines therefore has tokens with no model to attribute them to.

This also means identity cannot be recovered by tailing: after a restart the
byte offset may already be past every `turn_context`. Until another turn
names the model, an incremental tail cannot recover that earlier context. The file has to be re-read from both ends — head for the
opening context, tail for the newest — which is what `headChunk`/`tailChunk`
in `collect/tail.ts` exist for. Claude is easier: `message.model` is on every
assistant line, so its tail always answers.

### Thread index — `session_index.jsonl`
`{id, thread_name, updated_at}` — human-readable names for the UI, cheaply.

### State DBs (SQLite, read-only, WAL)
| File | Tables of interest |
| --- | --- |
| `state_5.sqlite` | `threads`, `projects`, `project_roots`, `thread_spawn_edges` (parent→child agent tree), `thread_sections` |
| `thread_history_1.sqlite` | `thread_turns`, `thread_items` |
| `logs_2.sqlite` | `logs` |

These databases were investigated as potential sources; the current adapter
does not open them. The earlier design proposed `mode=ro` + `immutable=0` for
live WAL data. Any future implementation must separately prove that opening
and reading it cannot write vendor files or disrupt the writer; flags alone
are not that validation. Preserve the JSONL fallback if database access fails.

### Model catalog — `models_cache.json`
`{slug, display_name, description, default_reasoning_level, supported_reasoning_levels[]}`
— a possible source for pretty names and effort labels instead of hardcoding.
The current adapter does not read this catalog.

### Other
`config.toml` (active model/profile), `version.json` (client version),
`auth.json` (**never read by Adjent** — it holds credentials).
The current provider reads `version.json`; the other metadata sources above
are documented for understanding the vendor layout, not as a claim they all ship.

## Drift policy

Both layouts are internal implementation details of vendor tools and will change.

1. Every provider has parser tests that generate **synthetic fixtures**. Preserve
   vendor shapes, invent values; never commit real lines or truncated identifiers.
2. Parsers are **additive-tolerant**: unknown fields ignored, missing optional
   fields yield `null`, never a throw.
3. Each provider declares a descriptive `supportedVersions` range. An out-of-range
   "format may have changed" badge remains a design goal; the range is not yet an
   enforced runtime compatibility check. Keep serving whatever still parses.
4. A parse failure degrades one provider, never the app.

## Collection limits and drift

- Reads use 64 KiB chunks and return roughly 1 MiB of complete records per file
  per collection. Large histories catch up over multiple ticks.
- A record may span chunks. Partial final records wait for a newline, including
  across restarts. Files that shrink restart from zero.
- Records larger than 16 MiB are skipped with provider health marked degraded
  on subsequent detection. Later records remain readable; totals may be incomplete.
- Parser tests use generated synthetic fixtures. Unknown fields are ignored;
  malformed records and missing optional fields do not crash the app.
- `supportedVersions` is a descriptive parser range, not a tested compatibility
  matrix or an enforced runtime version check.
- Report drift using a minimal synthetic reproducer. Never attach credentials,
  complete transcripts, or unredacted snapshots to an issue.
