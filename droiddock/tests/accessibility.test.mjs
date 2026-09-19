import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const statsSource = readFileSync(new URL('../public/stream-stats.js', import.meta.url), 'utf8');

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

function srgb(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => srgb(parseInt(hex.slice(1 + i, 3 + i), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (hi + 0.05) / (lo + 0.05);
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
    dataset: {}, style: {}, handlers: {}, textContent: '', hidden: false, disabled: false, checked: false,
    width: 0, height: 0, title: '', value: '', focused: false, drawCount: 0,
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
    getContext() {
      return {
        clearRect() {},
        drawImage: () => { this.drawCount += 1; },
      };
    },
    getBoundingClientRect() { return { width: 720, height: 1280, left: 0, top: 0 }; },
    focus() { this.focused = true; },
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    setPointerCapture() {},
    ...extra,
  };
}

function loadBrowser(options = {}) {
  const elements = new Map();
  const documentHandlers = {};
  const windowHandlers = {};
  const documentState = { hidden: false };
  const keyButtons = ['back', 'home', 'recents', 'volumeDown', 'volumeUp', 'power'].map((key) => makeElement({ dataset: { key }, disabled: true }));
  const summary = makeElement();
  const more = makeElement({
    open: false,
    querySelector(sel) { return sel === 'summary' ? summary : null; },
    contains(node) {
      return node === more || node === summary || node === element('text-input') || node === element('send-text') || node === element('message') || node === element('text-byte-count') || node === element('text-input-help') || node === element('stream-stats-enabled') || node === element('stream-stats-panel') || node === element('stream-stats-bytes');
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
  function element(id) {
    if (id === 'more-controls') return more;
    if (id === 'help-controls') return help;
    if (!elements.has(id)) {
      elements.set(id, makeElement({
        hidden: id === 'screen' || id === 'stream-stats-panel',
        disabled: id === 'text-input' || id === 'send-text',
      }));
    }
    return elements.get(id);
  }
  for (const id of ['screen', 'connect', 'connect-label', 'state', 'message', 'empty', 'empty-title', 'empty-message', 'device', 'resolution', 'text-input', 'send-text', 'text-form', 'text-byte-count', 'text-input-help', 'screen-area', 'close-help', 'help-panel', 'stream-stats-enabled', 'stream-stats-panel', 'stream-stats-bytes', 'stream-stats-frames', 'stream-stats-queue']) element(id);
  let clock = 0;
  const intervals = new Map();
  let nextInterval = 0;
  const sockets = [];
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
  class Observer { observe() {} }
  const sandbox = {
    document: Object.assign(documentState, {
      getElementById: element,
      querySelectorAll: (sel) => sel === '[data-key]' ? keyButtons : [],
      addEventListener(name, handler) { documentHandlers[name] = handler; },
      fullscreenEnabled: false,
      fullscreenElement: null,
    }),
    window: { addEventListener(name, handler) { windowHandlers[name] = handler; } },
    location: { protocol: 'http:', host: '127.0.0.1:3210' },
    WebSocket: FakeWebSocket,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
    MutationObserver: Observer,
    ResizeObserver: Observer,
    performance: { now() { return clock; } },
    setInterval(fn, ms) {
      const id = ++nextInterval;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: () => new Promise(() => {}),
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    DataView,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(options.appSource || `${statsSource}\n${appSource}`, sandbox);
  return {
    element, keyButtons, summary, more, help, helpSummary, sockets, documentHandlers, windowHandlers, documentState, FakeVideoDecoder, intervals,
    setTime(value) { clock = value; },
    advanceTime(ms) { clock += ms; },
    tickIntervals() { for (const item of [...intervals.values()]) item.fn(); },
  };
}

function dispatchKey(browser, target, event) {
  target?.handlers.keydown?.(event);
  browser.documentHandlers.keydown?.(event);
  return event;
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

export { loadBrowser, startConnect, deliverSyntheticFrame };

test('browser chrome exposes names, a live status, and natural tab order on the synthetic screen', () => {
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  const canvas = tagById('screen');
  assert.equal(canvas.attrs.tabindex, '0');
  assert.ok('hidden' in canvas.attrs);
  assert.match(canvas.attrs['aria-label'], /Type while focused/i);
  assert.match(canvas.attrs['aria-label'], /Tab moves to browser controls/i);
  const connect = tagById('connect');
  assert.equal(connect.attrs['aria-label'], 'Connect');
  assert.equal(connect.attrs['aria-describedby'], 'state');
  const state = tagById('state');
  assert.equal(state.attrs.role, 'status');
  assert.equal(state.attrs['aria-live'], 'polite');
  assert.match(html, /<label for="text-input">Fallback text input<\/label>/);
  assert.match(html, /aria-describedby="text-input-help text-byte-count"/);
  assert.match(html, /<button id="send-text"[^>]*>Send<\/button>/);
  assert.match(html, /role="group" aria-label="Phone controls"/);
  assert.match(html, /<summary class="icon-button" aria-label="Help"/);
  assert.match(html, /<summary class="icon-button" aria-label="Details and text input"/);
  const emptyMessage = tagById('empty-message');
  assert.equal(emptyMessage.attrs.role, 'status');
  assert.equal(emptyMessage.attrs['aria-live'], 'polite');
  assert.equal(emptyMessage.attrs['aria-atomic'], 'true');
  assert.match(html, /id="message" class="message" role="status" aria-live="polite"/);
  for (const match of html.matchAll(/<(button|summary)\b([^>]*)>/g)) {
    const attrs = attributes(match[2]);
    if (attrs.id === 'send-text') continue;
    assert.ok(attrs['aria-label'], `${match[0]} needs an accessible name`);
  }
  for (const match of html.matchAll(/<svg\b([^>]*)>/g)) {
    assert.match(match[1], /aria-hidden="true"/);
  }
  assert.deepEqual([...html.matchAll(/data-key="([^"]+)"/g)].map((match) => match[1]), ['back', 'home', 'recents', 'volumeDown', 'volumeUp', 'power']);
  const canvasAt = html.indexOf('id="screen"');
  const connectAt = html.indexOf('id="connect"');
  const firstKey = html.indexOf('data-key="back"');
  const fullscreenAt = html.indexOf('id="fullscreen"');
  const helpAt = html.indexOf('id="help-controls"');
  const detailsAt = html.indexOf('id="more-controls"');
  assert.ok(canvasAt < connectAt && connectAt < firstKey && firstKey < fullscreenAt && fullscreenAt < helpAt && helpAt < detailsAt);
});

test('visible focus styles meet a 3:1 contrast ratio on the empty rail and dark screen', () => {
  const slate = css.match(/--slate:(#[0-9a-fA-F]{6})/);
  const canvasFocus = css.match(/canvas:focus-visible\{outline:2px solid (#[0-9a-fA-F]{6})/);
  assert.ok(slate && canvasFocus);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--slate\);outline-offset:2px\}/);
  assert.doesNotMatch(css, /outline\s*:\s*none/);
  assert.ok(contrast(slate[1], '#ffffff') >= 3, `rail focus ${slate[1]} on white`);
  assert.ok(contrast(slate[1], '#f1f4f7') >= 3, `rail focus ${slate[1]} on page background`);
  assert.ok(contrast(canvasFocus[1], '#000000') >= 3, `screen focus ${canvasFocus[1]} on black`);
  assert.doesNotMatch(css, /\.state\{[^}]*font-size:0/);
});

test('keyboard handling keeps Tab in the browser and closes details before sending Back', async () => {
  const browser = loadBrowser();
  assert.equal(browser.element('screen').hidden, true);
  assert.ok(browser.keyButtons.every((button) => button.disabled));

  const socket = await startConnect(browser);
  assert.equal(browser.element('connect').getAttribute('aria-label'), 'Disconnect');
  assert.equal(browser.element('state').textContent, 'Connecting');
  assert.equal(browser.element('state').dataset.state, 'connecting');
  deliverSyntheticFrame(browser, socket);
  assert.equal(browser.element('screen').hidden, false);
  assert.equal(browser.element('state').textContent, 'Connected');
  assert.equal(browser.element('resolution').textContent, '720 × 1280');
  assert.ok(browser.keyButtons.every((button) => !button.disabled));
  assert.match(browser.element('message').textContent, /Tab stays in the browser/);

  const beforeTab = socket.sent.length;
  const tab = dispatchKey(browser, browser.element('screen'), keyEvent('Tab'));
  assert.equal(tab.defaultPrevented, false);
  assert.equal(socket.sent.length, beforeTab);

  const letter = dispatchKey(browser, browser.element('screen'), keyEvent('a'));
  assert.equal(letter.defaultPrevented, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'a' });
  dispatchKey(browser, browser.element('screen'), keyEvent('Enter'));
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'enter' });

  const beforeShortcut = socket.sent.length;
  dispatchKey(browser, browser.element('screen'), keyEvent('v', { ctrlKey: true }));
  assert.equal(socket.sent.length, beforeShortcut);

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

  browser.more.open = true;
  browser.summary.focused = false;
  const fromChrome = dispatchKey(browser, browser.element('connect'), keyEvent('Escape'));
  assert.equal(fromChrome.defaultPrevented, true);
  assert.equal(browser.more.open, false);
  assert.equal(browser.summary.focused, true);
});
