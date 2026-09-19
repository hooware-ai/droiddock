import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function loadConfig(root, env = process.env) {
  let local = {}, present = true;
  try {
    local = JSON.parse((await readFile(join(root, 'config.local.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error();
    for (const field of ['deviceSerial', 'deviceName', 'adb']) {
      if (local[field] !== undefined && typeof local[field] !== 'string') throw new Error();
    }
  } catch (error) {
    if (error.code === 'ENOENT') present = false;
    else throw new Error('Fix config.local.json: it must contain a JSON object with string deviceSerial, deviceName and adb fields.');
  }
  const config = {
    deviceSerial: env.DROIDDOCK_DEVICE_SERIAL ?? local.deviceSerial ?? '',
    deviceName: env.DROIDDOCK_DEVICE_NAME ?? local.deviceName ?? 'Android phone',
    adb: env.DROIDDOCK_ADB ?? local.adb ?? 'adb',
    port: Number(env.DROIDDOCK_PORT ?? local.port ?? 3210),
  };
  if (!config.deviceSerial || config.deviceSerial === 'YOUR_DEVICE_SERIAL' || !/^[A-Za-z0-9]+$/.test(config.deviceSerial)) {
    throw new Error('Set deviceSerial in config.local.json or DROIDDOCK_DEVICE_SERIAL to the permanent ro.serialno value; see README.md.');
  }
  if (!config.adb.trim()) throw new Error('Set adb in config.local.json or DROIDDOCK_ADB to an installed ADB executable.');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('Set port or DROIDDOCK_PORT to an integer from 1024 to 65535.');
  }
  const sources = Object.fromEntries([
    ['deviceSerial', 'DROIDDOCK_DEVICE_SERIAL'], ['deviceName', 'DROIDDOCK_DEVICE_NAME'],
    ['adb', 'DROIDDOCK_ADB'], ['port', 'DROIDDOCK_PORT'],
  ].map(([field, name]) => [field, env[name] !== undefined ? 'environment' : local[field] !== undefined ? 'config.local.json' : 'default']));
  return { config, details: { localConfigPresent: present, sources } };
}

export async function inspectVendor(root) {
  const source = await readFile(join(root, 'src/droiddock/protocol.ts'), 'utf8');
  const version = source.match(/export const SCRCPY_VERSION = "([\d.]+)"/)?.[1];
  const hash = source.match(/export const SERVER_SHA256 = "([a-f0-9]{64})"/)?.[1];
  if (!version || !hash) throw new Error('Restore the pinned scrcpy version and SHA-256 constants in src/droiddock/protocol.ts.');
  const folder = join(root, 'droiddock/vendor', `scrcpy-${version}`);
  const manifest = JSON.parse(await readFile(join(folder, 'upstream.json'), 'utf8'));
  const actual = createHash('sha256').update(await readFile(join(folder, 'scrcpy-server'))).digest('hex');
  if (manifest.version !== version || manifest.sha256 !== hash || actual !== hash || manifest.file !== 'scrcpy-server') {
    throw new Error('Restore the unmodified pinned vendor server and upstream.json; their version and SHA-256 must match protocol.ts.');
  }
  await access(join(folder, 'LICENSE'));
  return { version, sha256: actual };
}

// Never include command output in reports: discovery can contain device identities.
export function runCommand(file, args, { env = process.env, timeoutMs = 20000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', overflow = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Command timed out.')); }, timeoutMs);
    child.stdout?.on('data', chunk => { if (stdout.length + chunk.length <= 65536) stdout += chunk.toString(); else overflow = true; });
    child.stderr?.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Command could not start.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow) reject(new Error('Command did not complete successfully.'));
      else resolveResult(stdout.trim());
    });
  });
}

async function readStatus(origin) {
  const response = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!response.ok) throw new Error('Status request failed.');
  const status = await response.json();
  if (status.app !== 'DroidDock' || !['idle', 'connecting', 'connected', 'error'].includes(status.state)) throw new Error('Port does not serve DroidDock.');
  return status;
}

