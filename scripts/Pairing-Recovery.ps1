# Pure parser for a conservative hint from one bounded ADB discovery sample.
function Get-DroidDockRecoveryHint {
  param(
    [string]$DevicesText,
    [int]$DevicesExitCode,
    [string]$ServicesText,
    [int]$ServicesExitCode,
    [string]$Serial
  )
  if ($DevicesExitCode -ne 0 -or $ServicesExitCode -ne 0) { return 'unknown' }
  # A listed transport that did not pass the discovery identity check is
  # contradictory, even when ADB calls it a usable device.
  if ($DevicesText -match ('(?m)^' + [regex]::Escape($Serial) + '\s+\S+')) { return 'unknown' }

  $connect = @()
  $pairing = @()
  $configured = '^adb-' + [regex]::Escape($Serial) + '-\S+\s+_adb-tls-connect\._tcp\.?\s+(\S+)\s*$'
  $pairingRow = '^\S+\s+_adb-tls-pairing\._tcp\.?\s+(\S+)\s*$'
  foreach ($line in ($ServicesText -split '\r?\n')) {
    $line = $line.Trim()
    $endpoint = $null
    if ($line -match $configured) { $endpoint = $Matches[1]; $kind = 'connect' }
    elseif ($line -match $pairingRow) { $endpoint = $Matches[1]; $kind = 'pairing' }
    else { continue }
    if ($endpoint -notmatch '^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$') { return 'unknown' }
    $address = $Matches[1]
    $port = [int]$Matches[2]
    $parsed = $null
    if ($port -lt 1 -or $port -gt 65535 -or
        -not [System.Net.IPAddress]::TryParse($address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $parsed.ToString() -cne $address) { return 'unknown' }
    if ($kind -eq 'connect') { $connect += $address }
    else { $pairing += $address }
  }
  if ($connect.Count -ne 1 -or $pairing.Count -ne 1) { return 'unknown' }
  if ($connect[0] -cne $pairing[0]) { return 'unknown' }
  return 'candidate'
}
