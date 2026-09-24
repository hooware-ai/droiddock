# Agent instructions for DroidDock

DroidDock by Hooware is a local browser interface for an authorized Android phone. Read [README.md](README.md) and the relevant guide before changing or installing it. No private knowledge base, personal plugin, or previous task is required.

## Setup requests

Treat a request to set up this repository as authorization for routine local installation, build, phone configuration, service launch, and browser verification. Read [docs/SETUP.md](docs/SETUP.md) first.

- Inspect the host and checkout. Clone only into an empty destination; preserve local edits and configuration. The supported setup host is Windows. Offline checks on another OS do not prove live host support.
- Run `scripts/Install-DroidDock.ps1` with Windows PowerShell 5.1 or newer. Read its result, resolve recoverable blockers, and rerun. Do not hand routine executable work back to the user.
- The user handles physical connection, phone-side authorization, ambiguous device selection, and platform approvals when needed. Never pick the first ADB row, a watch, or an emulator as the intended phone.
- Verify the permanent phone serial. Never configure a changing wireless endpoint as the identity. For an authorized pairing attempt, use a short-lived code supplied by the user in the current task without asking for duplicate entry. Prefer non-echo input to ADB and avoid repeating the code. Do not put it in process arguments, scripts, project files, persistent logs, Git, issues, or public reports. A tool invocation may be retained in the private task transcript, so do not claim that chat-supplied codes stay outside transcripts.
- Open the returned local URL in a compatible browser and click **Connect**. If the user requests Codex, use supported browser/panel tools as described in [docs/CODEX.md](docs/CODEX.md). Do not use private app databases or undocumented IPC.
- Inspect actual rendered phone video. HTTP readiness, connected status, packet counts, or canvas dimensions alone do not prove video display. State unverified steps explicitly.
- Do not perform consequential phone actions just to demonstrate control. Respect existing sessions; only move control when the user requested that phone view. Diagnostics must clean up their own temporary session.
- Report the URL, passed checks, and any blocker. Leave the requested working view open.

## Development rules

- Keep the browser UI and bridge separate from the unmodified scrcpy server. Pin vendor versions and verify SHA-256; preserve upstream licenses and provenance.
- Keep the service loopback-only and the browser control API structured. Do not add a general-purpose shell endpoint.
- Verify configured permanent device identity before control. Keep session cleanup scoped; never restart shared ADB or remove unrelated forwards as a shortcut.
- Keep device identities, usernames, email addresses, machine paths, local config, credentials, logs, and private screenshots out of tracked files and public reports. Use synthetic fixtures.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Do not publish a suspected vulnerability as an ordinary issue.
- After implementation changes, run `npm run typecheck`, `npm run build`, and `npm test`. Add meaningful regression coverage for behavior changes. Distinguish offline checks from Windows live-phone evidence.
- Keep changes focused and documentation accurate. AI assistance does not replace contributor accountability or maintainer review. Never claim tests, live checks, releases, or security guarantees without evidence.
