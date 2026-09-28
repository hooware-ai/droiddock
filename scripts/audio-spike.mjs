// Issue #63 audio spike: an isolated proof of feasibility, not production code.
// It never contacts a phone or ADB. `node scripts/audio-spike.mjs` serves a
// loopback-only page that encodes a synthetic tone with WebCodecs Opus, frames
// it exactly as the pinned scrcpy 4.1 audio socket would, parses it
// incrementally, decodes it, and measures decode and real-time playback.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// scrcpy 4.1 audio codec ids (develop.md). 0 and 1 in the codec position
// disable the stream: 0 = capture unavailable (video continues), 1 = error.
export const AUDIO_CODECS = { opus: 0x6f707573, aac: 0x00616163, flac: 0x666c6163, raw: 0x00726177 };
// Opus packets are a few hundred bytes; raw PCM packets are larger. Bound the buffer anyway.
export const MAX_AUDIO_PACKET = 1 << 20;

export class AudioStreamParser {
  constructor(maxPacket = MAX_AUDIO_PACKET) {
    this.buffer = new Uint8Array(0);
    this.codec = undefined;
    this.maxPacket = maxPacket;
  }
  push(chunk) {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer); next.set(chunk, this.buffer.length);
    this.buffer = next;
    const events = [];
    const view = () => new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    if (this.codec === undefined) {
      if (this.buffer.length < 4) return events;
      const id = view().getUint32(0);
      this.buffer = this.buffer.subarray(4);
      if (id === 0 || id === 1) { this.codec = null; events.push({ type: 'disabled', error: id === 1 }); }
      else {
        const name = Object.keys(AUDIO_CODECS).find(key => AUDIO_CODECS[key] === id);
        if (!name) throw new Error('Unknown audio codec.');
        this.codec = name;
        events.push({ type: 'codec', codec: name });
      }
    }
    if (this.codec === null) {
      if (this.buffer.length) throw new Error('Data after a disabled audio stream.');
      return events;
    }
    while (this.buffer.length >= 12) {
      const header = view();
      const high = header.getUint32(0), low = header.getUint32(4), size = header.getUint32(8);
      // Audio has no session packets, so the top (session/media) bit must be clear.
      if (high & 0x80000000) throw new Error('Unexpected audio session packet.');
      if (!size || size > this.maxPacket) throw new Error('Invalid audio packet size.');
      if (this.buffer.length < 12 + size) break;
      const data = this.buffer.slice(12, 12 + size);
      const config = (high & 0x40000000) !== 0;
      const key = (high & 0x20000000) !== 0;
      const pts = (high & 0x1fffffff) * 0x100000000 + low;
      events.push(config ? { type: 'config', data } : { type: 'packet', pts, key, data });
      this.buffer = this.buffer.subarray(12 + size);
    }
    return events;
  }
}

// Builds scrcpy-framed audio bytes; used by the page and the tests.
export function frameAudioPacket({ config = false, key = false, pts = 0, data }) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  const high = config ? 0x40000000 : (key ? 0x20000000 : 0) | Math.floor(pts / 0x100000000);
  view.setUint32(0, high); view.setUint32(4, config ? 0 : pts % 0x100000000); view.setUint32(8, data.length);
  out.set(data, 12);
  return out;
}

