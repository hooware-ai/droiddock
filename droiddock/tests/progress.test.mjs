import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { CONNECTION_PROGRESS } from '../../dist/droiddock/session.js';
import { loadBrowser, startConnect } from './accessibility.test.mjs';

async function until(check, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function withServer(run, serverPath = 'dist/droiddock/server.js') {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const peers = [];
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'invalid-test-serial' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => server.once('exit', resolve));
  async function status() { return (await fetch(`${origin}/api/status`)).json(); }
  function peer(path = '/stream', wsOrigin = origin) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin: wsOrigin });
    const item = { ws, messages: [], close: undefined };
    ws.on('message', (data, binary) => { if (!binary) item.messages.push(JSON.parse(data.toString())); });
    ws.on('close', (code, reason) => { item.close = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    peers.push(item);
    return item;
  }
  async function open(path = '/stream') {
    const item = peer(path);
    await once(item.ws, 'open', { signal: AbortSignal.timeout(3000) });
    await until(() => item.messages.find(value => value.type === 'status'), 'initial socket status');
    return item;
  }
  try {
    await until(async () => {
      assert.equal(server.exitCode, null, `test server exited: ${output}`);
      try { return (await fetch(`${origin}/api/status`)).ok; } catch { return false; }
    }, 'isolated test server');
    await run({ open, status });
  } finally {
    for (const item of peers) item.ws.terminate();
    if (server.exitCode === null) server.kill();
    await exited;
  }
}

function connectingMessages(item) {
  return item.messages.filter(value => value.type === 'status' && value.state === 'connecting').map(value => value.message);
}

function countWrites(element) {
  let value = element.textContent;
  let writes = 0;
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get() { return value; },
    set(next) {
      writes += 1;
      value = String(next);
    },
  });
  return () => writes;
}

test('connection progress vocabulary is a small sanitized stage list', () => {
  const stages = [
    'Finding the configured phone…',
    'Preparing the phone connection…',
    'Opening the video stream…',
  ];
  assert.deepEqual(Object.values(CONNECTION_PROGRESS), stages);
  const serverSource = readFileSync(new URL('../../src/droiddock/server.ts', import.meta.url), 'utf8');
  for (const text of stages) {
    assert.doesNotMatch(text, /%|\bETA\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|tcp:|adb |[/\\]|scrcpy_|serial/i);
    assert.ok(serverSource.includes(`"${text}"`), `server allowlist includes ${text}`);
  }
});

