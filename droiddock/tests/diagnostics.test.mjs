import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, inspectVendor, videoEvidence, verifyLive, diagnose, runCommand, formatSupportSummary } from '../../scripts/Test-DroidDock.mjs';

const root = resolve('.');
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'droiddock-diagnostics-'));
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries:10, retryDelay:100 }));
  return folder;
}

test('configuration follows server environment precedence and never reports identity values', async t => {
  const folder = await fixture(t);
  await writeFile(join(folder, 'config.local.json'), '\uFEFF' + JSON.stringify({ deviceSerial: 'LOCAL123', adb: 'local-adb', port: 3201 }));
  const loaded = await loadConfig(folder, { DROIDDOCK_DEVICE_SERIAL: 'ENV456', DROIDDOCK_ADB: 'env-adb', DROIDDOCK_PORT: '3202' });
  assert.equal(loaded.config.deviceSerial, 'ENV456');
  assert.equal(loaded.config.adb, 'env-adb');
  assert.equal(loaded.config.port, 3202);
  assert.equal(loaded.details.sources.deviceSerial, 'environment');
  assert.doesNotMatch(JSON.stringify(loaded.details), /LOCAL123|ENV456|env-adb/);
  await assert.rejects(loadConfig(folder, { DROIDDOCK_DEVICE_SERIAL: '' }), /permanent/);
  await assert.rejects(loadConfig(folder, { DROIDDOCK_PORT: 'NaN' }), /1024/);
  await writeFile(join(folder, 'config.local.json'), '[]');
  await assert.rejects(loadConfig(folder, {}), /JSON object/);
});

test('vendor check rejects modified server and manifest disagreement', async t => {
  const folder = await fixture(t);
  await cp(join(root, 'src'), join(folder, 'src'), { recursive: true });
  await cp(join(root, 'droiddock/vendor'), join(folder, 'droiddock/vendor'), { recursive: true });
  const result = await inspectVendor(folder);
  const vendor = join(folder, 'droiddock/vendor', `scrcpy-${result.version}`);
  const manifestPath = join(vendor, 'upstream.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
  await assert.rejects(inspectVendor(folder), /SHA-256/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(vendor, 'scrcpy-server'), 'modified');
  await assert.rejects(inspectVendor(folder), /SHA-256/);
});

test('video evidence requires valid metadata and actual frame packets beyond codec configuration', () => {
  const evidence = { frames: 0 };
  const packet = Buffer.alloc(13); packet.writeUInt32BE(1, 8); packet.writeBigUInt64BE(1n << 63n, 0);
  videoEvidence(packet, true, evidence);
  assert.equal(evidence.frames, 0);
  packet.writeBigUInt64BE(1n << 62n, 0);
  videoEvidence(packet, true, evidence);
  assert.equal(evidence.frames, 1);
  videoEvidence(JSON.stringify({ type: 'video', codec: 'h264', width: 640, height: 1280 }), false, evidence);
  assert.equal(evidence.metadata.width, 640);
  assert.throws(() => videoEvidence(Buffer.alloc(12), true, evidence), /framing/);
  assert.throws(() => videoEvidence(JSON.stringify({ type: 'video', codec: 'h264', width: -1, height: 1 }), false, evidence), /metadata/);
  assert.throws(() => videoEvidence(JSON.stringify({ type: 'status', state: 'error', message: 'PRIVATE123' }), false, evidence), error => !error.message.includes('PRIVATE123'));
});

async function statusServer(t, installation, moving = true, correctConfiguration = true) {
  let reads = 0, writes = 0, upgrades = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'application/json');
    const configurationId = createHash('sha256').update(JSON.stringify([null, null, null, server.address().port])).digest('hex').slice(0, 16);
    res.end(JSON.stringify({ app: 'DroidDock', state: 'connected', packets: moving ? ++reads : 1, installationId: installation, configurationId: correctConfiguration ? configurationId : 'different' }));
  });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return { port: server.address().port, effects: () => ({ writes, upgrades }) };
}
const installationId = folder => createHash('sha256').update(resolve(folder).toLowerCase()).digest('hex').slice(0, 16);

