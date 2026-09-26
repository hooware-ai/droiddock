import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

async function until(check, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(t, sessionMode = 'error') {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'pairing-controller-'));
  const folder = join(root, 'dist/droiddock');
  await mkdir(folder, { recursive: true });
  for (const name of ['server.js', 'config.js', 'protocol.js', 'lock-state.js', 'file-paste.js']) {
    await copyFile(join('dist/droiddock', name), join(folder, name));
  }
  await copyFile('dist/droiddock/pairing.js', join(folder, 'pairing-real.js'));
  await copyFile('dist/process.js', join(root, 'dist/process.js'));
  await writeFile(join(root, 'pair-mode'), 'success');
  await writeFile(join(root, 'verify-mode'), 'success');
  await writeFile(join(root, 'session-mode'), sessionMode);
  await writeFile(join(folder, 'pairing.js'), `
    import { appendFile, readFile } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    import { join } from 'node:path';
    export { parsePairingRequest } from './pairing-real.js';
    const root = fileURLToPath(new URL('../../', import.meta.url));
    export async function pairConfiguredPhone(_adb, _serial, request) {
      await appendFile(join(root, 'events'), 'pair-start\\n');
      const mode = (await readFile(join(root, 'pair-mode'), 'utf8')).trim();
      if (mode === 'success') return 'paired';
      if (mode === 'failed') return 'failed';
      return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (settled) return; settled = true; clearInterval(timer); resolve(value); };
        const timer = setInterval(async () => {
          try { await readFile(join(root, 'release')); finish('paired'); } catch {}
        }, 10);
        const aborted = () => {
          void appendFile(join(root, 'events'), 'pair-abort\\n');
          if (mode === 'wait-abort') finish('unavailable');
        };
        if (request.signal.aborted) aborted();
        else request.signal.addEventListener('abort', aborted, { once: true });
      });
    }
  `);
  await writeFile(join(folder, 'session.js'), `
    import { appendFile, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export class ScrcpySession {
      constructor(root, onEvent) { this.root = root; this.onEvent = onEvent; }
      async start() {
        if ((await readFile(join(this.root, 'session-mode'), 'utf8')).trim() === 'connected') {
          this.onEvent({ type:'video', codec:'h264', width:1, height:1 }); return;
        }
        const error = new Error('The configured phone is unavailable.');
        error.name = 'PhoneDiscoveryError'; error.recovery = 'candidate'; throw error;
      }
      async stop() {}
      static async verifyConfiguredPhone(root, signal) {
        await appendFile(join(root, 'events'), 'verify\\n');
        if (signal.aborted || (await readFile(join(root, 'verify-mode'), 'utf8')).trim() === 'wrong')
          throw new Error('SYNTHETIC_PRIVATE_WRONG_IDENTITY');
      }
    }
  `);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(folder, 'server.js')], {
    env: { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'SYNTHETICPHONE', DROIDDOCK_ADB: 'synthetic-adb' },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(server, 'exit');
  const peers = [];
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    if (server.exitCode === null) server.kill('SIGKILL');
    await exited;
    await rm(root, { recursive: true, force: true });
    assert.doesNotMatch(stderr, /SYNTHETIC_PRIVATE|UnhandledPromiseRejection|uncaughtException/);
  });
  const status = async () => (await fetch(`${origin}/api/status`)).json();
  await until(async () => { try { return (await status()).app === 'DroidDock'; } catch { return false; } }, 'isolated server');
  async function open(path = '/stream', wsOrigin = origin) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin: wsOrigin });
    const peer = { ws, messages: [] };
    peers.push(peer);
    ws.on('error', () => {});
    ws.on('message', data => peer.messages.push(JSON.parse(data.toString())));
    await once(ws, 'open', { signal: AbortSignal.timeout(3000) });
    await until(() => peer.messages.some(message => message.type === 'status'), 'socket greeting');
    peer.send = value => ws.send(JSON.stringify(value));
    return peer;
  }
  const events = async () => (await readFile(join(root, 'events'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { root, origin, server, status, open, events };
}

async function recoverable(peer, bridge) {
  peer.send({ type: 'connect' });
  await until(async () => (await bridge.status()).state === 'error', 'recoverable connection state');
}

test('pairing is a narrow controller-only message with sanitized validation and identity results', { timeout: 15000 }, async t => {
  const bridge = await fixture(t);
  const noController = await fetch(`${bridge.origin}/api/pairing`, { method: 'POST', headers: { Origin: bridge.origin, 'X-DroidDock': '1' } });
  assert.equal(noController.status, 404);
  const foreign = new WebSocket(bridge.origin.replace('http:', 'ws:') + '/stream', { origin: 'https://foreign.example' });
  foreign.on('error', () => {});
  const [foreignError] = await once(foreign, 'error', { signal: AbortSignal.timeout(3000) });
  assert.match(foreignError.message, /403/);
  const owner = await bridge.open();
  await recoverable(owner, bridge);
  for (const input of [
    { type: 'pairingRequest', code: '12345' },
    { type: 'pairingRequest', code: '123456', manualEndpoint: 'localhost:37002' },
    { type: 'pairingRequest', code: '123456', arbitrary: 'SYNTHETIC_PRIVATE' },
    { type: 'pairingCancel', arbitrary: 'SYNTHETIC_PRIVATE' },
  ]) owner.send(input);
  await until(() => owner.messages.filter(message => message.type === 'inputError').length === 4, 'four sanitized input errors');
  assert.equal((await bridge.events()).length, 0);
  assert.doesNotMatch(JSON.stringify(owner.messages), /12345|123456|localhost|SYNTHETIC_PRIVATE/);
  await writeFile(join(bridge.root, 'verify-mode'), 'wrong');
  owner.send({ type: 'pairingRequest', code: '012345' });
  await until(() => owner.messages.some(message => message.type === 'pairingResult' && message.result === 'paired-unverified'), 'unverified identity result');
  await writeFile(join(bridge.root, 'verify-mode'), 'success');
  owner.send({ type: 'pairingRequest', code: '012345' });
  await until(() => owner.messages.some(message => message.type === 'pairingResult' && message.result === 'identity-verified'), 'verified identity result');
  assert.equal((await bridge.status()).state, 'error', 'pairing does not claim rendered video');
  assert.deepEqual(await bridge.events(), ['pair-start', 'verify', 'pair-start', 'verify']);
});

test('one attempt is in flight; explicit cancellation stops it without a second result', { timeout: 15000 }, async t => {
  const bridge = await fixture(t);
  await writeFile(join(bridge.root, 'pair-mode'), 'wait-abort');
  const owner = await bridge.open();
  await recoverable(owner, bridge);
  owner.send({ type: 'pairingRequest', code: '123456' });
  await until(async () => (await bridge.events()).includes('pair-start'), 'pair attempt start');
  owner.send({ type: 'pairingRequest', code: '654321' });
  await until(() => owner.messages.some(message => message.type === 'pairingResult' && message.result === 'busy'), 'busy response');
  owner.send({ type: 'pairingCancel' });
  await until(() => owner.messages.some(message => message.type === 'pairingResult' && message.result === 'cancelled'), 'cancel response');
  await until(async () => (await bridge.events()).includes('pair-abort'), 'pair cancellation');
  await delay(30);
  assert.deepEqual(await bridge.events(), ['pair-start', 'pair-abort']);
  assert.deepEqual(owner.messages.filter(message => message.type === 'pairingResult').map(message => message.result), ['busy', 'cancelled']);
});

test('handoff cancels an old attempt and ignores a late success before the next owner pairs', { timeout: 15000 }, async t => {
  const bridge = await fixture(t);
  await writeFile(join(bridge.root, 'pair-mode'), 'ignore-abort');
  const old = await bridge.open();
  await recoverable(old, bridge);
  old.send({ type: 'pairingRequest', code: '123456' });
  await until(async () => (await bridge.events()).includes('pair-start'), 'old pair start');
  old.ws.on('message', data => {
    if (JSON.parse(data.toString()).type === 'moved' && old.ws.readyState === WebSocket.OPEN) {
      old.send({ type: 'pairingRequest', code: '654321' });
      old.send({ type: 'pairingCancel' });
    }
  });
  const next = await bridge.open('/stream?takeover=1');
  await until(async () => (await bridge.events()).includes('pair-abort'), 'handoff cancellation');
  await writeFile(join(bridge.root, 'release'), '');
  await until(async () => (await bridge.status()).state === 'idle', 'handoff cleanup');
  assert.equal(old.messages.some(message => message.type === 'pairingResult'), false);
  assert.equal(next.messages.some(message => message.type === 'pairingResult'), false);
  assert.deepEqual(await bridge.events(), ['pair-start', 'pair-abort'], 'stale success never verifies identity');
  await writeFile(join(bridge.root, 'pair-mode'), 'success');
  next.send({ type: 'connect' });
  await until(async () => (await bridge.status()).state === 'error', 'replacement recovery state');
  next.send({ type: 'pairingRequest', code: '654321' });
  await until(() => next.messages.some(message => message.type === 'pairingResult' && message.result === 'identity-verified'), 'replacement identity result');
});

test('connected sessions reject pairing; controller closure cancels before shutdown', { timeout: 15000 }, async t => {
  const connected = await fixture(t, 'connected');
  const active = await connected.open();
  active.send({ type: 'connect' });
  await until(async () => (await connected.status()).state === 'connected', 'connected session');
  active.send({ type: 'pairingRequest', code: '123456' });
  await until(() => active.messages.some(message => message.type === 'pairingResult' && message.result === 'unavailable'), 'connected pairing refusal');
  assert.deepEqual(await connected.events(), []);

  const stopping = await fixture(t);
  await writeFile(join(stopping.root, 'pair-mode'), 'wait-abort');
  const owner = await stopping.open();
  await recoverable(owner, stopping);
  owner.send({ type: 'pairingRequest', code: '123456' });
  await until(async () => (await stopping.events()).includes('pair-start'), 'shutdown pair start');
  const guarded = await fetch(`${stopping.origin}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' } });
  assert.equal(guarded.status, 409, 'shutdown cannot skip an active controller');
  owner.ws.close();
  await until(async () => (await stopping.events()).includes('pair-abort'), 'controller closure cancellation');
  assert.equal(owner.messages.some(message => message.type === 'pairingResult' && message.result === 'identity-verified'), false);
  await until(async () => (await stopping.status()).state === 'idle', 'cleanup after controller closure');
  const shutdown = await fetch(`${stopping.origin}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' } });
  assert.equal(shutdown.status, 200);
});