const pageScript = `
${`const AUDIO_CODECS = ${JSON.stringify(AUDIO_CODECS)}; const MAX_AUDIO_PACKET = ${MAX_AUDIO_PACKET};`}
${AudioStreamParser.toString()}
${frameAudioPacket.toString()}
const out = document.getElementById('out');
const report = {};
const show = () => { out.textContent = JSON.stringify(report, null, 2); window.__audioSpike = report; };
const RATE = 48000, CHANNELS = 2, FRAMES = 960, SECONDS = 10;
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(2) : null; };
function opusHead(preSkip) {
  const head = new Uint8Array(19);
  head.set([...'OpusHead'].map(c => c.charCodeAt(0)));
  head[8] = 1; head[9] = CHANNELS;
  const view = new DataView(head.buffer);
  view.setUint16(10, preSkip, true); view.setUint32(12, RATE, true);
  return head;
}
async function encodeTone() {
  const chunks = []; let description;
  const encoder = new AudioEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      chunks.push({ data, pts: chunk.timestamp });
      if (meta?.decoderConfig?.description) description = new Uint8Array(meta.decoderConfig.description);
    },
    error(e) { report.encodeError = String(e); },
  });
  encoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: CHANNELS, bitrate: 128000, opus: { frameDuration: 20000 } });
  for (let i = 0; i < SECONDS * RATE / FRAMES; i++) {
    const planar = new Float32Array(FRAMES * CHANNELS);
    for (let n = 0; n < FRAMES; n++) {
      const t = (i * FRAMES + n) / RATE;
      planar[n] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
      planar[FRAMES + n] = 0.5 * Math.sin(2 * Math.PI * 660 * t);
    }
    encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAMES, numberOfChannels: CHANNELS, timestamp: Math.round(i * FRAMES * 1e6 / RATE), data: planar }));
  }
  await encoder.flush(); encoder.close();
  return { chunks, head: description?.length === 19 ? description : opusHead(312) };
}
function scrcpyStream({ chunks, head }) {
  const parts = [new Uint8Array([0x6f, 0x70, 0x75, 0x73]), frameAudioPacket({ config: true, data: head })];
  for (const chunk of chunks) parts.push(frameAudioPacket({ pts: chunk.pts, data: chunk.data }));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function* randomChunks(bytes) {
  let offset = 0;
  while (offset < bytes.length) { const size = 1 + Math.floor(Math.random() * 4096); yield bytes.subarray(offset, offset + size); offset += size; }
}
function zeroCrossingHz(samples) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return +(crossings / 2 / (samples.length / RATE)).toFixed(1);
}
async function decodeAll(stream) {
  const parser = new AudioStreamParser();
  const events = [];
  const parseStart = performance.now();
  for (const chunk of randomChunks(stream)) events.push(...parser.push(chunk));
  report.parseMs = +(performance.now() - parseStart).toFixed(2);
  const config = events.find(e => e.type === 'config');
  const packets = events.filter(e => e.type === 'packet');
  report.codec = events.find(e => e.type === 'codec')?.codec;
  report.packets = packets.length;
  report.bytesPerSecond = Math.round(stream.length / SECONDS);
  const left = new Float32Array(RATE * 2), right = new Float32Array(RATE * 2);
  let frames = 0; const latency = []; const queued = new Map();
  const decoder = new AudioDecoder({
    output(data) {
      const start = queued.get(data.timestamp); if (start !== undefined) latency.push(performance.now() - start);
      const offset = frames - RATE * 2;
      if (offset >= 0 && offset < RATE * 2) {
        const count = Math.min(data.numberOfFrames, RATE * 2 - offset);
        const l = new Float32Array(data.numberOfFrames), r = new Float32Array(data.numberOfFrames);
        data.copyTo(l, { planeIndex: 0, format: 'f32-planar' }); data.copyTo(r, { planeIndex: 1, format: 'f32-planar' });
        left.set(l.subarray(0, count), offset); right.set(r.subarray(0, count), offset);
      }
      frames += data.numberOfFrames; data.close();
    },
    error(e) { report.decodeError = String(e); },
  });
  decoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: CHANNELS, description: config.data });
  const decodeStart = performance.now();
  for (const packet of packets) { queued.set(packet.pts, performance.now()); decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: packet.pts, data: packet.data })); }
  await decoder.flush(); decoder.close();
  const decodeMs = performance.now() - decodeStart;
  Object.assign(report, {
    decodeMs: +decodeMs.toFixed(1), realtimeFactor: Math.round(SECONDS * 1000 / decodeMs),
    decodedSeconds: +(frames / RATE).toFixed(3), perPacketLatencyMsP50: percentile(latency, 0.5), perPacketLatencyMsP95: percentile(latency, 0.95),
    leftHz: zeroCrossingHz(left.subarray(RATE)), rightHz: zeroCrossingHz(right.subarray(RATE)),
  });
  return { config, packets };
}
// Real-time run: packets arrive on their PTS schedule with +/-jitter, are parsed,
// decoded and scheduled as AudioBufferSourceNodes with a target buffer.
async function realtime({ config, packets }, audible) {
  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: RATE });
  const gain = ctx.createGain(); gain.gain.value = audible ? 0.05 : 0; gain.connect(ctx.destination);
  // ?target=<ms> sets the playback buffer; ?busy=<ms> blocks the main thread for that long every
  // 16 ms to stand in for video decode and rendering work on the same thread.
  const params = new URLSearchParams(location.search);
  const target = Number(params.get('target') || 60) / 1000, jitterMs = 15, busyMs = Number(params.get('busy') || 0);
  const busy = busyMs ? setInterval(() => { const end = performance.now() + busyMs; while (performance.now() < end); }, 16) : 0;
  let next = 0, underruns = 0; const buffered = []; const handlerMs = [];
  const decoder = new AudioDecoder({
    output(data) {
      const t0 = performance.now();
      const buffer = ctx.createBuffer(CHANNELS, data.numberOfFrames, RATE);
      for (let c = 0; c < CHANNELS; c++) { const plane = new Float32Array(data.numberOfFrames); data.copyTo(plane, { planeIndex: c, format: 'f32-planar' }); buffer.copyToChannel(plane, c); }
      data.close();
      if (next < ctx.currentTime) { if (next) underruns++; next = ctx.currentTime + target; }
      const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(gain); source.start(next);
      buffered.push((next - ctx.currentTime) * 1000);
      next += buffer.duration;
      handlerMs.push(performance.now() - t0);
    },
    error(e) { report.realtimeError = String(e); },
  });
  decoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: CHANNELS, description: config.data });
  const start = performance.now();
  await new Promise(done => {
    let i = 0;
    const tick = () => {
      while (i < packets.length && packets[i].pts / 1000 <= performance.now() - start) {
        const p = packets[i++];
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.pts, data: p.data }));
      }
      if (i >= packets.length) { setTimeout(done, 300); return; }
      setTimeout(tick, Math.max(0, 20 + (Math.random() * 2 - 1) * jitterMs));
    };
    tick();
  });
  decoder.close();
  clearInterval(busy);
  report.realtime = {
    audible, contextState: ctx.state, baseLatencyMs: +(ctx.baseLatency * 1000).toFixed(1), outputLatencyMs: +((ctx.outputLatency || 0) * 1000).toFixed(1),
    targetBufferMs: target * 1000, arrivalJitterMs: jitterMs, mainThreadBusyMsPer16: busyMs, underruns, scheduledAheadMsP50: percentile(buffered, 0.5), scheduledAheadMsP95: percentile(buffered, 0.95),
    outputHandlerMsP95: percentile(handlerMs, 0.95), outputHandlerMsMax: +Math.max(...handlerMs).toFixed(2),
  };
  await ctx.close();
}
let prepared;
(async () => {
  report.userAgent = navigator.userAgent;
  report.encoderSupported = typeof AudioEncoder === 'function' && (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: CHANNELS, bitrate: 128000 })).supported;
  report.decoderSupported = typeof AudioDecoder === 'function' && (await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: CHANNELS })).supported;
  show();
  if (!report.encoderSupported || !report.decoderSupported) return;
  const encoded = await encodeTone();
  report.opusHeadFromEncoder = encoded.head.length === 19;
  prepared = await decodeAll(scrcpyStream(encoded));
  report.ready = true; show();
})().catch(e => { report.error = String(e); show(); });
document.getElementById('play').addEventListener('click', async () => {
  if (!prepared) return;
  report.realtime = 'running'; show();
  try { await realtime(prepared, document.getElementById('audible').checked); } catch (e) { report.realtimeError = String(e); }
  show();
});
`;

const page = `<!doctype html><meta charset="utf-8"><title>DroidDock audio spike</title>
<h1>DroidDock audio spike (#63)</h1>
<p>Synthetic audio only. No phone, ADB, or recording is involved.</p>
<label><input id="audible" type="checkbox"> Audible (quiet test tone)</label>
<button id="play" type="button">Run real-time playback test</button>
<pre id="out">Running offline decode test…</pre>
<script src="/spike.js"></script>`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer((req, res) => {
    const expected = `127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== expected || req.method !== 'GET') { res.writeHead(403); res.end(); return; }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
    if (path === '/spike.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(pageScript); return; }
    res.writeHead(404); res.end();
  });
  server.listen(Number(process.env.AUDIO_SPIKE_PORT || 0), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
}
