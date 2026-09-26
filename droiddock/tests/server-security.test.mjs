import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail('Timed out waiting for isolated bridge fixture');
}

// All sessions are file-gated stubs. These tests never discover or control devices.
async function fixture(t, implementation, filePasteImplementation) {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'security-test-'));
  const folder = join(root, 'dist/droiddock');
  await mkdir(folder, { recursive: true });
  for (const name of ['server.js', 'config.js', 'protocol.js', 'lock-state.js', 'file-paste.js']) await copyFile(join('dist/droiddock', name), join(folder, name));
  if (filePasteImplementation) await writeFile(join(folder, 'file-paste.js'), filePasteImplementation);
  await copyFile('dist/process.js', join(root, 'dist/process.js'));
  await writeFile(join(folder, 'session.js'), implementation);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(folder, 'server.js')], {
    env: { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'SYNTHETIC' },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  let ws;
  t.after(async () => {
    ws?.terminate();
    // Synthetic sessions may deliberately refuse cleanup, so SIGTERM can remain pending.
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    assert.ok(root.startsWith(base + '/') || root.startsWith(base + '\\'));
    await rm(root, { recursive: true, force: true });
    assert.doesNotMatch(output, /UnhandledPromiseRejection|uncaughtException/);
  });
  const status = async () => (await fetch(`${origin}/api/status`)).json();
  await until(async () => { try { return (await status()).app === 'DroidDock'; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin });
  ws.on('error', () => {});
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  return {
    root, origin, messages, status,
    send: type => ws.send(JSON.stringify({ type })),
    sendRaw: value => ws.send(value),
    reopen: async () => {
      const closed = once(ws, 'close');
      ws.close(); await closed;
      await until(async () => (await status()).state === 'error');
      ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin });
      const nextMessages = [];
      ws.on('error', () => {});
      ws.on('message', data => nextMessages.push(JSON.parse(data.toString())));
      await once(ws, 'open');
      await until(() => nextMessages.length);
      return nextMessages;
    },
    post: action => fetch(`${origin}/api/${action}`, { method: 'POST', headers: { 'X-DroidDock': '1' } }),
  };
}

test('bridge status redacts a failed device command', { timeout: 10000 }, async t => {
  const bridge = await fixture(t, `
    import { CommandError } from '../process.js';
    export class ScrcpySession {
      async start() { throw new CommandError({ command:'SYNTHETIC_PRIVATE_PATH', args:['SYNTHETIC_PRIVATE_SERIAL'], code:2, stdout:'SYNTHETIC_PRIVATE_STDOUT', stderr:'SYNTHETIC_PRIVATE_STDERR', durationMs:1 }); }
      async stop() {}
    }
  `);
  bridge.send('connect');
  const failed = await until(async () => { const value = await bridge.status(); return value.state === 'error' && value; });
  assert.match(failed.message, /device command failed/);
  assert.doesNotMatch(JSON.stringify([failed, bridge.messages]), /SYNTHETIC_PRIVATE/);
});

test('malformed controls never echo JSON parser excerpts', { timeout: 10000 }, async t => {
  const bridge = await fixture(t, 'export class ScrcpySession {}');
  bridge.sendRaw('{"SYNTHETIC_PRIVATE_INPUT" broken');
  const error = await until(() => bridge.messages.find(message => message.type === 'inputError'));
  assert.equal(error.message, 'Invalid JSON control message.');
  assert.doesNotMatch(JSON.stringify(bridge.messages), /SYNTHETIC_PRIVATE/);
});

test('rich paste requires current controller capability and releases the host staging file', { timeout: 10000 }, async t => {
  const bridge = await fixture(t, `
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export class ScrcpySession {
      constructor(root, onEvent) { Object.assign(this, { root, onEvent }); }
      async start() { this.onEvent({ type:'video', codec:'h264', width:1, height:1 }); }
      async pasteFile(path, mime) {
        const data = await readFile(path);
        await writeFile(join(this.root, 'paste-result.json'), JSON.stringify({ path, mime, bytes:[...data] }));
      }
      async stop() {}
    }
  `);
  bridge.send('connect');
  await until(async () => (await bridge.status()).state === 'connected');
  const token = await until(() => bridge.messages.find(message => message.type === 'pasteCapability')?.value);
  const url = `${bridge.origin}/api/paste-file`;
  const headers = { origin: bridge.origin, 'x-droiddock': '1', 'x-paste-capability': token, 'content-type': 'image/png' };
  assert.equal((await fetch(url, { method:'POST', headers: { ...headers, 'x-paste-capability':'0'.repeat(64) }, body:Buffer.from([1]) })).status, 403);
  assert.equal((await fetch(url, { method:'POST', headers, body:Buffer.from([1, 2, 3]) })).status, 200);
  const result = JSON.parse(await readFile(join(bridge.root, 'paste-result.json'), 'utf8'));
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.bytes, [1, 2, 3]);
  await assert.rejects(readFile(result.path));
});

