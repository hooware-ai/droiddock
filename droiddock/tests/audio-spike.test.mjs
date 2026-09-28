import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioStreamParser, AUDIO_CODECS, MAX_AUDIO_PACKET, frameAudioPacket } from '../../scripts/audio-spike.mjs';

const id = codec => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, codec); return bytes; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const opusHead = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]);

test('audio spike parser reads the scrcpy 4.1 codec id, config, and media packets from any fragmentation', () => {
  const stream = concat(id(AUDIO_CODECS.opus), frameAudioPacket({ config: true, data: opusHead }),
    frameAudioPacket({ pts: 20000, data: new Uint8Array([1, 2, 3]) }), frameAudioPacket({ pts: 2 ** 40 + 5, key: true, data: new Uint8Array([4]) }));
  for (const step of [1, 3, 7, stream.length]) {
    const parser = new AudioStreamParser();
    const events = [];
    for (let offset = 0; offset < stream.length; offset += step) events.push(...parser.push(stream.subarray(offset, offset + step)));
    assert.deepEqual(events.map(event => event.type), ['codec', 'config', 'packet', 'packet'], `step ${step}`);
    assert.equal(events[0].codec, 'opus');
    assert.deepEqual([...events[1].data], [...opusHead]);
    assert.deepEqual([events[2].pts, events[2].key, [...events[2].data]], [20000, false, [1, 2, 3]]);
    assert.deepEqual([events[3].pts, events[3].key], [2 ** 40 + 5, true]);
  }
});

test('audio spike parser honors disable codes and rejects malformed streams', () => {
  assert.deepEqual(new AudioStreamParser().push(id(0)), [{ type: 'disabled', error: false }]);
  assert.deepEqual(new AudioStreamParser().push(id(1)), [{ type: 'disabled', error: true }]);
  assert.throws(() => new AudioStreamParser().push(concat(id(0), new Uint8Array([9]))), /Data after a disabled audio stream/);
  assert.throws(() => new AudioStreamParser().push(id(0x68323634)), /Unknown audio codec/);
  const session = new Uint8Array(12); session[0] = 0x80; session[11] = 1;
  assert.throws(() => new AudioStreamParser().push(concat(id(AUDIO_CODECS.opus), session)), /Unexpected audio session packet/);
  const empty = new Uint8Array(12);
  assert.throws(() => new AudioStreamParser().push(concat(id(AUDIO_CODECS.opus), empty)), /Invalid audio packet size/);
  const oversize = new Uint8Array(12); new DataView(oversize.buffer).setUint32(8, MAX_AUDIO_PACKET + 1);
  // The size is rejected from the header, before any payload is buffered.
  assert.throws(() => new AudioStreamParser().push(concat(id(AUDIO_CODECS.opus), oversize)), /Invalid audio packet size/);
});
