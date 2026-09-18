# Setup troubleshooting examples

Short, synthetic walkthroughs for the three setup failures newcomers hit most often.
Placeholders only — no real serials, paths, or hostnames.

These complement the recovery table in [SETUP.md](SETUP.md). After each fix, rerun:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-DroidDock.ps1
```

## 1. USB device shows `unauthorized`

**Symptom.** Setup exits `needs_action`. ADB lists the phone but not as authorized:

```text
List of devices attached
DEVICE_SERIAL_HERE    unauthorized
```

**Cause.** USB debugging is on, but this PC has not been approved on the phone (or a prior trust entry was revoked).

**Fix.** Unlock the phone, accept the **Allow USB debugging?** prompt, optionally check **Always allow from this computer**, then rerun the installer. Prefer a data cable over charge-only.

## 2. Missing PowerShell 7 or ADB on PATH

**Symptom.** Installer reports a dependency blocker, or manual checks fail:

```text
pwsh : The term 'pwsh' is not recognized...
adb : The term 'adb' is not recognized...
```

**Cause.** PowerShell 7 (`pwsh`) and/or Android platform-tools are not installed, or their install locations are not on PATH. `-SkipDependencyInstall` makes this a hard stop.

**Fix.** Rerun the installer **without** `-SkipDependencyInstall` so WinGet can install `Microsoft.PowerShell` and `Google.PlatformTools`, **or** install those packages yourself and open a new terminal so PATH updates. Confirm with `pwsh -NoProfile -Command "$PSVersionTable.PSVersion"` and `adb version`.

## 3. Wireless debugging will not reconnect

**Symptom.** After a Wi-Fi change or idle period, ADB no longer shows the phone:

```text
List of devices attached
```

(empty), or `adb connect` fails with `Connection refused` / `failed to connect to PHONE_IP:PORT`.

**Cause.** Wireless debugging pairing/connection ports are short-lived. The old connection port is stale, or the phone and PC left the same LAN.

**Fix.** Confirm both devices are on the same network. On the phone open **Developer options → Wireless debugging**, note the **current** connection endpoint (not the pairing port), then:

```powershell
& '<ADB executable path>' connect '<phone-ip>:<connection-port>'
```

If connect still fails, use **Pair device with pairing code** once in a private terminal (`adb pair`), type the code at the prompt (never in chat or logs), then `adb connect` with the connection port from the main Wireless debugging screen. Rerun setup after the device shows `device`.