test('live observes advancing existing stream without opening a WebSocket or sending writes', async t => {
  const server = await statusServer(t, installationId(root));
  const result = await verifyLive({ root, config: { port: server.port }, timeoutMs: 800 });
  assert.equal(result.mode, 'existing-session');
  assert.ok(result.packetsAdvanced > 0);
  assert.deepEqual(server.effects(), { writes: 0, upgrades: 0 });
});

test('live refuses foreign installations and stalled streams without disturbing them', async t => {
  const foreign = await statusServer(t, 'another-installation');
  await assert.rejects(verifyLive({ root, config: { port: foreign.port }, timeoutMs: 300 }), /another installation/);
  assert.deepEqual(foreign.effects(), { writes: 0, upgrades: 0 });
  const changed = await statusServer(t, installationId(root), true, false);
  await assert.rejects(verifyLive({ root, config: { port: changed.port }, timeoutMs: 300 }), /another installation or configuration/);
  assert.deepEqual(changed.effects(), { writes: 0, upgrades: 0 });
  const stalled = await statusServer(t, installationId(root), false);
  await assert.rejects(verifyLive({ root, config: { port: stalled.port }, timeoutMs: 300 }), /advancing video packets/);
  assert.deepEqual(stalled.effects(), { writes: 0, upgrades: 0 });
});

async function fakeBridge(t, mode) {
  const folder = await fixture(t);
  await mkdir(join(folder, 'dist/droiddock'), { recursive: true });
  const script = `
    import { createServer } from 'node:http';
    import { appendFileSync } from 'node:fs';
    import { WebSocketServer } from ${JSON.stringify(import.meta.resolve('ws'))};
    let state = 'idle', ws;
    const report = () => ({ app: 'DroidDock', state, installationId: ${JSON.stringify(installationId(folder))}, packets: 0 });
    const record = text => appendFileSync('events.txt', text + '\\n');
    const server = createServer((req, res) => {
      if (req.url === '/api/connect') {
        state = 'connected'; record('connect');
        ws.send(JSON.stringify({type:'video', codec:'h264', width:640, height:1280}));
        const packet = Buffer.alloc(13); packet.writeUInt32BE(1,8);
        if (${JSON.stringify(mode)} === 'config-only') packet.writeBigUInt64BE(1n << 63n,0);
        ws.send(packet); ws.send(packet);
      }
      if (req.url === '/api/disconnect') { state = 'idle'; record('disconnect-cleaned'); }
      if (req.url === '/api/status' && state === 'idle') record('idle');
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(report()));
    });
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', client => { ws = client; client.on('message', () => record('UNEXPECTED INPUT')); });
    server.listen(Number(process.env.DROIDDOCK_PORT),'127.0.0.1', () => record('port:' + server.address().port));
  `;
  await writeFile(join(folder, 'dist/droiddock/server.js'), script);
  await writeFile(join(folder, 'package.json'), '{"type":"module"}');
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const configuredPort = reservation.address().port;
  await new Promise(done => reservation.close(done));
  return { folder, config: { port: configuredPort, deviceSerial: 'SYNTHETIC', adb: 'unused' } };
}

test('temporary live verifies metadata and frames, disconnects to idle and stops its server', { timeout: 12000 }, async t => {
  const { folder, config } = await fakeBridge(t, 'frames');
  const result = await verifyLive({ root: folder, config, timeoutMs: 2500 });
  assert.equal(result.mode, 'temporary-session');
  assert.equal(result.frames, 2);
  assert.equal(result.contentSaved, false);
  const events = await readFile(join(folder, 'events.txt'), 'utf8');
  assert.match(events, /connect\ndisconnect-cleaned\nidle/);
  assert.doesNotMatch(events, /UNEXPECTED/);
  const port = Number(events.match(/port:(\d+)/)[1]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));
});