async function existingStatus(origin, root, config) {
  try {
    const status = await readStatus(origin);
    const installationId = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16);
    if (status.installationId !== installationId) throw new Error('Different installation.');
    const configurationId = createHash('sha256').update(JSON.stringify([config.deviceSerial, config.adb, config.deviceName, config.port])).digest('hex').slice(0, 16);
    if (status.configurationId !== configurationId) throw new Error('Different configuration.');
    return status;
  }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return undefined;
    throw new Error('The configured port is unavailable, unrecognized, or belongs to another installation or configuration. Restart this installation or choose an unused port before --live; existing sessions were left untouched.');
  }
}

async function observeStream(origin, initial, timeoutMs) {
  const initialPackets = Number(initial.packets);
  if (!Number.isSafeInteger(initialPackets) || initialPackets < 0) throw new Error('Existing server lacks valid packet counters. Rebuild and restart it before --live.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(250);
    const next = await readStatus(origin);
    if (next.state === 'connected' && Number.isSafeInteger(next.packets) && next.packets > initialPackets) {
      return { mode: 'existing-session', packetsAdvanced: next.packets - initialPackets, observation: 'Read-only status counters; existing connection preserved.' };
    }
    if (next.state === 'error' || next.state === 'idle') break;
  }
  throw new Error('Existing session did not show advancing video packets. It was left untouched; check the phone and reconnect in DroidDock.');
}

async function temporaryPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolveClose => reservation.close(resolveClose));
  return port;
}

export function videoEvidence(message, binary, evidence) {
  if (binary) {
    const packet = Buffer.from(message);
    if (packet.length <= 12 || packet.readUInt32BE(8) !== packet.length - 12) throw new Error('Invalid video packet framing.');
    // Configuration packets alone do not prove the screen is delivering frames.
    if (!(packet.readBigUInt64BE(0) & (1n << 63n))) evidence.frames++;
  } else {
    let event;
    try { event = JSON.parse(message.toString()); } catch { throw new Error('Invalid video metadata message.'); }
    if (!event || typeof event !== 'object') throw new Error('Invalid video metadata message.');
    if (event.type === 'video') {
      if (event.codec !== 'h264' || !Number.isInteger(event.width) || !Number.isInteger(event.height) || event.width < 1 || event.height < 1 || event.width > 8192 || event.height > 8192) throw new Error('Invalid video metadata.');
      evidence.metadata = { codec: event.codec, width: event.width, height: event.height };
    }
    if (event.type === 'status' && event.state === 'error') throw new Error('Phone stream failed. Check device authorization and wireless debugging, then reconnect.');
  }
}

