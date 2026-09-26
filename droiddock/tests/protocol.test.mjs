import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoParser, encodeControl } from '../../dist/droiddock/protocol.js';

// Fixtures follow scrcpy v4.1 doc/develop.md and ControlMessageReader.java.
const codec = Buffer.from('68323634', 'hex');
function session(width, height, resized = false) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(0x80000000 + Number(resized), 0);
  b.writeUInt32BE(width, 4);
  b.writeUInt32BE(height, 8);
  return b;
}
function media(flags, payload = Buffer.from([0, 0, 0, 1, 0x65])) {
  const b = Buffer.alloc(12 + payload.length);
  b.writeBigUInt64BE(flags, 0);
  b.writeUInt32BE(payload.length, 8);
  payload.copy(b, 12);
  return b;
}
const portrait = { type: 'video', codec: 'h264', width: 720, height: 1280 };

test('every two-chunk split preserves codec, session, config, key and delta packets', () => {
  const packets = [media(1n << 62n), media((1n << 61n) | 123456n), media(123457n)];
  const wire = Buffer.concat([codec, session(720, 1280), ...packets]);
  const expected = [portrait, ...packets.map((packet, i) => {
    const data = Buffer.from(packet);
    data.writeBigUInt64BE([1n << 63n, (1n << 62n) | 123456n, 123457n][i], 0);
    return { type: 'packet', data };
  })];
  for (let split = 0; split <= wire.length; split++) {
    const parser = new VideoParser();
    assert.deepEqual([...parser.push(wire.subarray(0, split)), ...parser.push(wire.subarray(split))], expected, `split ${split}`);
  }
  const parser = new VideoParser();
  assert.deepEqual([...wire].flatMap(byte => parser.push(Buffer.from([byte]))), expected);
});

test('coalesced rotation sessions reset dimensions without consuming following media', () => {
  const parser = new VideoParser();
  const events = parser.push(Buffer.concat([codec, session(720, 1280), media(1n << 62n), session(1280, 720, true), media((1n << 61n) | 99n)]));
  assert.deepEqual(events.filter(e => e.type === 'video'), [portrait, { ...portrait, width: 1280, height: 720 }]);
  assert.equal(events[3].data.readBigUInt64BE(0), (1n << 62n) | 99n);
});

test('retains all 61 timestamp bits when adapting both media flags', () => {
  const parser = new VideoParser();
  const maxPts = (1n << 61n) - 1n;
  const event = parser.push(Buffer.concat([codec, media((3n << 61n) | maxPts)]))[0];
  assert.equal(event.data.readBigUInt64BE(0), (3n << 62n) | maxPts);
});

test('rejects wrong codec and malformed dimensions', () => {
  assert.throws(() => new VideoParser().push(Buffer.from('68323635', 'hex')), /H.264/);
  for (const [w, h] of [[0, 1], [1, 0], [8193, 1], [1, 8193]]) {
    assert.throws(() => new VideoParser().push(Buffer.concat([codec, session(w, h)])), /dimensions/);
  }
});

test('rejects zero and oversized payload lengths before waiting for payload', () => {
  for (const size of [0, 8 * 1024 * 1024 + 1, 0xffffffff]) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(size, 8);
    assert.throws(() => new VideoParser().push(Buffer.concat([codec, header])), /packet size/);
  }
});

test('incomplete media waits for remaining payload', () => {
  const parser = new VideoParser();
  const packet = media(47n);
  assert.deepEqual(parser.push(Buffer.concat([codec, packet.subarray(0, -1)])), []);
  assert.deepEqual(parser.push(packet.subarray(-1)), [{ type: 'packet', data: packet }]);
});

test('key events match upstream big-endian down/up wire format', () => {
  const packets = encodeControl({ type: 'key', key: 'home' });
  assert.deepEqual(packets.map(b => b.toString('hex')), ['0000000000030000000000000000', '0001000000030000000000000000']);
});

