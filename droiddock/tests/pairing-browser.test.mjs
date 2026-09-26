import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrowser, startConnect, dispatchKey, keyEvent } from './accessibility.test.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

async function recovery() {
  const b = loadBrowser();
  const socket = await startConnect(b);
  socket.onopen();
  socket.receive({ type: 'status', state: 'error', recovery: 'candidate', message: 'The phone may need wireless debugging recovery.' });
  return { b, socket };
}

function packet() {
  const payload = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e]);
  const buffer = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buffer);
  view.setBigUint64(0, 1n << 63n);
  view.setUint32(8, payload.length);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

test('pairing guidance is keyboard-accessible, explicit, masked and never stores a code', async () => {
  assert.match(html, /id="pair-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="pair-controls"[^>]*hidden/);
  assert.match(html, /id="pair-controls"[^>]*role="dialog"[^>]*aria-labelledby="pair-title"[^>]*hidden/);
  assert.match(html, /id="pair-code" type="password"[^>]*maxlength="6"[^>]*autocomplete="off"/);
  const { b, socket } = await recovery();
  assert.equal(b.element('pair-toggle').hidden, false);
  b.element('pair-toggle').handlers.click();
  assert.equal(b.element('pair-controls').hidden, false);
  assert.equal(b.element('pair-code').focused, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'pairingDiscovery' });
  socket.receive({ type: 'pairingDiscovery', result: 'available' });
  assert.match(b.element('pair-discovery-status').textContent, /found/i);
  const before = socket.sent.length;
  b.element('pair-code').value = '123456';
  const escape = dispatchKey(b, b.element('pair-code'), keyEvent('Escape'));
  assert.equal(escape.defaultPrevented, true);
  assert.equal(b.element('pair-controls').hidden, true);
  assert.equal(b.element('pair-code').value, '');
  assert.equal(b.element('pair-toggle').focused, true);
  assert.equal(socket.sent.length, before);
});

test('an initial server error can open guidance on a controller socket without starting phone control', async () => {
  const writes = [];
  const b = loadBrowser({
    localStorage: { getItem: () => null, setItem(...args) { writes.push(args); } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ state: 'error', recovery: 'unknown', message: 'Connection unavailable.' }) }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.element('pair-toggle').hidden, false);
  b.element('pair-toggle').handlers.click();
  const socket = b.sockets.at(-1);
  socket.onopen();
  assert.equal(b.element('pair-code').disabled, false);
  assert.equal(b.element('pair-code').focused, true);
  assert.equal(socket.sent.some(item => item.type === 'connect'), false);
  assert.deepEqual(socket.sent.filter(item => item.type === 'pairingDiscovery'), [{ type: 'pairingDiscovery' }]);
  assert.deepEqual(writes, []);
});

test('invalid code and endpoint never leave the page; wrong and expired codes clear before retry', async () => {
  const { b, socket } = await recovery();
  b.element('pair-toggle').handlers.click();
  socket.receive({ type: 'pairingDiscovery', result: 'manual-required' });
  assert.match(b.element('pair-discovery-status').textContent, /address and pairing port/i);
  const submit = () => b.element('pair-form').handlers.submit({ preventDefault() {} });
  b.element('pair-code').value = '12345';
  submit();
  assert.equal(b.element('pair-code').value, '');
  assert.equal(socket.sent.some(item => item.type === 'pairingRequest'), false);
  b.element('pair-code').value = '123456';
  b.element('pair-endpoint').value = '127.0.0.1:1234';
  submit();
  assert.equal(socket.sent.some(item => item.type === 'pairingRequest'), false);
  b.element('pair-code').value = '012345';
  b.element('pair-endpoint').value = '192.0.2.10:37002';
  submit();
  assert.deepEqual(socket.sent.at(-1), { type: 'pairingRequest', code: '012345', manualEndpoint: '192.0.2.10:37002' });
  assert.equal(b.element('pair-code').value, '');
  assert.equal(b.element('pair-submit').disabled, true);
  socket.receive({ type: 'pairingResult', result: 'failed' });
  assert.match(b.element('pair-status').textContent, /not accepted/i);
  assert.equal(b.element('pair-submit').disabled, false);
  b.element('pair-code').value = '654321';
  submit();
  socket.receive({ type: 'pairingResult', result: 'expired' });
  assert.match(b.element('pair-status').textContent, /expired/i);
  assert.equal(b.element('pair-code').value, '');
});

