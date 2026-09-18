import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeElement(extra = {}) {
  const attrs = {};
  const classes = new Set();
  return {
    dataset: {}, style: {}, handlers: {}, textContent: '', hidden: false, disabled: false,
    width: 0, height: 0, title: '', value: '', focused: false, open: false,
    classList: {
      toggle(name, force) {
        if (force === undefined) classes.has(name) ? classes.delete(name) : classes.add(name);
        else if (force) classes.add(name);
        else classes.delete(name);
      },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return attrs[name]; },
    getContext() { return { clearRect() {}, drawImage() {} }; },
    getBoundingClientRect() { return { width: 720, height: 1280, left: 0, top: 0 }; },
    querySelector() { return { title: '', focus() {} }; },
    contains() { return false; },
    focus() { this.focused = true; },
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    setPointerCapture() {},
    ...extra,
  };
}

function annexB(profile, constraints, level) {
  return Uint8Array.from([0, 0, 0, 1, 0x67, profile, constraints, level]);
}

function videoPacket({ config = false, keyframe = false, timestamp = 1n, payload }) {
  const buffer = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buffer);
  let flags = timestamp & ((1n << 62n) - 1n);
  if (config) flags |= 1n << 63n;
  if (keyframe) flags |= 1n << 62n;
  view.setBigUint64(0, flags);
  view.setUint32(8, payload.length);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

function configPacket(payload = annexB(0x42, 0xc0, 0x1e)) {
  return videoPacket({ config: true, payload });
}

function keyframePacket(payload = Uint8Array.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21])) {
  return videoPacket({ keyframe: true, payload });
}

function deltaPacket(payload = Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a])) {
  return videoPacket({ keyframe: false, timestamp: 2n, payload });
}

function loadBrowser(options = {}) {
  const elements = new Map();
  const keyButtons = ['back', 'home', 'recents', 'volumeDown', 'volumeUp', 'power'].map((key) => makeElement({ dataset: { key }, disabled: true }));
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, makeElement({
        hidden: id === 'screen',
        disabled: id === 'text-input' || id === 'send-text',
      }));
    }
    return elements.get(id);
  }
  for (const id of ['screen', 'connect', 'connect-label', 'state', 'message', 'empty', 'empty-title', 'empty-message', 'device', 'resolution', 'text-input', 'send-text', 'text-form', 'screen-area', 'more-controls']) element(id);
  const sockets = [];
  const decoders = [];
  const supportChecks = [];
  const timers = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  class FakeVideoDecoder {
    static isConfigSupported = options.omitSupportCheck
      ? undefined
      : function isConfigSupported(config) {
        supportChecks.push(config);
        if (options.isConfigSupported) return options.isConfigSupported(config);
        return Promise.resolve({ supported: true, config });
      };
    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
      this.configured = [];
      this.decoded = [];
      this.closed = false;
      decoders.push(this);
    }
    configure(config) {
      if (options.configure) return options.configure(this, config);
      this.state = 'configured';
      this.configured.push(config);
    }
    decode(chunk) { this.decoded.push(chunk); }
    close() { this.state = 'closed'; this.closed = true; }
  }
  class FakeChunk {
    constructor(init) { Object.assign(this, init); }
  }
  class Observer { observe() {} }
  runInNewContext(appSource, {
    document: {
      getElementById: element,
      querySelectorAll: (sel) => sel === '[data-key]' ? keyButtons : [],
      addEventListener() {},
    },
    window: { addEventListener() {} },
    location: { protocol: 'http:', host: '127.0.0.1:3210' },
    WebSocket: FakeWebSocket,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeChunk,
    MutationObserver: Observer,
    ResizeObserver: Observer,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout(id) { if (id) timers[id - 1] = null; },
    fetch: () => new Promise(() => {}),
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Promise,
    Error,
  });
  return { element, keyButtons, sockets, decoders, supportChecks, timers, FakeVideoDecoder };
}

async function connect(browser) {
  await browser.element('connect').handlers.click();
  const socket = browser.sockets.at(-1);
  socket.onopen();
  return socket;
}