test('cleanup retry reserves paste ownership before concurrent HTTP requests', { timeout: 10000 }, async t => {
  const bridge = await fixture(t, `
    export class ScrcpySession {
      constructor(root, onEvent) { this.onEvent = onEvent; }
      async start() { this.onEvent({ type:'video', codec:'h264', width:1, height:1 }); }
      async pasteFile() { return false; }
      async stop() {}
    }
  `, `
    export class PasteFileError extends Error { constructor(message, status) { super(message); this.status = status; } }
    export class HostPasteCleanup {
      pending = true;
      track() {}
      async retry() { await new Promise(done => setTimeout(done, 50)); this.pending = false; return true; }
    }
    export function pasteMime() { return 'image/png'; }
    export async function stagePasteFile(req) { for await (const chunk of req) {} return 'SYNTHETIC'; }
  `);
  bridge.send('connect');
  await until(async () => (await bridge.status()).state === 'connected');
  const token = await until(() => bridge.messages.find(message => message.type === 'pasteCapability')?.value);
  const headers = { origin: bridge.origin, 'x-droiddock': '1', 'x-paste-capability': token, 'content-type': 'image/png' };
  const url = `${bridge.origin}/api/paste-file`;
  const statuses = await Promise.all([1, 2].map(() => fetch(url, { method:'POST', headers, body:Buffer.from([1]) }).then(response => response.status)));
  assert.deepEqual(statuses.sort(), [200, 409]);
});

test('only the initial error greeting is marked as a snapshot, never current attempt failures', { timeout: 10000 }, async t => {
  const bridge = await fixture(t, `
    export class ScrcpySession {
      async start() { throw new Error('Could not connect to the phone.'); }
      async stop() { throw new Error('Cleanup temporarily unavailable.'); }
    }
  `);
  assert.equal((await until(() => bridge.messages[0])).snapshot, true);
  bridge.send('connect');
  await until(async () => (await bridge.status()).state === 'error');
  const messages = await bridge.reopen();
  assert.equal(messages[0].type, 'status');
  assert.equal(messages[0].state, 'error');
  assert.equal(messages[0].snapshot, true);
  bridge.send('connect');
  const error = await until(() => messages.slice(1).find(message => message.state === 'error'));
  assert.equal(error.snapshot, undefined);
  assert.match(error.message, /cleanup could not be confirmed/);
  assert.equal(messages.filter(message => message.snapshot).length, 1);
});

test('disconnect waits for cleanup and failed cleanup must succeed before reconnect', { timeout: 15000 }, async t => {
  const bridge = await fixture(t, `
    import { access, appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    export class ScrcpySession {
      constructor(root, onEvent) { Object.assign(this, {root,onEvent}); }
      async start() { await appendFile(join(this.root,'events.txt'),'start\\n'); this.onEvent({type:'video',codec:'h264',width:1,height:1}); }
      async stop() {
        await appendFile(join(this.root,'events.txt'),'stop\\n');
        while (true) { try { await access(join(this.root,'release-cleanup')); break; } catch { await delay(10); } }
        try { await access(join(this.root,'allow-cleanup')); } catch { throw new Error('SYNTHETIC_PRIVATE_CLEANUP_FAILURE'); }
      }
    }
  `);
  bridge.send('connect');
  await until(async () => (await bridge.status()).state === 'connected');
  let returned = false;
  const disconnected = bridge.post('disconnect').then(async response => { returned = true; return response.json(); });
  await until(async () => (await bridge.status()).message.includes('Disconnecting'));
  assert.equal((await bridge.status()).state, 'connecting');
  assert.equal(returned, false, 'disconnect must await actual cleanup');
  await writeFile(join(bridge.root, 'release-cleanup'), '');
  assert.equal((await disconnected).state, 'error');
  assert.doesNotMatch(JSON.stringify(await bridge.status()), /SYNTHETIC_PRIVATE/);
  const shutdown = await bridge.post('shutdown');
  assert.equal(shutdown.status, 409, 'shutdown cannot abandon retained resources');
  assert.match((await shutdown.json()).error, /cleanup could not be confirmed/);
  bridge.send('connect');
  await until(async () => (await readFile(join(bridge.root, 'events.txt'), 'utf8')).split('stop\n').length >= 3);
  await until(async () => (await bridge.status()).state === 'error');
  assert.equal((await readFile(join(bridge.root, 'events.txt'), 'utf8')).match(/start\n/g).length, 1, 'failed cleanup prevents a replacement session');
  await writeFile(join(bridge.root, 'allow-cleanup'), '');
  bridge.send('connect');
  await until(async () => (await bridge.status()).state === 'connected');
  assert.equal((await readFile(join(bridge.root, 'events.txt'), 'utf8')).match(/start\n/g).length, 2, 'successful retry permits reconnect');
  assert.equal((await (await bridge.post('disconnect')).json()).state, 'idle');
});

