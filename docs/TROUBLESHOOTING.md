# Setup troubleshooting examples

These examples use generic placeholders and show only the relevant status fields. Your local output may include device details or paths; review it before sharing. Run the installer from the repository root after each correction:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DroidDock.ps1
```

## USB phone appears unauthorized

**Symptom:** Setup reports `status: needs_action`, `stage: authorize_phone`, and asks you to unlock the phone and approve USB debugging. `adb devices` may show `<transport-id> unauthorized`.

**Cause:** The phone has not authorized this computer for ADB. An `unauthorized` transport is not an eligible phone for DroidDock.

**Fix:** Unlock the intended phone, check its USB debugging prompt, and approve only this trusted computer. If the prompt does not appear, confirm USB debugging is enabled and reconnect a data-capable cable. Rerun the installer. Do not select a different phone merely because it is authorized.

## PowerShell 7 or ADB is missing

**Symptom:** The installer reports `status: error`, `stage: prerequisites`, with a message such as `Missing prerequisite Microsoft.PowerShell`, `PowerShell 7 could not be located after installation`, `Missing prerequisite Google.PlatformTools`, or `Configured ADB executable is missing`. This differs from Windows PowerShell 5.1, which can start the installer but does not replace the required `pwsh` runtime.

**Cause:** A required tool is absent, its installation was blocked, or the configured ADB path no longer points to an executable.

**Fix:** If you used `-SkipDependencyInstall`, rerun without it so the installer can install missing tools through WinGet. Otherwise resolve the reported WinGet policy or installation error and rerun. For an existing ADB installation, point the installer to that executable instead of overwriting local configuration:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DroidDock.ps1 -AdbPath '<ADB executable path>'
```

The path must identify `adb.exe`, not its containing directory. If a configured path is stale, rerun with `-AdbPath` or repair that path in the ignored `config.local.json` after reviewing the file. Do not publish its contents.

## Wireless phone does not reconnect

**Symptom:** Setup reports `status: needs_action`, `stage: configured_phone_unreachable` after a previously paired phone changes network or wireless-debugging endpoint. A saved connection endpoint is not a permanent phone identity.

**Cause:** The phone is offline, wireless debugging is off, the PC is on a different network, or the connection port has changed. DroidDock refuses to substitute another phone for the configured one.

**Fix:** Put the PC and intended phone on the same network, enable Wireless debugging on the phone, and rerun the installer so it can try discovery again. If discovery is unavailable, read the **current connection endpoint** from the phone's main Wireless debugging screen and connect with the installed ADB executable:

```powershell
& '<ADB executable path>' connect '<phone-ip>:<connection-port>'
```

Use the connection port, not the separate pairing port. Then rerun the installer; it verifies the permanent device identity before saving or controlling the phone. If pairing itself expired, follow the [private pairing procedure](SETUP.md#wireless-debugging-android-11) instead of placing a pairing code in a command, issue, or log. Do not restart shared ADB or remove unrelated device forwards to fix one phone.
