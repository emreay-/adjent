# Architecture

## Decision: the stack

**Electron + TypeScript, pnpm workspaces, React (Vite) for the panel,
zero native modules, electron-builder → NSIS + AppImage/deb via GitHub Actions.**

Why, against the stated constraint ("simple to build, package, deploy"):

| Option | Verdict |
| --- | --- |
| **Electron + TS** | **Chosen.** Tray, native toasts, autostart, single-instance and auto-update are one-liners. `electron-builder` produces Windows and Linux artifacts from one CI matrix. Same language as the parsers. Cost: ~120 MB installer — irrelevant for a dev tool. |
| Tauri v2 (Rust) | ~6 MB bundles, but a Rust toolchain plus divergent `webkit2gtk` deps across distros is the exact friction we were told to avoid. Kept as an escape hatch. |
| Python + PySide/pystray | Fast to prototype, worst cross-platform packaging story (PyInstaller / hand-rolled AppImage). |
| Go + systray + local web UI | Single static binary is attractive, but the UI lands in a browser tab rather than a popover, and it is a second language for the same parsing work. |

**The hedge that makes this reversible:** `packages/core` has *no* Electron and
*no* DOM imports. It is a plain Node library. If bundle size ever matters, the
shell is replaced with Tauri driving `core` as a sidecar process, or `core` is
ported to Rust behind the same interface — without touching providers, rules, or
tests.

### Deliberate constraint: no native modules

No `better-sqlite3`, no `node-notifier`. Native modules are the number one cause
of "easy to build" quietly becoming false (electron-rebuild, prebuild matrices,
glibc variance). Instead:

* **Storage** — an in-memory ring buffer of recent events, backed by plain JSON
  and JSONL files under `~/.adjent/` (see below). Adequate for 5h/7d windows and
  the chart. If real history queries appear later, use `node:sqlite` (built into
  Node 22+ and Electron 32+) — still no native dependency.
* **Reading Codex SQLite** — also `node:sqlite`, opened read-only.
* **Notifications** — Electron's built-in `Notification`.

## Module layout

```
adjent/
  packages/
    core/                 # no UI, no electron — the entire product logic
      providers/
        provider.ts       # the ProviderAdapter interface
        claude/           # + __fixtures__/
        codex/            # + __fixtures__/
      model/              # normalized domain types
      collect/            # byte-offset tailer, pid liveness, fs watcher
      quota/              # poll, windows, cost model
      rules/              # alarm engine (pure)
      sinks/              # notification | webhook | prometheus | mqtt ...
      state.ts            # the single AppState snapshot + event bus
    cli/                  # adjent status | watch | cost | statusline
    desktop/              # electron main (tray, windows, autostart) + renderer
  docs/
```

`cli` and `desktop` are both thin. Everything testable lives in `core`.

## What is persisted, and where

Adjent writes **only** under `~/.adjent/` — never into a vendor directory
(README principle 3). Every file is best-effort: corrupt or missing degrades to
"no history", never to an error, and state writes are atomic (tmp + rename) so a
crash mid-write cannot leave a half-parsed file.

| File | Holds | Retention |
| --- | --- | --- |
| `settings.json` | user preferences (scale, theme, tray, widget, cadence) | forever |
| `alarms.yaml` | user-authored rules — **read-only**, Adjent never writes it | n/a |
| `state.json` | tail byte-offsets per file, the fitted exchange rate, alarm memory (cooldowns, fired levels), burn-rate EWMAs, binding choice, plan tiers | latest snapshot |
| `ledger.jsonl` | recent usage events, so per-agent burn survives a restart | 48 h |
| `history.jsonl` | utilization samples — what the chart's measured curve is drawn from | 14 d |
| `alarms.jsonl` | the notification log behind the notifications view | 90 d / 500 |

Cadence: `state.json` and `ledger.jsonl` are rewritten at most once a minute and
flushed on quit; `history.jsonl` takes a sample only when utilization changes or
every five minutes, which keeps it to a few hundred KB a fortnight.