function fakeFrame(overrides = {}) {
  return {
    displayWidth: 720,
    displayHeight: 1280,
    closed: false,
    close() { this.closed = true; },
    ...overrides,
  };
}

function configSnapshot(value) {
  return {
    codec: String(value.codec),
    optimizeForLatency: Boolean(value.optimizeForLatency),
    hardwareAcceleration: String(value.hardwareAcceleration),
  };
}

test('supported H.264 config keeps low-latency decode and flushes a pending keyframe', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  socket.onmessage({ data: deltaPacket() });
  socket.onmessage({ data: keyframePacket() });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'connecting');
  assert.deepEqual(configSnapshot(browser.supportChecks[0]), {
    codec: 'avc1.42c01e',
    optimizeForLatency: true,
    hardwareAcceleration: 'prefer-hardware',
  });
  probe.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 1);
  assert.deepEqual(browser.decoders[0].configured.map(configSnapshot), [{
    codec: 'avc1.42c01e',
    optimizeForLatency: true,
    hardwareAcceleration: 'prefer-hardware',
  }]);
  assert.equal(browser.decoders[0].decoded.length, 1);
  assert.equal(browser.decoders[0].decoded[0].type, 'key');
  assert.ok(browser.keyButtons.every((button) => button.disabled));
  const frame = fakeFrame();
  browser.decoders[0].output(frame);
  assert.equal(frame.closed, true);
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(browser.element('resolution').textContent, '720 × 1280');
  assert.ok(browser.keyButtons.every((button) => !button.disabled));
});

test('unsupported config fails locally without configuring a decoder', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket(annexB(0x64, 0x00, 0x28)) });
  probe.resolve({ supported: false });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /cannot decode the phone's H\.264 video \(avc1\.640028\)/);
  assert.match(browser.element('empty-message').textContent, /Chrome or Edge/);
  assert.equal(socket.closed, true);
});

test('rejected support check fails locally without waiting for video', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  probe.reject(new Error('operation is not supported'));
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /Could not check H\.264 decoder support: operation is not supported/);
});

test('missing isConfigSupported fails locally instead of configuring', async () => {
  const browser = loadBrowser({ omitSupportCheck: true });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /Could not check H\.264 decoder support/);
});

test('late supported result after disconnect does not revive the stream', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  await browser.element('connect').handlers.click();
  assert.equal(browser.element('state').dataset.state, 'idle');
  probe.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'idle');
  assert.equal(browser.element('message').classList.contains('error'), false);
});

test('late unsupported result after disconnect does not mark a disconnected view as failed', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  await connect(browser);
  browser.sockets[0].onmessage({ data: configPacket() });
  await browser.element('connect').handlers.click();
  probe.resolve({ supported: false });
  await settle();
  assert.equal(browser.element('state').dataset.state, 'idle');
  assert.doesNotMatch(browser.element('message').textContent, /cannot decode/);
});

test('two configuration packets completing out of order keep only the current config', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const browser = loadBrowser({
    isConfigSupported: () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket(annexB(0x64, 0x00, 0x28)) });
  socket.onmessage({ data: configPacket(annexB(0x42, 0xc0, 0x1e)) });
  socket.onmessage({ data: keyframePacket() });
  first.resolve({ supported: false });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'connecting');
  second.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 1);
  assert.equal(browser.decoders[0].configured[0].codec, 'avc1.42c01e');
  assert.equal(browser.decoders[0].decoded.length, 1);
  assert.equal(browser.element('state').dataset.state, 'connecting');
});

test('stale supported result from an earlier config does not configure or fail the replacement', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const browser = loadBrowser({
    isConfigSupported: () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket(annexB(0x64, 0x00, 0x28)) });
  socket.onmessage({ data: configPacket(annexB(0x42, 0xc0, 0x1e)) });
  first.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'connecting');
  second.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 1);
  assert.equal(browser.decoders[0].configured[0].codec, 'avc1.42c01e');
});

