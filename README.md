# Adjent

[![CI](https://github.com/emreay-/adjent/actions/workflows/ci.yml/badge.svg)](https://github.com/emreay-/adjent/actions/workflows/ci.yml)

**A tray-resident monitor for local AI coding agents.** It answers, at a glance:

> *Which agents are running right now, on what models, in which projects — and
> how much of my quota have they burned?*

Plus a rule-driven alarm engine that tells you **before** you hit a wall, and a
headless CLI so a script can ask the same questions.

Adjent watches [Claude Code](https://claude.com/claude-code) and
[OpenAI Codex](https://openai.com/codex), read-only, on Windows and Linux.

---

## Why

One agent is easy to keep in your head. Four are not.

Vendors show you a percentage when you ask. They do not tell you *which* of your
running sessions is spending it, whether you are on track to last the week, or
that the subagent you started an hour ago has been looping ever since. By the
time the number is obviously a problem, the week's budget is gone.

Adjent sits in the tray and answers the only question that matters while you
work: **should I change what I am doing right now?**

## What it does

- **One number that means something.** The hero figure is always
  vendor-reported utilization of the *binding* limit — the one that will stop
  you first, which is not always the fullest one. 84% of a weekly limit with six
  days left is less urgent than 60% of a five-hour limit with forty minutes left.
- **Per-agent attribution.** Which session, which project, which model, and what
  each is costing per hour.
- **Alarms you can prove before you trust them.** `adjent rules test` replays
  your rules against your own recorded history and shows what would have fired.
  Edit them in the panel or in your editor — either way the file is watched, so
  a save applies without a restart.
- **A programmatic surface.** Every command speaks `--json`, `adjent check` is a
  budget gate with meaningful exit codes, and `adjent watch --json` is a JSONL
  event stream.
- **Honest numbers.** Every figure is typed `reported`, `exact` or `derived`.
  Derived values render with `≈`; measured ones never do.

## Status

**Working, unreleased.** Core, CLI and desktop all build and are tested on
Windows and Linux for every push. Both providers read live data; the tray,
panel, alarm engine, notification log and CLI are in.

Not yet done: signed builds and a published release — see
[docs/PACKAGING.md](docs/PACKAGING.md) for how distribution will work, and why
Flatpak's sandbox suits a read-only monitor better than Snap's.

Until then, run it from source.

## Install

Requires **Node 22.5+** and **pnpm 9**.

```sh
git clone https://github.com/emreay-/adjent.git
cd adjent
pnpm install
pnpm -r build
```

Then either surface:

```sh
# the desktop tray app
pnpm --filter @adjent/desktop start

# the CLI
node packages/cli/dist/main.js status
```

There is nothing to configure. Adjent finds `~/.claude` and `~/.codex` if they
are there, and reports what it can if they are not.

## The CLI

```
adjent status                    everything at once
adjent limits                    how full each limit is
adjent agents                    what is running, most expensive first
adjent watch                     a live loop
adjent check                     may I start more work?
adjent explain <term>            what a number means
adjent statusline                one line, for Claude Code's statusLine

adjent rules init                write ~/.adjent/alarms.yaml from a preset
adjent rules validate            check it, and print what will actually run
adjent rules test                replay your rules against your own history
```

Every command takes `--json`. Run `adjent --help` for the full flag list, or
read [docs/API.md](docs/API.md) — the payload shape, the exit-code table and the
compatibility promise are all on that one page.

### The budget gate

The question a fleet actually has is *"do I have room to start five more
workers?"*. That is an exit code:

```sh
# Only start the batch if a fifth of the budget is still there.
adjent check --budget 20% --quiet || exit 0

# Refuse to act on a reading more than ten minutes old.
adjent check --budget 20% --max-age 10m --quiet

# Narrow it to one limit. The keys are the vendors' own — `adjent limits --json`
# lists them, and a wrong one tells you what it should have been.
adjent check --budget 20% --limit weekly_all --quiet
```

`--budget 20%` means *at least 20% must remain*. It is judged against the
binding limit unless you narrow it, and when several limits are in scope it must
hold for **all** of them — a gate that passed because one limit had room would
green-light work the weekly limit cannot afford.

Exit codes distinguish the cases a script cares about: **0** it holds, **4** it
does not, **3** there was nothing to judge, **5** the data was too old, **2** a
flag could not be read. `4` and `3` are successful evaluations, not failures — a
CI step that treats any non-zero code as breakage will misread a working gate.

### Proving a rule before you trust it

Authoring an alarm is guesswork until you can see what it would have done:

```sh
adjent rules init --preset fleet     # five presets ship; the file is commented
adjent rules validate                # what Adjent actually understood
adjent rules test                    # what it would have done to your last week
```

`rules test` replays your rules over `~/.adjent/history.jsonl` and prints the
timeline, the per-rule counts and the longest quiet stretch — which is what
tells you whether a rule is usable or merely correct. Rules that history cannot
answer for are named as **not evaluated** rather than reported as silent.

## Principles

These are constraints, not aspirations. They are enforced in code and in CI.

1. **Read-only toward vendors.** Adjent never writes into `~/.claude` or
   `~/.codex`, never touches credentials, and never runs an OAuth refresh —
   rotating a token could break the very tool it is monitoring. It writes only
   under `~/.adjent/`.
2. **Metadata only.** Parsers extract token counts, model ids, paths and
   timestamps, and discard the rest at read time. Message content never enters
   application state, so no surface can leak it.
3. **Honest numbers.** Every figure carries its provenance as data, not
   decoration. A consumer decides how to render from that; it never has to guess
   whether a number was measured or modelled.
4. **Degrade per provider, never the app.** A format change or a failed endpoint
   disables one backend's data. Parsers ignore unknown fields and never throw on
   shape drift.
5. **Cut ruthlessly.** Everything on the resting surface must help answer
   "should I change what I am doing right now?". Everything else is one click
   away.
6. **The core is UI-agnostic.** `packages/core` imports no Electron and no DOM.
   The CLI and the desktop app are thin shells over it.

## Privacy

Adjent is local-first and sends nothing anywhere unless you configure a sink.

It reads vendor transcripts to count tokens, and discards everything else as it
goes. Paths *are* retained — `projectPath` is what makes per-project attribution
work — so a snapshot describes your directory layout. That is the field to think
about if you pipe payloads somewhere.

Machine identity in a payload is a random UUID minted into
`~/.adjent/machine.json`, deliberately not derived from a hostname, user name or
MAC address: a snapshot can leave the machine that produced it, and a derived id
would let anyone holding one work out whose it was.

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/API.md](docs/API.md) | The snapshot shape, exit codes, the event stream, the compatibility promise |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, module layout, the provider interface |
| [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) | Verified on-disk formats for both vendors |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every term, and how burn rate is actually derived |
| [docs/UI.md](docs/UI.md) | Information design — the budget, the one chart, the units |
| [docs/ALARMS.md](docs/ALARMS.md) | The alarm models, formalised |
| [docs/PACKAGING.md](docs/PACKAGING.md) | Distribution channels, sandboxing, signing, updates |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones, expansion, risks |

## Development

```sh
pnpm -r build        # build every package, in dependency order
pnpm -r typecheck    # requires a build first: packages typecheck against dist
pnpm -r test         # vitest, no watch
```

CI runs the same sequence on `ubuntu-latest` and `windows-latest` for every push
and pull request, plus two repository guards: no usernames, home paths or
key-shaped strings in tracked files, and LF line endings in the index.

Layout:

```
packages/core       providers, quota model, alarm engine, snapshot API
packages/cli        headless CLI — a thin shell over core
packages/desktop    Electron tray, panel, widget
```

**No native modules.** No `better-sqlite3`, no `node-notifier`, nothing needing
node-gyp or a prebuild matrix. Storage is JSON and JSONL under `~/.adjent/`;
notifications are Electron's own. If a dependency needs a native build, the
answer is a different dependency.

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the house rules and what a
good PR looks like. There is **no CLA**: contributions are accepted under the
same MIT terms as the project, and a sign-off line is all that is asked.

## Licence

[MIT](LICENSE).

Permissive on purpose. Adjent is more useful to more people if anyone can take
it, embed it, or build on it, and that matters more here than defending against
a hypothetical competitor.