test('synthetic startup gates report stages in order and only for the current session', { timeout: 15000 }, async () => {
  const fixtureBase = resolve('.setup');
  await mkdir(fixtureBase, { recursive: true });
  const fixture = await mkdtemp(join(fixtureBase, 'progress-gates-'));
  const fixtureDist = join(fixture, 'dist/droiddock');
  try {
    await mkdir(fixtureDist, { recursive: true });
    for (const name of ['server.js', 'config.js', 'protocol.js', 'lock-state.js']) {
      await copyFile(join('dist/droiddock', name), join(fixtureDist, name));
    }
    await writeFile(join(fixtureDist, 'session.js'), `
      import { access, appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      let nextId = 0;
      export const CONNECTION_PROGRESS = {
        findingPhone: 'Finding the configured phone…',
        preparingConnection: 'Preparing the phone connection…',
        openingStream: 'Opening the video stream…',
      };
      export class ScrcpySession {
        constructor(root, onEvent, onFailure, onProgress = () => {}) {
          Object.assign(this, { root, onEvent, onFailure, onProgress, id: ++nextId });
        }
        async log(event) { await appendFile(join(this.root, 'events.log'), event + '\\n'); }
        async gate(name) {
          while (true) { try { await access(join(this.root, name)); return; } catch { await delay(10); } }
        }
        async start() {
          await this.log('start:' + this.id);
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
          await this.gate('release-find');
          this.onProgress(CONNECTION_PROGRESS.preparingConnection);
          await this.gate('release-prepare');
          this.onProgress(CONNECTION_PROGRESS.openingStream);
          await this.gate('release-stream');
          this.onEvent({ type: 'video', sessionId: this.id });
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
        }
        input() { throw new Error('Connect your phone first.'); }
        async stop() { await this.log('stop:' + this.id); }
      }
    `);
    await withServer(async ({ open, status }) => {
      const item = await open();
      item.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await status()).message === CONNECTION_PROGRESS.findingPhone, 'finding stage');
      assert.equal((await status()).state, 'connecting');
      assert.deepEqual([...new Set(connectingMessages(item))], [CONNECTION_PROGRESS.findingPhone]);
      assert.equal(item.messages.some(value => value.state === 'connected' || value.type === 'video'), false);

      await writeFile(join(fixture, 'release-find'), '');
      await until(async () => (await status()).message === CONNECTION_PROGRESS.preparingConnection, 'preparing stage');
      assert.equal((await status()).state, 'connecting');
      assert.deepEqual([...new Set(connectingMessages(item))], [
        CONNECTION_PROGRESS.findingPhone,
        CONNECTION_PROGRESS.preparingConnection,
      ]);

      await writeFile(join(fixture, 'release-prepare'), '');
      await until(async () => (await status()).message === CONNECTION_PROGRESS.openingStream, 'opening stage');
      assert.equal((await status()).state, 'connecting');
      assert.equal(item.messages.some(value => value.state === 'connected' || value.type === 'video'), false);

      await writeFile(join(fixture, 'release-stream'), '');
      await until(() => item.messages.some(value => value.type === 'video' && value.sessionId === 1), 'current session video');
      const ready = await status();
      assert.equal(ready.state, 'connected');
      assert.equal(ready.message, 'Connected');
      assert.deepEqual([...new Set(connectingMessages(item))], [
        CONNECTION_PROGRESS.findingPhone,
        CONNECTION_PROGRESS.preparingConnection,
        CONNECTION_PROGRESS.openingStream,
      ]);
      const statuses = item.messages.filter(value => value.type === 'status');
      const connectedAt = statuses.findIndex(value => value.state === 'connected');
      assert.ok(connectedAt >= 0);
      assert.equal(statuses.slice(connectedAt + 1).some(value => value.state === 'connecting'), false);
      assert.deepEqual((await readFile(join(fixture, 'events.log'), 'utf8')).trim().split('\n'), ['start:1']);
    }, join(fixtureDist, 'server.js'));
  } finally {
    assert.ok(fixture.startsWith(fixtureBase + '\\') || fixture.startsWith(fixtureBase + '/'));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('browser announces new stages once and keeps input gated until a frame renders', async () => {
  const browser = loadBrowser();
  const emptyWrites = countWrites(browser.element('empty-message'));
  const messageWrites = countWrites(browser.element('message'));
  const stateWrites = countWrites(browser.element('state'));
  const socket = await startConnect(browser);
  socket.onopen();
  assert.equal(browser.element('state').dataset.state, 'connecting');
  assert.ok(browser.keyButtons.every(button => button.disabled));
  const emptyAfterConnect = emptyWrites();
  const messageAfterConnect = messageWrites();
  const stateAfterConnect = stateWrites();

  socket.receive({ type: 'status', state: 'connecting', message: CONNECTION_PROGRESS.findingPhone });
  assert.equal(browser.element('empty-message').textContent, CONNECTION_PROGRESS.findingPhone);
  assert.equal(browser.element('message').textContent, CONNECTION_PROGRESS.findingPhone);
  assert.equal(browser.element('message').getAttribute('aria-live'), 'off');
  const emptyAfterFind = emptyWrites();
  socket.receive({ type: 'status', state: 'connecting', message: CONNECTION_PROGRESS.findingPhone });
  assert.equal(emptyWrites(), emptyAfterFind);
  assert.equal(messageWrites(), messageAfterConnect + 1);
  assert.equal(stateWrites(), stateAfterConnect);
  assert.equal(browser.element('state').textContent, 'Connecting');

  socket.receive({ type: 'status', state: 'connecting', message: CONNECTION_PROGRESS.preparingConnection });
  socket.receive({ type: 'status', state: 'connecting', message: CONNECTION_PROGRESS.openingStream });
  assert.equal(browser.element('empty-message').textContent, CONNECTION_PROGRESS.openingStream);
  assert.ok(browser.keyButtons.every(button => button.disabled));

  socket.receive({ type: 'status', state: 'connected', message: 'Connected' });
  socket.receive({ type: 'video' });
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(browser.element('empty-message').textContent, 'Waiting for the live screen.');
  assert.ok(browser.keyButtons.every(button => button.disabled));
  assert.equal(browser.element('screen').hidden, true);

  socket.onmessage({ data: (() => {
    const payload = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e]);
    const buffer = new ArrayBuffer(12 + payload.length);
    const view = new DataView(buffer);
    view.setBigUint64(0, 1n << 63n);
    view.setUint32(8, payload.length);
    new Uint8Array(buffer, 12).set(payload);
    return buffer;
  })() });
  browser.FakeVideoDecoder.latest.emit();
  assert.equal(browser.element('screen').hidden, false);
  assert.ok(browser.keyButtons.every(button => !button.disabled));
  assert.equal(browser.element('message').getAttribute('aria-live'), 'polite');
  assert.ok(emptyAfterConnect >= 1);
});

test('browser timeout and failure stay off connected and do not enable controls', async () => {
  const browser = loadBrowser();
  const socket = await startConnect(browser);
  socket.onopen();
  socket.receive({ type: 'status', state: 'connecting', message: CONNECTION_PROGRESS.openingStream });
  socket.receive({ type: 'status', state: 'error', message: 'Connection timed out. Check wireless debugging and reconnect.' });
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('empty-message').textContent, /timed out/i);
  assert.ok(browser.keyButtons.every(button => button.disabled));
  assert.equal(browser.element('screen').hidden, true);
  assert.equal(socket.closed, true);

  const retry = loadBrowser();
  const retrySocket = await startConnect(retry);
  retrySocket.onopen();
  retrySocket.receive({ type: 'status', state: 'connecting', message: CONNECTION_PROGRESS.preparingConnection });
  retrySocket.receive({ type: 'status', state: 'error', message: 'Could not connect to the phone. Check the phone connection and local tool installation.' });
  assert.equal(retry.element('state').dataset.state, 'error');
  assert.ok(retry.keyButtons.every(button => button.disabled));
  assert.equal(retry.element('screen').hidden, true);
  retrySocket.receive({ type: 'status', state: 'connected', message: 'Connected' });
  retrySocket.receive({ type: 'video' });
  assert.equal(retry.element('state').dataset.state, 'error');
  assert.ok(retry.keyButtons.every(button => button.disabled));
});