function commandStage(call) {
  if (call.file === 'pwsh') return 'discovery';
  if (call.args[2] === 'push') return 'push';
  if (call.args[2] === 'forward' && call.args[3] === 'tcp:0') return 'allocate';
  if (call.args.includes('--remove')) return 'remove';
  if (call.args[2] === 'shell' && call.args[3] === 'rm') return 'rm';
  if (call.args.includes('getprop')) return 'identity';
  if (call.args[0] === 'forward' && call.args[1] === '--list') return 'list';
  return 'other';
}

function syntheticProcessModule({ commandLog, releaseDir, consumeRelease = false, defaultHold = {} } = {}) {
  const logLine = commandLog
    ? `await appendFile(${JSON.stringify(commandLog)}, JSON.stringify({file,args}) + '\\n');`
    : '';
  const gate = releaseDir
    ? `
      if (state.hold[kind]) {
        const gateFile = ${JSON.stringify(join(releaseDir, 'release-'))} + kind;
        while (true) {
          try {
            await access(gateFile);
            ${consumeRelease ? 'await rm(gateFile);' : ''}
            break;
          } catch { await delay(10); }
        }
      }`
    : `
      if (state.hold[kind] && !state.released[kind]) await new Promise(resolve => { state.waiters[kind] = resolve; });`;
  return `
    import { access, appendFile, rm } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    export const state = {
      calls:[], forward:'', oldIdentity:null, newIdentity:'SYNTHETICPHONE', discovery:'NEW',
      failRemove:false, failRm:false, failPrivateRm:false, failBroadcast:false, allocationTimeout:false,
      hold:Object.assign(Object.create(null), ${JSON.stringify(defaultHold)}),
      waiters:Object.create(null), released:Object.create(null),
    };
    export function release(kind) { state.released[kind] = true; state.waiters[kind]?.(); }
    function kindOf(file, args) {
      if (file === 'pwsh') return 'discovery';
      if (args[2] === 'push') return 'push';
      if (args[2] === 'forward' && args[3] === 'tcp:0') return 'allocate';
      if (args.includes('--remove')) return 'remove';
      if (args[2] === 'shell' && args[3] === 'rm') return 'rm';
      return '';
    }
    export async function runChecked(file, args, options) {
      state.calls.push({file,args,options});
      ${logLine}
      const kind = kindOf(file, args);
      ${gate}
      if (file === 'pwsh') return {stdout:state.discovery};
      if (args.includes('dumpsys')) return {stdout:state.lockDump ?? ''};
      if (args[0] === 'forward' && args[1] === '--list') return {stdout:state.forward};
      const transport = args[1];
      if (args[2] === 'push') return {stdout:''};
      if (args[2] === 'forward' && args[3] === 'tcp:0') {
        state.forward += '\\n' + transport + ' tcp:45678 ' + args[4];
        if (state.allocationTimeout) throw new Error('Synthetic allocation timeout');
        return {stdout:'45678'};
      }
      if (args[2] === 'shell' && args[3] === 'getprop') {
        const identity = transport === 'OLD' ? state.oldIdentity : state.newIdentity;
        if (!identity) throw new Error('SYNTHETIC_PRIVATE_OFFLINE');
        return {stdout:identity};
      }
      if (args[2] === 'shell' && args[3] === 'pm' && args[4] === 'path') return {stdout:'package:/synthetic/helper.apk'};
      if (args[2] === 'shell' && args[3] === 'am' && args[4] === 'broadcast') return {stdout:'Broadcast completed: result=' + (state.failBroadcast ? '0' : '1')};
      if (args[2] === 'shell' && args[3] === 'run-as') {
        if (args[5] === 'rm' && state.failPrivateRm) throw new Error('SYNTHETIC_PRIVATE_HELPER_FILE_ERROR');
        return {stdout:''};
      }
      if (args[2] === 'forward' && args[3] === '--remove') {
        if (state.failRemove) throw new Error('SYNTHETIC_PRIVATE_FORWARD_ERROR');
        state.forward = state.forward.split('\\n').filter(line => line.trim().split(' ')[1] !== args[4]).join('\\n');
        return {stdout:''};
      }
      if (args[2] === 'shell' && args[3] === 'rm') {
        if (state.failRm) throw new Error('SYNTHETIC_PRIVATE_FILE_ERROR');
        return {stdout:''};
      }
      throw new Error('Unexpected synthetic command');
    }
  `;
}

