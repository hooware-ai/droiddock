import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeControl } from '../../dist/droiddock/protocol.js';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

function submit(b) { b.element('pin-form').handlers.submit({ preventDefault() {} }); }
async function connected() {
  const b = loadBrowser();
  const socket = deliverSyntheticFrame(b, await startConnect(b));
  b.more.open = b.element('pin-controls').open = true;
  return { b, socket };
}

test('PIN serializes all ten digits as Android down/up pairs, without Enter or clipboard', () => {
  const packets = encodeControl({ type: 'pin', digits: '0123456789' });
  assert.equal(packets.length, 20);
  packets.forEach((p, index) => {
    assert.equal(p.length, 14);
    assert.equal(p[0], 0);
    assert.equal(p[1], index % 2);
    assert.equal(p.readUInt32BE(2), 7 + Math.floor(index / 2));
    assert.ok(p.subarray(6).every(byte => byte === 0));
  });
  assert.equal(encodeControl({ type: 'pin', digits: '0'.repeat(64) }).length, 128);
});

test('PIN rejects entire malformed requests without echoing supplied data', () => {
  for (const digits of ['', null, 1234, '12a3', ' 1234', '1234\n', '\uff11\uff12', '0'.repeat(65)]) {
    assert.throws(() => encodeControl({ type: 'pin', digits }), { message: 'PIN must contain 1 to 64 digits.' });
  }
});

test('manual send clears PIN, preserves leading zero, never auto-sends Enter or retries', async () => {
  const { b, socket } = await connected();
  const before = socket.sent.length;
  b.element('pin-input').value = '0123'; submit(b);
  assert.deepEqual(socket.sent.slice(before), [{ type: 'pin', digits: '0123' }]);
  assert.equal(b.element('pin-input').value, '');
  assert.match(b.element('pin-status').textContent, /Check your phone/);
  submit(b);
  assert.equal(socket.sent.length, before + 1);
  b.element('pin-enter').handlers.click();
  b.element('pin-backspace').handlers.click();
  assert.deepEqual(socket.sent.slice(-2), [{ type: 'key', key: 'enter' }, { type: 'key', key: 'backspace' }]);
});

test('closed panel, pre-frame and handed-off views never send PIN controls', async () => {
  const b = loadBrowser();
  b.more.open = b.element('pin-controls').open = true;
  const socket = await startConnect(b);
  for (const id of ['pin-input', 'send-pin', 'pin-enter', 'pin-backspace']) assert.equal(b.element(id).disabled, true);
  b.element('pin-input').value = '0123'; submit(b);
  assert.equal(socket.sent.length, 0);
  deliverSyntheticFrame(b, socket);
  b.element('pin-controls').open = false;
  const before = socket.sent.length;
  b.element('pin-input').value = '0123'; submit(b);
  b.element('pin-enter').handlers.click();
  assert.equal(socket.sent.length, before);
  b.element('pin-controls').open = true;
  b.element('pin-input').value = '0123'; socket.receive({ type: 'moved' });
  assert.equal(b.element('pin-input').value, '');
  b.element('pin-input').value = '0123'; submit(b);
  assert.equal(socket.sent.length, before);
});

test('PIN clears on panel close, focus loss, page hide, visibility loss, and disconnect', async () => {
  const { b } = await connected();
  const clearEvents = [
    () => { b.element('pin-controls').open = false; b.element('pin-controls').handlers.toggle(); },
    () => { b.more.open = false; b.more.handlers.toggle(); },
    () => b.windowHandlers.blur(),
    () => b.windowHandlers.pagehide(),
    () => { b.documentState.hidden = true; b.documentHandlers.visibilitychange(); },
    () => b.element('connect').handlers.click(),
  ];
  for (const clear of clearEvents) {
    b.element('pin-input').value = '0123'; await clear();
    assert.equal(b.element('pin-input').value, '');
  }
});

test('invalid PIN and clipboard events do not send; uncertain send clears without retry', async () => {
  const { b, socket } = await connected();
  const before = socket.sent.length;
  b.element('pin-input').value = '123x'; submit(b);
  assert.equal(socket.sent.length, before);
  for (const name of ['paste', 'copy', 'cut', 'drop']) {
    let prevented = false;
    b.element('pin-input').handlers[name]({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  let attempts = 0;
  socket.send = () => { attempts++; throw Error('Synthetic transport error'); };
  b.element('pin-input').value = '0123'; submit(b);
  assert.equal(b.element('pin-input').value, '');
  assert.match(b.element('pin-status').textContent, /uncertain/);
  submit(b);
  assert.equal(attempts, 1);
});


test('steady video frames do not rewrite PIN controls or clear a draft', async () => {
  const { b } = await connected();
  let writes = 0;
  for (const id of ['pin-input', 'send-pin', 'pin-backspace', 'pin-enter']) {
    Object.defineProperty(b.element(id), 'disabled', { get() { return false; }, set() { writes++; }, configurable: true });
  }
  b.element('pin-input').value = '0123';
  for (let i = 0; i < 120; i++) b.FakeVideoDecoder.latest.emit();
  assert.equal(writes, 0);
  assert.equal(b.element('pin-input').value, '0123');
});
