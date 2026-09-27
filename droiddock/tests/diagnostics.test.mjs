import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, inspectVendor, videoEvidence, verifyLive, diagnose, runCommand } from '../../scripts/Test-DroidDock.mjs';
import { buildIdentity } from '../../dist/droiddock/build-id.js';

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

async function statusServer(t, installation, moving = true, correctConfiguration = true, buildId = buildIdentity(root)) {
  let reads = 0, writes = 0, upgrades = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'application/json');
    const configurationId = createHash('sha256').update(JSON.stringify([null, null, null, server.address().port])).digest('hex').slice(0, 16);
    res.end(JSON.stringify({ app: 'DroidDock', state: 'connected', packets: moving ? ++reads : 1, installationId: installation, configurationId: correctConfiguration ? configurationId : 'different', ...(buildId === null ? {} : { buildId }) }));
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

test('live refuses foreign installations, stale builds, and stalled streams without disturbing them', async t => {
  const foreign = await statusServer(t, 'another-installation');
  await assert.rejects(verifyLive({ root, config: { port: foreign.port }, timeoutMs: 300 }), /another installation/);
  assert.deepEqual(foreign.effects(), { writes: 0, upgrades: 0 });
  const changed = await statusServer(t, installationId(root), true, false);
  await assert.rejects(verifyLive({ root, config: { port: changed.port }, timeoutMs: 300 }), /another installation or configuration/);
  assert.deepEqual(changed.effects(), { writes: 0, upgrades: 0 });
  // null models a service started before build identifiers existed.
  for (const build of ['0000000000000000', null]) {
    const stale = await statusServer(t, installationId(root), true, true, build);
    await assert.rejects(verifyLive({ root, config: { port: stale.port }, timeoutMs: 300 }), /different build of this checkout\. Restart needed/);
    assert.deepEqual(stale.effects(), { writes: 0, upgrades: 0 });
  }
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
  const invalid = await invoke(['--json'], { DROIDDOCK_DEVICE_SERIAL: 'PRIVATE INVALID SERIAL' });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.report.ok, false);
  assert.doesNotMatch(JSON.stringify(invalid.report), /PRIVATE INVALID SERIAL/);
});
