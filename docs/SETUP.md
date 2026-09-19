# Set up DroidDock

The supported host is **Windows**. Use a Chromium browser with WebCodecs support and an Android phone authorized for debugging. Codex is optional; the same local page works in a normal browser. Other operating systems are not supported for live setup by this runbook. Offline CI does not validate device discovery, video, or control on those hosts. [Compatibility](COMPATIBILITY.md) lists those requirements separately from checks that have actually been run.

## Install

From a new checkout of [hooware-ai/droiddock](https://github.com/hooware-ai/droiddock):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DroidDock.ps1
```

Run from the repository root. This entry point supports Windows PowerShell 5.1. The execution-policy argument applies only to this process; it does not change the saved machine policy.

The installer reuses compatible Node.js 24+, PowerShell 7 (`pwsh`), and ADB executables. When needed, it installs WinGet packages `OpenJS.NodeJS.LTS`, `Microsoft.PowerShell`, and `Google.PlatformTools`. Its WinGet calls accept source and package agreements. Package policy, elevation, or restart requirements can still need user action. Use `-SkipDependencyInstall` to require existing prerequisites. Installing desktop scrcpy is optional: DroidDock includes its pinned device server.

Setup installs locked npm dependencies, builds and checks the project, identifies the phone, creates or preserves ignored `config.local.json`, and launches the service. Open its returned URL and click **Connect**. The default port for a new configuration is 3210, but use the returned URL rather than assuming that port is free.

| Option | Purpose |
| --- | --- |
| `-DeviceSerial <serial>` | Select the intended phone by permanent Android serial; setup verifies it. |
| `-AdbPath <path>` | Use a particular ADB executable. Quote paths containing spaces. |
| `-Port <number>` | Choose a port from 1024 through 65535. |
| `-NoLaunch` | Prepare and validate installation without starting the service. |
| `-SkipDependencyInstall` | Require existing platform dependencies. Missing tools remain a blocker. |

The script calls `scripts/setup.mjs` once the runtime is available. Its structured result is `ready` (exit 0), `needs_action` (exit 2), or `error` (exit 1). Installation can also print progress. Read the result's detail/action fields; an interrupted or incomplete setup can be resumed by rerunning the same command. `ready` with `-NoLaunch` means prepared installation, not a running phone view.

Without an explicit port override, setup can choose a nearby free port. With an explicit port, an occupied port is an error to resolve. Never stop an unrelated service to make space.

## Authorize the intended phone

### USB

Enable Android Developer options and USB debugging, connect a data cable, unlock the phone, and accept this computer's debugging authorization on the phone. Only approve a computer you trust.

An `unauthorized` ADB entry needs phone approval; `offline` needs reconnection. No entry can indicate a charge-only cable, disabled debugging, or a missing device USB driver. Rerun setup after resolving the condition.

Setup selects eligible authorized phones by permanent identity. Multiple transports for the same permanent device are one phone. Watches and emulators are excluded from automatic selection. If there are multiple eligible phones, choose the intended one with `-DeviceSerial`; do not assume the first ADB entry is correct. An existing configuration must not silently switch to another phone because the saved phone is unreachable.

### Wireless debugging (Android 11+)

Put the PC and phone on the same network. On the phone, open **Developer options → Wireless debugging → Pair device with pairing code**. Use the displayed pairing endpoint in a private local terminal:

```powershell
& '<ADB executable path>' pair '<phone-ip>:<pairing-port>'
```

Type the short-lived code directly into ADB's prompt. Keep it out of command arguments, chat, captured terminal transcripts, logs, and tracked files. An agent must not capture the terminal while the code may be visible. If a private interactive prompt is unavailable, the user completes this one pairing step locally.

DroidDock discovers the paired phone's advertised connection endpoint by its permanent serial. If mDNS discovery is unavailable, use the separate connection endpoint shown on the main Wireless debugging screen:

```powershell
& '<ADB executable path>' connect '<phone-ip>:<connection-port>'
```

The pairing port and connection port differ and can change. Neither is the device identity. Rerun setup after connection. If pairing expires, repeat the private prompt flow. Do not restart shared ADB or disturb other devices to recover one phone.

## Configuration and launch

`config.local.json` is ignored by Git; [config.example.json](../config.example.json) shows its shape. It contains `deviceSerial`, optional `deviceName`, `adb`, and `port`. Use a generic device name if diagnostic output might be shared.

| Environment override | Meaning |
| --- | --- |
| `DROIDDOCK_DEVICE_SERIAL` | Permanent phone serial (required via config or environment). |
| `DROIDDOCK_DEVICE_NAME` | Display name, default `Android phone`. |
| `DROIDDOCK_ADB` | ADB executable, default `adb` from PATH. |
| `DROIDDOCK_PORT` | Local HTTP port, default 3210. |

Environment variables override saved configuration. A running process does not automatically reload changed settings; disconnect, stop that installation's service, and relaunch after a change.

```powershell
pwsh -NoProfile -File scripts/Start-DroidDock.ps1 -OpenBrowser
```

Omit `-OpenBrowser` to return the URL without opening the default browser. The foreground alternative is `npm run droiddock`, stopped with Ctrl+C. For optional Codex use, see [CODEX.md](CODEX.md).

## Verify what is working

Offline development checks require Node.js but no phone:

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

For installation/device diagnostics on the supported Windows host:

```powershell
node scripts/Test-DroidDock.mjs
node scripts/Test-DroidDock.mjs --live
node scripts/Test-DroidDock.mjs --support-summary
```

The baseline checks configuration, dependencies, build artifacts, vendor integrity, and phone reachability without starting video. `--live` adds packet verification. When idle, it uses a temporary service and phone session and cleans them up. When an active session exists, it observes advancing packet counters without taking control from the browser. Live checks stay opt-in; adding `--support-summary` only formats the same result and does not start extra device actions.

The diagnostic returns JSON with overall `ok` and individual checks: exit 0 for pass, 1 for failed checks, 2 for invalid arguments. These codes differ from the installer's `needs_action` result. `--json` keeps that JSON report. `--support-summary` prints a compact Markdown subset from an explicit allowlist: diagnostic schema/tool versions and named check outcomes (`passed`, `failed`, `skipped`, or `not requested`). It does not serialize leftover paths, serials, endpoints, installation or configuration identifiers, clipboard or screen content, raw subprocess output, or exception strings. Review the summary before sharing; the command does not upload it or copy it to the clipboard.

**Packet checks do not prove browser rendering.** Open the returned URL, select Connect, and inspect actual phone video. Use harmless navigation to check input only when authorized. Do not send a message, buy something, or change a sensitive setting as a test. Report offline checks, device connectivity, and rendered video separately. A disconnected phone leaves live setup incomplete even if all offline tests pass.

## Recovery

| Situation | Action |
| --- | --- |
| Interrupted install | Rerun the installer; preserve local configuration and edits. |
| WinGet blocked or unavailable | Resolve package-manager/platform requirements, or supply compatible installed tools. |
| No authorized phone | Resolve cable/debugging authorization or wireless pairing, then rerun. |
| Multiple phones | Select the intended permanent identity explicitly. |
| Saved phone unreachable | Reconnect it; do not substitute another device. |
| Invalid config | Repair invalid fields while preserving other settings. Do not blindly copy the example over it. |
| Occupied port | Choose a verified free port with `-Port`; use the returned URL. |
| Existing service uses different settings | Disconnect, close its controlling tab, stop only the verified installation, then relaunch. |
| Connected label but blank video | Check WebCodecs support, browser errors, and connectivity; reconnect and inspect rendered frames. |
| Phone open in another tab | Use that view, or deliberately click Connect in the requested new view to transfer control. |
| Wi-Fi interruption | Restore connectivity and click Connect again; discover current endpoints. |

Launcher logs are under `%LOCALAPPDATA%\DroidDock\<installationId>`. Keep logs, local config, device identities, network addresses, pairing material, and private phone screenshots out of public reports. Follow [SUPPORT.md](../SUPPORT.md) for sanitized reports.

## Disconnect, stop, and remove

Click **Disconnect** or close the controlling tab to end the phone session. The service remains available for reopening. Session cleanup targets its own temporary server, socket, and ADB tunnel. Do not use `adb kill-server`, delete all ADB forwards, or kill every Node/scrcpy process.

A foreground `npm run droiddock` process stops gracefully with Ctrl+C. For a background service, disconnect and close its controlling tab first. The idle service supports `POST /api/shutdown` with `X-DroidDock: 1`; verify that its installation/configuration IDs match this checkout before using it. Shutdown refuses while a controlling browser or phone session exists. If process termination is necessary, identify the exact Node command line for this checkout's `dist/droiddock/server.js` and its listener, and stop only that process. Recheck the listener and session-owned tunnel.

To remove DroidDock, stop the verified service, preserve any local work you need, and remove only its checkout and corresponding logs. Other installations may use the same log parent directory. There is no global uninstall script. Do not uninstall shared Node.js, PowerShell, ADB, or desktop scrcpy as part of removal. You may separately revoke this computer in the phone's debugging settings.

## Agent-assisted setup

Read [AGENTS.md](../AGENTS.md), inspect the host and checkout, and execute the same documented installer. Clone only into an empty destination; preserve dirty work and local configuration. Ask the user only for physical phone actions, ambiguous selection, private pairing, or required platform approvals. Complete routine setup and recovery directly, verify the actual browser view with supported tools, and report any missing verification explicitly.
