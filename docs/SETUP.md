# Set up DroidDock

The supported host is **Windows**. Use a Chromium browser with WebCodecs support and an Android phone authorized for debugging. Codex is optional; the same local page works in a normal browser. Other operating systems are not supported for live setup by this runbook. Offline CI does not validate device discovery, video, or control on those hosts. [Compatibility](COMPATIBILITY.md) lists those requirements separately from checks that have actually been run.

## Install

From a new checkout of [hooware-ai/droiddock](https://github.com/hooware-ai/droiddock):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DroidDock.ps1
```

Run from the repository root. This entry point supports Windows PowerShell 5.1. The execution-policy argument applies only to this process; it does not change the saved machine policy.

The installer reuses compatible Node.js 24+, PowerShell 7 (`pwsh`), and ADB executables. When needed, it installs WinGet packages `OpenJS.NodeJS.LTS`, `Microsoft.PowerShell`, and `Google.PlatformTools`. Its WinGet calls accept source and package agreements. Package policy, elevation, or restart requirements can still need user action. Use `-SkipDependencyInstall` to require existing prerequisites. Installing desktop scrcpy is optional: DroidDock includes its pinned device server.

Setup installs locked npm dependencies, builds the project, runs its installation tests (`npm run test:install`, the offline suite without publication and release-packaging checks), identifies the phone, creates or preserves ignored `config.local.json`, and launches the service. Open its returned URL and click **Connect**. The default port for a new configuration is 3210, but use the returned URL rather than assuming that port is free.

| Option | Purpose |
| --- | --- |
| `-DeviceSerial <serial>` | Select the intended phone by permanent Android serial; setup verifies it. |
| `-AdbPath <path>` | Use a particular ADB executable. Quote paths containing spaces. |
| `-Port <number>` | Choose a port from 1024 through 65535. |
| `-NoLaunch` | Prepare and validate installation without starting the service. |
| `-SkipDependencyInstall` | Require existing platform dependencies. Missing tools remain a blocker. |

The script calls `scripts/setup.mjs` once the runtime is available. Its structured result is `ready` (exit 0), `needs_action` (exit 2), or `error` (exit 1). Installation can also print progress. Read the result's detail/action fields; an interrupted or incomplete setup can be resumed by rerunning the same command. An `error` with stage `offline_tests_failed` means an installation test failed; run `npm run test:install` in the checkout to see which one. Stage `offline_tests_timeout` means the tests did not finish within the time limit, for example on a busy computer; rerun setup when it is less busy. `ready` with `-NoLaunch` means prepared installation, not a running phone view.

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

Prefer typing the short-lived code directly into ADB's prompt. If the user has already supplied the code to an agent in the current task and authorized pairing, the agent may use it for that one attempt without asking for duplicate entry. Prefer non-echo input to ADB; do not place the code in command arguments, scripts, project files, persistent logs, Git, issues, or public reports. Avoid repeating or displaying it. A private task or tool transcript may retain a code supplied there, so do not promise transcript secrecy. If no code was supplied and a private input path is unavailable, the user completes this one pairing step locally.

DroidDock discovers the paired phone's advertised connection endpoint by its permanent serial. If mDNS discovery is unavailable, use the separate connection endpoint shown on the main Wireless debugging screen:

```powershell
& '<ADB executable path>' connect '<phone-ip>:<connection-port>'
```

The pairing port and connection port differ and can change. Neither is the device identity. Rerun setup after connection. If pairing expires, repeat pairing with a fresh code. Do not restart shared ADB or disturb other devices to recover one phone.

When a DroidDock connection fails, its status may report a `candidate` pairing service or `unknown` recovery evidence. A candidate is only an mDNS association with the configured phone's connect advertisement; DroidDock has not verified the permanent phone identity. An unavailable phone alone does not prove that pairing was lost. If you need to re-pair, open **Pair device with pairing code** on the physical phone, then select **Pair this computer** in the browser's connection error view. The panel checks for an endpoint once when opened and when you select **Refresh endpoint**; it does not keep scanning in the background. If no endpoint is found, type the phone's displayed pairing address and port. Contradictory advertisements cannot be overridden with a manual address. Enter the temporary six-digit code and explicitly select **Pair this computer**. The field clears on submit, cancel, panel closure, hidden tab, handoff, or disconnect. Do not share the code or a screenshot of the phone's pairing screen. The browser does not save or upload it; JavaScript and ADB cannot guarantee memory erasure. After identity verification, the page reconnects the same configured phone and reports success only after a frame is drawn. Pairing can succeed without video; check the separate error feedback and reconnect if needed. The private terminal steps above remain available if the panel or mDNS is unsupported.

## Optional direct image and file paste

Direct paste into a compatible focused Android app requires a small, optional DroidDock Android helper. Install it on the **configured phone** after normal setup. You need JDK 17 or newer and Android SDK platform 36 for the one-time build; the checked-in Gradle wrapper pins the build tool and verifies its download checksum, and [dependency verification](#helper-build-dependency-checksums) checks every build artifact it downloads. The helper is a debuggable local build because the bridge copies each explicitly pasted file into its private storage with Android's `run-as` command. It has no launcher screen and does not run a background service.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-PasteHelper.ps1
```

The script uses the same `DROIDDOCK_DEVICE_SERIAL` and `DROIDDOCK_ADB` environment overrides as the running app, then verifies that permanent phone identity before installation. Reinstall the helper after changing phones. In DroidDock, focus the phone screen and press Ctrl+V with one copied image/file, or choose **Paste file** in Details. The browser sends only that selected item, up to 16 MiB, to the local bridge. The bridge stages it temporarily, verifies the session's phone identity, copies it to helper-private storage, sets an Android content-URI clipboard item, and requests Android Paste in the currently focused app. A failed device-side cleanup remains pending in the running service and is retried on the verified phone before reconnecting. The browser reports when the paste gesture was sent, not whether the target app accepted it. If nothing appears, use that app's own attachment control. Ordinary text paste does not need this helper.

Android apps must implement rich-content receiving for a direct image/file paste to work. No manufacturer-specific branch is used, but other phones and target apps remain unverified. An explicitly pasted item replaces the phone clipboard; the helper retains up to four recent items and removes older items on a later paste. Uninstalling the helper removes its private files. No automatic clipboard watching or synchronization is enabled.

### Helper build dependency checksums

`android/paste-helper/gradle/verification-metadata.xml` pins a SHA-256 checksum for every artifact the helper build downloads: the Android Gradle Plugin, its build dependencies, and the host-specific `aapt2` tool for Windows, Linux, and macOS. `Install-PasteHelper.ps1` and CI build with `--dependency-verification strict`, so a missing or different checksum stops the build before anything is installed. Treat a verification failure as a possibly altered download: do not bypass it or install the result.

Signatures are not verified. Most Google Maven artifacts that make up the plugin publish no PGP signatures, so signature checks would cover only a small subset and add a trusted-key list to maintain. Like the Gradle distribution pin, the checksums are recorded on first download over HTTPS, and every change to them is visible in review. On 2026-09-27, all 35 entries under `com.android.tools.build` and `com.android.application` were independently compared with their official Google Maven `.sha256` sidecars; every value matched, including the plugin JAR and the Windows, Linux, and macOS `aapt2` JARs. The sidecar URL follows `https://dl.google.com/dl/android/maven2/<group-as-path>/<name>/<version>/<artifact>.sha256`. The other entries have not all been independently compared with publisher checksums.

Maintainers regenerate the file only for a deliberate plugin or build change, such as a Dependabot `gradle` pull request, which fails CI until then. From `android/paste-helper`, use a fresh Gradle user home so every artifact is downloaded again:

```powershell
$env:GRADLE_USER_HOME = Join-Path $env:TEMP ('droiddock-gradle-verify-' + [guid]::NewGuid().ToString('N'))
.\gradlew.bat --write-verification-metadata sha256 assembleDebug --rerun-tasks --no-daemon
```

`--rerun-tasks` makes the build resolve the task-time `aapt2` artifact. A Windows run records only the Windows `aapt2` jar; add the Linux and macOS jars for the same version from Google Maven, checking each download against Google's published `.sha1` file. Review the diff: every changed or added coordinate should follow from the intended upgrade. Then confirm that a clean strict build passes on Windows and in the CI `android-paste-helper` job.

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

The baseline checks configuration, dependencies, build artifacts, vendor integrity, and phone reachability without starting video. `--live` adds packet verification. When idle, it uses a temporary service and phone session and cleans them up. When an active session exists, it observes advancing packet counters without taking control from the browser.

The diagnostic returns JSON with overall `ok` and individual checks: exit 0 for pass, 1 for failed checks, 2 for invalid arguments. These codes differ from the installer's `needs_action` result. Review output before sharing it, even when individual checks redact identities.

`--support-summary` explicitly prints a compact Markdown table of fixed check outcomes and validated tool versions from that same diagnostic result. It omits paths, device identities, endpoints, raw command output, and error text. It does not write to the clipboard or upload anything. Review the summary yourself before sharing it. Add `--live` only when you intend to run the optional live packet check; the summary flag alone performs baseline checks only. `--json` and `--support-summary` cannot be combined. Output format does not change the diagnostic exit codes.

**Packet checks do not prove browser rendering.** Open the returned URL, select Connect, and inspect actual phone video. Use harmless navigation to check input only when authorized. Do not send a message, buy something, or change a sensitive setting as a test. Report offline checks, device connectivity, and rendered video separately. A disconnected phone leaves live setup incomplete even if all offline tests pass.

## Update an installation

A running service keeps the server code and browser page it started with, even after the checkout changes. Restart it after every update so both come from the same build:

1. Click **Disconnect** or close the controlling tab to finish the phone session.
2. Update the checkout, for example with `git pull --ff-only`.
3. Rerun `scripts/Install-DroidDock.ps1`. It installs dependencies, rebuilds, stops this installation's idle service, and relaunches it. With an active session it reports that and changes nothing.

The installer never reports an active session as updated: even a matching compiled `buildId` cannot prove that newly pulled source has been rebuilt. Finish the session and rerun the installer.

For a foreground service, stop `npm run droiddock` with Ctrl+C, then run `npm ci --ignore-scripts`, `npm run build`, and `npm run droiddock` again.

`/api/status` includes a `buildId`: a non-secret hash of the compiled server and the served browser files, like the installation and configuration identifiers. The launcher, `scripts/phone.mjs`, and `Test-DroidDock.mjs --live` compare it with the checkout. On a mismatch they report **Restart needed** and leave the running service and its session unchanged. Opening the phone view is refused; status and disconnect still work and include `restartNeeded: true`, so the session can be settled first. A service started before build identifiers existed is treated as a mismatch.

## Recovery

For concrete examples of USB authorization, missing tools, and wireless reconnects, see [troubleshooting](TROUBLESHOOTING.md).

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
| Restart needed (service from a different build) | Finish the phone session, then rerun the installer; see [update an installation](#update-an-installation). |
| Connected label but blank video | Check WebCodecs support, browser errors, and connectivity; reconnect and inspect rendered frames. |
| Phone open in another tab | Use that view, or deliberately click Connect in the requested new view to transfer control. |
| Wi-Fi interruption | Restore connectivity and click Connect again; discover current endpoints. |

Launcher logs are under `%LOCALAPPDATA%\DroidDock\<installationId>`. Keep logs, local config, device identities, network addresses, pairing material, and private phone screenshots out of public reports. Follow [SUPPORT.md](../SUPPORT.md) for sanitized reports.

## Disconnect, stop, and remove

Click **Disconnect** or close the controlling tab to end the phone session. The service remains available for reopening. Session cleanup targets its own temporary server, socket, and ADB tunnel. Do not use `adb kill-server`, delete all ADB forwards, or kill every Node/scrcpy process.

A foreground `npm run droiddock` process stops gracefully with Ctrl+C. For a background service, disconnect and close its controlling tab first. The idle service supports `POST /api/shutdown` with `X-DroidDock: 1`; verify that its installation/configuration IDs match this checkout before using it. Shutdown refuses while a controlling browser or phone session exists. If process termination is necessary, identify the exact Node command line for this checkout's `dist/droiddock/server.js` and its listener, and stop only that process. Recheck the listener and session-owned tunnel.

To remove DroidDock, stop the verified service, preserve any local work you need, and remove only its checkout and corresponding logs. Other installations may use the same log parent directory. There is no global uninstall script. Do not uninstall shared Node.js, PowerShell, ADB, or desktop scrcpy as part of removal. You may separately revoke this computer in the phone's debugging settings.

## Agent-assisted setup

Read [AGENTS.md](../AGENTS.md), inspect the host and checkout, and execute the same documented installer. Clone only into an empty destination; preserve dirty work and local configuration. Ask the user only for physical phone actions, ambiguous selection, pairing input not already supplied in the current task, or required platform approvals. Complete routine setup and recovery directly, verify the actual browser view with supported tools, and report any missing verification explicitly.
