# Security

Adjent is an unreleased WIP. Security fixes target the current main branch;
there are no supported release branches or response-time guarantees yet.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/emreay-/adjent/security/advisories/new)
when it is available. If that form is unavailable, open an issue asking only for
a private security contact, without vulnerability details, credentials, logs or
proof-of-concept data. Wait for a private channel before sending the report.

Include the affected revision, platform, impact, and a minimal synthetic
reproduction. Do not attach real vendor transcripts, access tokens, webhook URLs,
account identifiers, or unredacted snapshots. A screenshot can expose project
names and paths too.

## Data and trust boundaries

Adjent reads local vendor metadata. Claude quota additionally uses the existing
access token for Anthropic's private usage endpoint. Adjent never refreshes or
writes vendor credentials. It does not read Codex authentication data.

Message bodies are discarded during parsing. Retained metadata includes paths,
labels, identifiers, timestamps and usage; these are sensitive even without
message bodies. Configured webhooks receive alarm payloads. There is no telemetry
or automatic crash-report upload.

See [data sources](docs/DATA-SOURCES.md) and [architecture](docs/ARCHITECTURE.md)
for the implemented boundaries and limitations. Repository hygiene checks are
pattern-based aids, not a guarantee that history or diagnostics are safe to share.