export async function verifyLive({ root = projectRoot, config, env = process.env, timeoutMs = 40000 }) {
  const configuredOrigin = `http://127.0.0.1:${config.port}`;
  const existing = await existingStatus(configuredOrigin, root, config);
  if (existing && ['connecting', 'connected'].includes(existing.state)) return observeStream(configuredOrigin, existing, timeoutMs);
  const { WebSocket } = await import('ws');
  const port = await temporaryPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, 'dist/droiddock/server.js')], {
    cwd: root, env: { ...env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: config.deviceSerial, DROIDDOCK_ADB: config.adb },
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let childError = false, ready = false, ws, result, failure;
  child.on('error', () => { childError = true; });
  try {
    const startupDeadline = Date.now() + Math.min(timeoutMs, 8000);
    while (Date.now() < startupDeadline && child.exitCode === null && !childError) {
      try {
        const status = await readStatus(origin);
        const expected = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16);
        ready = status.state === 'idle' && status.installationId === expected && child.exitCode === null;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error('Temporary DroidDock server did not start. Run npm run build and npm test, then retry.');
    // Recheck immediately before allocating a phone session in case the user connected meanwhile.
    const current = await existingStatus(configuredOrigin, root, config);
    if (current && ['connecting', 'connected'].includes(current.state)) {
      result = await observeStream(configuredOrigin, current, timeoutMs);
    } else {
      const evidence = { frames: 0, metadata: undefined };
      ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin, maxPayload: 8 * 1024 * 1024 + 12, handshakeTimeout: 5000 });
      let streamError;
      ws.on('error', () => { streamError = new Error('Temporary screen WebSocket failed. Rebuild DroidDock and retry.'); });
      ws.on('message', (message, binary) => { try { videoEvidence(message, binary, evidence); } catch (error) { streamError = error; } });
      await once(ws, 'open');
      const connect = fetch(`${origin}/api/connect`, { method: 'POST', headers: { 'X-DroidDock': '1' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      // The server awaits discovery in this request, while video events arrive independently.
      let connectError;
      const connected = connect.then(response => { if (!response.ok) connectError = new Error('Temporary server refused the connection.'); }).catch(() => { connectError = new Error('Temporary phone connection request failed or timed out.'); });
      const deadline = Date.now() + timeoutMs;
      while ((!evidence.metadata || evidence.frames < 2) && Date.now() < deadline) {
        if (streamError || connectError) throw streamError ?? connectError;
        if (ws.readyState !== WebSocket.OPEN) throw new Error('Phone stream closed before video could be verified.');
        await delay(100);
      }
      await connected;
      if (streamError || connectError) throw streamError ?? connectError;
      if (!evidence.metadata || evidence.frames < 2) throw new Error('No complete live video stream arrived. Unlock the phone, check wireless debugging, and retry.');
      result = { mode: 'temporary-session', video: evidence.metadata, frames: evidence.frames, contentSaved: false, inputSent: false };
    }
  } catch (error) { failure = error; }
  finally {
    if (ready) {
      try {
        // Await stop(): this drains pending setup and removes this session's ADB tunnel.
        const response = await fetch(`${origin}/api/disconnect`, { method: 'POST', headers: { 'X-DroidDock': '1' }, signal: AbortSignal.timeout(45000), redirect: 'error' });
        if (!response.ok || (await readStatus(origin)).state !== 'idle') throw new Error();
      } catch { failure = new Error('Temporary session cleanup could not be verified. Check DroidDock and ADB before another live test.'); }
    }
    ws?.terminate();
    if (child.exitCode === null && !childError) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        failure = new Error('Temporary server required forced termination; inspect ADB cleanup before retrying.');
      }
    }
  }
  if (failure) throw failure;
  return { ...result, cleanup: 'idle confirmed; temporary server stopped' };
}

