# Contributing to Adjent

Thanks for looking. Issues, ideas and pull requests are all welcome.

## Licensing, in one paragraph

Adjent is [MIT](LICENSE). Contributions are accepted under the same terms —
inbound equals outbound — and **there is no CLA to sign**. MIT already permits
everything a maintainer might later need, so asking you to sign away rights
would be friction without purpose.

Please add a `Signed-off-by` line to your commits, which `git commit -s` does
for you. It is the [Developer Certificate of Origin](https://developercertificate.org/):
a statement that you wrote the change, or otherwise have the right to submit it
under MIT. It is not a copyright assignment.

## Getting set up

Node 22.12+ and pnpm 9. Electron 44 requires this Node baseline for development.

```sh
pnpm install
pnpm -r build        # build first: packages typecheck against each other's dist
pnpm -r typecheck
pnpm -r test
node --test scripts/test/*.test.mjs
node scripts/repo-hygiene.mjs
node packages/cli/test/smoke.mjs
```

CI runs exactly that on Windows and Linux for every pull request, so running it
locally first will save you a round trip. Two extra guards run as well: no
personal data in tracked files, and LF line endings — both described below.

## What a good pull request looks like

**Small and focused.** One change per PR. If you have found a second thing,
that is a second PR — or an issue, if it is bigger than the change you came for.

**Tested.** A new behaviour without a test is not finished. Look at the existing
suites for the house style: they are written to state the *property* being
protected and, where the behaviour is subtle, why it matters. `replay.test.ts`
and `check.test.ts` are reasonable models.

Please make sure a new test would actually fail against the old code. It is
surprisingly easy to write one that passes either way.

**Explained.** Commit messages use an imperative subject and a body covering
motivation → changes → consequences → validation. The `git log` is the design
record for this project, so a message that says what changed but not *why* has
lost the useful half.

## House rules

These are not style preferences; each exists because breaking it caused a real
problem. [CLAUDE.md](CLAUDE.md) is the long version.

**Read-only toward vendors.** Never write under `~/.claude` or `~/.codex`, never
modify credentials, never trigger an OAuth refresh. Adjent writes only under
`~/.adjent/`. A `401` is a normal state to back off from, not an error to fix.

**Metadata only.** Parsers extract token counts, model ids, paths and
timestamps and discard the rest *at read time*. Message content must never
enter application state, a log line, or any payload. New surfaces — JSON, HTTP,
exports — multiply the places this can leak, so check each one deliberately.

**Provenance is typed.** Every displayed number is `reported`, `exact` or
`derived`. Derived values render with `≈`; measured ones never do. On
machine-readable surfaces provenance travels as *data*, not as a glyph a
consumer has to parse back out.

**Degrade per provider, never the app.** A format change or a failed endpoint
disables one backend's data. Parsers ignore unknown fields, treat missing
optionals as null, and never throw on shape drift.

**No native modules.** Nothing requiring node-gyp or a prebuild matrix. Storage
is JSON and JSONL; notifications are Electron's own. If a dependency needs a
native build, the answer is a different dependency.

**Core stays UI-agnostic.** `packages/core` imports no Electron and no DOM.

**Vocabulary comes from [docs/GLOSSARY.md](docs/GLOSSARY.md).** `utilization`,
`limit`, `bindingLimit`, `burnRate` — no synonyms. Note `limit`, not `window`:
in a desktop app a window is a UI element. `window` survives only for a time
span.

## No personal data in the repository

Nothing private from your machine may enter version control. CI flags some
patterns; manual review is required for usage figures, images and history:

- No usernames, home directories, hostnames or machine names. Use `~`,
  `<user>`, `C:\Users\<user>\...`.
- No tokens, keys, cookies, account identifiers or session ids — not even
  expired or truncated ones.
- No real usage figures, plan names or quota percentages from a real account,
  in code, tests or docs. Fixtures use invented values.
- Test fixtures derived from real vendor files must be redacted by hand:
  regenerate the ids, blank the paths, invent the numbers, keep only the
  *shape*.

Line endings are LF, enforced by `.gitattributes` and checked in CI. A CRLF file
that slips in breaks the renderer tests on one platform only, which is a
miserable way to find out.

## The API is a promise

Anything in [docs/API.md](docs/API.md) is a contract with agents, orchestrators
and people building integrations. Both humans and machines are first-class
consumers; desktop presentation must not determine what a headless caller can
understand. Inside a `schemaVersion`, changes are additive only; a removal or a
rename is a version bump plus a migration note in the same commit. The contract
test will stop you by accident — please do not route around it.

Preserve the detailed reasoning, derivations and worked examples in the docs.
Use synthetic data and correct or label stale claims while keeping the
explanations that teach how the system works.

## Reporting a security issue

Follow [SECURITY.md](SECURITY.md) for a private reporting route. Do not publish
vulnerability details or sensitive diagnostics in an issue.
