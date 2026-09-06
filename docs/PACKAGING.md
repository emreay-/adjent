# Distribution

How a person who has never seen this repository ends up with Adjent running.

[ARCHITECTURE.md](ARCHITECTURE.md#packaging--ci) fixes the build: `electron-builder`,
NSIS + portable on Windows, AppImage + `.deb` on Linux. This document answers
the next question — through which channel, and in what order to build them.

The desktop manifest explicitly supplies `electron-builder-squirrel-windows`
at the version required by `electron-builder`'s packaging library. Keep the pair
aligned when upgrading: pnpm can otherwise retain an older automatically
installed peer and pull the old packaging toolchain back into the lockfile.
This satisfies a build-tool peer; the Windows distribution targets remain NSIS
and portable. Audit the complete dependency graph, including development tools.

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

When implemented, the updater must be gated on install provenance — a build-time
channel marker, or the absence of the manager's own marker file. Where the
updater is off, the correct behaviour is to *say so*: "update available — run
`flatpak update`", not a silent no-op and not a download button that fails.

## Signing, and what it costs to skip

Linux needs none of this. Windows does.

Unsigned Windows builds may trigger SmartScreen or organizational application
control policies. Exact behavior depends on the machine and reputation; do not
promise that every user can bypass a warning. The first downloadable prerelease
must clearly state whether its artifacts are signed.

There are two broad signing approaches: manage a certificate/key through an
appropriate hardware or hosted key service, or integrate a managed signing
service into CI. The first brings key-custody and runner-access work; the second
brings service eligibility, identity verification and provider integration. Both
need investigation, and neither makes a new application immediately trusted on
every Windows machine.

Signing and automatic updates are future work. Evaluate current availability,
eligibility, cost and CI support when choosing a service. The original design
considered Azure-hosted signing for its CI fit; that is a candidate, not a promise
of eligibility or a current price quote. Keep this decision separate from
whether an early, clearly labelled source release is useful.

## Cutting a release

Executable from a clone by anyone with push access to the repository. No
special tooling, no secrets beyond what GitHub Actions already has, nothing
built by hand.

### 1. Choose the version

One version number spans the whole workspace. The root manifest and all three
package manifests carry it, and they must agree. CI and release builds enforce agreement with
`node scripts/check-version.mjs`; tag builds also validate the exact tag.

Adjent is pre-1.0, which under semver means the minor version carries breaking
changes:

* **patch** (`0.1.0` → `0.1.1`) — fixes and internal work only.
* **minor** (`0.1.0` → `0.2.0`) — new user-visible capability, *or* anything
  that breaks a documented contract: the snapshot `schemaVersion`, an exit
  code's meaning, a CLI flag, the `alarms.yaml` schema. A `schemaVersion` bump
  is always at least a minor.
* **major** — after 1.0, not before.

The manifests currently read `0.1.0` and no `v0.1.0` tag exists, so **the first
release tags what the manifests already say**. Every release after it bumps
first.

### 2. Bump, if this is not the first release

Set the same version in all four manifests:

```sh
pnpm -r exec npm version <new-version> --no-git-tag-version
npm version <new-version> --no-git-tag-version   # the root manifest
```

`--no-git-tag-version` matters: npm would otherwise create its own tag, with a
different name from the one the workflow expects.

Then verify all four agree, because a mismatch produces installers whose
filenames disagree with the release:

```sh
git diff --stat        # expect exactly four package.json files
node scripts/check-version.mjs
```

Commit the bump on its own: `Release v<version>`.

### 3. Verify before tagging

A tag is public and a release is what people install. Run what CI runs, plus
the binary smoke test:

```sh
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck && pnpm -r test
node --test scripts/test/*.test.mjs
node scripts/repo-hygiene.mjs
node scripts/check-version.mjs
node packages/cli/test/smoke.mjs
```

All checks must pass locally. CI runs them again on the tag, but finding a
failure after the tag is public means either deleting a tag people may have
fetched or burning a version number.

### 4. Tag and push

The tag name is `v` followed by the exact manifest version — `v0.1.0`, not
`0.1.0` and not `V0.1.0`. `release.yml` triggers on `v*`, so a misspelled tag
either does nothing or fails the version check before packaging.

```sh
git tag -a v0.1.0 -m 'Adjent v0.1.0'
git push origin main
git push origin v0.1.0
```

Push the branch first. A tag pointing at a commit the remote does not have is
the one failure here that is awkward to unwind.

**To rehearse without publishing anything**, run the Release workflow manually
from the Actions tab (`workflow_dispatch`) instead of tagging. It builds and
uploads workflow artifacts only; it cannot create or update a release. Supply an
existing `tag` to check out that exact tag, or leave it empty to build the selected
ref. Both modes check workspace versions, and a tag must match them.

### 5. Promote the draft

A tag push leaves a **draft prerelease** carrying the installers for both
platforms and a `SHA256SUMS` file. It is deliberately not published, because an
unsigned Windows build trips SmartScreen and a person should decide when that is
ready to be seen.

Whoever cuts the release then:

1. Waits for both `package` jobs to go green — a half-built release is worse
   than none, since the missing platform looks like an unsupported one.
2. Downloads one installer per platform and *runs* it. The smoke test proves
   the CLI works; nothing yet proves the packaged desktop app launches.

   **Clear `ELECTRON_RUN_AS_NODE` from the shell first.** Some tool and agent
   environments set it. With it set, `Adjent.exe` runs as plain Node rather than
   as Electron: `app` is undefined, the process exits immediately with status 0
   and prints nothing, and a perfectly good build looks broken. This produced a
   false "packaging is broken" diagnosis on 2026-08-28. Check it before judging
   a build, and confirm the app is really working by watching `~/.adjent/`
   for a fresh write rather than by the process merely being alive.
3. Writes the release notes. What a user gained, what breaks, and — while
   builds are unsigned — the SmartScreen warning and how to get past it.
4. Publishes the draft.

Anyone with write access to the repository can do all of this; nothing here is
personal to one maintainer.

### 6. After publishing

* Verify the `SHA256SUMS` entries match the published assets. Package manifests
  pin against these, so a mismatch breaks every downstream channel at once.
* Update any Scoop / WinGet manifests to the new version and hashes.
* Move the README's **Status** section on if the release changes what a
  stranger should do — the first release turns "run it from source" into an
  install instruction.

### If something goes wrong

**If a draft already exists**, the workflow fails instead of overwriting its
assets. Inspect the failed run and the existing release. A maintainer may remove
an unpublished draft and rerun the same tag to recover a partial upload. Never
replace a tag with a different commit once others may have fetched it; use a new
version for changed source.

**After publishing, a version number is spent.** People have the artefacts and
package managers may have pinned the hashes. Do not retag; fix forward with a
patch release, and delete the broken release only if it is actively harmful.

## Order of work

1. ~~**CI that releases.**~~ **Done** — two workflows:
   * [`ci.yml`](../.github/workflows/ci.yml) builds, typechecks and tests on
     `ubuntu-latest` and `windows-latest` for every push and pull request, and
     enforces two repository rules that were previously only written down: no
     usernames, home paths or key-shaped strings in tracked files, and LF line
     endings in the index.
   * [`release.yml`](../.github/workflows/release.yml) runs on a `v*` tag:
     build, test, then `electron-builder` per platform, and a **draft** release
     carrying every artefact plus a `SHA256SUMS` file — which is exactly what a
     Scoop or WinGet manifest pins against.

   Two deliberate choices there. `electron-builder` runs with `--publish never`,
   because given a token and a tag it will upload on its own and skip the draft
   step entirely. And the release is a draft rather than live, because an
   unsigned Windows build trips SmartScreen and a person should decide when
   that is ready to be seen.

   Every candidate still needs manual Windows and Linux installer validation.
   Unit tests and CLI smoke tests do not prove the packaged desktop app launches
   or that workspace dependencies resolve inside the asar.
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
