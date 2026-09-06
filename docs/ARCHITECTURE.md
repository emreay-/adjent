# Architecture

## Two audiences, one core

Adjent provides observability and advisory orchestration for AI work. Humans
use the tray, panel and notifications to inspect work and intervene. Agents and
orchestrators use snapshots, events, checks and advisory gates to inform their
own work policies. Both are first-class consumers of the same collection,
estimation and rule engine.

The headless CLI runs without Electron or an open desktop session. Human
supervision can be part of an orchestration workflow, but is not a dependency
of the machine interface. As more decisions move to agents, freshness,
provenance, unknown states and compatibility become essential decision inputs.
The public contract lives in [API.md](API.md); desktop presentation constraints
live in [UI.md](UI.md).

Adjent supplies observations and advisory signals. The caller owns scheduling
and enforcement, including whether to involve a human. Future integrations
build on this boundary; they do not require writing vendor state or controlling
agent processes from Adjent.

## Decision: the stack

**Electron + TypeScript, pnpm workspaces, plain HTML/CSS/JavaScript for the panel,
zero native modules, electron-builder → NSIS + AppImage/deb via GitHub Actions.**

Why, against the stated constraint ("simple to build, package, deploy"):

| Option | Verdict |
| --- | --- |
| **Electron + TS** | **Chosen.** Tray, native toasts and a single-instance lock share one runtime. Login integration and auto-update can use the same shell when implemented. `electron-builder` produces Windows and Linux artifacts from one CI matrix. Same language as the parsers. Trade-off: a larger bundled runtime than a native shell; acceptable for the initial developer audience. |
| Tauri v2 (Rust) | Potentially much smaller bundles, but a Rust toolchain plus divergent `webkit2gtk` deps across distros is the exact friction we were told to avoid. Kept as an escape hatch. |
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
  the chart. If real history queries appear later, a runtime-provided SQLite API
  is a possible alternative to a native Node dependency; verify support in both
  the CLI runtime and Electron before adopting it.
* **Codex SQLite** — investigated as a possible data source, but not currently
  read. The adapter uses JSON/JSONL. Any future database reader must remain
  read-only; see the WAL discussion in [DATA-SOURCES.md](DATA-SOURCES.md).
* **Notifications** — Electron's built-in `Notification`.

## Module layout

```
adjent/
  packages/
    core/                 # no UI, no electron — the entire product logic
      src/providers/
        provider.ts       # the ProviderAdapter interface
        claude/           # synthetic fixtures in test/
        codex/            # synthetic fixtures in test/
      src/model/              # normalized domain types
      src/collect/        # byte-offset tailer and network deadlines
      src/quota/          # ledger, limit assessment, fit and breakdown
      src/rules/          # pure engine, configuration, reload and replay
      src/sinks/          # console + webhook; desktop owns tray/toast
      src/monitor.ts      # AppState snapshot + event bus
      src/persist.ts      # JSON/JSONL storage
      src/api/            # snapshot, budget check and advisory gate
    cli/                  # adjent status | watch | check | statusline
    desktop/              # electron main (tray, windows, notifications) + renderer
  docs/
```

`cli` and `desktop` are both thin. Everything testable lives in `core`.

## What is persisted, and where

Monitor data defaults to `~/.adjent/` — never a vendor directory. Electron
also maintains shell profile/cache data. Missing or corrupt monitor history
degrades to a cold start. State writes use tmp + rename so a crash mid-write
does not leave a half-parsed state file; this is not a promise that every settings
write is transactional. Explicit rule/gate writes report failures to callers.

| File | Holds | Retention |
| --- | --- | --- |
| `settings.json` | user preferences (scale, theme, tray, widget, cadence) | forever |
| `alarms.yaml` | user-authored rules — created by CLI init or explicitly saved in the panel | n/a |
| `state.json` | tail byte-offsets per file, the fitted exchange rate, alarm memory (cooldowns, fired levels), burn-rate EWMAs, binding choice, plan tiers | latest snapshot |
| `ledger.jsonl` | recent usage events, so per-agent burn survives a restart | 48 h |
| `history.jsonl` | utilization samples — what the chart's measured curve is drawn from | 14 d |
| `alarms.jsonl` | the notification log behind the notifications view | 90 d / 500 |
| `machine.json` | random snapshot identity, not derived from the host | until removed |
| `gate.json` | advisory hold/open signal | until changed or removed |

Cadence: `state.json` and `ledger.jsonl` are rewritten at most once a minute and
flushed on quit; `history.jsonl` takes a sample only when utilization changes or
every five minutes, which keeps it to a few hundred KB a fortnight.

**Why persist at all.** Without it every launch is a cold start: offsets reset,
so every transcript is re-read; the fit re-bootstraps, so per-agent rates read
*learning* for the first stretch of every session; and alarm cooldowns forget
themselves, so a threshold already crossed fires again. With it, a warm start
resumes from the recorded offsets, avoiding a complete transcript re-read.
Actual startup latency depends on the size of retained metadata and local I/O.

