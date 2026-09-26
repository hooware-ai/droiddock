#requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9]+$')][string]$DeviceSerial,
  [Parameter(Mandatory)][string]$AdbPath,
  [ValidateRange(1, 600)][int]$WaitSeconds = 15,
  [switch]$ReportRecovery
)
$ErrorActionPreference = 'Stop'
$script:AdbPath = (Get-Command $AdbPath -ErrorAction Stop).Source
if ($ReportRecovery) { . (Join-Path $PSScriptRoot 'Pairing-Recovery.ps1') }
$script:RecoveryHint = 'unknown'

function Invoke-MirrorProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutMs = 5000
  )
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.WorkingDirectory = Split-Path -Parent $FilePath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  # Keep scrcpy and discovery on the same installed ADB binary.
  $start.Environment['ADB'] = $script:AdbPath
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMs)) {
      $process.Kill()
      $process.WaitForExit()
      return [pscustomobject]@{ ExitCode = -1; Text = 'Command timed out.' }
    }
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      Text = ($stdout.GetAwaiter().GetResult() + "`n" + $stderr.GetAwaiter().GetResult()).Trim()
    }
  } finally {
    $process.Dispose()
  }
}

function Invoke-MirrorAdb {
  param([string[]]$Arguments, [int]$TimeoutMs = 5000)
  Invoke-MirrorProcess -FilePath $script:AdbPath -Arguments $Arguments -TimeoutMs $TimeoutMs
}

function Get-MirrorDevices {
  param([string]$Text)
  foreach ($line in ($Text -split '\r?\n')) {
    if ($line -match '^(\S+)\s+device(?:\s|$)') {
      $transport = $Matches[1]
      $transport
    }
  }
}

function Get-MirrorEndpoints {
  param([string]$Text, [string]$Serial)
  $service = '^adb-' + [regex]::Escape($Serial) + '-\S+\s+_adb-tls-connect\._tcp\.?\s+(\S+)\s*$'
  foreach ($line in ($Text -split '\r?\n')) {
    if ($line -match $service) { $Matches[1] }
  }
}

function Find-MirrorDevice {
  param(
    [string]$Serial,
    [double]$TimeoutSeconds = 60,
    [int]$PollIntervalMs = 1500
  )
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  # Every ADB command shares the deadline, including stale/offline transports.
  $query = {
    param([string[]]$Command)
    $remaining = [int][Math]::Floor(($TimeoutSeconds * 1000) - $timer.Elapsed.TotalMilliseconds)
    if ($remaining -le 0) {
      return [pscustomobject]@{ ExitCode = -1; Text = '' }
    }
    Invoke-MirrorAdb -Arguments $Command -TimeoutMs ([Math]::Min(5000, $remaining))
  }
  $verify = {
    param([string]$Transport)
    $identity = & $query -Command @('-s', $Transport, 'shell', 'getprop', 'ro.serialno')
    $script:LastVerifyEvidence = if ($identity.ExitCode -eq -1) { 'timeout' } elseif ($identity.ExitCode -eq 0 -and $identity.Text.Trim() -cne $Serial) { 'mismatch' } else { 'other' }
    $identity.ExitCode -eq 0 -and $identity.Text.Trim() -ceq $Serial
  }
  do {
    $devices = & $query -Command @('devices', '-l')
    if ($devices.ExitCode -eq 0) {
      foreach ($transport in @(Get-MirrorDevices -Text $devices.Text)) {
        if (& $verify $transport) {
          return $transport
        }
      }
    }
    $services = & $query -Command @('mdns', 'services')
    if ($ReportRecovery) {
      $script:RecoveryHint = Get-DroidDockRecoveryHint -DevicesText $devices.Text -DevicesExitCode $devices.ExitCode -ServicesText $services.Text -ServicesExitCode $services.ExitCode -Serial $Serial
    }
    if ($services.ExitCode -eq 0) {
      foreach ($endpoint in @(Get-MirrorEndpoints -Text $services.Text -Serial $Serial | Select-Object -Unique)) {
        $connect = & $query -Command @('connect', $endpoint)
        if ($ReportRecovery -and $connect.ExitCode -eq -1) { $script:RecoveryHint = 'unknown' }
        if ($connect.ExitCode -eq 0) {
          if (& $verify $endpoint) { return $endpoint }
          if ($ReportRecovery -and $script:LastVerifyEvidence -in @('timeout', 'mismatch')) { $script:RecoveryHint = 'unknown' }
        }
      }
    }
    $remaining = [int][Math]::Floor(($TimeoutSeconds * 1000) - $timer.Elapsed.TotalMilliseconds)
    if ($remaining -gt 0 -and $PollIntervalMs -gt 0) {
      Start-Sleep -Milliseconds ([Math]::Min($PollIntervalMs, $remaining))
    }
  } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)
  throw "The configured phone could not be reached. Check USB authorization or paired wireless debugging; see README.md."
}


if ($ReportRecovery) {
  try {
    $transport = Find-MirrorDevice -Serial $DeviceSerial -TimeoutSeconds $WaitSeconds
    [pscustomobject]@{ transport = $transport; recovery = 'not-needed' } | ConvertTo-Json -Compress
  } catch {
    # Do not expose raw discovery output or identifiers to browser status.
    [pscustomobject]@{ transport = $null; recovery = $script:RecoveryHint } | ConvertTo-Json -Compress
  }
} else {
  Find-MirrorDevice -Serial $DeviceSerial -TimeoutSeconds $WaitSeconds
}
