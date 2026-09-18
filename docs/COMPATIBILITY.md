# Compatibility

This page records what DroidDock has **actually been checked against**. Intended setup requirements are not a test matrix. Offline CI and packet diagnostics are not live Android or browser support.

No maintainer or volunteer live-phone result has been published yet. Treat every live Android version and every browser build as **untested** until a sanitized report is added here.

## How to read a result

Keep these layers separate. A later layer does not inherit a pass from an earlier one.

| Evidence | What it can show | What it cannot show |
| --- | --- | --- |
| Offline suite and CI | Protocol framing, structured controls, HTTP/WebSocket boundaries, ownership, setup helpers, diagnostics, and publication checks on the runner | That a phone streamed, that a browser decoded frames, or that Linux/macOS live setup works |
| Packet diagnostic (`node scripts/Test-DroidDock.mjs --live`) | That an authorized Windows host received session metadata and advancing media packets | That video appeared on a canvas, or that input, rotation, reconnect, or handoff worked |
| Live browser check | That a person inspected rendered phone video and named controls on a synthetic screen | Implied success from a Connected label, packet counts, or canvas size alone |

Use **Pass**, **Fail**, or **Not run** for each live column. Do not infer Pass from a different column.

## Intended setup (not a tested matrix)

These are the project's documented requirements and client checks. They describe what DroidDock asks for, not phones or browsers that have been proven to work.

| Area | Documented requirement | Live DroidDock evidence |
| --- | --- | --- |
| Host | Windows is the supported live host. The installer starts in Windows PowerShell 5.1+ and installs or reuses Node.js 24+ and PowerShell 7 for setup/discovery. | Not established. Linux/macOS are not supported for live setup. |
| Phone | An authorized Android phone with USB debugging. Setup selects by permanent serial and excludes watches, TVs, automotive devices, and emulators from automatic selection. | No published Android version, OEM, or connection result. |
| USB | The documented first connection. | Not run in a published report. |
| Wireless debugging | Android 11 or newer; pairing uses a private local ADB prompt. The wireless endpoint is not the device identity. | Not run in a published report. |
| Upstream device server | Unmodified [scrcpy 4.1](https://github.com/Genymobile/scrcpy/blob/v4.1/README.md) documents Android 5.0 (API 21) as its own device prerequisite. | That floor is scrcpy's claim, not a DroidDock live result. |
| Browser | A Chromium browser that exposes WebCodecs `VideoDecoder` and `EncodedVideoChunk`. The client refuses to connect without them, probes `VideoDecoder.isConfigSupported` for the phone's H.264 configuration before decoding, and names current Chrome or Edge on localhost. | No published Chrome, Edge, or other browser result. |
| Other browsers | Firefox, Safari, and non-Chromium engines are not a documented live target. | Not run; do not assume support or incompatibility. |
| Codex panel | Optional. The same local page can open in a supported local Codex browser panel. | Not a substitute for a named standalone-browser result. |

Current encoder settings are a maximum dimension of 1280 pixels, up to 60 fps, and 6 Mbps H.264. Those are session settings, not a performance or compatibility guarantee.

## Automated checks

The [Verify](../.github/workflows/verify.yml) workflow is the project's published automated coverage. It uses Node.js 24 on GitHub-hosted `ubuntu-latest` and `windows-latest` runners and runs `npm ci --ignore-scripts --no-fund`, `npm run verify`, `npm audit --audit-level=high`, and `npm run check:secrets`. `npm run verify` builds TypeScript, runs the offline Node test suite, checks publication rules, and checks in-repo documentation links.

| Workflow | Runners | What ran | Android | Browser video or input |
| --- | --- | --- | --- | --- |
| Verify | `ubuntu-latest`, `windows-latest` | Offline verify, high-severity audit, secret scan | Not run | Not run |
| Package release candidate | `ubuntu-latest` | Same offline verify path, then source packaging | Not run | Not run |
| CodeQL | `ubuntu-latest` | Static analysis of JavaScript/TypeScript | Not run | Not run |

Passing Verify on Linux does not establish Linux host support. Passing Verify on a Windows runner does not establish installer, ADB, phone, or browser behavior.

The initial public changelog states that this source distribution does not include a live-phone compatibility matrix or a stable-release support promise.

## Live Android and browser matrix

Report only checks that were actually performed. Leave untested columns as **Not run**. Use a synthetic or otherwise non-private screen. Omit device serials, model names that identify a personal device, accounts, network addresses, machine paths, pairing codes, raw logs, and private screenshots.

| Host | Android | Connection | Browser | Revision | Rendered video | Input | Rotation | Reconnect | Handoff | Packet diagnostic | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | Not run | Not run | Not run | Not run | Not run | Not run | No published live-phone result yet. |

Column meanings:

- **Rendered video:** Phone frames were visible on the local page after Connect, not merely a Connected label or packet counters.
- **Input:** Harmless tap, drag, or scroll on a synthetic screen. Mention keyboard or paste only if those were tried.
- **Rotation:** Decoder recovered for the new video size after a rotation the tester actually performed.
- **Reconnect:** A new Connect after disconnect, closed tab, or a restored connection the tester actually performed.
- **Handoff:** Connect in a second DroidDock tab moved control; the previous tab became inactive.
- **Packet diagnostic:** Optional `Test-DroidDock.mjs --live` on the supported Windows host. Record it here so it is not mistaken for rendered video.

When a sanitized report is accepted, add a row with the repository revision (short SHA or version), Windows version, Android version, USB or wireless, and browser name plus version. Prefer a pull request that updates this table. One environment per row.

## How to report a result

1. Read [CONTRIBUTING.md](../CONTRIBUTING.md), [SETUP.md](SETUP.md), and [SUPPORT.md](../SUPPORT.md).
2. On a Windows host, install from the setup guide and open the returned loopback URL.
3. Use a synthetic screen. Do not perform consequential phone actions to demonstrate control.
4. Record each live column as Pass, Fail, or Not run. If a phone or browser is unavailable, say **Not run** and stop; do not infer a pass from CI or packet counts.
5. Open a GitHub issue with the [compatibility report](https://github.com/hooware-ai/droiddock/issues/new?template=compatibility.yml) template, or send a pull request that adds one matrix row.

Suggested issue body (placeholders only):

```text
Revision: <short SHA>
Host: Windows <version>
Node.js: <version>
Browser: <name> <version>
Android: <version>
Connection: USB | wireless

Rendered video: Pass | Fail | Not run
Input: Pass | Fail | Not run
Rotation: Pass | Fail | Not run
Reconnect: Pass | Fail | Not run
Handoff: Pass | Fail | Not run
Packet diagnostic: Pass | Fail | Not run

Notes: short sanitized detail. No serials, paths, addresses, or private screenshots.
```

Failures that include a minimal sanitized reproduction belong in a [bug report](https://github.com/hooware-ai/droiddock/issues/new?template=bug_report.yml). Do not paste `config.local.json`, full environment output, or raw diagnostic logs.
