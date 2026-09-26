import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

async function until(check, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function withServer(run, serverPath = 'dist/droiddock/server.js', extraEnv = {}) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const peers = [];
  // An invalid serial fails before discovery or ADB, even if a local phone is configured.
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'invalid-test-serial', ...extraEnv },
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
  async function rejected(path, wsOrigin = origin) {
    const item = peer(path, wsOrigin);
    const [error] = await once(item.ws, 'error', { signal: AbortSignal.timeout(3000) });
    assert.match(error.message, /403/);
  }
  async function browserPost(action) {
    return fetch(`${origin}/api/${action}`, { method: 'POST', headers: { Origin: origin, 'X-DroidDock': '1' } });
  }
  try {
    await until(async () => {
      assert.equal(server.exitCode, null, `test server exited: ${output}`);
      try { return (await fetch(`${origin}/api/status`)).ok; } catch { return false; }
    }, 'isolated test server');
    await run({ origin, open, rejected, browserPost, status });
  } finally {
    for (const item of peers) item.ws.terminate();
    if (server.exitCode === null) server.kill();
    await exited;
  }
}

async function assertControlsSocket(item) {
  const count = item.messages.length;
  item.ws.send(JSON.stringify({ type: 'key', key: 'home' }));
  const response = await until(() => item.messages.slice(count).find(value => value.type === 'inputError'), 'current controller input response');
  assert.match(response.message, /Connect your phone first/);
  assert.equal(item.ws.readyState, WebSocket.OPEN);
}

test('explicit takeover moves the old controller while legacy and foreign sockets cannot take control', { timeout: 15000 }, async () => {
  await withServer(async ({ open, rejected, status }) => {
    const old = await open();
    await rejected('/stream');
    await rejected('/stream?takeover=1', 'https://evil.example');
    assert.equal(old.ws.readyState, WebSocket.OPEN);
    assert.equal(old.messages.some(value => value.type === 'moved'), false);
    await assertControlsSocket(old);

    const replacement = await open('/stream?takeover=1');
    await until(() => old.close, 'old controller close');
    assert.equal(old.close.code, 4001);
    assert.deepEqual(old.messages.filter(value => value.type === 'moved'), [{ type: 'moved', message: 'Phone opened elsewhere.' }]);
    // An old close callback must not clear the replacement or stop its session.
    assert.equal((await status()).state, 'idle');
    await assertControlsSocket(replacement);
    await rejected('/stream');
  });
});

test('browser HTTP commands cannot change ownership state and current socket commands still work', { timeout: 15000 }, async () => {
  await withServer(async ({ open, browserPost, status }) => {
    const old = await open();
    const replacement = await open('/stream?takeover=1');
    await until(() => old.close, 'displaced browser close');
    const initial = await status();
    assert.equal((await browserPost('connect')).status, 409);
    assert.deepEqual(await status(), initial);

    replacement.ws.send(JSON.stringify({ type: 'connect' }));
    await until(() => replacement.messages.find(value => value.type === 'status' && value.state === 'connecting'), 'socket connect command');
    await until(async () => (await status()).state === 'error', 'safe invalid-serial failure');
    const failed = await status();
    assert.match(failed.message, /Invalid device serial/);
    // The stale page's same-origin headers are indistinguishable from any other page.
    assert.equal((await browserPost('disconnect')).status, 409);
    assert.deepEqual(await status(), failed);
    assert.equal((await browserPost('connect')).status, 409);
    assert.deepEqual(await status(), failed);

    replacement.ws.send(JSON.stringify({ type: 'disconnect' }));
    await until(async () => (await status()).state === 'idle', 'socket disconnect command');
    await assertControlsSocket(replacement);
  });
});

