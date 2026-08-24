# Adjent

A cross-platform (Windows/Linux) desktop tray widget that answers, at a glance:

> *Which AI coding agents are running right now, on what models, in which projects — and how much of my quota have they burned?*

Plus a rule-driven alarm engine that tells you **before** you hit a wall.

[![CI](https://github.com/emreay-/adjent/actions/workflows/ci.yml/badge.svg)](https://github.com/emreay-/adjent/actions/workflows/ci.yml)

## Status

Working, unreleased. Core, CLI and desktop shell all build; both providers read
live data; the tray, panel, alarm engine and notification log are in. Every push
builds, typechecks and tests on Windows and Linux — see
[.github/workflows/ci.yml](.github/workflows/ci.yml).

Not yet done: signed builds and a published release. How that will work is
[docs/PACKAGING.md](docs/PACKAGING.md). Start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Doc | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Tech stack, module layout, provider interface, packaging |
| [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) | Verified on-disk formats for Claude Code and Codex |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every term defined, plus how burn rate is actually computed |
| [docs/UI.md](docs/UI.md) | Information design — the budget, the one chart, the units |
| [docs/ALARMS.md](docs/ALARMS.md) | The three alarm models, formalised |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones, expansion, integrations, risks |

## Principles

1. **Read-only and local-first.** Adjent never writes into agent state and never
   sends anything off the machine unless a sink is explicitly configured.
2. **Metadata only.** Parsers extract token counts, model ids, paths and
   timestamps. Message content is never read into memory, logged, or displayed.
3. **Never own what you observe.** Adjent reads vendor state; it never writes to
   a vendor's directory and never runs an OAuth refresh, because rotating a token
   could break the very tool it is monitoring.
4. **Honest numbers.** Measured, exact and derived figures are visually
   distinct. Adjent never renders a derived value as if it were measured.
5. **Cut ruthlessly.** Every element on the resting surface must help answer
   "should I change what I am doing right now?" Everything else is one click
   away. This is the whole differentiator — see [docs/UI.md](docs/UI.md).
6. **The core is UI-agnostic.** Everything works headless via CLI; the tray is
   one of several front-ends.
