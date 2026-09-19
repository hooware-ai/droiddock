import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function attributes(source) {
  const attrs = {};
  for (const match of source.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[match[1]] = match[2] ?? '';
  return attrs;
}

function tagById(id) {
  const match = html.match(new RegExp(`<([a-zA-Z0-9]+)([^>]*\\sid="${id}"[^>]*)>`, 'i'));
  assert.ok(match, `missing #${id}`);
  return { name: match[1], attrs: attributes(match[2]) };
}

function keyEvent(key, extras = {}) {
  return {
    key, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...extras,
  };
}

function makeElement(extra = {}) {
  const attrs = {};
  const classes = new Set();
  return {
    dataset: {}, style: {}, handlers: {}, textContent: '', hidden: false, disabled: false,
    width: 0, height: 0, title: '', value: '', focused: false, offsetLeft: 0, offsetTop: 0,
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
    getBoundingClientRect() { return { width: this.width || 720, height: this.height || 1280, left: 0, top: 0 }; },
    focus() { this.focused = true; },
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    setPointerCapture() {},
    ...extra,
  };
}

function configPacket() {
  const payload = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e]);
  const buffer = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buffer);
  view.setBigUint64(0, 1n << 63n);
  view.setUint32(8, payload.length);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

function loadBrowser({ fullscreenEnabled = true, fullscreenMode = 'succeed' } = {}) {
  const elements = new Map();
  const documentHandlers = {};
  const keyButtons = ['back', 'home', 'recents', 'volumeDown', 'volumeUp', 'power'].map((key) => makeElement({ dataset: { key }, disabled: true }));
  const summary = makeElement();
  const more = makeElement({
    open: false,
    querySelector(sel) { return sel === 'summary' ? summary : null; },
    contains(node) {
      return node === more || node === summary || node === element('text-input') || node === element('send-text') || node === element('message');
    },
  });
  const helpSummary = makeElement();
  const help = makeElement({
    open: false,
    querySelector(sel) { return sel === 'summary' ? helpSummary : null; },
    contains(node) {
      return node === help || node === helpSummary || node === element('close-help') || node === element('help-panel');
    },
  });
  const areaRect = { width: 360, height: 640, left: 0, top: 0 };
  const screenArea = makeElement({
    getBoundingClientRect() { return { ...areaRect }; },
  });
  const canvas = makeElement({
    hidden: true,
    getBoundingClientRect() {
      const width = Number.parseInt(this.style.width, 10);
      const height = Number.parseInt(this.style.height, 10);
      return {
        width: Number.isFinite(width) && width > 0 ? width : this.width || 0,
        height: Number.isFinite(height) && height > 0 ? height : this.height || 0,
        left: this.offsetLeft,
        top: this.offsetTop,
      };
    },
  });
  const fullscreen = makeElement({ hidden: true, title: 'Enter fullscreen' });
  fullscreen.setAttribute('aria-label', 'Enter fullscreen');
  fullscreen.setAttribute('aria-pressed', 'false');
  const docState = { fullscreenEnabled, fullscreenElement: null };
  const dock = makeElement({});
  if (fullscreenMode !== 'missing') {
    dock.requestFullscreen = async () => {
      if (fullscreenMode === 'deny') {
        const error = new Error('Fullscreen request denied.');
        error.name = 'TypeError';
        throw error;
      }
      docState.fullscreenElement = dock;
      documentHandlers.fullscreenchange?.();
    };
  }
  function element(id) {
    if (id === 'more-controls') return more;
    if (id === 'help-controls') return help;
    if (id === 'dock') return dock;
    if (id === 'screen-area') return screenArea;
    if (id === 'screen') return canvas;
    if (id === 'fullscreen') return fullscreen;
    if (!elements.has(id)) {
      elements.set(id, makeElement({
        hidden: id === 'pin-controls',
        disabled: id === 'text-input' || id === 'send-text',
      }));
    }
    return elements.get(id);
  }
  for (const id of ['connect', 'connect-label', 'state', 'message', 'empty', 'empty-title', 'empty-message', 'device', 'resolution', 'text-input', 'send-text', 'text-form', 'fullscreen-label', 'close-help', 'help-panel']) element(id);
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  class FakeVideoDecoder {
    static latest;
    constructor({ output }) {
      this.output = output;
      this.state = 'configured';
      this.decodeQueueSize = 0;
      FakeVideoDecoder.latest = this;
    }
    configure() {}
    close() { this.state = 'closed'; }
    decode() {}
    emit(frame = { displayWidth: 720, displayHeight: 1280, close() {} }) { this.output(frame); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() {}
  }
  runInNewContext(appSource, {
    document: {
      hasFocus: () => true,
      getElementById: element,
      querySelectorAll: (sel) => sel === '[data-key]' ? keyButtons : [],
      addEventListener(name, handler) { documentHandlers[name] = handler; },
      get fullscreenEnabled() { return docState.fullscreenEnabled; },
      get fullscreenElement() { return docState.fullscreenElement; },
      set fullscreenElement(value) { docState.fullscreenElement = value; },
      async exitFullscreen() {
        docState.fullscreenElement = null;
        documentHandlers.fullscreenchange?.();
      },
    },
    window: { addEventListener() {} },
    location: { protocol: 'http:', host: '127.0.0.1:3210' },
    WebSocket: FakeWebSocket,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
    MutationObserver: Observer,
    ResizeObserver: Observer,
    setTimeout,
    clearTimeout,
    setImmediate,
    requestAnimationFrame(callback) { return setTimeout(callback, 0); },
    cancelAnimationFrame: clearTimeout,
    fetch: () => new Promise(() => {}),
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    DataView,
  });
  return { element, keyButtons, summary, more, help, helpSummary, sockets, documentHandlers, FakeVideoDecoder, dock, fullscreen, areaRect, docState };
}

function dispatchKey(browser, target, event) {
  target?.handlers.keydown?.(event);
  browser.documentHandlers.keydown?.(event);
  return event;
}

async function startConnect(browser) {
  await browser.element('connect').handlers.click();
  return browser.sockets[0];
}

function deliverSyntheticFrame(browser, socket) {
  socket.onopen();
  socket.receive({ type: 'status', state: 'connecting' });
  socket.onmessage({ data: configPacket() });
  browser.FakeVideoDecoder.latest.emit();
  return socket;
}

async function connectedBrowser(options) {
  const browser = loadBrowser(options);
  const socket = await startConnect(browser);
  deliverSyntheticFrame(browser, socket);
  return { browser, socket };
}

function lastTouchDown(socket) {
  return socket.sent.filter((message) => message.type === 'touch' && message.action === 0).at(-1);
}

function tap(browser, clientX, clientY) {
  const canvas = browser.element('screen');
  canvas.handlers.pointerdown({ button: 0, pointerId: 1, clientX, clientY, preventDefault() {} });
  canvas.handlers.pointerup({ pointerId: 1, clientX, clientY });
}

test('fullscreen control is a hidden, named rail toggle after phone keys', () => {
  const dock = tagById('dock');
  assert.equal(dock.name, 'main');
  const button = tagById('fullscreen');
  assert.equal(button.name, 'button');
  assert.equal(button.attrs.type, 'button');
  assert.ok('hidden' in button.attrs);
  assert.equal(button.attrs['aria-label'], 'Enter fullscreen');
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.ok(!('data-key' in button.attrs));
  assert.doesNotMatch(html, /id="fullscreen"[^>]*tabindex="[1-9]/);
  assert.match(html, /<span id="fullscreen-label" class="sr-only">Enter fullscreen<\/span>/);
  assert.match(css, /\.dock:fullscreen/);
  assert.match(css, /#fullscreen\[aria-pressed=true\] \.fullscreen-enter\{display:none\}/);
  const powerAt = html.indexOf('data-key="power"');
  const fullscreenAt = html.indexOf('id="fullscreen"');
  const detailsAt = html.indexOf('id="more-controls"');
  assert.ok(powerAt < fullscreenAt && fullscreenAt < detailsAt);
});

test('unsupported Fullscreen API keeps the ordinary view and hides the control', async () => {
  const browser = loadBrowser({ fullscreenEnabled: false });
  assert.equal(browser.fullscreen.hidden, true);
  const { browser: missing } = await connectedBrowser({ fullscreenEnabled: true, fullscreenMode: 'missing' });
  assert.equal(missing.fullscreen.hidden, true);
  assert.equal(missing.element('state').dataset.state, 'connected');
  assert.ok(missing.keyButtons.every((button) => !button.disabled));
});

test('enter and exit follow fullscreenchange and keep the same session', async () => {
  const { browser, socket } = await connectedBrowser();
  assert.equal(browser.fullscreen.hidden, false);
  assert.equal(browser.fullscreen.getAttribute('aria-label'), 'Enter fullscreen');
  assert.equal(browser.fullscreen.getAttribute('aria-pressed'), 'false');
  const sentBefore = socket.sent.length;
  await browser.fullscreen.handlers.click();
  assert.equal(browser.docState.fullscreenElement, browser.dock);
  assert.equal(browser.dock.classList.contains('is-fullscreen'), true);
  assert.equal(browser.fullscreen.getAttribute('aria-label'), 'Exit fullscreen');
  assert.equal(browser.fullscreen.getAttribute('aria-pressed'), 'true');
  assert.equal(browser.element('fullscreen-label').textContent, 'Exit fullscreen');
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(browser.sockets.length, 1);
  assert.equal(socket.closed, undefined);
  assert.equal(socket.sent.filter((message) => message.type === 'connect').length, 1);
  assert.equal(socket.sent.length, sentBefore);
  await browser.fullscreen.handlers.click();
  assert.equal(browser.docState.fullscreenElement, null);
  assert.equal(browser.dock.classList.contains('is-fullscreen'), false);
  assert.equal(browser.fullscreen.getAttribute('aria-label'), 'Enter fullscreen');
  assert.equal(browser.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.equal(browser.sockets.length, 1);
  assert.equal(socket.sent.filter((message) => message.type === 'connect').length, 1);
});

test('browser-initiated exit updates the toggle without replacing the socket', async () => {
  const { browser, socket } = await connectedBrowser();
  await browser.fullscreen.handlers.click();
  browser.docState.fullscreenElement = null;
  browser.documentHandlers.fullscreenchange();
  assert.equal(browser.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.equal(browser.dock.classList.contains('is-fullscreen'), false);
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(socket.closed, undefined);
  assert.equal(browser.sockets.length, 1);
});

test('denied fullscreen does not reject to the host or break the connection', async () => {
  const { browser, socket } = await connectedBrowser({ fullscreenMode: 'deny' });
  const errors = [];
  const onReject = (reason) => { errors.push(reason); };
  process.on('unhandledRejection', onReject);
  try {
    await browser.fullscreen.handlers.click();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onReject);
  }
  assert.equal(errors.length, 0);
  assert.equal(browser.docState.fullscreenElement, null);
  assert.equal(browser.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(socket.closed, undefined);
  const before = socket.sent.length;
  dispatchKey(browser, browser.element('screen'), keyEvent('a'));
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'a' });
  assert.equal(socket.sent.length, before + 1);
});

test('Escape exiting fullscreen does not send Android Back', async () => {
  const { browser, socket } = await connectedBrowser();
  await browser.fullscreen.handlers.click();
  const before = socket.sent.length;
  const escape = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(escape.defaultPrevented, false);
  assert.equal(socket.sent.length, before);
  assert.ok(!socket.sent.some((message) => message.type === 'key' && message.key === 'back'));
  browser.docState.fullscreenElement = null;
  browser.documentHandlers.fullscreenchange();
  assert.equal(browser.fullscreen.getAttribute('aria-pressed'), 'false');
});

test('Escape after a change-first fullscreen exit still does not send Back', async () => {
  const { browser, socket } = await connectedBrowser();
  await browser.fullscreen.handlers.click();
  browser.docState.fullscreenElement = null;
  browser.documentHandlers.fullscreenchange();
  const before = socket.sent.length;
  dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(socket.sent.length, before);
  dispatchKey(browser, browser.element('screen'), keyEvent('a'));
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'a' });
});

test('Help Escape closes the panel before fullscreen or Android Back', async () => {
  const { browser, socket } = await connectedBrowser();
  await browser.fullscreen.handlers.click();
  browser.help.open = true;
  const before = socket.sent.length;
  const dismiss = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(dismiss.defaultPrevented, true);
  assert.equal(browser.help.open, false);
  assert.equal(browser.helpSummary.focused, true);
  assert.equal(browser.docState.fullscreenElement, browser.dock);
  assert.equal(socket.sent.length, before);
  const stillFullscreen = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(stillFullscreen.defaultPrevented, false);
  assert.equal(browser.docState.fullscreenElement, browser.dock);
  assert.ok(!socket.sent.some((message) => message.type === 'key' && message.key === 'back'));
});

test('Details and canvas Escape keep their windowed behavior', async () => {
  const { browser, socket } = await connectedBrowser();
  const back = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(back.defaultPrevented, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'back' });
  browser.more.open = true;
  const beforeOverlay = socket.sent.length;
  const dismiss = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(dismiss.defaultPrevented, true);
  assert.equal(browser.more.open, false);
  assert.equal(browser.summary.focused, true);
  assert.equal(socket.sent.length, beforeOverlay);
  await browser.fullscreen.handlers.click();
  browser.more.open = true;
  browser.summary.focused = false;
  const fullscreenDetails = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(fullscreenDetails.defaultPrevented, true);
  assert.equal(browser.more.open, false);
  assert.equal(browser.docState.fullscreenElement, browser.dock);
  assert.ok(!socket.sent.some((message, index) => index >= beforeOverlay && message.type === 'key' && message.key === 'back'));
});

