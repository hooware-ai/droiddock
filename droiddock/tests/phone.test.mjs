import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneAction } from '../../scripts/phone.mjs';

function fixture(kind = 'ours', state = 'connected', buildId = 'current-build') {
  let service = { kind, status: { configurationId: 'expected', buildId, state, device: 'Test phone', message: 'Ready' } };
  const calls = [];
  return { calls, set: value => { service = value; }, options: {
    port: 3210, configurationId: 'expected', buildId: 'current-build', restartGuidance: 'SYNTHETIC RESTART NEEDED', inspect: async () => service,
    launch: async () => { calls.push('launch'); service = { kind: 'ours', status: { configurationId: 'expected', buildId: 'current-build', state: 'idle' } }; },
    request: async (url, options) => { calls.push({ url, options }); service.status.state = 'idle'; return { ok: true }; },
  } };
}

test('status and disconnect on a stopped service never launch it', async () => {
  const f = fixture('free');
  for (const action of ['status', 'disconnect']) assert.equal((await phoneAction(action, f.options)).running, false);
  assert.deepEqual(f.calls, []);
});
test('open starts a stopped service once and preserves existing connected sessions', async () => {
  const f = fixture('free');
  assert.equal((await phoneAction('open', f.options)).state, 'idle');
  assert.deepEqual(f.calls, ['launch']);
  const active = fixture();
  assert.equal((await phoneAction('open', active.options)).state, 'connected');
  assert.deepEqual(active.calls, []);
});
test('all actions reject other installations and changed configuration without mutations', async () => {
  for (const action of ['open', 'status', 'disconnect']) {
    const f = fixture('occupied');
    await assert.rejects(phoneAction(action, f.options), /another service/);
    f.set({ kind: 'ours', status: { configurationId: 'other' } });
    await assert.rejects(phoneAction(action, f.options), /different phone settings/);
    assert.deepEqual(f.calls, []);
  }
});
test('disconnect uses only the guarded endpoint and verifies idle state', async () => {
  const f = fixture();
  assert.equal((await phoneAction('disconnect', f.options)).state, 'idle');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:3210/api/disconnect');
  assert.equal(f.calls[0].options.headers['X-DroidDock'], '1');
  assert.equal(f.calls[0].options.redirect, 'error');
  f.options.request = async () => ({ ok: false });
  await assert.rejects(phoneAction('disconnect', f.options), /did not confirm/);
  f.options.request = async () => ({ ok: true });
  f.set({ kind: 'ours', status: { configurationId: 'expected', state: 'connected' } });
  await assert.rejects(phoneAction('disconnect', f.options), /could not be verified/);
});
test('invalid actions and ports fail before any service access', async () => {
  const options = { port: 3210, inspect: () => assert.fail('must not access service') };
  await assert.rejects(phoneAction('shell', options), /Choose/);
  await assert.rejects(phoneAction('open', { ...options, port: 0 }), /Invalid/);
});
test('open refuses a service from a different build without launching, stopping, or disconnecting it', async () => {
  // null models a service started before build identifiers existed.
  for (const build of ['older-build', null]) {
    const f = fixture('ours', 'connected', build);
    await assert.rejects(phoneAction('open', f.options), /SYNTHETIC RESTART NEEDED/);
    assert.deepEqual(f.calls, []);
  }
  const launched = fixture('free');
  launched.options.launch = async () => { launched.calls.push('launch'); launched.set({ kind: 'ours', status: { configurationId: 'expected', buildId: 'older-build', state: 'idle' } }); };
  await assert.rejects(phoneAction('open', launched.options), /SYNTHETIC RESTART NEEDED/);
  assert.deepEqual(launched.calls, ['launch']);
});
test('status and disconnect still settle a stale-build session and flag the restart', async () => {
  const f = fixture('ours', 'connected', 'older-build');
  const status = await phoneAction('status', f.options);
  assert.equal(status.state, 'connected');
  assert.equal(status.restartNeeded, true);
  assert.equal(status.next, 'SYNTHETIC RESTART NEEDED');
  assert.deepEqual(f.calls, []);
  const disconnected = await phoneAction('disconnect', f.options);
  assert.equal(disconnected.state, 'idle');
  assert.equal(disconnected.restartNeeded, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:3210/api/disconnect');
  const current = await phoneAction('status', fixture().options);
  assert.equal(current.restartNeeded, undefined);
  assert.equal(current.next, undefined);
});
