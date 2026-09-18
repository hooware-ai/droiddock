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
async function fixture(t, implementation) {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'security-test-'));
  const folder = join(root, 'dist/droiddock');
  await mkdir(folder, { recursive: true });
  for (const name of ['server.js', 'config.js', 'protocol.js']) await copyFile(join('dist/droiddock', name), join(folder, name));
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

async function sessionFixture(t) {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'cleanup-test-'));
  const folder = join(root, 'dist/droiddock');
  await mkdir(folder, { recursive: true });
  for (const name of ['session.js', 'protocol.js']) await copyFile(join('dist/droiddock', name), join(folder, name));
  await writeFile(join(folder, 'config.js'), `export const config = { adb:'SYNTHETIC_ADB', deviceSerial:'SYNTHETICPHONE' };`);
  await writeFile(join(root, 'dist/process.js'), `
    export const state = { calls:[], forward:'', oldIdentity:null, newIdentity:'SYNTHETICPHONE', discovery:'NEW', failRemove:false, failRm:false, allocationTimeout:false };
    export async function runChecked(file, args) {
      state.calls.push({file,args});
      if (file === 'pwsh') return {stdout:state.discovery};
      if (args[0] === 'forward' && args[1] === '--list') return {stdout:state.forward};
      const transport = args[1];
      if (args[2] === 'push') return {stdout:''};
      if (args[2] === 'forward' && args[3] === 'tcp:0' && state.allocationTimeout) {
        state.forward += '\\n' + transport + ' tcp:45678 ' + args[4];
        throw new Error('Synthetic allocation timeout');
      }
      if (args[2] === 'shell' && args[3] === 'getprop') {
        const identity = transport === 'OLD' ? state.oldIdentity : state.newIdentity;
        if (!identity) throw new Error('SYNTHETIC_PRIVATE_OFFLINE');
        return {stdout:identity};
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
  `);
  t.after(async () => {
    assert.ok(root.startsWith(base + '/') || root.startsWith(base + '\\'));
    await rm(root, { recursive: true, force: true });
  });
  const { ScrcpySession } = await import(pathToFileURL(join(folder, 'session.js')));
  const { state } = await import(pathToFileURL(join(root, 'dist/process.js')));
  const { config } = await import(pathToFileURL(join(folder, 'config.js')));
  const session = new ScrcpySession(root, () => {}, () => {});
  return { root, folder, state, config, session };
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
  const { session, state, root } = await sessionFixture(t);
  const vendor = join(root, 'droiddock/vendor/scrcpy-4.1');
  await mkdir(vendor, { recursive: true });
  await copyFile('droiddock/vendor/scrcpy-4.1/scrcpy-server', join(vendor, 'scrcpy-server'));
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
