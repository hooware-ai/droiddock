# Support

Start with the [setup and recovery guide](docs/SETUP.md). Windows is the supported live host; a Chromium browser with WebCodecs support and an authorized Android phone are required. [Codex integration](docs/CODEX.md) is optional. The [compatibility notes](docs/COMPATIBILITY.md) record CI coverage and the live Android/browser matrix; they do not invent untested support.

For bugs, questions, and feature requests, use [GitHub issues](https://github.com/hooware-ai/droiddock/issues). Search for an existing report first. Community support is provided as available, with no response-time guarantee.

## Include useful, safe evidence

Provide the repository revision or version, Windows/Node/browser versions, USB or wireless connection type, expected behavior, actual behavior, and minimal reproduction steps. State whether the failure is during installation, phone discovery, stream connection, video rendering, or input. Distinguish offline test results from live-device checks.

**Do not post secrets or personal identifiers.** Exclude account names, email addresses, personal handles, device serials, local usernames, machine paths, network addresses, pairing codes, and private phone screenshots. Use generic placeholders such as `<device-serial>` and `<checkout>` where context is needed. Do not paste `config.local.json`, full environment output, or raw logs.

Diagnostics in the setup guide may help identify the failing step. For a compact starting point, run `node scripts/Test-DroidDock.mjs --support-summary` (add `--live` only if you want packet checks). Review that Markdown before sharing it. The command does not upload the summary or copy it to the clipboard. It is an allowlisted check-outcome report, not a rendered-video claim, and it is not a substitute for the versions, connection type, and reproduction steps above. Do not paste the raw JSON diagnostic, `config.local.json`, or logs instead. Reproduce on a neutral test screen if a screenshot is essential; do not rely on a small blur to remove private content from an otherwise private phone screen.

For suspected security vulnerabilities, stop and use [private security reporting](SECURITY.md). Do not include vulnerability details in an ordinary support issue.
