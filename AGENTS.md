# Adjent — agent instructions

All agent instructions live in [CLAUDE.md](CLAUDE.md); this file exists so
tools that look for `AGENTS.md` find the same rules. Read that file in full —
in particular:

- the **read-only toward vendors** rule (never write `~/.claude`, `~/.codex`,
  or credentials; never run OAuth refresh),
- the **no personal/sensitive data in the repo** rule (no real paths,
  usernames, tokens, IDs, or usage numbers — synthetic fixtures only),
- the doc map in `docs/` — design is authoritative; read before coding.
