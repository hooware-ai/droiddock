#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$droidRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $droidRoot 'config.local.json'
$config = [pscustomobject]@{}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  try { $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
  catch { throw 'Invalid config.local.json. Check the local configuration format.' }
  if ($config -isnot [pscustomobject] -or
      ($null -ne $config.deviceSerial -and $config.deviceSerial -isnot [string]) -or
      ($null -ne $config.adb -and $config.adb -isnot [string])) {
    throw 'Invalid config.local.json. Check the local configuration format.'
  }
}
$serial = if ($null -ne $env:DROIDDOCK_DEVICE_SERIAL) { $env:DROIDDOCK_DEVICE_SERIAL } else { [string]$config.deviceSerial }
if (-not $serial -or $serial -eq 'YOUR_DEVICE_SERIAL' -or $serial -cnotmatch '^[A-Za-z0-9]+$') {
  throw 'Set a valid permanent phone identity in config.local.json or DROIDDOCK_DEVICE_SERIAL.'
}
$adb = if ($null -ne $env:DROIDDOCK_ADB) { $env:DROIDDOCK_ADB } elseif ($null -ne $config.adb) { [string]$config.adb } else { 'adb' }
if (-not $adb.Trim()) { throw 'Set an ADB executable in config.local.json or DROIDDOCK_ADB.' }
if (-not (Get-Command $adb -ErrorAction SilentlyContinue)) { throw 'The configured ADB executable is unavailable.' }

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $sdk 'platforms\android-36') -PathType Container)) {
  throw 'Android SDK platform 36 is required to build the optional paste helper.'
}
$env:ANDROID_HOME = $sdk
if (-not $env:JAVA_HOME -and -not (Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'JDK 17 or newer is required to build the optional paste helper.'
}

$transports = @()
$devices = & $adb devices
if ($LASTEXITCODE -ne 0) { throw 'ADB could not list connected devices.' }
foreach ($line in $devices) {
  if ($line -notmatch '^([^\s]+)\s+device\s*$') { continue }
  $transport = $Matches[1]
  $identity = & $adb -s $transport shell getprop ro.serialno
  if ($LASTEXITCODE -eq 0 -and $identity.Trim() -ceq $serial) { $transports += $transport }
}
if ($transports.Count -ne 1) { throw 'Connect exactly one authorized transport for the configured phone, then retry.' }

$project = Join-Path $droidRoot 'android\paste-helper'
$wrapper = Join-Path $project 'gradlew.bat'
Push-Location $project
try {
  & $wrapper :assembleDebug --no-daemon --console=plain
  if ($LASTEXITCODE -ne 0) { throw 'The optional Android paste helper did not build.' }
} finally { Pop-Location }
$apk = Join-Path $project 'build\outputs\apk\debug\DroidDockPasteHelper-debug.apk'
if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw 'The paste helper APK was not produced.' }
& $adb -s $transports[0] install -r $apk | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The phone rejected the paste helper installation.' }
$installed = & $adb -s $transports[0] shell pm path ai.hooware.droiddock.paste
if ($LASTEXITCODE -ne 0 -or -not ($installed -match 'package:')) { throw 'The paste helper installation could not be verified.' }
Write-Output 'DroidDock paste helper installed on the configured phone.'