**Why persist at all.** Without it every launch is a cold start: offsets reset,
so every transcript is re-read; the fit re-bootstraps, so per-agent rates read
*learning* for the first stretch of every session; and alarm cooldowns forget
themselves, so a threshold already crossed fires again. With it, a warm start
resumes from the recorded offsets in under a second.

**What is deliberately not persisted.** Anything derived that is cheap to
recompute — assessments, verdicts, projections — and the `AppState` snapshot
itself. Message content is never stored, in memory or on disk.

## Domain model

```ts
type Backend = {
  id: 'claude' | 'codex'
  displayName: string
  version: string | null
  binPath: string | null
  plan: string | null            // e.g. 'pro'
  health: 'ok' | 'degraded' | 'absent'
}

type Agent = {                   // one running or recent session
  id: string
  backend: BackendId
  label: string                  // Claude `name`, Codex `thread_name`
  projectPath: string | null
  gitBranch: string | null
  model: string | null           // last observed model
  effort: string | null
  entrypoint: string | null      // cli | vscode | sdk
  parentId: string | null        // subagent / spawn edge
  pid: number | null
  state: 'live' | 'idle' | 'ended'
  startedAt: number
  lastActivityAt: number
  totals: TokenTotals
  burn: number                   // units/min over a 10-minute sliding window
}

type UsageEvent = {
  ts: number; backend: BackendId; agentId: string; model: string
  input: number; cacheCreate: number; cacheRead: number
  output: number; thinking: number
  requestId: string              // dedup key — transcripts do get re-read
}

type QuotaWindow = {
  backend: BackendId
  key: string                    // '5h' | '7d' | vendor limit_id
  windowMinutes: number
  usedPercent: number
  resetsAt: number               // epoch seconds
  source: 'reported' | 'estimated'
  confidence: 'high' | 'medium' | 'low'
}
```

`source` and `confidence` are not cosmetic. The UI must render an estimated ring
differently (dashed stroke, `~` prefix) from a reported one.

## Provider interface

Adding a backend (Gemini CLI, Cursor, Aider, Copilot CLI…) means implementing
this and dropping in fixtures. Nothing else in the app changes.

```ts
interface ProviderAdapter {
  readonly id: BackendId
  detect(): Promise<Backend | null>          // binary, version, config dirs
  listAgents(): Promise<Agent[]>             // live + recent
  watch(emit: (e: UsageEvent[]) => void): Unsubscribe
  quota(): Promise<QuotaWindow[]>            // [] if the vendor exposes none
  readonly supportedVersions: string         // semver range
}
```

### Collection loop

* **Watch, don't poll.** `fs.watch` on transcript directories; on change, read
  only from the last known byte offset (offsets persisted per file). Debounce
  250 ms, cap concurrent tails.
* **Poll only the cheap things.** Pid liveness and `sessions/*.json` every 5 s.
* **Dedup on `requestId`.** Transcripts can be rewritten (compaction), so the
  ledger must be idempotent.
* **Never read message bodies.** The line parser extracts the metadata keys and
  discards the remainder before it reaches application state.

## Quota

### Codex — reported
Take the newest `rate_limits` record across rollouts. Map `primary` / `secondary`
onto `QuotaWindow` by `window_minutes` (300 → 5h, 10080 → 7d). `source:
'reported'`, `confidence: 'high'`. Done — no modelling required.

### Claude — reported
The M0 spike closed positively: `GET https://api.anthropic.com/api/oauth/usage`,
authenticated with the OAuth token in `~/.claude/.credentials.json`, returns
`five_hour` / `seven_day` utilization with `resets_at`, plus a `limits[]` array
carrying per-model scoped windows, a server-assigned `severity`, and `is_active`
marking the currently binding limit. `source: 'reported'`, `confidence: 'high'`.

Both backends are therefore reported. **No estimation, no user calibration.**

Because this endpoint is private, four rules are structural, not stylistic:

1. **Read the token, never write it.** Adjent must not run the refresh flow.
   Refreshing rotates the refresh token; if Adjent did that, it could invalidate
   Claude Code's own credentials. Adjent is a reader of auth state, never an
   owner of it.
