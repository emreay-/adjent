# Adjent — agent instructions

Cross-platform (Windows/Linux) observability and advisory orchestration for AI
work. People use the tray-resident monitor; agents and orchestrators use the
headless contracts. Both consume live agent, model, project, quota and alarm
data for local coding agents (Claude Code, Codex). Agent-driven orchestration
is a central future direction; human supervision is not a runtime requirement.
Enforcement remains with the caller, as described in README.md.
Design-first repo: read the docs before writing code.

## Doc map — read in this order for context

| Doc | Authority on |
| --- | --- |
| [README.md](README.md) | principles; public setup and project constraints |
| [docs/API.md](docs/API.md) | machine-facing contracts for agents, orchestrators and integrations |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | stack, module layout, provider interface, packaging |
| [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) | verified vendor on-disk formats and the quota endpoint |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | terminology; the exchange-rate model, derived step by step |
| [docs/UI.md](docs/UI.md) | form factor, component budget, hero number, mockups |
| [docs/ALARMS.md](docs/ALARMS.md) | the four rule types, config schema, sinks |
| [docs/ROADMAP.md](docs/ROADMAP.md) | milestones, expansion, risks |
| [docs/PACKAGING.md](docs/PACKAGING.md) | distribution channels, sandboxing, signing, update policy |

## Hard rules (from the design; do not relax without discussion)

1. **Read-only toward vendors.** Never write into `~/.claude` or `~/.codex`.
   Never write `.credentials.json`; never run an OAuth refresh flow. A `401` is
   a normal state (back off, serve stale-marked data), not an error to fix.
2. **Metadata only.** Parsers must never load message bodies into application
   state, logs, or UI. Extract usage/model/path/timestamp keys and discard the
   rest.
3. **Provenance is typed.** Every displayed number is `reported`, `exact`, or
   `derived`. Derived values render with `≈`; measured values never do. The
   hero number is always vendor-reported utilization of the binding limit.
4. **No native Node modules.** Storage is in-memory plus JSON/JSONL under
   `~/.adjent/` (`packages/core/src/persist.ts`); notifications use Electron's
   built-in `Notification`. If a dependency needs node-gyp or a prebuild
   matrix, find another way. (This rule once named `node:sqlite` as the
   intended store; nothing has ever used it, and the JSONL design is what
   shipped.)
5. **Core stays UI-agnostic.** `packages/core` imports no Electron and no DOM.
   CLI and desktop are thin shells over it.
6. **Degrade per provider.** A format change or endpoint failure disables one
   backend's data, never the app. Parsers are additive-tolerant: unknown fields
   ignored, missing optionals null, never throw on shape drift.

## No personal/sensitive data in the repo — hard rule

Nothing from the development machine may enter version control:

- No usernames, home-directory paths, hostnames, or machine names. Use
  placeholders: `~`, `<user>`, `C:\Users\<user>\...`.
- No tokens, keys, cookies, org/account UUIDs, or session IDs — not even
  truncated or expired ones.
- No real usage numbers, plan/tier strings, or quota percentages from a real
  account in code, tests, or committed docs. Fixtures use synthetic values.
- Test fixtures derived from real vendor files must be redacted by hand:
  regenerate IDs, zero the paths, invent the numbers, keep only the *shape*.
- Before any commit: scan the diff for the above. When in doubt, leave it out.

Historical revisions contain examples predating this rule. Current examples
must be synthetic; publication requires a separate history audit (see
[docs/PUBLICATION.md](docs/PUBLICATION.md)).

## Working alongside other agents

More than one agent can work in this repo at once. They are **not** isolated by
default: a plain clone means one working directory, one HEAD and one index, so a
branch switch by either agent moves the ground under the other, and `git add -A`
commits whatever the other one happens to have half-finished. Both of those have
already happened here.

**Current layout: one worktree, on `main`.** The parallel split was retired on
2026-08-24; `adjent-core/` and `adjent-branding/` and their branches are gone.
Adjent is a tray app under a machine-wide single-instance lock, so only one copy
can ever run — that ceiling made parallel worktrees cost more in merge overhead
than they returned. Work on `main` unless a task genuinely needs isolation.

**When one does**, give the agent its own worktree and its own long-lived branch:

```sh
git worktree add -b <area>/<topic> ../adjent-<area> main
cd ../adjent-<area> && pnpm install      # a fresh worktree has no node_modules
```

Run `git worktree list` before assuming anything about the layout. These rules
apply the moment a second worktree exists:

1. **Never `git add -A`.** Stage explicit paths. This is the single rule that
   would have prevented every cross-contamination so far.
2. **Never switch branches in a directory you do not own**, and never commit
   files you did not write. If another agent's work is uncommitted in your tree,
   leave it and say so.
3. **Merge `main` in often** rather than letting branches drift — the packages
   are small and conflicts are cheap when caught early.
4. **Fold a branch back with `git merge`, not by replaying its commits.**
   Rebasing or cherry-picking onto `main` and leaving the branch alive gives
   every commit two hashes: the branch then reads as "N ahead" forever and the
   next honest merge conflicts with itself. `work/branding` ended up exactly
   there — nine commits duplicated, identical trees, permanent phantom drift.
5. Worktrees live *outside* the repo directory, so nothing needs gitignoring.
6. `dist/` and `node_modules/` are per-worktree. Never build or run the Electron
   app from a directory another agent is editing.
7. **Only one Adjent can run at a time**, whichever worktree it was built from —
   `app.requestSingleInstanceLock()` is machine-wide. Agree who holds it before
   launching, and stop it by **PID**, never `taskkill /IM electron.exe`, which
   also kills every other Electron app on the machine.
8. **Tearing a worktree down:** stop anything running from it first, then
   `git worktree remove --force <path>`. On Windows that deregisters the
   worktree but usually leaves `node_modules`; finish with
   `cmd /c rd /s /q <path>`, which drops pnpm's symlinks without following them
   into the global store. "Device or resource busy" means a shell still has the
   directory as its cwd — find it rather than forcing.
9. Gitignored working files do not travel with a branch. `brand/*-brand-identity.html`
   in particular is per-worktree; copy the current one out before removing a tree.

## Conventions

- Treat humans and agents as first-class consumers. Keep machine contracts
  independent of desktop presentation and explicit about missing or stale data.
- Preserve the teaching value of the docs: retain derivations, reasoning and
  worked examples; replace private data with synthetic data and clearly label
  proposed behavior instead of removing explanations.
- TypeScript strict; pnpm workspaces (`core/`, `cli/`, `desktop/` under
  `packages/`) per ARCHITECTURE.md.
- Vocabulary in code follows GLOSSARY.md: `utilization`, `limit`,
  `bindingLimit`, `bucket`, `burnRate` — do not invent synonyms. Note `limit`,
  not `window`: in a desktop app a window is a UI element, and `limit` is the
  vendors' own word. `window` survives only for a *time span* (`windowMinutes`,
  the `agent_burn` lookback) and in the rolling-window maths in GLOSSARY.md.
- Line endings are LF, enforced by `.gitattributes`.
- Math in docs is KaTeX-compatible `$…$`/`$$…$$`. When editing it
  programmatically, never pass LaTeX through bash heredocs or Python string
  layers that interpret escapes (`\f`, `\t`, `\b`, `\a` get eaten — this bit us
  twice); write via file tools or scripts with raw/UTF-8 handling, and re-check
  for control characters afterwards.
- Commits: imperative subject, structured body (motivation → changes →
  consequences → validation). Do not amend or force-push unless asked.
