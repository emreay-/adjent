# Public WIP publication

Publishing the source and publishing installers are separate decisions. This
checklist covers the source repository; [PACKAGING.md](PACKAGING.md) covers releases.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
node --test scripts/test/*.test.mjs
node scripts/check-version.mjs
node scripts/repo-hygiene.mjs
node packages/cli/test/smoke.mjs
node scripts/demo-loop.mjs
pnpm audit --prod
pnpm audit
```

Review both audit scopes. Electron, the test runner and the packaging tools are
declared as development dependencies, so a clean production-only audit does not
cover the desktop runtime or build pipeline. Resolve or explicitly assess each
advisory before trusting that pipeline with release credentials or artifacts.

The README screenshot is rendered from synthetic state by
`node scripts/screenshot.mjs` after building. It loads the actual panel without
starting the monitor or reading vendor directories. Its renderer blocks network
requests and uses temporary profile data. On first use, Electron may need to
download its runtime binary as part of dependency setup.

## History is a separate review

```sh
node scripts/repo-hygiene.mjs --history
```

The history scanner examines locally reachable file versions and commit messages.
It reports locations and categories, never matched values. It cannot detect all
account-derived figures or prove that a fixture was invented. It does not fetch
remote refs, inspect unreachable objects, OCR images, or inspect GitHub logs.

The pre-publication review found account-derived examples in historical design
documents, home-directory paths, and private project/session labels in regression
fixtures. Those values were replaced throughout reachable development history,
preserving the commit graph, attribution, timestamps and documentation sections.
A fresh clone of `main` passed the pattern scanner; the rewritten history also
passed a check for the known private values. This does not cover GitHub-managed
pull-request refs. Pattern checks remain an aid, not proof that every value is
synthetic.

**GitHub object cleanup remains separate.** After the rewrite, GitHub still served
an old sensitive document when addressed by its original commit ID. A force-push
does not purge cached views or unreachable server objects. Closed automated
update PRs created during the rewrite also retained old ancestry in read-only
`refs/pull/*` refs. Include those refs in the Support request: deleting a branch
or closing a PR does not remove its GitHub-managed history. Keep the repository
private until GitHub Support has handled the remaining objects and the old
document is no longer retrievable. Follow the
[sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

An alternative that does not wait for a server-side purge is to retain the
original repository as a private archive and publish the verified rewritten
history into a freshly created repository. This can preserve all sanitized
development commits; it need not be a single source snapshot. Push only the
reviewed branch/tag refs, never a mirror of the old remote's PR or internal refs.
Verify the new repository's identity and a fresh clone, and confirm that requests
for the old sensitive commit fail there before making it public.

The original Actions runs were archived privately and deleted with approval.
Recovery bundles and audit files under ignored `scratch/` contain the old private
history: never publish them. Other pre-rewrite clones must not merge or push old
history back into this repository.

For a repository that has not yet been sanitized, choose and review one approach:

- Preserve development history after a deliberate sanitization of every affected
  reachable branch and tag; verify a fresh clone of the intended public history.
- Publish a reviewed source snapshot with new history, keeping the development
  repository private. Include the license and contribution attribution.

Do not rewrite or force-push history as a side effect of a normal cleanup commit.
To prepare the snapshot option without changing this repository's history, run
`node scripts/export-source.mjs`. It creates `scratch/public-source` with a
SHA-256 manifest, excluding Git history and ignored local/build files. It refuses
to overwrite an existing export. Review this tree before initializing new history;
the export alone does not publish anything or replace the historical audit.

Review author/committer names and email addresses for intended public attribution.
Review tracked binary/design assets for metadata and screenshots for private text.
If actual credentials are discovered, removing them from Git is not revocation;
the owner must handle them through the issuer's normal credential-management flow.
Adjent and its agents must never run vendor OAuth refresh flows.

## GitHub review before visibility changes

- Audit remote-only branches/tags, PRs, issues, attachments, release assets,
  Actions history and logs for private information.
- Review repository description, default branch and the WIP README.
- Configure private vulnerability reporting and verify the link in SECURITY.md.
- Review Actions permissions and fork-PR behavior; keep publication credentials
  out of untrusted PR jobs.
- Set the intended branch protection/required checks and dependency alert policy.
- Inspect the final public history or snapshot, then change visibility explicitly.

GitHub makes Actions history and logs visible when a private repository becomes
public. See [GitHub's visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
and [private vulnerability reporting setup](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Installer validation remains separate

Before promoting a draft, test the actual Windows and Linux artifacts: launch,
tray, panel, settings, notifications, scaling, shutdown and restart. Unit tests
and a screenshot do not establish OS integration. Runtime upgrades must receive
the same validation; track Electron's [supported releases](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
and [security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
