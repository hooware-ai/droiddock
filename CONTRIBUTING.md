# Contributing to DroidDock

Thanks for helping make Android access from a local browser more useful and reliable. Small, focused changes are easiest to review. Read the [code of conduct](CODE_OF_CONDUCT.md) and [security policy](SECURITY.md) before participating.

## Choose work

Check existing [issues](https://github.com/hooware-ai/droiddock/issues) and the [roadmap](docs/ROADMAP.md). For a substantial feature or change to device access, discuss the proposed behavior in an issue first. A small bug fix or documentation correction can go straight to a pull request. Proposed roadmap items are not commitments or assigned work.

## Development setup

Install Node.js **24 or newer**, clone your fork, and run from the repository root:

```powershell
npm ci --ignore-scripts
npm run verify
```

Tests import built output; rebuild after TypeScript changes. `npm run test:droiddock` is an alias for `npm test`. Windows setup runs `npm run test:install` as its installation gate: every offline test except those listed in `publicationTests` in `scripts/install-tests.mjs`. List a new test file there only when it covers publication or release-packaging tooling that an installed service never uses. The offline suite does not require an Android device. Windows is the supported live host; follow [setup](docs/SETUP.md) for ADB, PowerShell, and phone authorization. Passing offline tests on Linux does not validate a live Linux installation.

Keep dependencies locked. Never commit `config.local.json`, `.env` files, logs, pairing codes, device serials, local usernames/paths, or private phone screenshots. Use synthetic fixtures and generic placeholder values. Review your full diff, including newly added files, before pushing.

## Implementation and validation

- Keep changes focused and preserve the repository's existing style. Avoid unrelated refactors.
- Add regression coverage for changed behavior, especially protocol parsing, session ownership, cancellation, cleanup, and request validation.
- Keep the browser control API structured and loopback-only. Do not add arbitrary command execution or weaken identity checks.
- Preserve upstream licenses, version pins, and checksum validation. See [architecture](docs/ARCHITECTURE.md) before changing scrcpy integration.
- Update user-facing documentation when behavior changes. Distinguish implemented features from proposals.

For changes to device/session behavior or video/control UI, also perform relevant live checks on a Windows host and an authorized test phone when available: rendered video, harmless tap/drag, keyboard and paste, rotation, disconnect/reconnect, closed-tab cleanup, handoff, and connection loss. Verify that session-owned ADB forwards are removed without disturbing unrelated resources. Use a test screen without private data.

Report exactly which checks you ran and their results. If a phone or platform is unavailable, mark the live check as **not run** and explain the gap; do not infer live success from mocked tests or packet counters. Maintainers decide which additional evidence is needed before merging. Use the table in [compatibility](docs/COMPATIBILITY.md) when recording Android and browser results.

## Pull requests and review

Describe the concrete problem, the resulting behavior, and relevant validation. Link an issue when one exists. Use the PR checklist and keep screenshots synthetic or clearly sanitized. Bug reproductions should contain the smallest useful example, not a raw diagnostic dump.

Maintainers review changes, validation, licensing, and privacy before merge. CI assists that review; it does not automatically approve a contribution. Expect revisions when the behavior or evidence is incomplete. No response or merge deadline is guaranteed.

AI-assisted contributions are welcome. You remain accountable for the code, explanation, test results, and provenance. Mention substantial AI assistance when it helps reviewers understand how the work was produced. Verify generated claims and dependencies; never upload secrets, private phone content, or other people's restricted material to an AI service as part of a contribution. Do not submit fabricated test results or claim a tool's approval as maintainer review.

By contributing original code, you agree it can be distributed under the repository's MIT license. Keep third-party material under its applicable license and provide attribution and provenance. Do not copy code you do not have permission to contribute.
