# Public release procedure

Release from the standalone public repository. Do not publish a private checkout, its `.git` directory, or an archive made by zipping a working directory. Public Git history, author and committer metadata, tag metadata, branch names, remote URLs, file paths, and source text all need review. Original release attribution is **Hooware <hooware-ai@users.noreply.github.com>**.

## Check the proposed content

Stage the exact intended public files, then run:

```powershell
npm ci --ignore-scripts
npm run verify
npm run check:secrets
```

The public check reads Git index blobs, including staged content that differs from the working tree. It also scans every reachable commit tree and commit/reference metadata. Use a full clone: shallow repositories are rejected because their history is incomplete (CI checkouts need `fetch-depth: 0`). Git replacement objects are disabled during inspection. No network, Android device, service launch, or additional dependency is needed for this checker. Normal mode permits contributor names and emails in commit/tag attribution; it still rejects personal emails in original source files and any configured private deny patterns anywhere inspected. The offline tests use temporary Git repositories and synthetic identities.

`npm run verify` builds TypeScript, runs the offline tests, checks the public index/history, and checks local documentation links. `npm run check:secrets` separately runs checksum-pinned Gitleaks against an export of the exact staged blobs and committed history; its first run downloads the pinned scanner. Run it again after committing the final source. To scan an exported source directory, use `npm run check:secrets -- --directory <exported-source>`. The built-in public checker alone does not run Gitleaks. Neither command launches the phone service. Normal checks accept credential-free HTTPS or SSH GitHub fork remotes for contributors; private deny patterns still apply to remote names and both configured and effective fetch/push URLs.

The release path allowlist is maintained in `scripts/check-public.mjs`. It includes source, scripts, tests, public docs, selected GitHub templates/workflows, package metadata, and `config.example.json`. It rejects local configuration, `.env` files, build output, dependency installations, logs, screenshots, unknown binary files, symlinks, and submodules. New public file types require deliberate review and an allowlist change. Keep the vendor server and license byte-identical; their SHA-256 hashes are pinned in the checker. Their upstream notices are preserved, rather than replaced with company attribution.

Built-in text checks cover common credential formats, private-key headers, literal credential assignments, personal email addresses, and concrete home-directory paths. Examples must use reserved example domains and placeholders such as `C:\Users\<user>\work` or `/home/<user>/work`. Only the exact company noreply address is exempt from the email rule in original files.

Names, usernames, handles, device identifiers, and proprietary values cannot be inferred reliably. Supply a private list of case-insensitive literal deny strings (at least three characters each), either as `DROIDDOCK_PUBLIC_DENY_JSON`, a JSON array in the process environment, or as `DROIDDOCK_PUBLIC_DENY_FILE`, an absolute path to a JSON array **outside this checkout**. Both lists are combined when provided. Keep this list out of Git and do not put private values in command lines, CI output, examples, or issue reports. Configure the environment through your private local workflow. Findings show file paths and rule names, never matching text; paths containing matched private values are redacted. The checker reports generic errors rather than Git stderr that might contain private machine paths.

These are conservative safeguards, not proof that arbitrary secrets or identifying prose are absent. Review the staged diff and all intended public history manually, and use an independent secret scanner when preparing publication. A failure in an old commit requires rebuilding the public history from reviewed content; deleting a current file does not clear historical findings. Coordinate any already-published history repair separately.

## First public commit

Initialize a fresh repository from reviewed source, without carrying over private Git history. Configure its local author identity before the first commit:

```powershell
git config user.name Hooware
git config user.email hooware-ai@users.noreply.github.com
```

After making the intended public commit, run:

```powershell
node scripts/check-public.mjs --initial-release
```

This additional gate requires exactly one reachable commit, and checks that its author and committer use the company identity above. Annotated tags must also use the company identity. It intentionally fails before the first commit and after a second commit. It cannot detect history retained only as unreachable objects; never distribute `.git` or push private references. Initial-release checks and all packaging runs require every configured fetch and push remote to point to `hooware-ai/droiddock` on GitHub over HTTPS or SSH, or have no remotes at all. Contributor fork remotes are accepted only in ordinary development checks.

After the initial publication, normal development and pull requests use the ordinary check, which allows legitimate contributor attribution. Supply private deny patterns in both modes whenever a release must exclude specific identities.

## Activate the public repository

Git author and committer fields are separate from the GitHub account that pushes commits, creates releases, signs tags, or triggers workflows. The company Git identity does not hide that account's public attribution. Before publication, review the signed-in publishing account, linked profile and email attribution, signing identity, and the public author shown for releases and workflow activity. Use only the account and attribution approved for publication.

Repository files cannot activate GitHub settings. When publication is authorized, complete and verify these settings on the public repository:

- Protect `main` with a branch rule or ruleset requiring pull requests, maintainer review, and successful Windows and Linux Verify checks before merge. Confirm the exact check names after their first successful run. Block force pushes and branch deletion, and review who can bypass the rule.
- Enable private vulnerability reporting and verify that the private reporting link in [SECURITY.md](../SECURITY.md) is available to eligible reporters. Keep the policy's fallback instructions if a reporter cannot access it; never request exploit details in a public issue.
- Confirm Actions permissions, enabled security/dependency features, default branch, release permissions, and the intended public account attribution. Review the first CI run and ensure required checks actually gate a proposed change.

Record which settings are configured and which have been verified. A written policy, a workflow file, or a successful local check does not establish that repository protection or private reporting is active.

## Build a reproducible source archive

Before tagging, move the [CHANGELOG](../CHANGELOG.md) entries that the release contains from **Unreleased** to a new `## <version> - <date>` section. Check each cited pull request against `git log <previous-tag>..HEAD`; later changes stay under **Unreleased**. Commit that change as part of the release commit.

From a clean, committed checkout:

```powershell
npm run release:package
```

For the first public release, run `npm run release:package -- --initial-release`. The packager reruns the public checks, enforces canonical release remotes, and creates:

```text
artifacts/releases/droiddock-<version>-<commit-prefix>/
  droiddock-<version>-<commit-prefix>.zip
  manifest.json
  SHA256SUMS
```

The archive is made by `git archive` from the exact full `HEAD` commit ID, with a single named top-level directory. It contains tracked source/docs/vendor files only, not `.git`, local settings, `node_modules`, or `dist`. Ignored files may remain on disk; they never enter the archive. Any staged, unstaged, or untracked nonignored files block packaging. Builds are checked separately and are not shipped as prebuilt JavaScript.

The archive uses uncompressed ZIP entries and the Git commit timestamp, avoiding differences between compression-library versions. The manifest records the full commit ID and each file's relative path, byte count, and SHA-256. `SHA256SUMS` covers the ZIP and manifest. Every actual ZIP file is compared byte-for-byte with the committed Git blob; export substitutions, omissions, or unexpected files fail. Release attributes cannot use `export-ignore` or `export-subst`.

Output is restricted to the checkout's ignored `artifacts/releases` directory. The packager rejects symlink output directories and refuses to overwrite an existing release directory. To reproduce the same release, use a separate clean checkout of the same commit, then compare the ZIP, manifest, and checksum bytes. Retain the original artifacts as evidence.

Review the manifest, final archive, licenses, release notes, and checksums before uploading. A successful offline release check establishes neither live phone/video compatibility nor authorization to publish. Follow the project's publication approval process separately.