2. **`401` is a normal state, not an error.** Back off, keep serving the last
   good snapshot marked stale, and wait for Claude Code to refresh the token on
   its next use.
3. **Poll at most once a minute**, and only while a session is live or the panel
   is open. Plus an explicit manual refresh.
4. **A shape change degrades one provider, never the app.** Parse defensively;
   fall back to `limits[]` if the named limit keys move, and vice versa.

Adjent never sends the token anywhere except the endpoint that issued it, and
never logs or displays it.

**API-key, Bedrock and Vertex users have no such endpoint.** For them
`quota()` returns `[]` and the panel shows spend instead of percentage — which is
the more useful number for metered billing anyway.

### The exchange rate — tokens per percentage point

Percentage is the currency you actually spend from; tokens are the receipt.
Neither is useful alone, and the missing piece is the rate between them. Adjent
**learns it from observation** rather than assuming it.

Dollars are not that rate. On a subscription you never pay them, so a cost figure
is a proxy for a quantity you don't hold. USD is therefore **off by default** for
subscription auth, and on by default for API-key/Bedrock/Vertex auth — where it
is the real unit.

#### How it is learned

Adjent holds two aligned series: an exact per-turn token timeline (model × token
kind) and a polled utilization series. Between two polls of a trailing limit,

```
Δu  ≈  Σ_k  w_k · ( tokens_k entering the limit
                    − tokens_k aging out the back of it )
```

Both bracketed quantities are known exactly, because Adjent has the full
timeline — this is the step that makes the rolling window tractable rather than
confounding. Each poll therefore contributes one row of a linear system in `w`.
Solve online by non-negative least squares, initialised from published price
ratios as a prior so the first estimate is sane, and let observation pull it
toward the truth.

What it yields:

* **A blended rate** — "1% of the 5-hour limit ≈ 4.2M tokens at your current
  mix." Always identifiable, and the number most people want.
* **Per-model, per-kind rates** — "1% ≈ 62k Opus output tokens, or 3.1M Opus
  cache reads." Only identifiable when the user's mix actually varies across
  models; with a single model the system is underdetermined and Adjent reports
  the blended rate alone rather than inventing a decomposition.
* **Confidence** from residual variance and sample count, surfaced in the UI.

#### What it unlocks

Per-agent quota attribution, which is the whole point:

```
agent burn %/h  =  (agent tokens/h, by kind)  ·  w
```

That converts "this subagent wrote 900k tokens" into **"this subagent is eating
4.1% of your 5-hour limit per hour"** — the only form of that number anyone can
act on. It is also what makes the `agent_burn` alarm expressible in the same unit
as every other alarm, and what lets Adjent answer a forward question: "that
queued refactor looks like ~15M tokens, roughly 3.6% of the limit."

The absolute limit size falls out of the same fit (`100 / w · typical mix`) and
is shown as an approximation. The authoritative number on the panel is always
the polled percentage.

## Desktop shell

The full information design — what is on the resting surface, what is behind a
click, and the spec for the one chart — is in **[UI.md](UI.md)**. In summary:

* **Tray icon** rendered at runtime: an arc filled to the *binding* limit across
  backends, coloured by pace state rather than raw percentage. 70% six hours into
  a weekly limit is fine; 70% after one hour is not.
* **Popover panel** (frameless, 380×560, anchored to the tray), budgeted to one
  verdict, one hero number, one chart and four agent rows.
* **Notifications** via Electron `Notification`. Windows needs
  `app.setAppUserModelId()` for toasts to render with identity; Linux routes
  through libnotify behind the same API.
* **Also** `adjent statusline`, which prints a one-line summary suitable for
  Claude Code's `statusLine` setting — quota visible where you already are.

## Packaging & CI

* `electron-builder`: Windows NSIS + portable `.exe`; Linux AppImage + `.deb`.
* GitHub Actions matrix (`windows-latest`, `ubuntu-latest`), tag → draft release.
* Unsigned to start, with the SmartScreen warning documented in the README. Code
  signing is a later, purely commercial step.
* `electron-updater` against GitHub Releases once signing exists.