export async function diagnose({ root = projectRoot, env = process.env, live = false, command = runCommand } = {}) {
  const checks = [];
  const check = async (name, action, fallback) => {
    try { const details = await action(); checks.push({ name, ok: true, ...details }); return details; }
    catch (error) { checks.push({ name, ok: false, message: fallback ?? error.message }); return undefined; }
  };
  await check('node', () => {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 or newer, then reopen your terminal.');
    return { version: process.versions.node };
  });
  let config;
  await check('configuration', async () => { const loaded = await loadConfig(root, env); config = loaded.config; return loaded.details; });
  const vendor = await check('vendor', () => inspectVendor(root), 'Vendor verification failed. Restore the pinned scrcpy server, upstream.json and LICENSE; their hash and version must match protocol.ts.');
  await check('build', async () => {
    await access(join(root, 'dist/droiddock/server.js'));
    const compiled = await readFile(join(root, 'dist/droiddock/protocol.js'), 'utf8');
    if (vendor && (!compiled.includes(`SCRCPY_VERSION = "${vendor.version}"`) || !compiled.includes(`SERVER_SHA256 = "${vendor.sha256}"`))) throw new Error();
    await access(join(root, 'node_modules/ws/package.json'));
    return {};
  }, 'Build or dependencies are missing/stale. Run npm ci and npm run build.');
  if (config) {
    const adb = await check('adb', async () => {
      const output = await command(config.adb, ['version'], { env, timeoutMs: 5000 });
      const version = output.match(/Android Debug Bridge version ([\d.]+)/)?.[1];
      if (!version) throw new Error();
      return { version };
    }, 'ADB could not report its version. Install Android platform-tools and correct adb or DROIDDOCK_ADB.');
    const pwsh = await check('powershell', async () => {
      const version = await command('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { env, timeoutMs: 5000 });
      if (!/^\d+$/.test(version) || Number(version) < 7) throw new Error();
      return { major: Number(version) };
    }, 'Install PowerShell 7 and ensure pwsh is available on PATH.');
    if (adb && pwsh) await check('device', async () => {
      await command('pwsh', ['-NoProfile', '-File', join(root, 'scripts/Start-DroidDockAdb.ps1'), '-AdbPath', config.adb], {env, timeoutMs:20000});
      const transport = await command('pwsh', ['-NoProfile', '-File', join(root, 'scripts/Find-DroidDockDevice.ps1'), '-DeviceSerial', config.deviceSerial, '-AdbPath', config.adb, '-WaitSeconds', '15'], { env, timeoutMs: 20000 });
      if (!transport || /\s/.test(transport)) throw new Error();
      return { permanentIdentityVerified: true };
    }, 'Configured phone was not found or identity verification failed. Authorize USB or enable paired wireless debugging; see README.md.');
  }
  if (live) {
    if (checks.every(item => item.ok)) await check('live', () => verifyLive({ root, config, env }));
    else checks.push({ name: 'live', ok: false, message: LIVE_CHECK_SKIPPED });
  }
  return { app: 'DroidDock', diagnosticVersion: 1, ok: checks.every(item => item.ok), liveRequested: live, checks };
}

const LIVE_CHECK_SKIPPED = 'Live verification skipped until baseline checks pass.';
const SUPPORT_SUMMARY_CHECKS = ['node', 'configuration', 'vendor', 'build', 'adb', 'powershell', 'device', 'live'];
const SUPPORT_SUMMARY_MAX_CHARS = 4096;
const CLI_FLAGS = ['--live', '--json', '--support-summary', '--help'];
const CLI_USAGE = 'Usage: node scripts/Test-DroidDock.mjs [--live] [--json] [--support-summary] [--help]';

function supportCheck(report, name) {
  return Array.isArray(report?.checks) ? report.checks.find(item => item && item.name === name) : undefined;
}

function supportOutcome(report, name) {
  const item = supportCheck(report, name);
  if (name === 'live') {
    if (report?.liveRequested !== true) return 'not requested';
    if (!item) return 'skipped';
    if (item.ok === true) return 'passed';
    return item.message === LIVE_CHECK_SKIPPED ? 'skipped' : 'failed';
  }
  if (item) return item.ok === true ? 'passed' : 'failed';
  return 'skipped';
}

function supportVersion(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value) ? value : undefined;
}

function supportDetails(name, item, outcome) {
  if (name === 'live') {
    const notes = [];
    if (outcome === 'not requested') notes.push('pass --live to request packet checks');
    else if (outcome === 'skipped') notes.push('skipped until baseline checks pass');
    else if (outcome === 'passed' && item) {
      if (item.mode === 'existing-session') notes.push('existing-session packet counters observed');
      else if (item.mode === 'temporary-session') notes.push('temporary-session stream packets observed');
      if (Number.isSafeInteger(item.packetsAdvanced) && item.packetsAdvanced > 0) notes.push('packet counters advanced');
      if (Number.isInteger(item.frames) && item.frames >= 0 && item.frames <= 1000000) notes.push(`${item.frames} frame packets`);
      const video = item.video;
      if (video && typeof video === 'object' && !Array.isArray(video)) {
        if (video.codec === 'h264') notes.push('codec h264');
        if (Number.isInteger(video.width) && Number.isInteger(video.height) && video.width >= 1 && video.height >= 1 && video.width <= 8192 && video.height <= 8192) {
          notes.push(`${video.width}x${video.height}`);
        }
      }
      if (item.contentSaved === false) notes.push('no screen content saved');
      if (item.inputSent === false) notes.push('no input sent');
    }
    notes.push('not a rendered-video claim');
    return notes.join('; ');
  }
  if (outcome !== 'passed' || !item) return '';
  if (name === 'node' || name === 'adb') {
    const version = supportVersion(item.version);
    return version ? `version ${version}` : '';
  }
  if (name === 'vendor') {
    const version = supportVersion(item.version);
    return version ? `scrcpy ${version}` : '';
  }
  if (name === 'powershell' && Number.isInteger(item.major) && item.major >= 0 && item.major <= 99) return `major ${item.major}`;
  if (name === 'device' && item.permanentIdentityVerified === true) return 'permanent identity verified';
  if (name === 'configuration' && typeof item.localConfigPresent === 'boolean') return item.localConfigPresent ? 'local config present' : 'local config absent';
  return '';
}