test('configuration packets alone fail live verification but still clean up', { timeout: 12000 }, async t => {
  const { folder, config } = await fakeBridge(t, 'config-only');
  await assert.rejects(verifyLive({ root: folder, config, timeoutMs: 800 }), /No complete live video/);
  const events = await readFile(join(folder, 'events.txt'), 'utf8');
  assert.match(events, /disconnect-cleaned\nidle/);
  const port = Number(events.match(/port:(\d+)/)[1]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));
});

test('baseline uses permanent identity discovery and redacts subprocess evidence', async () => {
  const calls = [];
  const report = await diagnose({ root, env: { DROIDDOCK_DEVICE_SERIAL: 'SYNTHETICPRIVATE', DROIDDOCK_ADB: 'FAKEADB' }, command: async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'FAKEADB') return 'Android Debug Bridge version 1.0.41\nInstalled as PRIVATEPATH';
    if (args.includes('-Command')) return '7';
    if (args.some(arg => arg.endsWith('Start-DroidDockAdb.ps1'))) return '';
    assert.ok(args.includes('SYNTHETICPRIVATE'));
    assert.ok(args.some(arg => arg.endsWith('Find-DroidDockDevice.ps1')));
    return 'PRIVATE_TRANSPORT';
  } });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(calls.length, 4);
  assert.ok(calls[2].args.some(arg => arg.endsWith('Start-DroidDockAdb.ps1')));
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETICPRIVATE|PRIVATEPATH|PRIVATE_TRANSPORT|FAKEADB/);
});

test('subprocess runner enforces deadlines and suppresses stderr details', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {},1000)'], { timeoutMs: 100 }), /timed out/);
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("PRIVATE");process.exit(2)']), error => !error.message.includes('PRIVATE'));
});

test('Windows daemon startup does not retain captured command pipes', {skip:process.platform !== 'win32'}, async t => {
  const folder = await fixture(t);
  const pidFile = join(folder, 'daemon.pid');
  const start = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'inherit',windowsHide:true,detached:true}); fs.writeFileSync(process.argv[1],String(child.pid)); child.unref();`;
  try {
    await writeFile(join(folder, 'start-server'), start.replace('process.argv[1]', JSON.stringify(pidFile)));
    const result = spawnSync('pwsh', ['-NoProfile','-File',join(root,'scripts/Start-DroidDockAdb.ps1'),'-AdbPath',process.execPath], {cwd:folder, encoding:'utf8', windowsHide:true, timeout:5000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const daemon = Number(await readFile(pidFile, 'utf8'));
    assert.doesNotThrow(() => process.kill(daemon, 0));
  } finally {
    try { process.kill(Number(await readFile(pidFile, 'utf8'))); } catch {}
  }
});

test('CLI returns parseable redacted JSON and stable usage/failure exit codes', async () => {
  async function invoke(args, env = {}) {
    const child = spawn(process.execPath, ['scripts/Test-DroidDock.mjs', ...args], {
      cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(stderr, '');
    return { code, report: JSON.parse(stdout) };
  }
  assert.equal((await invoke(['--unknown'])).code, 2);
  assert.equal((await invoke(['--help'])).code, 0);
  const help = await invoke(['--help']);
  assert.match(help.report.usage, /--support-summary/);
  assert.match(help.report.supportSummary, /Review it before sharing/);
  assert.match(help.report.supportSummary, /not a rendered-video claim/);
  const invalid = await invoke(['--json'], { DROIDDOCK_DEVICE_SERIAL: 'PRIVATE INVALID SERIAL' });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.report.ok, false);
  assert.doesNotMatch(JSON.stringify(invalid.report), /PRIVATE INVALID SERIAL/);
});

const supportSuccess = Object.freeze({
  app: 'DroidDock',
  diagnosticVersion: 1,
  ok: true,
  liveRequested: true,
  checks: Object.freeze([
    Object.freeze({ name: 'node', ok: true, version: '24.10.0' }),
    Object.freeze({ name: 'configuration', ok: true, localConfigPresent: true, sources: Object.freeze({ deviceSerial: 'environment', deviceName: 'default', adb: 'config.local.json', port: 'default' }) }),
    Object.freeze({ name: 'vendor', ok: true, version: '4.1', sha256: 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae' }),
    Object.freeze({ name: 'build', ok: true }),
    Object.freeze({ name: 'adb', ok: true, version: '1.0.41' }),
    Object.freeze({ name: 'powershell', ok: true, major: 7 }),
    Object.freeze({ name: 'device', ok: true, permanentIdentityVerified: true }),
    Object.freeze({ name: 'live', ok: true, mode: 'temporary-session', video: Object.freeze({ codec: 'h264', width: 640, height: 1280 }), frames: 2, contentSaved: false, inputSent: false, cleanup: 'idle confirmed; temporary server stopped' }),
  ]),
});

const supportSuccessMarkdown = `# DroidDock support summary

