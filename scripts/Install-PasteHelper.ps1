#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$droidRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $droidRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Configure DroidDock and the intended phone before installing the paste helper.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not $config.deviceSerial) { throw 'The configured permanent phone identity is missing.' }
$adb = if ($config.adb) { [string]$config.adb } else { 'adb' }
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
  if ($LASTEXITCODE -eq 0 -and $identity.Trim() -ceq [string]$config.deviceSerial) { $transports += $transport }
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