**What is deliberately not persisted.** Anything derived that is cheap to
recompute — assessments, verdicts, projections — and the `AppState` snapshot
itself. Message bodies temporarily pass through the line parser, but are
discarded before normalized state, persistence, logs or UI. Retained paths, labels
and identifiers can still be sensitive.

## Domain model

The example below follows the current core types; see
[`model/types.ts`](../packages/core/src/model/types.ts) for full declarations and
[API.md](API.md) for the separately versioned public JSON contract.

```ts
type Backend = {
  id: 'claude' | 'codex'
  displayName: string
  version: string | null
  plan: string | null            // synthetic example: 'demo-plan'
  rateLimitTier: string | null   // change triggers re-bootstrap
  healthDetail: string | null
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
  startedAt: number              // epoch milliseconds
  lastActivityAt: number
  totals: TokenTotals
}

type UsageEvent = {
  ts: number; backend: BackendId; agentId: string; model: string
  subId?: string | null         // detection label; tokens roll up to parent
  effort: string | null
  tokens: TokenTotals           // input, cacheWrite, cacheRead, output, thinking
  requests: number
  requestId: string              // dedup key — transcripts do get re-read
}

type QuotaLimit = {
  backend: BackendId
  key: string                    // '5h' | '7d' | vendor limit_id
  windowMinutes: number
  label: string
  utilization: number
  resetsAt: number | null        // epoch milliseconds
  observedAt: number             // freshness, not the render time
  severity: 'normal' | 'warning' | 'critical' | null
  vendorActive: boolean          // vendor-named binding limit
  scope: string | null
  source: 'reported' | 'exact' | 'derived' // current providers report quota
}
```

`source` and confidence are not cosmetic. Quota is reported; per-agent burn is
separately derived in `AgentBurn` and carries a confidence level. Derived figures
render with `≈`, whereas the reported hero never does. `LimitAssessment` combines
a `QuotaLimit` with its measured burn, pace, verdict and binding selection.

## Provider interface

Adding a backend (Gemini CLI, Cursor, Aider, Copilot CLI…) means implementing
this and adding synthetic fixtures. The shared quota/rule engine remains reusable;
backend types, registration and labels must also be updated. This is an adapter
boundary, not runtime plugin discovery.

```ts
interface ProviderAdapter {
  readonly id: BackendId
  detect(): Promise<Backend | null>          // binary, version, config dirs
  listAgents(): Promise<Agent[]>             // live + recent
  collectUsage(): Promise<UsageEvent[]>     // newly appended complete records
  getTailOffsets(): Record<string, number>
  setTailOffsets(offsets: Record<string, number>): void
  quota(): Promise<QuotaLimit[]>            // [] if the vendor exposes none
  readonly supportedVersions: string         // semver range
}
```

### Collection loop

* **Read incrementally.** The original design preferred `fs.watch` with debounce
  for transcripts. The current shells schedule `Monitor.tick()` and poll file
  metadata, reading from persisted byte offsets. Rule configuration uses a watcher.
  A future transcript watcher should retain this offset-based recovery path.
* **Bound work and memory.** Reads use 64 KiB chunks and return roughly 1 MiB of
  complete records per file per collection. Long histories catch up over ticks;
  totals during catch-up may be incomplete. Records above 16 MiB are skipped,
  and subsequent provider detection reports degraded health.
* **Bound external waits.** Quota and webhook requests have a five-second deadline
  covering headers and body. Providers are visited sequentially, but a stalled
  request cannot stop the loop indefinitely.
* **Dedup on `requestId`.** Transcripts can be rewritten (compaction), so the
  ledger must be idempotent.
* **Never retain message bodies.** The line parser extracts the metadata keys and
  discards the remainder before it reaches application state.

## Quota

### Codex — reported
Take the newest `rate_limits` record across rollouts. Map `primary` / `secondary`
onto `QuotaLimit` by `window_minutes` (300 → 5h, 10080 → 7d). `source:
'reported'`. No modelling is required for that percentage; freshness still
depends on when the local client last recorded a response.

### Claude — reported
The M0 spike closed positively: `GET https://api.anthropic.com/api/oauth/usage`,
authenticated with the OAuth token in `~/.claude/.credentials.json`, returns
`five_hour` / `seven_day` utilization with `resets_at`, plus a `limits[]` array
carrying per-model scoped windows, a server-assigned `severity`, and `is_active`
marking the currently binding limit for that vendor. `source: 'reported'`.

Both backends therefore supply reported quota. **No estimation or calibration
is needed for the hero percentage.** Per-agent attribution below is derived.

Because this endpoint is private, four rules are structural, not stylistic:

1. **Read the token, never write it.** Adjent must not run the refresh flow.
   Refreshing rotates the refresh token; if Adjent did that, it could invalidate
   Claude Code's own credentials. Adjent is a reader of auth state, never an
   owner of it.
2. **`401` is a normal state, not an error.** Back off, keep serving the last
   good snapshot marked stale, and wait for Claude Code to refresh the token on
   its next use.
