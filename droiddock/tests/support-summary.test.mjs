import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { formatSupportSummary } from '../../scripts/support-summary.mjs';
import { runDiagnosticCli } from '../../scripts/Test-DroidDock.mjs';

const baseline = () => ({
  app: 'DroidDock',
  diagnosticVersion: 1,
  liveRequested: false,
  ok: true,
  checks: [
    { name: 'node', ok: true, version: '24.11.1' },
    { name: 'configuration', ok: true },
    { name: 'vendor', ok: true, version: '4.1' },
    { name: 'build', ok: true },
    { name: 'adb', ok: true, version: '1.0.41' },
    { name: 'powershell', ok: true, major: 7 },
    { name: 'device', ok: true, permanentIdentityVerified: true },
  ],
});

test('summary has a fixed, compact Markdown layout and labels packet evidence accurately', () => {
  const report = baseline();
  const expected = [
    '# DroidDock support summary',
    '',
    'Diagnostic schema: 1',
    '',
    '| Check | Result | Tool version |',
    '| --- | --- | --- |',
    '| Node.js | Passed | 24.11.1 |',
    '| Configuration | Passed | — |',
    '| Pinned scrcpy server | Passed | 4.1 |',
    '| Build and dependencies | Passed | — |',
    '| ADB | Passed | 1.0.41 |',
    '| PowerShell | Passed | 7 |',
    '| Configured phone | Passed | — |',
    '| Live stream packets | Not requested | — |',
    '',
    'A live check observes stream packets; it does not prove video rendered in a browser.',
    'Review this summary before sharing. DroidDock does not upload or copy it automatically.',
  ].join('\n');
  assert.equal(formatSupportSummary(report), expected);
  report.liveRequested = true;
  report.checks.push({ name: 'live', ok: true, mode: 'existing-session', packetsAdvanced: 3 });
  assert.match(formatSupportSummary(report), /\| Live stream packets \| Passed \| — \|/);
  assert.doesNotMatch(formatSupportSummary(report), /video rendered.*Passed/i);
  assert.ok(formatSupportSummary(report).length < 1024);
});

test('failures, skipped prerequisites, and requested live failures stay distinct', () => {
  const missingConfig = baseline();
  missingConfig.ok = false;
  missingConfig.liveRequested = true;
  missingConfig.checks = missingConfig.checks.filter(item => !['adb', 'powershell', 'device'].includes(item.name));
  missingConfig.checks.find(item => item.name === 'configuration').ok = false;
  missingConfig.checks.push({ name: 'live', ok: false, message: 'PRIVATE DIAGNOSTIC OUTPUT' });
  const text = formatSupportSummary(missingConfig);
  assert.match(text, /\| Configuration \| Failed \| — \|/);
  assert.match(text, /\| ADB \| Skipped \| — \|/);
  assert.match(text, /\| PowerShell \| Skipped \| — \|/);
  assert.match(text, /\| Configured phone \| Skipped \| — \|/);
  assert.match(text, /\| Live stream packets \| Skipped \| — \|/);
  assert.doesNotMatch(text, /PRIVATE/);

  const failedAdb = baseline();
  failedAdb.ok = false;
  failedAdb.checks.find(item => item.name === 'adb').ok = false;
  failedAdb.checks = failedAdb.checks.filter(item => item.name !== 'device');
  assert.match(formatSupportSummary(failedAdb), /\| Configured phone \| Skipped \| — \|/);

  const failedPowerShell = baseline();
  failedPowerShell.ok = false;
  failedPowerShell.checks.find(item => item.name === 'powershell').ok = false;
  failedPowerShell.checks = failedPowerShell.checks.filter(item => item.name !== 'device');
  assert.match(formatSupportSummary(failedPowerShell), /\| PowerShell \| Failed \| — \|/);
  assert.match(formatSupportSummary(failedPowerShell), /\| Configured phone \| Skipped \| — \|/);

  const failedLive = baseline();
  failedLive.ok = false;
  failedLive.liveRequested = true;
  failedLive.checks.push({ name: 'live', ok: false, message: 'PRIVATE PATH' });
  assert.match(formatSupportSummary(failedLive), /\| Live stream packets \| Failed \| — \|/);
});

test('contradictory overall and prerequisite results cannot claim dependent checks passed', () => {
  const overall = baseline();
  overall.ok = false;
  const overallText = formatSupportSummary(overall);
  assert.doesNotMatch(overallText, /\| .* \| Passed \|/);

  const configuration = baseline();
  configuration.ok = false;
  configuration.checks.find(item => item.name === 'configuration').ok = false;
  const configurationText = formatSupportSummary(configuration);
  assert.match(configurationText, /\| Configuration \| Failed \| — \|/);
  assert.match(configurationText, /\| ADB \| Unknown \| — \|/);
  assert.match(configurationText, /\| PowerShell \| Unknown \| — \|/);
  assert.match(configurationText, /\| Configured phone \| Unknown \| — \|/);
});