// Project only allowlisted schema/tool versions and named check outcomes.
// Do not serialize the raw report or copy paths, serials, endpoints, ids, or exception strings.
export function formatSupportSummary(report) {
  const source = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const schema = Number.isInteger(source.diagnosticVersion) && source.diagnosticVersion >= 1 && source.diagnosticVersion <= 99
    ? source.diagnosticVersion
    : undefined;
  const lines = [
    '# DroidDock support summary',
    '',
    'Review this summary before sharing. DroidDock does not upload it or copy it to the clipboard.',
    '',
    '- App: DroidDock',
    ...(schema !== undefined ? [`- Diagnostic schema: ${schema}`] : []),
    `- Overall: ${source.ok === true ? 'passed' : 'failed'}`,
    `- Live requested: ${source.liveRequested === true ? 'yes' : 'no'}`,
    '',
    '## Checks',
    '',
    '| Check | Outcome | Details |',
    '| --- | --- | --- |',
  ];
  for (const name of SUPPORT_SUMMARY_CHECKS) {
    const outcome = supportOutcome(source, name);
    const details = supportDetails(name, supportCheck(source, name), outcome).replace(/\r?\n/g, ' ').replace(/\|/g, '/');
    lines.push(`| ${name} | ${outcome} | ${details} |`);
  }
  lines.push('', 'Packet or stream evidence from the live check is not a rendered-video claim. Inspect the browser view separately.', '');
  const markdown = lines.join('\n');
  return markdown.length <= SUPPORT_SUMMARY_MAX_CHARS
    ? markdown
    : `${markdown.slice(0, SUPPORT_SUMMARY_MAX_CHARS - 24).trimEnd()}\n\n[summary truncated]\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !CLI_FLAGS.includes(arg))) {
    console.log(JSON.stringify({ app: 'DroidDock', ok: false, message: CLI_USAGE }));
    process.exitCode = 2;
  } else if (args.includes('--help')) {
    console.log(JSON.stringify({
      usage: 'node scripts/Test-DroidDock.mjs [--live] [--json] [--support-summary]',
      exitCodes: { 0: 'All requested checks passed', 1: 'A diagnostic check failed', 2: 'Invalid arguments' },
      live: 'Observe an existing active stream, or verify video in a temporary server and disconnect. No screen content is saved and no phone input is sent.',
      json: 'Print the existing JSON diagnostic report. This is the default when --support-summary is omitted.',
      supportSummary: 'Print a compact allowlisted Markdown summary of the same diagnostic result. Review it before sharing. Nothing is uploaded or copied to the clipboard. Packet evidence is not a rendered-video claim.',
    }, null, 2));
  } else {
    try {
      const report = await diagnose({ live: args.includes('--live') });
      console.log(args.includes('--support-summary') ? formatSupportSummary(report) : JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch {
      const failure = { app: 'DroidDock', ok: false, message: 'Diagnostics could not complete. Verify the local installation and retry.' };
      console.log(args.includes('--support-summary') ? formatSupportSummary(failure) : JSON.stringify(failure));
      process.exitCode = 1;
    }
  }
}