test('verified pairing reconnects the same controller and reports success only after a rendered frame', async () => {
  const { b, socket } = await recovery();
  b.element('pair-toggle').handlers.click();
  b.element('pair-code').value = '123456';
  b.element('pair-form').handlers.submit({ preventDefault() {} });
  socket.receive({ type: 'pairingResult', result: 'identity-verified' });
  assert.equal(b.element('pair-controls').hidden, true);
  assert.equal(b.element('state').dataset.state, 'connecting');
  assert.deepEqual(socket.sent.at(-1), { type: 'connect' });
  assert.ok(b.keyButtons.every(button => button.disabled));
  socket.receive({ type: 'status', state: 'connected', message: 'Connected' });
  assert.equal(b.element('state').dataset.state, 'connecting', 'server status is not rendered-video success');
  assert.ok(b.keyButtons.every(button => button.disabled), 'server status and packet count are not rendered video');
  socket.onmessage({ data: packet() });
  assert.ok(b.keyButtons.every(button => button.disabled));
  b.FakeVideoDecoder.latest.emit();
  assert.equal(b.element('state').dataset.state, 'connected');
  assert.match(b.element('message').textContent, /video is visible after re-pairing/i);
  assert.ok(b.keyButtons.every(button => !button.disabled));
});

test('verified pairing with no video reports a distinct failure without claiming recovery', async () => {
  const { b, socket } = await recovery();
  b.element('pair-toggle').handlers.click();
  b.element('pair-code').value = '123456';
  b.element('pair-form').handlers.submit({ preventDefault() {} });
  socket.receive({ type: 'pairingResult', result: 'identity-verified' });
  socket.receive({ type: 'status', state: 'error', message: 'Synthetic stream failure.' });
  assert.equal(b.element('state').dataset.state, 'error');
  assert.match(b.element('message').textContent, /pairing was verified, but the phone video did not open/i);
  assert.ok(b.keyButtons.every(button => button.disabled));
});

test('hide, cancel, handoff and disconnect clear secrets and suppress stale pairing results', async () => {
  for (const end of [
    (b) => { b.documentState.hidden = true; b.documentHandlers.visibilitychange(); },
    (b) => b.element('pair-cancel').handlers.click(),
    (_b, socket) => socket.receive({ type: 'moved' }),
    (b) => b.element('connect').handlers.click(),
    (b) => b.windowHandlers.blur(),
    (b) => b.windowHandlers.pagehide(),
  ]) {
    const { b, socket } = await recovery();
    b.element('pair-toggle').handlers.click();
    socket.receive({ type: 'pairingDiscovery', result: 'available' });
    b.element('pair-code').value = '123456';
    b.element('pair-form').handlers.submit({ preventDefault() {} });
    b.element('pair-code').value = '654321';
    await end(b, socket);
    assert.equal(b.element('pair-code').value, '');
    assert.ok(socket.sent.some(item => item.type === 'pairingCancel') || socket.closed, 'attempt was cancelled or its controller closed');
    const before = socket.sent.length;
    socket.receive({ type: 'pairingResult', result: 'identity-verified' });
    assert.equal(socket.sent.length, before, 'late verification cannot reconnect');
    assert.ok(b.keyButtons.every(button => button.disabled));
  }
});

test('endpoint refresh is explicit and a hidden panel never probes again', async () => {
  const { b, socket } = await recovery();
  b.element('pair-toggle').handlers.click();
  assert.equal(socket.sent.filter(item => item.type === 'pairingDiscovery').length, 1);
  b.element('pair-refresh').handlers.click();
  assert.equal(socket.sent.filter(item => item.type === 'pairingDiscovery').length, 1, 'no overlapping check');
  socket.receive({ type: 'pairingDiscovery', result: 'manual-required' });
  b.element('pair-refresh').handlers.click();
  assert.equal(socket.sent.filter(item => item.type === 'pairingDiscovery').length, 2);
  b.element('close-pair').handlers.click();
  assert.deepEqual(socket.sent.at(-1), { type: 'pairingDiscoveryCancel' });
  b.element('pair-refresh').handlers.click();
  assert.equal(socket.sent.filter(item => item.type === 'pairingDiscovery').length, 2);
});

test('a failed browser send still clears the code and leaves delivery uncertain', async () => {
  const { b, socket } = await recovery();
  b.element('pair-toggle').handlers.click();
  socket.receive({ type: 'pairingDiscovery', result: 'available' });
  socket.send = () => { throw new Error('SYNTHETIC_PRIVATE_TRANSPORT'); };
  b.element('pair-code').value = '123456';
  b.element('pair-form').handlers.submit({ preventDefault() {} });
  assert.equal(b.element('pair-code').value, '');
  assert.match(b.element('pair-status').textContent, /uncertain/i);
  b.element('pair-code').value = '654321';
  b.element('close-pair').handlers.click();
  assert.equal(b.element('pair-code').value, '');
  assert.equal(b.element('pair-controls').hidden, true);
  assert.doesNotMatch(b.element('pair-status').textContent, /SYNTHETIC_PRIVATE/);
});