async function installVendor(root) {
  const vendor = join(root, 'droiddock/vendor/scrcpy-4.1');
  await mkdir(vendor, { recursive: true });
  await copyFile('droiddock/vendor/scrcpy-4.1/scrcpy-server', join(vendor, 'scrcpy-server'));
}

async function sessionFixture(t, { vendor = false } = {}) {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'cleanup-test-'));
  const folder = join(root, 'dist/droiddock');
  await mkdir(folder, { recursive: true });
  for (const name of ['session.js', 'protocol.js', 'lock-state.js']) await copyFile(join('dist/droiddock', name), join(folder, name));
  await writeFile(join(folder, 'config.js'), `export const config = { adb:'SYNTHETIC_ADB', deviceSerial:'SYNTHETICPHONE' };`);
  await writeFile(join(root, 'dist/process.js'), syntheticProcessModule());
  if (vendor) await installVendor(root);
  t.after(async () => {
    assert.ok(root.startsWith(base + '/') || root.startsWith(base + '\\'));
    await rm(root, { recursive: true, force: true });
  });
  const { ScrcpySession } = await import(pathToFileURL(join(folder, 'session.js')));
  const processModule = await import(pathToFileURL(join(root, 'dist/process.js')));
  const { config } = await import(pathToFileURL(join(folder, 'config.js')));
  const session = new ScrcpySession(root, () => {}, () => {});
  return { root, folder, state: processModule.state, release: processModule.release, config, session };
}

