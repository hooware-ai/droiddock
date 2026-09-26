import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const powershell = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8', windowsHide: true, timeout: 5000,
});
const hasPowerShell = powershell.status === 0;
const query = `. ./scripts/Pairing-Recovery.ps1
$sample = [Console]::In.ReadToEnd() | ConvertFrom-Json
Get-DroidDockRecoveryHint -DevicesText $sample.devices -DevicesExitCode $sample.devicesCode -ServicesText $sample.services -ServicesExitCode $sample.servicesCode -Serial $sample.serial`;

function hint(overrides = {}) {
  const sample = {
    serial: 'SYNTHETICPHONE', devices: 'List of devices attached', devicesCode: 0, servicesCode: 0,
    services: 'List of discovered mdns services\n  adb-SYNTHETICPHONE-x _adb-tls-connect._tcp 192.0.2.10:37001\n  adb-guid-y _adb-tls-pairing._tcp 192.0.2.10:37002',
    ...overrides,
  };
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', query], {
    input: JSON.stringify(sample), encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  assert.equal(result.status, 0, 'parser must finish without PowerShell errors');
  assert.equal(result.stderr, '');
  return result.stdout.trim();
}

test('matching pairing advertisement is only a candidate, with no endpoint in output', { skip: !hasPowerShell }, () => {
  assert.equal(hint(), 'candidate');
});

test('missing, ambiguous, contradictory, and failed ADB evidence stays unknown', { skip: !hasPowerShell }, () => {
  assert.equal(hint({ services: 'List of discovered mdns services' }), 'unknown');
  assert.equal(hint({ services: 'adb-SYNTHETICPHONE-x _adb-tls-connect._tcp 192.0.2.10:37001\nadb-guid-y _adb-tls-pairing._tcp 192.0.2.11:37002' }), 'unknown');
  assert.equal(hint({ services: 'adb-SYNTHETICPHONE-x _adb-tls-connect._tcp 192.0.2.10:37001\nadb-guid-y _adb-tls-pairing._tcp 192.0.2.10:37002\nadb-other-z _adb-tls-pairing._tcp 192.0.2.10:37003' }), 'unknown');
  assert.equal(hint({ services: 'adb-SYNTHETICPHONE-x _adb-tls-connect._tcp 192.0.2.10:37001\nadb-SYNTHETICPHONE-z _adb-tls-connect._tcp 192.0.2.10:37004\nadb-guid-y _adb-tls-pairing._tcp 192.0.2.10:37002' }), 'unknown');
  assert.equal(hint({ devices: 'SYNTHETICPHONE unauthorized' }), 'unknown');
  assert.equal(hint({ devices: 'SYNTHETICPHONE device usb:1-1' }), 'unknown');
  assert.equal(hint({ devicesCode: -1 }), 'unknown');
  assert.equal(hint({ servicesCode: -1 }), 'unknown');
  assert.equal(hint({ services: 'adb-SYNTHETICPHONE-x _adb-tls-connect._tcp 192.0.2.10:37001\nadb-guid-y _adb-tls-pairing._tcp 192.0.2.10:99999' }), 'unknown');
});
