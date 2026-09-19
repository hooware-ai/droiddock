import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

// Synthetic decoder consumption is deterministic; these tests do not model GPU
// timing or prove recovery from a live WebCodecs stall.
function packet(index) {
  const payload = Uint8Array.from([0, 0, 0, 1, index === 0 ? 0x65 : 0x41, index]);
  const data = new ArrayBuffer(12 + payload.length);
  const header = new DataView(data);
  header.setBigUint64(0, (index === 0 ? 1n << 62n : 0n) | BigInt(1000000 + index * 16667));
  header.setUint32(8, payload.length);
  new Uint8Array(data, 12).set(payload);
  return data;
}

async function setup(detection) {
  const storageWrites = [];
  const b = loadBrowser({ localStorage: {
    getItem: () => detection ? 'true' : null,
    setItem(...args) { storageWrites.push(args); },
  } });
  const socket = deliverSyntheticFrame(b, await startConnect(b));
  socket.receive({ type: 'status', state: 'connected', installationId: 'aaaaaaaaaaaaaaaa', configurationId: 'bbbbbbbbbbbbbbbb' });
  assert.equal(socket.sent.filter(message => message.type === 'lockSubscription').at(-1).enabled, detection);
  b.element('pin-toggle').handlers.click();
  b.element('pin-input').value = '0123';
  const decoder = b.FakeVideoDecoder.latest;
  const accepted = [];
  const pending = [];
  let framesClosed = 0;
  decoder.decode = chunk => {
    accepted.push({ timestamp: chunk.timestamp, type: chunk.type, bytes: Array.from(chunk.data) });
    pending.push(chunk);
    decoder.decodeQueueSize = pending.length;
  };
  function drain() {
    while (pending.length) {
      pending.shift();
      decoder.decodeQueueSize = pending.length;
      decoder.emit({ displayWidth: 720, displayHeight: 1280, close() { framesClosed++; } });
    }
  }
  const pinWrites = [];
  for (const [id, property] of [
    ['pin-controls', 'hidden'], ['pin-input', 'value'], ['pin-input', 'disabled'],
    ['send-pin', 'disabled'], ['pin-backspace', 'disabled'], ['pin-enter', 'disabled'],
    ['pin-status', 'textContent'], ['lock-status', 'textContent'], ['auto-pin', 'checked'],
  ]) {
    const element = b.element(id);
    let current = element[property];
    Object.defineProperty(element, property, {
      get: () => current,
      set(value) { pinWrites.push([id, property]); current = value; },
      configurable: true,
    });
  }
  const commandsBeforeVideo = socket.sent.length;
  function unchangedPin() {
    assert.deepEqual(pinWrites, []);
    assert.equal(b.element('pin-input').value, '0123');
    assert.equal(b.element('pin-controls').hidden, false);
    assert.equal(b.element('auto-pin').checked, detection);
    assert.equal(socket.sent.length, commandsBeforeVideo);
    assert.deepEqual(storageWrites, []);
    assert.deepEqual(b.requests, ['/api/status']);
  }
  function assertOrdered(count) {
    assert.equal(accepted.length, count);
    assert.deepEqual(accepted.map(chunk => chunk.timestamp), Array.from({ length: count }, (_, index) => 1000000 + index * 16667));
    for (let index = 0; index < count; index++) {
      const expected = [0, 0, 0, 1, index === 0 ? 0x65 : 0x41, index];
      if (index === 0) expected.unshift(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e);
      assert.equal(accepted[index].type, index === 0 ? 'key' : 'delta');
      assert.deepEqual(accepted[index].bytes, expected);
    }
  }
  return { b, socket, decoder, accepted, drain, unchangedPin, assertOrdered, storageWrites,
    offer: index => socket.onmessage({ data: packet(index) }),
    framesClosed: () => framesClosed };
}

for (const scenario of ['regular drained packets', 'nine-packet burst followed by drain']) {
  test(`decoder preserves ordered packets with detection off/on: ${scenario}`, async () => {
    const results = [];
    for (const detection of [false, true]) {
      const s = await setup(detection);
      for (let index = 0; index < 36; index++) {
        s.offer(index);
        if (scenario === 'regular drained packets' || index >= 8) s.drain();
        s.unchangedPin();
      }
      s.assertOrdered(36);
      assert.equal(s.framesClosed(), 36);
      assert.equal(s.decoder.decodeQueueSize, 0);
      assert.equal(s.decoder.state, 'configured');
      assert.equal(s.socket.closed, undefined);
      assert.equal(s.b.element('state').dataset.state, 'connected');
      assert.equal(s.b.element('screen').hidden, false);
      results.push(s.accepted);
    }
    assert.deepEqual(results[0], results[1]);
  });
}

test('a decoder still at depth nine fails on the next packet equally with detection off/on', async () => {
  const results = [];
  for (const detection of [false, true]) {
    const s = await setup(detection);
    // Depth eight is accepted, leaving nine outstanding requests. The next
    // arrival triggers the existing guard; this does not assert a time limit.
    for (let index = 0; index < 9; index++) {
      assert.equal(s.decoder.decodeQueueSize, index);
      s.offer(index);
      s.unchangedPin();
    }
    assert.equal(s.decoder.decodeQueueSize, 9);
    s.offer(9);
    s.assertOrdered(9);
    assert.equal(s.framesClosed(), 0);
    assert.equal(s.decoder.state, 'closed');
    assert.equal(s.socket.closed, true);
    assert.equal(s.b.element('state').dataset.state, 'error');
    assert.equal(s.b.element('message').textContent, 'Video decoding fell behind. Connect again to restart the live screen.');
    assert.equal(s.b.element('screen').hidden, true);
    assert.ok(s.b.keyButtons.every(button => button.disabled));
    assert.equal(s.b.element('pin-controls').hidden, true);
    assert.equal(s.b.element('pin-input').value, '');
    assert.equal(s.b.element('pin-input').disabled, true);
    assert.equal(s.b.element('auto-pin').checked, detection);
    assert.deepEqual(s.storageWrites, []);
    const commandsAfterFailure = s.socket.sent.length;
    s.offer(10);
    s.drain();
    s.b.element('pin-input').value = '0123';
    s.b.element('pin-form').handlers.submit({ preventDefault() {} });
    assert.equal(s.socket.sent.length, commandsAfterFailure);
    assert.equal(s.b.element('pin-input').value, '');
    assert.equal(s.b.element('state').dataset.state, 'error');
    assert.equal(s.b.element('screen').hidden, true);
    assert.equal(s.framesClosed(), 9, 'late decoder output must still release each frame');
    s.assertOrdered(9);
    results.push({ accepted: s.accepted, message: s.b.element('message').textContent, framesClosed: s.framesClosed() });
  }
  assert.deepEqual(results[0], results[1]);
});
