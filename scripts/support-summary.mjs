const CHECKS = [
  ['node', 'Node.js'],
  ['configuration', 'Configuration'],
  ['vendor', 'Pinned scrcpy server'],
  ['build', 'Build and dependencies'],
  ['adb', 'ADB'],
  ['powershell', 'PowerShell'],
  ['device', 'Configured phone'],
  ['live', 'Live stream packets'],
];

const safeVersion = value =>
  typeof value === 'string' && value.length <= 20 && /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(value) ? value : null;

function entries(report) {
  const rows = new Map();
  if (!Array.isArray(report?.checks) || report.checks.length > CHECKS.length) return rows;
  for (const item of report.checks) {
    if (!item || typeof item !== 'object' || !CHECKS.some(([name]) => name === item.name)) continue;
    if (rows.has(item.name)) rows.set(item.name, null);
    else rows.set(item.name, item);
  }
  return rows;
}

function directStatus(item, name) {
  if (!item || typeof item.ok !== 'boolean') return 'Unknown';
  if (!item.ok) return 'Failed';
  if (['node', 'vendor', 'adb'].includes(name) && !safeVersion(item.version)) return 'Unknown';
  if (name === 'powershell' && (!Number.isInteger(item.major) || item.major < 7 || item.major > 99)) return 'Unknown';
  if (name === 'device' && item.permanentIdentityVerified !== true) return 'Unknown';
  if (name === 'live') {
    const observed = item.mode === 'existing-session'
      ? Number.isSafeInteger(item.packetsAdvanced) && item.packetsAdvanced > 0
      : item.mode === 'temporary-session'
        ? Number.isSafeInteger(item.frames) && item.frames >= 2
        : false;
    if (!observed) return 'Unknown';
  }
  return 'Passed';
}

function statuses(report, rows) {
  const result = new Map();
  for (const [name] of CHECKS.slice(0, -1)) {
    const item = rows.get(name);
    if (item === undefined && (name === 'adb' || name === 'powershell') &&
        result.get('configuration') === 'Failed') result.set(name, 'Skipped');
    else if (item === undefined && name === 'device' &&
        ['configuration', 'adb', 'powershell'].some(key => ['Failed', 'Skipped'].includes(result.get(key)))) result.set(name, 'Skipped');
    else result.set(name, directStatus(item, name));
  }
  const live = rows.get('live');
  if (report?.liveRequested === false && live === undefined) result.set('live', 'Not requested');
  else if (report?.liveRequested === true && live?.ok === false &&
      [...result.values()].some(status => status === 'Failed' || status === 'Skipped')) result.set('live', 'Skipped');
  else if (report?.liveRequested === true && [...result.values()].every(status => status === 'Passed')) result.set('live', directStatus(live, 'live'));
  else result.set('live', 'Unknown');
  return result;
}

export function formatSupportSummary(report) {
  const rows = entries(report);
  const status = statuses(report, rows);
  const version = report?.diagnosticVersion === 1 ? '1' : 'Unavailable';
  const lines = [
    '# DroidDock support summary',
    '',
    `Diagnostic schema: ${version}`,
    '',
    '| Check | Result | Tool version |',
    '| --- | --- | --- |',
  ];
  if (!Array.isArray(report?.checks)) lines.splice(4, 0, 'No completed diagnostic result is available.', '');
  for (const [name, label] of CHECKS) {
    const item = rows.get(name);
    const result = status.get(name);
    const toolVersion = result === 'Passed' && ['node', 'vendor', 'adb'].includes(name) ? safeVersion(item.version)
      : result === 'Passed' && name === 'powershell' ? String(item.major) : null;
    lines.push(`| ${label} | ${result} | ${toolVersion ?? '—'} |`);
  }
  lines.push(
    '',
    'A live check observes stream packets; it does not prove video rendered in a browser.',
    'Review this summary before sharing. DroidDock does not upload or copy it automatically.',
  );
  return lines.join('\n');
}