3. **Poll at most once a minute.** Idle suppression was an initial design goal;
   the current provider also polls during idle collection. Manual refresh honors
   the same rate cap. Redirects are rejected, and the deadline includes the body.
4. **A shape change degrades one provider, never the app.** Parse defensively;
   fall back to `limits[]` if the named limit keys move, and vice versa.

Adjent never sends the token anywhere except the endpoint that issued it, and
never logs or displays it.

**API-key, Bedrock and Vertex users have no such endpoint.** For them
`quota()` returns `[]`. Showing currency spend would be more useful for metered
billing, but that is future work; the current panel does not calculate a bill.

### The exchange rate — tokens per percentage point

Percentage is the currency you actually spend from; tokens are the receipt.
Neither is useful alone, and the missing piece is the rate between them. Adjent
**learns it from observation** rather than assuming it.

Dollars are not that rate. On a subscription you never pay them, so a cost figure
is a proxy for a quantity you do not hold. The intended design therefore keeps
USD secondary for subscription auth, while a future API-key/Bedrock/Vertex view
could lead with currency. That billing surface is not implemented today.

#### How it is learned

Adjent holds two aligned series: an exact per-turn token timeline (model × token
kind) and a polled utilization series. Between two polls of a trailing limit,

```
Δu  ≈  Σ_k  w_k · ( tokens_k entering the limit
                    − tokens_k aging out the back of it )
```

Both bracketed quantities can be counted from a complete local timeline —
this is the step that makes the rolling window tractable rather than confounding.
Missing local records or another device spending the account violate that
coverage assumption; the resulting weights must remain labelled as derived. Each poll therefore contributes one row of a linear system in `w`.
Solve online by non-negative least squares, initialised from published price
ratios as a prior so the first estimate is sane, and let observation pull it
toward the truth.

What it yields (all figures below are synthetic illustrations):

* **A blended rate** — "1% of the 5-hour limit ≈ 5M tokens at your current
  mix." Always identifiable, and the number most people want.
* **Per-model, per-kind rates** — "1% ≈ 80k model-x output tokens, or 4M model-x
  cache reads." Only identifiable when the user's mix actually varies across
  models; with a single model the system is underdetermined and Adjent reports
  the blended rate alone rather than inventing a decomposition.
* **Confidence** from residual variance and sample count, surfaced in the UI.

#### What it unlocks

Per-agent quota attribution, which is the whole point:

```
agent burn %/h  =  (agent tokens/h, by kind)  ·  w
```

That converts "this subagent wrote 1M tokens in an hour" into **"this subagent is eating
2% of your 5-hour limit per hour"** — the only form of that number anyone can
act on. It is also what makes the `agent_burn` alarm expressible in the same unit
as every other alarm, and what lets Adjent answer a forward question: "that
queued refactor looks like ~10M tokens, roughly 2% of the limit."

The absolute limit size falls out of the same fit (`100 / (w · typicalMix)`) for a normalized typical token mix. Any display of this quantity must be
an approximation, not a vendor-reported allowance. The authoritative number on the panel is always
the polled percentage.

## Desktop shell

The full information design — what is on the resting surface, what is behind a
click, and the spec for the one chart — is in **[UI.md](UI.md)**. In summary:

* **Tray icon** rendered at runtime: an arc filled to the *binding* limit across
  backends, coloured by pace state rather than raw percentage. For a synthetic
  five-hour limit, 40% after three hours is below linear pace; 40% after one hour
  is above it. A percentage alone does not determine urgency.
* **Popover panel** (frameless, 380×560, anchored to the tray), budgeted to one
  verdict, one hero number, one chart and four agent rows.
* **Notifications** via Electron `Notification`. Windows needs
  `app.setAppUserModelId()` for toasts to render with identity; Linux routes
  through libnotify behind the same API.
* **Also** `adjent statusline`, which prints a one-line summary suitable for
  Claude Code's `statusLine` setting — quota visible where you already are.

### Renderer trust boundary

Both windows explicitly enable sandboxing and context isolation, disable Node
integration, reject navigation and new windows, and use a narrow preload bridge.
Each main-process IPC handler verifies an owned window's main frame and exact
local URL. Rules text is checked and size-bounded before parsing or saving.
The renderer CSP restricts scripts to bundled files. This keeps vendor access,
disk writes and privileged operations in the main process.

## Packaging & CI

* `electron-builder`: Windows NSIS + portable `.exe`; Linux AppImage + `.deb`.
* GitHub Actions matrix (`windows-latest`, `ubuntu-latest`), tag → draft prerelease.
  Manual dispatch is artifact-only. Version checks bind tags to all manifests;
  existing releases are never overwritten. Synthetic CLI and renderer smoke tests
  complement unit tests; they do not replace installed-app validation.
* Unsigned to start; signing and distribution policy must be settled before a
  mainstream release. See the release procedure for candidate validation.
* `electron-updater` against GitHub Releases once signing exists.

Which channels those artefacts reach, and why Flatpak's sandbox suits a
read-only quota monitor better than Snap's, is [PACKAGING.md](PACKAGING.md).