Review this summary before sharing. DroidDock does not upload it or copy it to the clipboard.

- App: DroidDock
- Diagnostic schema: 1
- Overall: passed
- Live requested: yes

## Checks

| Check | Outcome | Details |
| --- | --- | --- |
| node | passed | version 24.10.0 |
| configuration | passed | local config present |
| vendor | passed | scrcpy 4.1 |
| build | passed |  |
| adb | passed | version 1.0.41 |
| powershell | passed | major 7 |
| device | passed | permanent identity verified |
| live | passed | temporary-session stream packets observed; 2 frame packets; codec h264; 640x1280; no screen content saved; no input sent; not a rendered-video claim |

Packet or stream evidence from the live check is not a rendered-video claim. Inspect the browser view separately.
`;

const supportFailed = Object.freeze({
  app: 'DroidDock',
  diagnosticVersion: 1,
  ok: false,
  liveRequested: true,
  checks: Object.freeze([
    Object.freeze({ name: 'node', ok: true, version: '24.10.0' }),
    Object.freeze({ name: 'configuration', ok: false, message: 'Set deviceSerial in config.local.json or DROIDDOCK_DEVICE_SERIAL to the permanent ro.serialno value; see README.md.' }),
    Object.freeze({ name: 'vendor', ok: true, version: '4.1' }),
    Object.freeze({ name: 'build', ok: true }),
    Object.freeze({ name: 'live', ok: false, message: 'Live verification skipped until baseline checks pass.' }),
  ]),
});

const supportFailedMarkdown = `# DroidDock support summary

Review this summary before sharing. DroidDock does not upload it or copy it to the clipboard.

- App: DroidDock
- Diagnostic schema: 1
- Overall: failed
- Live requested: yes

## Checks

| Check | Outcome | Details |
| --- | --- | --- |
| node | passed | version 24.10.0 |
| configuration | failed |  |
| vendor | passed | scrcpy 4.1 |
| build | passed |  |
| adb | skipped |  |
| powershell | skipped |  |
| device | skipped |  |
| live | skipped | skipped until baseline checks pass; not a rendered-video claim |