test('near-simultaneous takeover chain leaves exactly one controller after all displaced sockets close', { timeout: 15000 }, async () => {
  await withServer(async ({ open, rejected, status }) => {
    const first = await open();
    const challengers = await Promise.all(Array.from({ length: 3 }, () => open('/stream?takeover=1')));
    const peers = [first, ...challengers];
    await until(() => peers.filter(item => item.close).length === peers.length - 1, 'all displaced sockets to close');
    const owners = peers.filter(item => item.ws.readyState === WebSocket.OPEN);
    assert.equal(owners.length, 1);
    assert.notEqual(owners[0], first);
    for (const item of peers.filter(item => item !== owners[0])) {
      assert.equal(item.close.code, 4001);
      assert.deepEqual(item.messages.filter(value => value.type === 'moved'), [{ type: 'moved', message: 'Phone opened elsewhere.' }]);
    }
    assert.equal(owners[0].messages.some(value => value.type === 'moved'), false);
    await assertControlsSocket(owners[0]);
    assert.equal((await status()).state, 'idle');
    await rejected('/stream');
    await rejected('/stream?takeover=1', 'https://evil.example');
    await assertControlsSocket(owners[0]);
  });
});

test('handoff during session startup ignores obsolete callbacks and stale socket commands', { timeout: 15000 }, async () => {
  const fixtureBase = resolve('.setup');
  await mkdir(fixtureBase, { recursive: true });
  const fixture = await mkdtemp(join(fixtureBase, 'handoff-test-'));
  const fixtureDist = join(fixture, 'dist/droiddock');
  try {
    await mkdir(fixtureDist, { recursive: true });
    for (const name of ['server.js', 'config.js', 'protocol.js', 'lock-state.js', 'file-paste.js', 'pairing.js']) {
      await copyFile(join('dist/droiddock', name), join(fixtureDist, name));
    }
    await copyFile('dist/process.js', join(fixture, 'dist/process.js'));
    // File gates make startup and late callbacks deterministic without touching the
    // real built session module or starting any discovery/ADB child process.
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
          this.onProgress(CONNECTION_PROGRESS.preparingConnection);
          this.onProgress(CONNECTION_PROGRESS.openingStream);
          if (this.id === 1) await this.gate('release-start');
          this.onEvent({ type: 'video', sessionId: this.id });
          if (this.id === 1) this.onFailure('Obsolete startup failure');
        }
        input(value) {
          this.onEvent({ type: 'video', sessionId: this.id, input: value.type });
        }
        async stop() {
          await this.log('stop:' + this.id);
          if (this.id === 1) void this.lateCallbacks();
        }
        async lateCallbacks() {
          await this.gate('release-callbacks');
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
          this.onEvent({ type: 'video', sessionId: this.id });
          this.onFailure('Obsolete session failure');
          await this.log('callbacks-finished');
        }
      }
    `);
    await withServer(async ({ origin, open, status, browserPost }) => {
      const old = await open();
      old.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await status()).state === 'connecting', 'old startup');
      await until(async () => (await status()).message === 'Opening the video stream…', 'old session stage');
      await until(async () => {
        try { return (await readFile(join(fixture, 'events.log'), 'utf8')).includes('start:1'); } catch { return false; }
      }, 'stub session startup');
      old.ws.on('message', data => {
        if (JSON.parse(data.toString()).type === 'moved' && old.ws.readyState === WebSocket.OPEN) {
          for (const type of ['disconnect', 'connect', 'key']) old.ws.send(JSON.stringify({ type, key: 'home' }));
        }
      });
      const replacement = await open('/stream?takeover=1');
      replacement.ws.send(JSON.stringify({ type: 'connect' }));
      await until(() => old.close, 'obsolete socket close during startup');
      assert.equal(old.close.code, 4001);
      assert.equal((await status()).state, 'connecting');
      await writeFile(join(fixture, 'release-start'), '');
      await until(() => replacement.messages.some(value => value.type === 'video' && value.sessionId === 2), 'replacement session startup');
      assert.equal((await status()).state, 'connected');
      assert.deepEqual((await readFile(join(fixture, 'events.log'), 'utf8')).trim().split('\n'), ['start:1', 'stop:1', 'start:2']);

      const connected = await status();
      assert.equal((await browserPost('connect')).status, 409);
      assert.equal((await browserPost('disconnect')).status, 409);
      for (const action of ['connect', 'disconnect']) {
        const response = await fetch(`${origin}/api/${action}`, {
          method: 'POST', headers: { 'X-DroidDock': '1', 'Sec-Fetch-Site': 'same-origin' },
        });
        assert.equal(response.status, 409);
      }
      assert.deepEqual(await status(), connected);
      await writeFile(join(fixture, 'release-callbacks'), '');
      await until(async () => (await readFile(join(fixture, 'events.log'), 'utf8')).includes('callbacks-finished'), 'obsolete callbacks');
      assert.deepEqual(await status(), connected);
      const statuses = replacement.messages.filter(value => value.type === 'status');
      const connectedAt = statuses.findIndex(value => value.state === 'connected');
      assert.ok(connectedAt >= 0);
      assert.equal(statuses.slice(connectedAt + 1).some(value => value.state === 'connecting' || value.state === 'error' || value.type === 'video'), false);
      assert.equal(replacement.messages.some(value => value.type === 'video' && value.sessionId === 1), false);
      assert.equal(replacement.messages.some(value => value.type === 'inputError' || value.input), false);
      replacement.ws.send(JSON.stringify({ type: 'key', key: 'home' }));
      await until(() => replacement.messages.some(value => value.sessionId === 2 && value.input === 'key'), 'new owner input');
      replacement.ws.send(JSON.stringify({ type: 'disconnect' }));
      await until(async () => (await status()).state === 'idle', 'new owner disconnect');
    }, join(fixtureDist, 'server.js'));
  } finally {
    assert.ok(fixture.startsWith(fixtureBase + '\\') || fixture.startsWith(fixtureBase + '/'));
    await rm(fixture, { recursive: true, force: true });
  }
});

async function withSessionFixture(name, sessionSource, run, extraEnv = {}) {
  const fixtureBase = resolve('.setup');
  await mkdir(fixtureBase, { recursive: true });
  const fixture = await mkdtemp(join(fixtureBase, name));
  const fixtureDist = join(fixture, 'dist/droiddock');
  try {
    await mkdir(fixtureDist, { recursive: true });
    for (const file of ['server.js', 'config.js', 'protocol.js', 'lock-state.js', 'file-paste.js', 'pairing.js']) {
      await copyFile(join('dist/droiddock', file), join(fixtureDist, file));
    }
    await copyFile('dist/process.js', join(fixture, 'dist/process.js'));
    await writeFile(join(fixtureDist, 'session.js'), sessionSource);
    await run(fixture, join(fixtureDist, 'server.js'), extraEnv);
  } finally {
    assert.ok(fixture.startsWith(fixtureBase + '\\') || fixture.startsWith(fixtureBase + '/'));
    await rm(fixture, { recursive: true, force: true });
  }
}

const progressExports = `
      export const CONNECTION_PROGRESS = {
        findingPhone: 'Finding the configured phone…',
        preparingConnection: 'Preparing the phone connection…',
        openingStream: 'Opening the video stream…',
      };
`;

test('disconnect ignores delayed progress callbacks and stays off the connected state', { timeout: 15000 }, async () => {
  await withSessionFixture('progress-disconnect-', `
      import { access, appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      ${progressExports}
      export class ScrcpySession {
        constructor(root, onEvent, onFailure, onProgress = () => {}) {
          Object.assign(this, { root, onEvent, onFailure, onProgress });
        }
        async log(event) { await appendFile(join(this.root, 'events.log'), event + '\\n'); }
        async gate(name) {
          while (true) { try { await access(join(this.root, name)); return; } catch { await delay(10); } }
        }
        async start(signal) {
          await this.log('start');
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
          await new Promise((_, reject) => {
            const fail = () => reject(Object.assign(new Error('Connection cancelled.'), { name: 'AbortError' }));
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          });
        }
        input() { throw new Error('Connect your phone first.'); }
        async stop() {
          await this.log('stop');
          void this.lateCallbacks();
        }
        async lateCallbacks() {
          await this.gate('release-callbacks');
          this.onProgress(CONNECTION_PROGRESS.openingStream);
          this.onEvent({ type: 'video', sessionId: 1 });
          this.onFailure('Obsolete disconnected failure');
          await this.log('callbacks-finished');
        }
      }
    `, async (fixture, serverPath) => {
    await withServer(async ({ open, status }) => {
      const item = await open();
      item.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await status()).message === 'Finding the configured phone…', 'disconnect fixture startup');
      item.ws.send(JSON.stringify({ type: 'disconnect' }));
      await until(async () => (await status()).state === 'idle', 'disconnect cleanup');
      const idle = await status();
      await writeFile(join(fixture, 'release-callbacks'), '');
      await until(async () => {
        try { return (await readFile(join(fixture, 'events.log'), 'utf8')).includes('callbacks-finished'); } catch { return false; }
      }, 'delayed disconnect callbacks');
      assert.deepEqual(await status(), idle);
      assert.equal(idle.state, 'idle');
      assert.equal(item.messages.some(value => value.type === 'video'), false);
      assert.equal(item.messages.some(value => value.state === 'connected'), false);
    }, serverPath);
  });
});

test('startup timeout stays in error and ignores late progress or video', { timeout: 15000 }, async () => {
  await withSessionFixture('progress-timeout-', `
      import { access, appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      ${progressExports}
      export class ScrcpySession {
        constructor(root, onEvent, onFailure, onProgress = () => {}) {
          Object.assign(this, { root, onEvent, onFailure, onProgress });
        }
        async log(event) { await appendFile(join(this.root, 'events.log'), event + '\\n'); }
        async gate(name) {
          while (true) { try { await access(join(this.root, name)); return; } catch { await delay(10); } }
        }
        async start(signal) {
          await this.log('start');
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
          await new Promise((_, reject) => {
            const fail = () => reject(Object.assign(new Error('Connection cancelled.'), { name: 'AbortError' }));
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          });
        }
        input() { throw new Error('Connect your phone first.'); }
        async stop() {
          await this.log('stop');
          void this.lateCallbacks();
        }
        async lateCallbacks() {
          await this.gate('release-callbacks');
          this.onProgress(CONNECTION_PROGRESS.openingStream);
          this.onEvent({ type: 'video', sessionId: 1 });
          this.onFailure('Late timeout failure');
          await this.log('callbacks-finished');
        }
      }
    `, async (fixture, serverPath, extraEnv) => {
    await withServer(async ({ open, status }) => {
      const item = await open();
      item.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await status()).state === 'error', 'startup timeout');
      const failed = await status();
      assert.match(failed.message, /timed out/i);
      assert.equal(failed.state, 'error');
      assert.equal(item.messages.some(value => value.state === 'connected' || value.type === 'video'), false);
      await writeFile(join(fixture, 'release-callbacks'), '');
      await until(async () => {
        try { return (await readFile(join(fixture, 'events.log'), 'utf8')).includes('callbacks-finished'); } catch { return false; }
      }, 'late timeout callbacks');
      assert.deepEqual(await status(), failed);
      assert.equal(item.messages.some(value => value.state === 'connected' || value.type === 'video'), false);
    }, serverPath, extraEnv);
  }, { DROIDDOCK_STARTUP_TIMEOUT_MS: '80' });
});

test('startup failure reports error without a connected or rendered state', { timeout: 15000 }, async () => {
  await withSessionFixture('progress-failure-', `
      ${progressExports}
      export class ScrcpySession {
        constructor(root, onEvent, onFailure, onProgress = () => {}) {
          Object.assign(this, { root, onEvent, onFailure, onProgress });
        }
        async start() {
          this.onProgress(CONNECTION_PROGRESS.findingPhone);
          this.onProgress(CONNECTION_PROGRESS.preparingConnection);
          this.onProgress(CONNECTION_PROGRESS.openingStream);
          throw new Error('Could not connect to the phone. Check the phone connection and local tool installation.');
        }
        input() { throw new Error('Connect your phone first.'); }
        async stop() {}
      }
    `, async (_fixture, serverPath) => {
    await withServer(async ({ open, status }) => {
      const item = await open();
      item.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await status()).state === 'error', 'startup failure');
      const failed = await status();
      assert.match(failed.message, /Could not connect to the phone/);
      assert.equal(failed.state, 'error');
      assert.equal(item.messages.some(value => value.state === 'connected' || value.type === 'video'), false);
      const stages = [...new Set(item.messages.filter(value => value.type === 'status' && value.state === 'connecting').map(value => value.message))];
      assert.deepEqual(stages.slice(0, 3), [
        'Finding the configured phone…',
        'Preparing the phone connection…',
        'Opening the video stream…',
      ]);
      assert.ok(stages.every(message => [
        'Finding the configured phone…',
        'Preparing the phone connection…',
        'Opening the video stream…',
        'Disconnecting and cleaning up the phone connection…',
      ].includes(message)));
    }, serverPath);
  });
});

test('takeover cancels a pending lock read and the replacement must subscribe independently', { timeout: 15000 }, async () => {
  await withSessionFixture('lock-handoff-', `
    import { appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    let nextId = 0;
    export class ScrcpySession {
      constructor(root, onEvent) { Object.assign(this, { root, onEvent, id: ++nextId }); }
      async start() { this.onEvent({ type: 'video', sessionId: this.id }); }
      async stop() {}
      input(value) { this.onEvent({ type: 'video', sessionId: this.id, input: value.type }); }
      async readLockState(signal) {
        await appendFile(join(this.root, 'lock-events.log'), 'read:' + this.id + '\\n');
        if (this.id === 1) {
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          await appendFile(join(this.root, 'lock-events.log'), 'abort:' + this.id + '\\n');
          return 'locked-awake';
        }
        return 'unlocked';
      }
    }
  `, async (fixture, serverPath) => {
    await withServer(async ({ open, status }) => {
      const readEvents = async () => { try { return await readFile(join(fixture, 'lock-events.log'), 'utf8'); } catch { return ''; } };
      const first = await open();
      first.ws.send(JSON.stringify({ type: 'lockSubscription', enabled: true, visible: true }));
      first.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await readEvents()).includes('read:1'), 'first read');
      const replacement = await open('/stream?takeover=1');
      replacement.ws.send(JSON.stringify({ type: 'connect' }));
      await until(async () => (await status()).state === 'connected', 'replacement connection');
      await until(async () => (await readEvents()).includes('abort:1'), 'old lock read cancellation');
      await delay(2100);
      assert.equal((await readEvents()).includes('read:2'), false, 'new owner never inherits subscription');
      assert.equal(replacement.messages.some(value => value.type === 'lockState' && value.state === 'locked-awake'), false);
      replacement.ws.send(JSON.stringify({ type: 'lockSubscription', enabled: true, visible: true }));
      await until(() => replacement.messages.some(value => value.type === 'lockState' && value.state === 'unlocked'), 'replacement read');
      replacement.ws.send(JSON.stringify({ type: 'key', key: 'home' }));
      await until(() => replacement.messages.some(value => value.input === 'key'), 'phone control remains available');
      replacement.ws.send(JSON.stringify({ type: 'disconnect' }));
      await until(async () => (await status()).state === 'idle', 'cleanup');
    }, serverPath);
  });
});
