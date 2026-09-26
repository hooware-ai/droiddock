import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPairingEndpoint, pairConfiguredPhone } from '../../dist/droiddock/pairing.js';

const serial = 'SYNTHETICPHONE';
const address = '192.0.2.10';
const pairEndpoint = `${address}:37002`;
const services = `List of discovered mdns services\n  adb-${serial}-x _adb-tls-connect._tcp ${address}:37001\n  adb-guid-y _adb-tls-pairing._tcp ${pairEndpoint}`;
const devices = 'List of devices attached\n';
const success = `Enter pairing code: Successfully paired to ${pairEndpoint} [guid=adb-synthetic]`;

function fakeAdb({ deviceText = devices, serviceText = services, serviceCode = 0, pairCode = 0, pairOutput = success } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const action = args[0];
    const code = action === 'mdns' ? serviceCode : action === 'pair' ? pairCode : 0;
    const stdout = action === 'devices' ? deviceText : action === 'mdns' ? serviceText : pairOutput;
    return { command, args, code, stdout, stderr: '', durationMs: 1 };
  };
  return { calls, run };
}

test('one matching mDNS pairing service yields only a candidate endpoint', () => {
  assert.deepEqual(discoverPairingEndpoint(devices, services, serial), { kind: 'candidate', endpoint: pairEndpoint });
  assert.deepEqual(discoverPairingEndpoint(devices, 'List of discovered mdns services', serial), { kind: 'missing' });
  for (const sample of [
    `${services}\nadb-other _adb-tls-pairing._tcp ${address}:37003`,
    services.replace('192.0.2.10:37002', '192.0.2.11:37002'),
    services.replace('192.0.2.10:37002', '192.0.2.10:99999'),
    services.replace('192.0.2.10:37002', '192.0.2.010:37002'),
    services.replace('adb-guid-y _adb-tls-pairing', 'studio-qr-y _adb-tls-pairing'),
  ]) assert.deepEqual(discoverPairingEndpoint(devices, sample, serial), { kind: 'ambiguous' });
  assert.deepEqual(discoverPairingEndpoint(`${serial} unauthorized`, services, serial), { kind: 'ambiguous' });
});

test('pairing uses fixed ADB verbs and sends code only through stdin', async () => {
  const adb = fakeAdb();
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '012345' }, adb.run), 'paired');
  assert.deepEqual(adb.calls.map(call => call.args), [['devices', '-l'], ['mdns', 'services'], ['pair', pairEndpoint]]);
  assert.equal(adb.calls.every(call => call.command === 'synthetic-adb'), true);
  assert.equal(adb.calls.at(-1).options.input, '012345\n');
  assert.equal(adb.calls.slice(0, -1).every(call => call.options.input === undefined), true);
  for (const call of adb.calls) {
    assert.equal(JSON.stringify(call.args).includes('012345'), false);
    assert.equal(call.options.signal instanceof AbortSignal, true);
    assert.ok(call.options.timeoutMs <= 15_000);
    assert.ok(call.options.maxOutputBytes <= 32 * 1024);
  }
});

test('invalid and expired codes do not start ADB', async () => {
  const adb = fakeAdb();
  for (const code of ['', '12345', '1234567', '123 56', '１２３４５６']) {
    assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code }, adb.run), 'failed');
  }
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', expiresAtMs: Date.now() - 1 }, adb.run), 'expired');
  assert.equal(adb.calls.length, 0);
});

test('manual endpoint is a deliberate fallback, but cannot override contradictory mDNS', async () => {
  const absent = fakeAdb({ serviceText: 'List of discovered mdns services', serviceCode: 1 });
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456' }, absent.run), 'unavailable');
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', manualEndpoint: pairEndpoint }, absent.run), 'paired');
  const ambiguous = fakeAdb({ serviceText: `${services}\nadb-other _adb-tls-pairing._tcp ${address}:37003` });
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', manualEndpoint: pairEndpoint }, ambiguous.run), 'unavailable');
  const mismatch = fakeAdb();
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', manualEndpoint: `${address}:37004` }, mismatch.run), 'unavailable');
  const qr = fakeAdb({ serviceText: services.replace('adb-guid-y _adb-tls-pairing', 'studio-qr-y _adb-tls-pairing') });
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', manualEndpoint: pairEndpoint }, qr.run), 'unavailable');
  assert.equal(qr.calls.some(call => call.args[0] === 'pair'), false);
  const listed = fakeAdb({ deviceText: `${serial} unauthorized`, serviceCode: 1 });
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', manualEndpoint: pairEndpoint }, listed.run), 'unavailable');
  for (const endpoint of ['localhost:37002', '127.0.0.1:37002', '192.0.2.999:37002', '192.0.2.10:0', '192.0.2.10:37002 extra']) {
    const adb = fakeAdb({ serviceCode: 1 });
    assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', manualEndpoint: endpoint }, adb.run), 'unavailable');
    assert.equal(adb.calls.length, 0);
  }
});