Packet or stream evidence from the live check is not a rendered-video claim. Inspect the browser view separately.
`;

test('support summary uses a stable allowlist and distinguishes check outcomes', () => {
  assert.equal(formatSupportSummary(supportSuccess), supportSuccessMarkdown);
  assert.equal(formatSupportSummary(supportFailed), supportFailedMarkdown);
  const idle = formatSupportSummary({
    app: 'DroidDock', diagnosticVersion: 1, ok: true, liveRequested: false,
    checks: [
      { name: 'node', ok: true, version: '24.10.0' },
      { name: 'configuration', ok: true, localConfigPresent: false },
      { name: 'vendor', ok: true, version: '4.1' },
      { name: 'build', ok: true },
      { name: 'adb', ok: true, version: '1.0.41' },
      { name: 'powershell', ok: true, major: 7 },
      { name: 'device', ok: true, permanentIdentityVerified: true },
    ],
  });
  assert.match(idle, /\| configuration \| passed \| local config absent \|/);
  assert.match(idle, /\| live \| not requested \| pass --live to request packet checks; not a rendered-video claim \|/);
  assert.match(idle, /Live requested: no/);
  const existing = formatSupportSummary({
    ...supportSuccess,
    checks: supportSuccess.checks.map(item => item.name === 'live'
      ? { name: 'live', ok: true, mode: 'existing-session', packetsAdvanced: 4, observation: 'Read-only status counters; existing connection preserved.' }
      : item),
  });
  assert.match(existing, /\| live \| passed \| existing-session packet counters observed; packet counters advanced; not a rendered-video claim \|/);
  assert.doesNotMatch(existing, /rendered video(?! claim)/i);
  assert.doesNotMatch(existing, /\bdisplayed\b|\bcanvas\b/i);
  const liveFailed = formatSupportSummary({
    ...supportSuccess,
    ok: false,
    checks: supportSuccess.checks.map(item => item.name === 'live'
      ? { name: 'live', ok: false, message: 'Existing session did not show advancing video packets. It was left untouched; check the phone and reconnect in DroidDock.' }
      : item),
  });
  assert.match(liveFailed, /\| live \| failed \| not a rendered-video claim \|/);
  assert.doesNotMatch(liveFailed, /advancing video packets|untouched|reconnect/);
});

test('support summary drops private markers instead of redacting a raw report', () => {
  const dirty = {
    ...supportSuccess,
    message: 'PRIVATE_MARKER exception at C:\\Users\\<user>\\droiddock',
    installationId: 'deadbeefdeadbeef',
    configurationId: 'cafebabecafebabe',
    endpoint: 'http://127.0.0.1:3210/',
    deviceSerial: 'SERIALABC123',
    clipboard: 'CLIPBOARD_SECRET',
    screenshot: 'SCREEN_CONTENT',
    stderr: 'PRIVATE_OUTPUT '.repeat(4000),
    checks: [
      ...supportSuccess.checks.map(item => ({
        ...item,
        message: 'PRIVATE_MARKER raw subprocess PRIVATE_OUTPUT',
        path: '/home/<user>/.android',
        deviceSerial: 'SERIALABC123',
        installationId: 'deadbeefdeadbeef',
        configurationId: 'cafebabecafebabe',
        stderr: 'PRIVATE_OUTPUT',
        endpoint: 'ws://127.0.0.1:3210/stream',
        clipboard: 'CLIPBOARD_SECRET',
        screenshot: 'SCREEN_CONTENT',
        video: item.video ? { ...item.video, screenshot: 'SCREEN_CONTENT' } : item.video,
      })),
      { name: 'shell', ok: true, message: 'SHOULD_NOT_APPEAR' },
    ],
  };
  const markdown = formatSupportSummary(dirty);
  assert.equal(markdown, supportSuccessMarkdown);
  assert.doesNotMatch(markdown, /PRIVATE_MARKER|PRIVATE_OUTPUT|SERIALABC123|127\.0\.0\.1|deadbeef|cafebabe|CLIPBOARD_SECRET|SCREEN_CONTENT|SHOULD_NOT_APPEAR|ws:\/\//);
  assert.ok(markdown.length <= 4096);
});

test('support summary formats existing results without rerunning checks and stays cheaper than diagnose', async () => {
  let commands = 0;
  const report = await diagnose({
    root,
    env: { DROIDDOCK_DEVICE_SERIAL: 'SYNTHETICPRIVATE', DROIDDOCK_ADB: 'FAKEADB' },
    command: async (file, args) => {
      commands++;
      if (file === 'FAKEADB') return 'Android Debug Bridge version 1.0.41\nInstalled as PRIVATEPATH';
      if (args.includes('-Command')) return '7';
      if (args.some(arg => arg.endsWith('Start-DroidDockAdb.ps1'))) return '';
      return 'PRIVATE_TRANSPORT';
    },
  });
  const before = commands;
  const snapshot = JSON.stringify(report);
  const formatted = formatSupportSummary(report);
  assert.equal(commands, before);
  assert.equal(JSON.stringify(report), snapshot);
  assert.match(formatted, /\| node \| passed \|/);
  assert.match(formatted, /\| live \| not requested \|/);
  assert.doesNotMatch(formatted, /SYNTHETICPRIVATE|PRIVATEPATH|PRIVATE_TRANSPORT|FAKEADB/);

  const iterations = 1000;
  const formatStarted = performance.now();
  for (let i = 0; i < iterations; i++) formatSupportSummary(report);
  const formatMs = (performance.now() - formatStarted) / iterations;
  const diagnoseStarted = performance.now();
  await diagnose({
    root,
    env: { DROIDDOCK_DEVICE_SERIAL: 'SYNTHETICPRIVATE', DROIDDOCK_ADB: 'FAKEADB' },
    command: async (file, args) => {
      if (file === 'FAKEADB') return 'Android Debug Bridge version 1.0.41';
      if (args.includes('-Command')) return '7';
      return '';
    },
  });
  const diagnoseMs = performance.now() - diagnoseStarted;
  assert.ok(formatMs < diagnoseMs, `support-summary format ${formatMs.toFixed(4)}ms vs diagnose ${diagnoseMs.toFixed(2)}ms`);
  assert.ok(formatMs < 5, `support-summary format ${formatMs.toFixed(4)}ms exceeds 5ms bound`);
});

test('CLI --support-summary preserves JSON output and exit codes', async () => {
  async function invokeText(args, env = {}) {
    const child = spawn(process.execPath, ['scripts/Test-DroidDock.mjs', ...args], {
      cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(stderr, '');
    return { code, stdout };
  }
  const env = { DROIDDOCK_DEVICE_SERIAL: 'PRIVATE INVALID SERIAL' };
  const jsonChild = spawn(process.execPath, ['scripts/Test-DroidDock.mjs', '--json'], {
    cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let jsonOut = '', jsonErr = '';
  jsonChild.stdout.on('data', chunk => { jsonOut += chunk; });
  jsonChild.stderr.on('data', chunk => { jsonErr += chunk; });
  const [jsonCode] = await once(jsonChild, 'close');
  assert.equal(jsonErr, '');
  const jsonReport = JSON.parse(jsonOut);
  assert.equal(jsonCode, 1);
  assert.equal(jsonReport.app, 'DroidDock');
  assert.equal(jsonReport.diagnosticVersion, 1);
  assert.equal(jsonReport.ok, false);
  assert.doesNotMatch(jsonOut, /PRIVATE INVALID SERIAL|# DroidDock support summary/);

  const markdown = await invokeText(['--support-summary'], env);
  assert.equal(markdown.code, jsonCode);
  assert.match(markdown.stdout, /^# DroidDock support summary/m);
  assert.match(markdown.stdout, /\| configuration \| failed \|/);
  assert.match(markdown.stdout, /\| live \| not requested \|/);
  assert.doesNotMatch(markdown.stdout, /PRIVATE INVALID SERIAL/);
  assert.throws(() => JSON.parse(markdown.stdout));

  const both = await invokeText(['--json', '--support-summary'], env);
  assert.equal(both.code, jsonCode);
  assert.match(both.stdout, /^# DroidDock support summary/m);
  const leaked = await invokeText(['--support-summary'], { DROIDDOCK_DEVICE_SERIAL: 'SYNTHETIC1', DROIDDOCK_ADB: 'FAKEADB' });
  assert.doesNotMatch(leaked.stdout, /SYNTHETIC1|FAKEADB/);
  assert.match(leaked.stdout, /Review this summary before sharing/);
});