test('text prefixes UTF-8 byte count and enforces upstream 300-byte maximum', () => {
  assert.equal(encodeControl({ type: 'text', text: 'é🙂' })[0].toString('hex'), '0100000006c3a9f09f9982');
  assert.equal(encodeControl({ type: 'text', text: 'é'.repeat(150) })[0].length, 305);
  assert.throws(() => encodeControl({ type: 'text', text: 'é'.repeat(151) }), /300 UTF-8/);
});

test('touch uses pointer zero, 32-bit coordinates, 16-bit dimensions and pressure', () => {
  const base = { type: 'touch', x: 1, y: 2, width: 720, height: 1280 };
  assert.equal(encodeControl({ ...base, action: 0 })[0].toString('hex'), '02000000000000000000000000010000000202d00500ffff0000000000000000');
  const up = encodeControl({ ...base, action: 1 })[0];
  assert.equal(up.length, 32);
  assert.equal(up[1], 1);
  assert.equal(up.readUInt16BE(22), 0);
  assert.equal(encodeControl({ ...base, action: 2 })[0][1], 2);
  assert.equal(encodeControl({ ...base, action: 0, pointerId: 1 })[0].readBigUInt64BE(2), 1n);
  assert.equal(encodeControl({ ...base, action: 2, pointerId: 2 })[0].readBigUInt64BE(2), 2n);
  for (const pointerId of [-1, 3, 0.5, '1', null]) {
    assert.throws(() => encodeControl({ ...base, action: 0, pointerId }), /coordinate or action/);
  }
});

test('paste atomically sets Unicode clipboard then requests native Android paste', () => {
  const text = 'café 🙂\nsecond line';
  const [packet] = encodeControl({ type: 'paste', text });
  assert.equal(packet[0], 9);
  assert.equal(packet.readBigUInt64BE(1), 0n);
  assert.equal(packet[9], 1);
  assert.equal(packet.readUInt32BE(10), Buffer.byteLength(text));
  assert.equal(packet.subarray(14).toString('utf8'), text);
  assert.equal(encodeControl({ type: 'paste', text: 'é'.repeat(32768) })[0].length, 65550);
  for (const value of ['', null, 42, 'é'.repeat(32769)]) {
    assert.throws(() => encodeControl({ type: 'paste', text: value }), /65536 UTF-8/);
  }
});

test('scroll uses scrcpy 4.1 fixed point scale of 2048 per unit', () => {
  const packet = encodeControl({ type: 'scroll', x: 1, y: 2, width: 720, height: 1280, dx: 1, dy: -1 })[0];
  assert.equal(packet.toString('hex'), '03000000010000000202d005000800f80000000000');
  const half = encodeControl({ type: 'scroll', x: 0, y: 0, width: 1, height: 1, dx: 0.5, dy: 0 })[0];
  assert.equal(half.readInt16BE(13), 1024);
});

test('invalid controls cannot escape the structured allowlist', () => {
  const touch = { type: 'touch', action: 0, x: 0, y: 0, width: 720, height: 1280 };
  const invalid = [null, [], 'home', {}, { type: 'shell', command: 'id' },
    { type: 'key', key: '__proto__' }, { type: 'key', key: 'constructor' }, { type: 'key', key: 3 },
    { type: 'text', text: '' }, { type: 'text', text: 12 },
    ...[-1, 3, 0.5, NaN, Infinity, '0'].map(action => ({ ...touch, action })),
    ...[-1, 720, 0.5, NaN, Infinity, '0'].map(x => ({ ...touch, x })),
    ...[0, 8193, 1.5, '720'].map(width => ({ ...touch, width })),
    ...[-2, 2, NaN, Infinity, '0', undefined].map(dx => ({ ...touch, type: 'scroll', dx, dy: 0 }))];
  for (const message of invalid) assert.throws(() => encodeControl(message), undefined, JSON.stringify(message));
});