test('failure, rejected output, output overflow and cancellation never retry or echo evidence', async () => {
  for (const settings of [
    { pairCode: 1, pairOutput: 'SYNTHETIC_PRIVATE_FAILED' },
    { pairCode: 0, pairOutput: 'Failed: SYNTHETIC_PRIVATE_OUTPUT' },
    { pairCode: 0, pairOutput: 'SYNTHETIC_PRIVATE_NO_SUCCESS' },
  ]) {
    const adb = fakeAdb(settings);
    assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456' }, adb.run), 'failed');
    assert.equal(adb.calls.filter(call => call.args[0] === 'pair').length, 1);
  }
  const calls = [];
  const overflow = async (command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'pair') throw new Error('SYNTHETIC_PRIVATE_OVERFLOW');
    return { command, args, code: 0, stdout: args[0] === 'devices' ? devices : services, stderr: '', durationMs: 1 };
  };
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456' }, overflow), 'unavailable');
  assert.equal(calls.filter(call => call.args[0] === 'pair').length, 1);
  assert.equal(calls.at(-1).options.maxOutputBytes, 4 * 1024);

  const controller = new AbortController();
  let pairStarted;
  const pairReady = new Promise(resolve => { pairStarted = resolve; });
  const waiting = (command, args, options) => new Promise((resolve, reject) => {
    if (args[0] !== 'pair') {
      resolve({ command, args, code: 0, stdout: args[0] === 'devices' ? devices : services, stderr: '', durationMs: 1 });
      return;
    }
    pairStarted();
    if (options.signal.aborted) { reject(new Error('SYNTHETIC_PRIVATE_ABORT')); return; }
    options.signal.addEventListener('abort', () => reject(new Error('SYNTHETIC_PRIVATE_ABORT')), { once: true });
  });
  const first = pairConfiguredPhone('synthetic-adb', serial, { code: '123456', signal: controller.signal }, waiting);
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '654321' }, waiting), 'unavailable', 'concurrent attempt is refused');
  await pairReady;
  controller.abort();
  assert.equal(await first, 'unavailable');
});

test('the fixed deadline and a supplied code expiry cancel a hanging attempt', async () => {
  const pending = (command, args, options) => new Promise((resolve, reject) => {
    if (args[0] !== 'pair') {
      resolve({ command, args, code: 0, stdout: args[0] === 'devices' ? devices : services, stderr: '', durationMs: 1 });
      return;
    }
    if (options.signal.aborted) { reject(new Error('SYNTHETIC_PRIVATE_TIMEOUT')); return; }
    options.signal.addEventListener('abort', () => reject(new Error('SYNTHETIC_PRIVATE_TIMEOUT')), { once: true });
  });
  const start = Date.now();
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', expiresAtMs: start + 40 }, pending), 'expired');
  assert.ok(Date.now() - start < 1000);
});

test('an expired code cannot start pairing when the event loop delays the timer', async () => {
  const calls = [];
  const blockedDiscovery = async (command, args) => {
    calls.push(args[0]);
    if (args[0] === 'mdns') {
      const until = Date.now() + 40;
      while (Date.now() < until) { /* simulate a blocked event loop */ }
    }
    return { command, args, code: 0, stdout: args[0] === 'devices' ? devices : services, stderr: '', durationMs: 1 };
  };
  assert.equal(await pairConfiguredPhone('synthetic-adb', serial, { code: '123456', expiresAtMs: Date.now() + 20 }, blockedDiscovery), 'expired');
  assert.deepEqual(calls, ['devices', 'mdns']);
});

test('late discovery and pair results cannot advance after cancellation', async () => {
  const controller = new AbortController();
  let finishDevices;
  let devicesStarted;
  const ready = new Promise(resolve => { devicesStarted = resolve; });
  const calls = [];
  const slowDiscovery = (command, args) => {
    calls.push(args[0]);
    devicesStarted();
    return new Promise(resolve => { finishDevices = () => resolve({ command, args, code: 0, stdout: devices, stderr: '', durationMs: 1 }); });
  };
  const attempt = pairConfiguredPhone('synthetic-adb', serial, { code: '123456', signal: controller.signal }, slowDiscovery);
  await ready;
  controller.abort();
  finishDevices();
  assert.equal(await attempt, 'unavailable');
  assert.deepEqual(calls, ['devices']);

  const next = new AbortController();
  let finishPair;
  let pairStarted;
  const pairReady = new Promise(resolve => { pairStarted = resolve; });
  const slowPair = (command, args) => {
    if (args[0] !== 'pair') return Promise.resolve({ command, args, code: 0, stdout: args[0] === 'devices' ? devices : services, stderr: '', durationMs: 1 });
    pairStarted();
    return new Promise(resolve => { finishPair = () => resolve({ command, args, code: 0, stdout: success, stderr: '', durationMs: 1 }); });
  };
  const late = pairConfiguredPhone('synthetic-adb', serial, { code: '123456', signal: next.signal }, slowPair);
  await pairReady;
  next.abort();
  finishPair();
  assert.equal(await late, 'unavailable');
});