test('pointer mapping follows fitScreen after enter, exit, and resize', async () => {
  const { browser, socket } = await connectedBrowser();
  const canvas = browser.element('screen');
  assert.equal(canvas.style.width, '360px');
  assert.equal(canvas.style.height, '640px');
  tap(browser, 0, 0);
  assert.deepEqual(lastTouchDown(socket), { type: 'touch', action: 0, x: 0, y: 0, width: 720, height: 1280 });
  tap(browser, 359, 639);
  assert.deepEqual(lastTouchDown(socket), { type: 'touch', action: 0, x: 718, y: 1278, width: 720, height: 1280 });

  browser.areaRect.width = 1080;
  browser.areaRect.height = 1920;
  await browser.fullscreen.handlers.click();
  assert.equal(canvas.style.width, '1080px');
  assert.equal(canvas.style.height, '1920px');
  tap(browser, 540, 960);
  assert.deepEqual(lastTouchDown(socket), { type: 'touch', action: 0, x: 360, y: 640, width: 720, height: 1280 });

  browser.areaRect.width = 360;
  browser.areaRect.height = 640;
  await browser.fullscreen.handlers.click();
  assert.equal(canvas.style.width, '360px');
  assert.equal(canvas.style.height, '640px');
  tap(browser, 180, 320);
  assert.deepEqual(lastTouchDown(socket), { type: 'touch', action: 0, x: 360, y: 640, width: 720, height: 1280 });
});

test('fullscreen toggle does not bypass connection input gating', async () => {
  const browser = loadBrowser();
  assert.ok(browser.keyButtons.every((button) => button.disabled));
  await browser.fullscreen.handlers.click();
  assert.equal(browser.docState.fullscreenElement, browser.dock);
  assert.ok(browser.keyButtons.every((button) => button.disabled));
  const before = browser.sockets.length;
  dispatchKey(browser, browser.element('screen'), keyEvent('a'));
  dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(browser.sockets.length, before);
  browser.keyButtons[0].handlers.click();
  assert.equal(browser.sockets.length, 0);
  assert.ok(browser.keyButtons.every((button) => button.disabled));
});
