# Distribution

How a person who has never seen this repository ends up with Adjent running.

[ARCHITECTURE.md](ARCHITECTURE.md#packaging--ci) fixes the build: `electron-builder`,
NSIS + portable on Windows, AppImage + `.deb` on Linux. This document answers
the next question — through which channel, and in what order to build them.

## The shape of the answer

**GitHub Releases is the source of truth. Every other channel is a mirror of
it.** A tagged release builds once in CI and publishes the artefacts plus their
checksums; a WinGet manifest, a Scoop manifest, a Flathub build and an AUR
`PKGBUILD` all point back at those same files. Nothing is ever built by hand for
one channel, because a channel that builds its own binary eventually ships a
different one.

That ordering matters more than which managers get supported. Adding a manager
later is a manifest. Discovering that three channels disagree about what version
1.4.0 is, is a weekend.

## The constraint that decides Linux

Adjent's entire function is reading `~/.claude` and `~/.codex`. It is read-only
toward both (README rule 1), but it must *see* them, and they are not its own
files.

This puts it in direct conflict with how sandboxed Linux packaging works:

| Format | What it does to us |
| --- | --- |
| **AppImage** | No sandbox. Runs, sees the home directory, works. |
| **`.deb`** | No sandbox. Same. |
| **Flatpak** | Sandboxed by default. Needs an explicit filesystem grant. |
| **Snap** | Strict confinement cannot read arbitrary dotfiles; `classic` confinement can, but requires a manual review on the Snap Store to be granted. |

Flatpak is the tractable one, and its permission model is a *feature* here
rather than an obstacle. The manifest asks for exactly:

```yaml
finish-args:
  - --filesystem=~/.claude:ro
  - --filesystem=~/.codex:ro
  - --share=network        # the Claude quota endpoint, nothing else
```

Read-only, two directories, one network reason. That is a far better story than
"grant this quota monitor your home directory", and it is enforced rather than
promised — the sandbox makes README rule 1 structural instead of a convention.
It is worth checking early that both vendors keep their data at those paths on
Linux; a vendor that moves to `~/.config/...` changes the grant.

**Snap is not worth it.** Classic confinement means a review queue and a
justification for reading dotfiles, to reach an audience Flatpak already covers.

## Recommendation

### Windows

1. **GitHub Releases** — the NSIS installer for most people, the portable `.exe`
   for anyone who cannot install software. Available from day one; costs a CI
   workflow and nothing else.
2. **Scoop** — ship this first among the managers. A manifest is a small JSON
   file in a bucket, needs no signing, no review queue, and no account, and its
   users are exactly this product's audience: people who already have Claude
   Code and Codex installed. `scoop install adjent` can work the same week the
   first release does.
3. **WinGet** — the mainstream answer, built into Windows 11, and the one to
   submit once releases are stable. It is a PR to `microsoft/winget-pkgs` with a
   URL and a SHA256, validated by automation. Do this after a version or two,
   because every update is another PR and a broken manifest is public.

Chocolatey is skippable: more ceremony than Scoop, less reach than WinGet.

### Linux

1. **GitHub Releases** — AppImage and `.deb`. The AppImage is the honest
   universal answer and needs no packaging relationship with anyone.
2. **Flathub** — the mainstream channel, and the one that gets Adjent into
   GNOME Software and KDE Discover. Worth the manifest for the permission story
   alone.
3. **AUR** — a `PKGBUILD` wrapping the release artefact. Community-maintained by
   convention; cheap to seed, and Arch users will otherwise write one anyway.

No PPA, no RPM repository. The `.deb` covers Debian and Ubuntu directly, and
Flatpak covers everything else without maintaining a repository per distribution.

## Updates

`electron-updater` against GitHub Releases, **but only for the builds that came
from GitHub Releases.** A package-managed install must never update itself
behind the manager's back: Flatpak, WinGet and Scoop each own their upgrade
path, and an app that rewrites its own files under them produces a version the
manager cannot reason about.

So the updater is compiled in but gated on install provenance — a build-time
channel marker, or the absence of the manager's own marker file. Where the
updater is off, the correct behaviour is to *say so*: "update available — run
`flatpak update`", not a silent no-op and not a download button that fails.

## Signing, and what it costs to skip

Linux needs none of this. Windows does.

Unsigned, every release triggers SmartScreen's "unrecognised app" full-screen
warning, and reputation accrues per signing identity — so an unsigned app never
stops warning, no matter how many downloads it gets. That is survivable for an
early developer-audience release and fatal for a mainstream one.

Two routes: a traditional OV certificate (roughly $100–400/yr, and since 2023
the private key must live on a hardware token or an HSM, which complicates CI),
or **Azure Trusted Signing** (~$10/month, cloud-based, signs cleanly from CI, but
requires an organisation with a verifiable identity). Trusted Signing is the
better fit for a project that wants CI to do the signing — and note that even
signed, a *new* identity carries no SmartScreen reputation for its first weeks.

This is a commercial decision, not a technical blocker. The sequencing below
assumes it happens after there is something worth installing.

## Order of work

1. **CI that releases.** GitHub Actions matrix (`windows-latest`,
   `ubuntu-latest`), tag → build → draft release with checksums. Everything else
   depends on this existing, and nothing else can start until it does.
2. **Scoop manifest + AppImage.** The two channels that need no permission from
   anyone. This is a complete distribution story for the launch audience.
3. **Flathub submission.** The manifest, the read-only grants, and a check that
   both vendor paths hold on Linux.
4. **WinGet submission**, once release cadence has settled.
5. **Signing**, then enable `electron-updater` for the GitHub-Releases channel.
6. **AUR**, whenever someone asks — or seed it at step 2 if Arch users turn up
   early.

Steps 1–2 are a few days. Steps 3–4 are mostly waiting on review. Step 5 is
paperwork and money rather than engineering.