test('private markers in allowed and extra fields cannot enter the summary', () => {
  const report = baseline();
  report.checks[0].version = '24.11.1\nPRIVATE_EMAIL';
  report.checks[2].version = '[PRIVATE_LINK](https://example.invalid)';
  report.checks[4].version = '1.0.41|PRIVATE_TABLE';
  report.checks[5].major = '7PRIVATE';
  report.checks[6].serial = 'PRIVATE_SERIAL';
  report.checks[1].message = 'PRIVATE_EXCEPTION';
  report.configurationId = 'PRIVATE_ID';
  report.checks.push({ name: 'unknown', ok: true, output: 'PRIVATE_OUTPUT' });
  const text = formatSupportSummary(report);
  assert.doesNotMatch(text, /PRIVATE|example\.invalid/);
  assert.match(text, /\| Node.js \| Unknown \| — \|/);
  assert.match(text, /\| Pinned scrcpy server \| Unknown \| — \|/);
  assert.match(text, /\| ADB \| Unknown \| — \|/);
  assert.match(text, /\| PowerShell \| Unknown \| — \|/);
});

test('missing, duplicate, malformed, or contradictory rows never become passed', () => {
  const report = baseline();
  report.checks = report.checks.filter(item => item.name !== 'vendor');
  assert.match(formatSupportSummary(report), /\| Pinned scrcpy server \| Unknown \| — \|/);
  report.checks.push({ name: 'node', ok: true, version: '24.11.1' });
  assert.match(formatSupportSummary(report), /\| Node.js \| Unknown \| — \|/);
  report.checks.find(item => item.name === 'build').ok = 'true';
  assert.match(formatSupportSummary(report), /\| Build and dependencies \| Unknown \| — \|/);
  report.liveRequested = true;
  report.checks.push({ name: 'live', ok: true, mode: 'temporary-session', frames: 0 });
  assert.match(formatSupportSummary(report), /\| Live stream packets \| Unknown \| — \|/);
  report.checks.push({ name: 'extra', ok: true });
  assert.doesNotMatch(formatSupportSummary(report), /\| .* \| Passed \|/);
  assert.match(formatSupportSummary(null), /No completed diagnostic result is available/);
});

test('summary CLI formats one result, preserves JSON and exit codes, and never starts live checks implicitly', async () => {
  const report = baseline();
  const calls = [];
  const diagnose = async options => { calls.push(options); return report; };
  const summary = await runDiagnosticCli(['--support-summary'], diagnose);
  assert.equal(summary.exitCode, 0);
  assert.match(summary.output, /^# DroidDock support summary/);
  assert.deepEqual(calls, [{ live: false }]);
  const json = await runDiagnosticCli(['--json'], diagnose);
  assert.equal(json.output, JSON.stringify(report, null, 2));
  assert.equal(json.exitCode, 0);
  const defaultJson = await runDiagnosticCli([], diagnose);
  assert.equal(defaultJson.output, json.output);
  assert.equal(defaultJson.exitCode, json.exitCode);
  const invalid = await runDiagnosticCli(['--json', '--support-summary'], diagnose);
  assert.equal(invalid.exitCode, 2);
  const help = await runDiagnosticCli(['--help', '--support-summary'], diagnose);
  assert.equal(help.exitCode, 0);
  assert.equal(calls.length, 3, 'invalid and help modes do not diagnose');
  const live = await runDiagnosticCli(['--live', '--support-summary'], diagnose);
  assert.deepEqual(calls.at(-1), { live: true });
  assert.equal(live.exitCode, 0);
  const failure = await runDiagnosticCli(['--support-summary'], async () => { throw new Error('PRIVATE_ERROR'); });
  assert.equal(failure.exitCode, 1);
  assert.match(failure.output, /No completed diagnostic result is available/);
  assert.doesNotMatch(failure.output, /PRIVATE_ERROR/);
});

test('invoked CLI emits bounded Markdown without private configuration on failure', async () => {
  const child = spawn(process.execPath, ['scripts/Test-DroidDock.mjs', '--support-summary'], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, DROIDDOCK_DEVICE_SERIAL: 'PRIVATE INVALID SERIAL' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(stderr, '');
  assert.match(stdout, /^# DroidDock support summary/);
  assert.match(stdout, /\| Configuration \| Failed \| — \|/);
  assert.match(stdout, /\| Configured phone \| Skipped \| — \|/);
  assert.match(stdout, /\| Live stream packets \| Not requested \| — \|/);
  assert.doesNotMatch(stdout, /PRIVATE INVALID SERIAL/);
  assert.ok(stdout.length < 1024);
});