test('rotation video message invalidates an in-flight probe', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const browser = loadBrowser({
    isConfigSupported: () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket(annexB(0x64, 0x00, 0x28)) });
  socket.receive({ type: 'video' });
  socket.onmessage({ data: configPacket(annexB(0x42, 0xc0, 0x1e)) });
  first.resolve({ supported: false });
  await settle();
  assert.equal(browser.element('state').dataset.state, 'connecting');
  second.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 1);
  assert.equal(browser.decoders[0].configured[0].codec, 'avc1.42c01e');
});

test('pending media is bounded and a late support result cannot revive after the bound fails', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  socket.onmessage({ data: keyframePacket() });
  for (let i = 0; i < 7; i++) socket.onmessage({ data: deltaPacket() });
  assert.equal(browser.element('state').dataset.state, 'connecting');
  socket.onmessage({ data: deltaPacket() });
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /fell behind/);
  probe.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /fell behind/);
});

test('first-frame timeout still fires while a support check is pending', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  assert.equal(typeof browser.timers[0], 'function');
  browser.timers[0]();
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /No video arrived/);
  probe.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 0);
  assert.match(browser.element('message').textContent, /No video arrived/);
});

test('positive support probe still reports runtime configure and decode failures', async () => {
  const probe = deferred();
  const browser = loadBrowser({
    isConfigSupported: () => probe.promise,
    configure(_decoder, _config) { throw new Error('unsupported configuration'); },
  });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  probe.resolve({ supported: true });
  await settle();
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /Video decoding stopped: unsupported configuration/);
});

test('decoder error after a positive probe uses the existing decode-failure path', async () => {
  const browser = loadBrowser();
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  await settle();
  assert.equal(browser.decoders.length, 1);
  browser.decoders[0].error(new Error('decode failed'));
  assert.match(browser.element('message').textContent, /Video decoding stopped: decode failed/);
  assert.equal(browser.element('state').dataset.state, 'error');
});

test('usable controls require a rendered frame and VideoFrame.close always runs', async () => {
  const browser = loadBrowser();
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  await settle();
  socket.onmessage({ data: keyframePacket() });
  assert.ok(browser.keyButtons.every((button) => button.disabled));
  assert.equal(browser.element('text-input').disabled, true);
  const stale = fakeFrame({ displayWidth: 1080, displayHeight: 1920 });
  await browser.element('connect').handlers.click();
  browser.decoders[0].output(stale);
  assert.equal(stale.closed, true);
  assert.equal(browser.element('state').dataset.state, 'idle');
  assert.equal(browser.element('screen').hidden, true);
  assert.equal(browser.element('resolution').textContent, '');
});

test('backpressure after configure still fails without retrying', async () => {
  const browser = loadBrowser();
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  await settle();
  browser.decoders[0].decodeQueueSize = 9;
  socket.onmessage({ data: keyframePacket() });
  assert.equal(browser.element('state').dataset.state, 'error');
  assert.match(browser.element('message').textContent, /fell behind/);
  assert.equal(browser.decoders[0].decoded.length, 0);
});

test('reconnect after a stale probe uses only the new connection generation', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const browser = loadBrowser({
    isConfigSupported: () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  await connect(browser);
  browser.sockets[0].onmessage({ data: configPacket(annexB(0x64, 0x00, 0x28)) });
  await browser.element('connect').handlers.click();
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket(annexB(0x42, 0xc0, 0x1e)) });
  first.resolve({ supported: false });
  await settle();
  assert.equal(browser.element('state').dataset.state, 'connecting');
  second.resolve({ supported: true });
  await settle();
  assert.equal(browser.decoders.length, 1);
  assert.equal(browser.decoders[0].configured[0].codec, 'avc1.42c01e');
});

test('handoff moved notice ignores a late support result', async () => {
  const probe = deferred();
  const browser = loadBrowser({ isConfigSupported: () => probe.promise });
  const socket = await connect(browser);
  socket.onmessage({ data: configPacket() });
  socket.receive({ type: 'moved' });
  assert.equal(browser.element('state').dataset.state, 'moved');
  probe.resolve({ supported: false });
  await settle();
  assert.equal(browser.element('state').dataset.state, 'moved');
  assert.doesNotMatch(browser.element('message').textContent, /cannot decode/);
});