async function readCommandLog(root) {
  try {
    return (await readFile(join(root, 'commands.log'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

async function startupBridge(t) {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'startup-cancel-'));
  const folder = join(root, 'dist/droiddock');
  await mkdir(folder, { recursive: true });
  for (const name of ['server.js', 'session.js', 'config.js', 'protocol.js', 'lock-state.js', 'file-paste.js']) {
    await copyFile(join('dist/droiddock', name), join(folder, name));
  }
  await writeFile(join(root, 'dist/process.js'), syntheticProcessModule({
    commandLog: join(root, 'commands.log'),
    releaseDir: root,
    consumeRelease: true,
    defaultHold: { push: true, allocate: true, rm: true },
  }));
  await installVendor(root);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(folder, 'server.js')], {
    env: { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'SYNTHETICPHONE', DROIDDOCK_ADB: 'SYNTHETIC_ADB' },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  let ws;
  t.after(async () => {
    ws?.terminate();
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    assert.ok(root.startsWith(base + '/') || root.startsWith(base + '\\'));
    await rm(root, { recursive: true, force: true });
    assert.doesNotMatch(output, /UnhandledPromiseRejection|uncaughtException/);
  });
  const status = async () => (await fetch(`${origin}/api/status`)).json();
  await until(async () => { try { return (await status()).app === 'DroidDock'; } catch { return false; } });
  ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin });
  ws.on('error', () => {});
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  return {
    root, messages, status,
    send: type => ws.send(JSON.stringify({ type })),
    commands: () => readCommandLog(root),
    release: kind => writeFile(join(root, 'release-' + kind), ''),
  };
}

test('cleanup follows the original permanent identity to a changed wireless endpoint', async t => {
  const { session, state, config } = await sessionFixture(t);
  Object.assign(session, { transport:'OLD', forwardTransport:'OLD', port:45678, remoteMayExist:true });
  state.forward = `OLD tcp:45678 localabstract:scrcpy_${session.scid}\n`;
  config.deviceSerial = 'SYNTHETIC_DIFFERENT_CONFIGURATION';
  await session.stop();
  const discovery = state.calls.find(call => call.file === 'pwsh');
  assert.equal(discovery.args[discovery.args.indexOf('-DeviceSerial') + 1], 'SYNTHETICPHONE');
  assert.equal(session.transport, 'NEW');
  assert.deepEqual(state.calls.filter(call => call.args.includes('--remove')).map(call => call.args), [['-s','NEW','forward','--remove','tcp:45678']]);
  assert.deepEqual(state.calls.filter(call => call.args.includes('rm')).map(call => call.args), [['-s','NEW','shell','rm','-f',session.remote]]);
  assert.equal(session.port, 0);
  assert.equal(session.remoteMayExist, false);
});

test('cleanup never removes a reused forward and refuses a different phone', async t => {
  const { session, state } = await sessionFixture(t);
  Object.assign(session, { transport:'OLD', forwardTransport:'OLD', port:45678, remoteMayExist:true });
  state.forward = 'OTHER tcp:45678 localabstract:unrelated\n';
  state.oldIdentity = 'SYNTHETIC_OTHER_PHONE';
  state.newIdentity = 'SYNTHETIC_OTHER_PHONE';
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(session.stop(), /cleanup could not be confirmed/);
  assert.equal(state.calls.some(call => call.args.includes('--remove') || call.args.includes('rm')), false);
  assert.equal(session.remoteMayExist, true);
  state.newIdentity = 'SYNTHETICPHONE';
  await session.stop();
  assert.equal(state.calls.some(call => call.args.includes('--remove')), false);
  assert.equal(state.calls.filter(call => call.args.includes('rm')).length, 1);
  assert.equal(session.remoteMayExist, false);
});

test('failed forward cleanup remains tracked even after transport rediscovery', async t => {
  const { session, state } = await sessionFixture(t);
  Object.assign(session, { transport:'OLD', forwardTransport:'OLD', port:45678, remoteMayExist:true });
  state.forward = `OLD tcp:45678 localabstract:scrcpy_${session.scid}\n`;
  state.failRemove = true;
  await assert.rejects(session.stop(), /cleanup could not be confirmed/);
  assert.equal(session.transport, 'NEW');
  assert.equal(session.port, 45678);
  assert.equal(session.forwardTransport, 'OLD');
  state.failRemove = false;
  await session.stop();
  assert.equal(state.calls.filter(call => call.args.includes('--remove')).length, 2);
  assert.equal(session.port, 0);
  assert.equal(session.remoteMayExist, false);
});

test('already removed forward needs no removal and failed remote cleanup can retry', async t => {
  const { session, state } = await sessionFixture(t);
  Object.assign(session, { transport:'OLD', forwardTransport:'OLD', port:45678, remoteMayExist:true });
  state.failRm = true;
  await assert.rejects(session.stop(), /cleanup could not be confirmed/);
  assert.equal(session.port, 0);
  assert.equal(session.remoteMayExist, true);
  state.failRm = false;
  await session.stop();
  assert.equal(state.calls.some(call => call.args.includes('--remove')), false);
  assert.equal(state.calls.filter(call => call.args.includes('rm')).length, 2);
  assert.equal(session.remoteMayExist, false);
});

test('allocation timeout recovers only the exact owned forward when the returned port is unknown', async t => {
  const { session, state } = await sessionFixture(t, { vendor: true });
  state.forward = [
    'NEW tcp:12345 localabstract:unrelated',
    `OTHER tcp:23456 localabstract:scrcpy_${session.scid}`,
  ].join('\n');
  const unrelated = state.forward;
  state.allocationTimeout = true;
  await assert.rejects(session.start(new AbortController().signal), /allocation timeout/);
  assert.equal(session.port, 0);
  assert.equal(session.forwardMayExist, true);
  await session.stop();
  assert.deepEqual(state.calls.filter(call => call.args.includes('--remove')).map(call => call.args), [['-s','NEW','forward','--remove','tcp:45678']]);
  assert.equal(state.forward, unrelated);
  assert.equal(session.port, 0);
  assert.equal(session.forwardMayExist, false);
  assert.equal(session.remoteMayExist, false);
});

test('ambiguous allocation never removes another transport or another remote socket', async t => {
  const { session, state } = await sessionFixture(t);
  Object.assign(session, { transport:'OLD', forwardTransport:'OLD', forwardMayExist:true, port:0 });
  state.forward = [
    'OLD tcp:12345 localabstract:unrelated',
    `OTHER tcp:23456 localabstract:scrcpy_${session.scid}`,
  ].join('\n');
  await session.stop();
  assert.deepEqual(state.calls.map(call => call.args), [['forward','--list']]);
  assert.equal(session.forwardMayExist, false);
});

test('missing vendor errors are redacted and startup before push owns no device cleanup', async t => {
  const { session, state, root } = await sessionFixture(t);
  await assert.rejects(session.start(new AbortController().signal), error => {
    assert.match(error.message, /pinned scrcpy server could not be read/);
    assert.equal(error.message.includes(root), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  await session.stop();
  assert.deepEqual(state.calls, []);
});

test('malformed configuration never retains a parser cause containing private text', async t => {
  const { root, folder } = await sessionFixture(t);
  await copyFile('dist/droiddock/config.js', join(folder, 'invalid-config.js'));
  await writeFile(join(root, 'config.local.json'), '{"SYNTHETIC_PRIVATE_CONFIGURATION" broken');
  await assert.rejects(import(pathToFileURL(join(folder, 'invalid-config.js'))), error => {
    assert.match(error.message, /Invalid config.local.json/);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('already-aborted startup never issues a device command', async t => {
  const { session, state } = await sessionFixture(t, { vendor: true });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(session.start(abort.signal), error => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.deepEqual(state.calls, []);
  await session.stop();
  assert.deepEqual(state.calls, []);
  assert.equal(session.child, undefined);
  assert.equal(session.remoteMayExist, false);
  assert.equal(session.forwardMayExist, false);
});

test('cancel during discovery prevents the later vendor push after discovery settles', async t => {
  const { session, state, release } = await sessionFixture(t, { vendor: true });
  state.hold.discovery = true;
  const abort = new AbortController();
  const started = session.start(abort.signal);
  const discovery = await until(() => state.calls.find(call => commandStage(call) === 'discovery'));
  assert.match(discovery.args[discovery.args.indexOf('-DeviceSerial') + 1], /^SYNTHETICPHONE$/);
  abort.abort();
  assert.deepEqual(state.calls.map(commandStage), ['discovery']);
  release('discovery');
  await assert.rejects(started, error => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.deepEqual(state.calls.map(commandStage), ['discovery', 'identity']);
  assert.equal(session.remoteMayExist, false);
  await session.stop();
  assert.deepEqual(state.calls.map(commandStage), ['discovery', 'identity']);
  assert.equal(state.calls.some(call => ['push', 'allocate', 'remove', 'rm'].includes(commandStage(call))), false);
});

test('cancel during push prevents tunnel allocation and cleans only the session-owned remote file', async t => {
  const { session, state, release } = await sessionFixture(t, { vendor: true });
  state.hold.push = true;
  state.forward = 'NEW tcp:12345 localabstract:unrelated\nOTHER tcp:23456 localabstract:scrcpy_deadbeef';
  const unrelated = state.forward;
  const abort = new AbortController();
  const started = session.start(abort.signal);
  const pushed = await until(() => state.calls.find(call => commandStage(call) === 'push'));
  abort.abort();
  assert.deepEqual(state.calls.map(commandStage), ['discovery', 'identity', 'push']);
  assert.equal(pushed.args.at(-1), session.remote);
  release('push');
  await assert.rejects(started, error => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.deepEqual(state.calls.map(commandStage), ['discovery', 'identity', 'push']);
  assert.equal(session.remoteMayExist, true);
  assert.equal(session.forwardMayExist, false);
  assert.equal(session.child, undefined);
  await session.stop();
  assert.deepEqual(state.calls.map(commandStage), ['discovery', 'identity', 'push', 'identity', 'rm']);
  assert.deepEqual(state.calls.filter(call => commandStage(call) === 'rm').map(call => call.args), [['-s', 'NEW', 'shell', 'rm', '-f', session.remote]]);
  assert.equal(state.calls.some(call => commandStage(call) === 'allocate' || commandStage(call) === 'remove'), false);
  assert.equal(state.forward, unrelated);
  assert.equal(session.remoteMayExist, false);
});

test('cancel during tunnel allocation prevents scrcpy launch and cleans the exact owned forward and file', async t => {
  const { session, state, release } = await sessionFixture(t, { vendor: true });
  state.hold.allocate = true;
  state.forward = [
    'NEW tcp:12345 localabstract:unrelated',
    `OTHER tcp:23456 localabstract:scrcpy_${session.scid}`,
  ].join('\n');
  const unrelated = state.forward;
  const abort = new AbortController();
  const started = session.start(abort.signal);
  const allocated = await until(() => state.calls.find(call => commandStage(call) === 'allocate'));
  abort.abort();
  assert.equal(session.child, undefined);
  assert.deepEqual(allocated.args, ['-s', 'NEW', 'forward', 'tcp:0', `localabstract:scrcpy_${session.scid}`]);
  release('allocate');
  await assert.rejects(started, error => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(session.child, undefined);
  assert.equal(session.port, 45678);
  assert.equal(session.forwardMayExist, true);
  assert.equal(session.forwardTransport, 'NEW');
  await session.stop();
  assert.deepEqual(state.calls.map(commandStage), ['discovery', 'identity', 'push', 'allocate', 'list', 'identity', 'remove', 'rm']);
  assert.deepEqual(state.calls.filter(call => commandStage(call) === 'remove').map(call => call.args), [['-s', 'NEW', 'forward', '--remove', 'tcp:45678']]);
  assert.deepEqual(state.calls.filter(call => commandStage(call) === 'rm').map(call => call.args), [['-s', 'NEW', 'shell', 'rm', '-f', session.remote]]);
  assert.equal(state.forward, unrelated);
  assert.equal(session.child, undefined);
  assert.equal(session.port, 0);
  assert.equal(session.forwardMayExist, false);
  assert.equal(session.remoteMayExist, false);
});

test('replacement connect cannot start device work before cancelled startup and owned cleanup settle', { timeout: 15000 }, async t => {
  const bridge = await startupBridge(t);
  bridge.send('connect');
  const firstPush = await until(async () => (await bridge.commands()).find(call => commandStage(call) === 'push'));
  assert.equal(firstPush.args.at(-1).startsWith('/data/local/tmp/droiddock-'), true);
  assert.deepEqual((await bridge.commands()).map(commandStage), ['discovery', 'identity', 'push']);
  bridge.send('disconnect');
  await until(async () => (await bridge.status()).message.includes('Disconnecting'));
  bridge.send('connect');
  assert.deepEqual((await bridge.commands()).map(commandStage), ['discovery', 'identity', 'push']);
  await bridge.release('push');
  const cleanup = await until(async () => (await bridge.commands()).find(call => commandStage(call) === 'rm'));
  assert.deepEqual(cleanup.args, ['-s', 'NEW', 'shell', 'rm', '-f', firstPush.args.at(-1)]);
  assert.deepEqual((await bridge.commands()).map(commandStage), ['discovery', 'identity', 'push', 'identity', 'rm']);
  assert.equal((await bridge.commands()).filter(call => commandStage(call) === 'discovery').length, 1);
  assert.equal((await bridge.commands()).some(call => commandStage(call) === 'allocate' || commandStage(call) === 'remove'), false);
  await bridge.release('rm');
  await until(async () => (await bridge.commands()).filter(call => commandStage(call) === 'push').length === 2);
  assert.deepEqual((await bridge.commands()).map(commandStage), ['discovery', 'identity', 'push', 'identity', 'rm', 'discovery', 'identity', 'push']);
  assert.equal((await bridge.commands()).some(call => commandStage(call) === 'allocate'), false);
});

test('lock subscription is strictly typed, stays read-only and does not require a connected session', async t => {
  const bridge = await fixture(t, 'export class ScrcpySession {}');
  for (const value of [
    { type: 'lockSubscription', enabled: 'true', visible: true },
    { type: 'lockSubscription', enabled: true },
    { type: 'lockSubscription', enabled: true, visible: true, command: 'SYNTHETIC_PRIVATE' },
  ]) bridge.sendRaw(JSON.stringify(value));
  await until(() => bridge.messages.filter(value => value.type === 'inputError').length === 3);
  assert.ok(bridge.messages.filter(value => value.type === 'inputError').every(value => value.message === 'Invalid lock-state subscription.'));
  bridge.sendRaw(JSON.stringify({ type: 'lockSubscription', enabled: true, visible: true }));
  await until(() => bridge.messages.some(value => value.type === 'lockState'));
  assert.deepEqual(bridge.messages.filter(value => value.type === 'lockState'), [{ type: 'lockState', state: 'unknown', suspended: false }]);
  assert.equal((await bridge.status()).state, 'idle');
  assert.doesNotMatch(JSON.stringify(bridge.messages), /SYNTHETIC_PRIVATE/);
});

test('lock reads use only the verified session transport and bounded cancellable command', async t => {
  const { session, state } = await sessionFixture(t);
  const controller = new AbortController();
  assert.equal(await session.readLockState(controller.signal), 'unknown');
  assert.deepEqual(state.calls, []);
  session.transport = 'VERIFIED_SESSION_TRANSPORT';
  session.control = { destroyed: false };
  state.lockDump = '  KeyguardServiceDelegate\n    showing=true\n    occluded=false\n    screenState=SCREEN_STATE_ON\n    interactiveState=INTERACTIVE_STATE_AWAKE\n';
  assert.equal(await session.readLockState(controller.signal), 'locked-awake');
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0].args, ['-s', 'VERIFIED_SESSION_TRANSPORT', 'shell', 'dumpsys', 'window', 'policy']);
  assert.deepEqual(state.calls[0].options, { timeoutMs: 1000, maxOutputBytes: 64 * 1024, signal: controller.signal });
  session.closed = true;
  assert.equal(await session.readLockState(controller.signal), 'unknown');
  assert.equal(state.calls.length, 1);
});

test('failed paste staging cleanup survives disconnect and retries on the verified phone', async t => {
  const { session, state } = await sessionFixture(t);
  state.oldIdentity = 'SYNTHETICPHONE';
  session.transport = 'OLD';
  session.control = { destroyed:false, writableLength:0, write() {}, destroy() { this.destroyed = true; } };
  state.failRm = true;
  assert.equal(await session.pasteFile('SYNTHETIC_INPUT', 'image/png', new AbortController().signal), true,
    'successful delivery reports its unconfirmed cleanup');
  assert.equal(session.pasteCleanup.size, 1, 'failed transfer cleanup remains owned by session');
  const [id] = session.pasteCleanup.keys();
  const pushes = state.calls.filter(call => call.args.includes('push')).length;
  await assert.rejects(session.pasteFile('SYNTHETIC_INPUT', 'image/png', new AbortController().signal), /cleanup could not be confirmed/i);
  assert.equal(state.calls.filter(call => call.args.includes('push')).length, pushes,
    'a second upload cannot begin while device cleanup is unresolved');
  state.oldIdentity = null;
  await assert.rejects(session.stop(), /cleanup could not be confirmed/i);
  assert.equal(session.pasteCleanup.size, 1, 'disconnect cannot forget a device file');
  state.failRm = false;
  await session.stop();
  assert.equal(session.pasteCleanup.size, 0);
  assert.ok(state.calls.some(call => call.args.join(' ') === `-s NEW shell rm -f /data/local/tmp/droiddock-paste-${id}`));
});

test('partial helper-private paste file is retained for verified cleanup retry', async t => {
  const { session, state } = await sessionFixture(t);
  state.oldIdentity = 'SYNTHETICPHONE';
  session.transport = 'OLD';
  session.control = { destroyed:false, writableLength:0, write() {}, destroy() { this.destroyed = true; } };
  state.failBroadcast = true;
  state.failPrivateRm = true;
  await assert.rejects(session.pasteFile('SYNTHETIC_INPUT', 'image/png', new AbortController().signal), /prepare rich clipboard/i);
  assert.equal(session.pasteCleanup.size, 1);
  const [id, pending] = session.pasteCleanup.entries().next().value;
  assert.equal(pending.remote, false);
  assert.equal(pending.privateFile, true);
  state.oldIdentity = null;
  await assert.rejects(session.stop(), /cleanup could not be confirmed/i);
  state.failPrivateRm = false;
  await session.stop();
  assert.equal(session.pasteCleanup.size, 0);
  assert.ok(state.calls.some(call => call.args.join(' ') === `-s NEW shell run-as ai.hooware.droiddock.paste rm -f files/paste/${id}`));
});
