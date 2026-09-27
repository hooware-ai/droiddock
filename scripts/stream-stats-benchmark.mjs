// Synthetic, deterministic browser-controller workload. No node:test imports.
// Run with `node --expose-gc scripts/stream-stats-benchmark.mjs [off|on]`.
// DROIDDOCK_BENCH_SOURCE can name another revision's app.js for comparison.
// This does not measure WebCodecs, GPU drawing, a phone, or end-to-end latency.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';

const mode = process.argv[2] || 'off';
if (!['off', 'on'].includes(mode)) throw new Error('Mode must be off or on.');
if (!global.gc) throw new Error('Run with --expose-gc.');
const packetsPerSecond = Number(process.env.DROIDDOCK_BENCH_PACKETS || 2000);
if (!Number.isInteger(packetsPerSecond) || packetsPerSecond < 100 || packetsPerSecond % 100) throw new Error('Packet count must be a positive multiple of 100.');
const source = readFileSync(process.env.DROIDDOCK_BENCH_SOURCE || new URL('../droiddock/public/app.js', import.meta.url), 'utf8');

let simulatedMs = 0;
const elements = new Map();
const timers = new Map();
let nextTimerId = 0;
function element(id) {
  if (!elements.has(id)) {
    const handlers = {};
    elements.set(id, {
      handlers, dataset: {}, style: {}, textContent: '', value: '', checked: false,
      hidden: ['screen', 'pin-controls', 'pair-controls'].includes(id),
      open: false, width: 0, height: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(name, handler) { handlers[name] = handler; },
      setAttribute() {}, getAttribute() {}, focus() {}, contains() { return false; },
      querySelector() { return element('summary'); },
      getContext() { return { clearRect() {}, drawImage() {} }; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 1280 }; },
      hasPointerCapture() { return false; },
      releasePointerCapture() {}, setPointerCapture() {},
    });
  }
  return elements.get(id);
}
const sockets = [];
class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  sent = [];
  constructor() { sockets.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
class FakeVideoDecoder {
  static latest;
  constructor({ output }) { this.output = output; this.state = 'configured'; this.decodeQueueSize = 0; FakeVideoDecoder.latest = this; }
  configure() {}
  close() { this.state = 'closed'; }
  decode() {}
  emit(frame) { this.output(frame); }
}
class Observer { observe() {} }
runInNewContext(source, {
  document: { documentElement: element('root'), hasFocus: () => true, hidden: false, fullscreenEnabled: false,
    getElementById: element, querySelectorAll: () => [], addEventListener() {} },
  window: { addEventListener() {} },
  location: { protocol: 'http:', host: '127.0.0.1:3210' },
  localStorage: { getItem: () => null, setItem() {} },
  WebSocket: FakeWebSocket, VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
  MutationObserver: Observer, ResizeObserver: Observer,
  setTimeout(callback) { const id = ++nextTimerId; timers.set(id, callback); return id; },
  clearTimeout(id) { timers.delete(id); },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  fetch: () => new Promise(() => {}), TextEncoder, ArrayBuffer, Uint8Array, DataView,
  performance: { now: () => simulatedMs },
});

const config = new ArrayBuffer(20);
new DataView(config).setBigUint64(0, 1n << 63n);
new DataView(config).setUint32(8, 8);
new Uint8Array(config, 12).set([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e]);
const packet = new ArrayBuffer(18);
new DataView(packet).setUint32(8, 6);
new Uint8Array(packet, 12).set([0, 0, 0, 1, 0x41, 0]);
const keyPacket = packet.slice(0);
new DataView(keyPacket).setBigUint64(0, 1n << 62n);

element('connect').handlers.click();
const socket = sockets[0];
socket.onopen();
socket.receive({ type: 'status', state: 'connecting' });
socket.onmessage({ data: config });
socket.onmessage({ data: keyPacket });
let frames = 0;
const frame = { displayWidth: 720, displayHeight: 1280, close() { frames++; } };
FakeVideoDecoder.latest.emit(frame);
frames = 0;
element('more-controls').open = true;
element('more-controls').handlers.toggle?.();
if (mode === 'on') {
  const toggle = element('stream-stats-toggle');
  if (!toggle.handlers.change) throw new Error('This revision has no statistics toggle.');
  toggle.checked = true;
  toggle.handlers.change();
}

global.gc();
const startHeap = process.memoryUsage().heapUsed;
const startCpu = process.cpuUsage();
const inputSamples = [];
for (let second = 0; second < 60; second++) {
  for (let index = 0; index < packetsPerSecond; index++) {
    socket.onmessage({ data: packet });
    FakeVideoDecoder.latest.emit(frame);
    if (index % (packetsPerSecond / 100) === 0) {
      const start = performance.now();
      element('screen').handlers.keydown({ key: 'a', ctrlKey: false, metaKey: false, altKey: false,
        isComposing: false, preventDefault() {} });
      inputSamples.push(performance.now() - start);
    }
  }
  socket.sent.length = 0;
  simulatedMs += 1000;
  if (mode === 'on') {
    const [id, callback] = [...timers.entries()].at(-1) || [];
    if (callback) { timers.delete(id); callback(); }
  }
}
const cpu = process.cpuUsage(startCpu);
global.gc();
const heapGrowth = process.memoryUsage().heapUsed - startHeap;
inputSamples.sort((a, b) => a - b);
console.log(JSON.stringify({ mode, packets: packetsPerSecond * 60, frames, cpuMs: (cpu.user + cpu.system) / 1000,
  heapGrowthBytes: heapGrowth, inputP95Ms: inputSamples[Math.ceil(inputSamples.length * .95) - 1] }));
