import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

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

function expandHex(hex) {
  if (hex.length === 4) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return hex.slice(0, 7);
}

function tokensFrom(block) {
  const tokens = {};
  for (const match of block.matchAll(/--([a-z0-9-]+):(#[0-9a-fA-F]{3,8})/g)) tokens[match[1]] = expandHex(match[2]);
  return tokens;
}

function assertPalette(name, tokens) {
  const pairs = [
    ['ink', 'page', 4.5],
    ['ink', 'surface', 4.5],
    ['muted', 'page', 4.5],
    ['muted', 'surface', 4.5],
    ['danger', 'page', 4.5],
    ['danger', 'surface', 4.5],
    ['primary-ink', 'primary', 4.5],
    ['slate', 'page', 3],
    ['slate', 'surface', 3],
    ['disabled-ink', 'surface', 3],
    ['disabled-ink', 'page', 3],
  ];
  for (const [fg, bg, need] of pairs) {
    assert.ok(tokens[fg] && tokens[bg], `${name} missing ${fg}/${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    assert.ok(ratio >= need, `${name} ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} is ${ratio.toFixed(2)}:1`);
  }
  assert.ok(contrast(tokens['canvas-focus'], '#000000') >= 3, `${name} canvas focus`);
  assert.notEqual(tokens['disabled-ink'], tokens.slate);
  assert.notEqual(tokens['disabled-ink'], tokens.ink);
}

function makeElement(extra = {}) {
  const attrs = {};
  const classes = new Set();
  return {
    dataset: {}, style: {}, handlers: {}, textContent: '', hidden: false, disabled: false,
    width: 0, height: 0, title: '', value: '', focused: false, checked: false, name: '',
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
    focus() { this.focused = true; },
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    setPointerCapture() {},
    ...extra,
  };
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  let reads = 0;
  let writes = 0;
  return {
    get data() { return data; },
    get reads() { return reads; },
    get writes() { return writes; },
    getItem(key) {
      reads += 1;
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      writes += 1;
      data[key] = String(value);
    },
  };
}

function failingStorage() {
  return {
    reads: 0,
    writes: 0,
    getItem() { this.reads += 1; throw new Error('storage-unavailable'); },
    setItem() { this.writes += 1; throw new Error('storage-unavailable'); },
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

function loadThemeBrowser(options = {}) {
  const storage = options.storage ?? memoryStorage(options.stored);
  const root = { dataset: { theme: 'system' } };
  const listenerCounts = { themeChange: 0, document: {}, window: {} };
  const elements = new Map();
  const documentHandlers = {};
  const windowHandlers = {};
  const documentState = { hidden: false, fullscreenEnabled: true, fullscreenElement: null };
  const keyButtons = ['back', 'home', 'recents', 'volumeDown', 'volumeUp', 'power'].map((key) => makeElement({ dataset: { key }, disabled: true }));
  const themeRadios = ['system', 'light', 'dark'].map((value) => makeElement({
    name: 'theme',
    value,
    type: 'radio',
    checked: value === 'system',
  }));
  const themeChoice = makeElement({
    addEventListener(name, handler) {
      this.handlers[name] = handler;
      if (name === 'change') listenerCounts.themeChange += 1;
    },
  });
  const summary = makeElement();
  const more = makeElement({
    open: false,
    querySelector(sel) { return sel === 'summary' ? summary : null; },
    contains(node) {
      return node === more || node === summary || node === themeChoice || themeRadios.includes(node);
    },
  });
  const dock = makeElement({});
  dock.requestFullscreen = async () => {
    documentState.fullscreenElement = dock;
    documentHandlers.fullscreenchange?.();
  };
  const fullscreen = makeElement({ hidden: true, title: 'Enter fullscreen' });
  fullscreen.setAttribute('aria-label', 'Enter fullscreen');
  fullscreen.setAttribute('aria-pressed', 'false');
  function element(id) {
    if (id === 'more-controls') return more;
    if (id === 'theme-choice') return themeChoice;
    if (id === 'dock') return dock;
    if (id === 'fullscreen') return fullscreen;
    if (!elements.has(id)) {
      elements.set(id, makeElement({
        hidden: id === 'screen',
        disabled: id === 'text-input' || id === 'send-text' || id === 'pin-input' || id === 'send-pin',
      }));
    }
    return elements.get(id);
  }
  for (const id of [
    'screen', 'connect', 'connect-label', 'state', 'message', 'empty', 'empty-title', 'empty-message',
    'device', 'resolution', 'text-input', 'send-text', 'text-form', 'text-byte-count', 'text-input-help',
    'screen-area', 'fullscreen-label', 'pin-controls', 'pin-form', 'pin-input', 'send-pin',
    'pin-backspace', 'pin-enter', 'pin-status', 'pin-help', 'pin-privacy',
  ]) element(id);
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
    static created = 0;
    static latest;
    constructor({ output }) {
      this.output = output;
      this.state = 'configured';
      this.decodeQueueSize = 0;
      FakeVideoDecoder.created += 1;
      FakeVideoDecoder.latest = this;
    }
    configure() {}
    close() { this.state = 'closed'; }
    decode() {}
    emit(frame = { displayWidth: 720, displayHeight: 1280, close() {} }) { this.output(frame); }
  }
  FakeVideoDecoder.created = 0;
  class Observer { observe() {} }
  runInNewContext(appSource, {
    document: Object.assign(documentState, {
      documentElement: root,
      getElementById: element,
      querySelectorAll: (sel) => {
        if (sel === '[data-key]') return keyButtons;
        if (sel === 'input[name="theme"]') return themeRadios;
        return [];
      },
      addEventListener(name, handler) {
        listenerCounts.document[name] = (listenerCounts.document[name] || 0) + 1;
        documentHandlers[name] = handler;
      },
      async exitFullscreen() {
        documentState.fullscreenElement = null;
        documentHandlers.fullscreenchange?.();
      },
    }),
    window: {
      addEventListener(name, handler) {
        listenerCounts.window[name] = (listenerCounts.window[name] || 0) + 1;
        windowHandlers[name] = handler;
      },
    },
    location: { protocol: 'http:', host: '127.0.0.1:3210' },
    localStorage: storage,
    WebSocket: FakeWebSocket,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: class { constructor(init) { Object.assign(this, init); } },
    MutationObserver: Observer,
    ResizeObserver: Observer,
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame(callback) { return 1; },
    cancelAnimationFrame() {},
    fetch: () => new Promise(() => {}),
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    DataView,
  });
  return {
    element, keyButtons, more, sockets, documentHandlers, FakeVideoDecoder, dock, fullscreen,
    themeChoice, themeRadios, root, storage, listenerCounts, documentState,
  };
}

function selectTheme(browser, value) {
  const radio = browser.themeRadios.find((input) => input.value === value);
  assert.ok(radio, `missing ${value} radio`);
  browser.themeChoice.handlers.change({ target: radio });
}

function keyEvent(key, extras = {}) {
  return {
    key, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...extras,
  };
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
  const browser = loadThemeBrowser(options);
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  return { browser, socket };
}

test('markup defaults to system appearance and stores only that preference', () => {
  assert.match(html, /<html lang="en" data-theme="system">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<fieldset id="theme-choice" class="theme-choice">/);
  assert.match(html, /<legend>Appearance<\/legend>/);
  assert.match(html, /id="theme-system"[^>]*value="system" checked/);
  assert.match(html, /id="theme-light"[^>]*value="light"/);
  assert.match(html, /id="theme-dark"[^>]*value="dark"/);
  assert.match(appSource, /THEME_STORAGE_KEY = 'droiddock\.theme'/);
  assert.equal([...appSource.matchAll(/localStorage/g)].length, 2);
  assert.doesNotMatch(appSource, /sessionStorage|matchMedia|setInterval/);
  assert.doesNotMatch(appSource, /canvas\.style\.(?:filter|background)|context\.filter/);
});

test('light and dark palettes keep text, focus, and disabled contrast', () => {
  const root = css.match(/:root\{[^}]+\}/);
  const dark = css.match(/\[data-theme=dark\]\{[^}]+\}/);
  const systemDark = css.match(/@media\(prefers-color-scheme:dark\)\{\[data-theme=system\]\{[^}]+\}/);
  assert.ok(root && dark && systemDark);
  const lightTokens = tokensFrom(root[0]);
  const darkTokens = tokensFrom(dark[0]);
  assert.deepEqual(darkTokens, tokensFrom(systemDark[0].replace(/^@media\(prefers-color-scheme:dark\)\{/, '')));
  assertPalette('light', lightTokens);
  assertPalette('dark', darkTokens);
  assert.match(css, /button:disabled\{[^}]*color:var\(--disabled-ink\)/);
  assert.match(css, /\.icon-button:disabled\{[^}]*color:var\(--disabled-ink\)/);
  assert.doesNotMatch(css, /button:disabled\{[^}]*opacity:\.38/);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--slate\)/);
  assert.doesNotMatch(css, /outline\s*:\s*none/);
});

test('chrome layouts use theme tokens and never recolor canvas pixels', () => {
  assert.match(css, /:root\{[^}]*background:var\(--page\)/);
  assert.match(css, /body\{[^}]*background:var\(--page\)/);
  assert.match(css, /\.controls\{[^}]*background:var\(--surface\)/);
  assert.match(css, /\.details-panel\{[^}]*background:var\(--surface\)/);
  assert.match(css, /\.text-form input\{[^}]*background:var\(--input\);color:var\(--ink\)/);
  assert.match(css, /\.empty-icon\{[^}]*stroke:var\(--empty-icon\)/);
  assert.match(css, /\.empty p\{[^}]*color:var\(--muted\)/);
  assert.match(css, /h2\{[^}]*color:var\(--ink\)/);
  assert.match(css, /\.message\.error\{color:var\(--danger\)\}/);
  assert.match(css, /\.dock:fullscreen,\.dock:-webkit-full-screen,\.dock\.is-fullscreen\{[^}]*background:var\(--page\)/);
  assert.match(css, /canvas\{display:block;background:#000;/);
  assert.match(css, /canvas:focus-visible\{outline:2px solid var\(--canvas-focus\)/);
  assert.doesNotMatch(css, /canvas[^{]*\{[^}]*\b(?:filter|mix-blend-mode)\s*:/);
  assert.doesNotMatch(css, /#screen[^{]*\{[^}]*\b(?:filter|mix-blend-mode|background)\s*:/);
  assert.match(css, /\.theme-choice\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.theme-choice\{[^}]*min-width:0/);
  assert.match(css, /\.details-panel\{[^}]*overflow:auto/);
  assert.match(css, /@media\(max-width:320px\)/);
});

test('theme code stays out of frame, pointer, and decoder paths', () => {
  const decode = appSource.match(/function decodePacket\([\s\S]*?\n  \}/);
  const pointer = appSource.match(/canvas\.addEventListener\('pointerdown'[\s\S]*?canvas\.addEventListener\('wheel'/);
  assert.ok(decode && pointer);
  assert.doesNotMatch(decode[0], /theme|localStorage|dataset\.theme/);
  assert.doesNotMatch(pointer[0], /theme|localStorage|dataset\.theme/);
  assert.doesNotMatch(appSource, /resetDecoder\(\);\s*[^}]*theme|theme[\s\S]{0,80}resetDecoder/);
});

test('default, stored, invalid, and storage-failure preferences stay local', () => {
  const fresh = loadThemeBrowser();
  assert.equal(fresh.root.dataset.theme, 'system');
  assert.equal(fresh.themeRadios.find((input) => input.value === 'system').checked, true);
  assert.equal(fresh.storage.reads, 1);
  assert.equal(fresh.storage.writes, 0);
  assert.equal(fresh.sockets.length, 0);

  const stored = loadThemeBrowser({ stored: { 'droiddock.theme': 'dark' } });
  assert.equal(stored.root.dataset.theme, 'dark');
  assert.equal(stored.themeRadios.find((input) => input.value === 'dark').checked, true);
  assert.equal(stored.storage.writes, 0);

  const invalid = loadThemeBrowser({ stored: { 'droiddock.theme': 'neon' } });
  assert.equal(invalid.root.dataset.theme, 'system');
  assert.equal(invalid.storage.writes, 0);

  const failed = loadThemeBrowser({ storage: failingStorage() });
  assert.equal(failed.root.dataset.theme, 'system');
  selectTheme(failed, 'dark');
  assert.equal(failed.root.dataset.theme, 'dark');
  assert.equal(failed.sockets.length, 0);
  assert.equal(failed.element('state').textContent, '');
});

test('synthetic disconnected, error, connected, and fullscreen layouts survive theme changes', async () => {
  const disconnected = loadThemeBrowser();
  assert.equal(disconnected.element('screen').hidden, true);
  assert.equal(disconnected.element('empty').hidden, false);
  assert.ok(disconnected.keyButtons.every((button) => button.disabled));
  selectTheme(disconnected, 'dark');
  selectTheme(disconnected, 'light');
  assert.equal(disconnected.element('screen').hidden, true);
  assert.equal(disconnected.element('empty').hidden, false);
  assert.equal(disconnected.sockets.length, 0);
  assert.ok(disconnected.keyButtons.every((button) => button.disabled));

  const errored = loadThemeBrowser();
  const errorSocket = await startConnect(errored);
  errorSocket.onopen();
  errorSocket.receive({ type: 'status', state: 'error', message: 'Synthetic connection error.' });
  assert.equal(errored.element('state').dataset.state, 'error');
  assert.equal(errored.element('empty-title').textContent, 'The phone is unavailable.');
  assert.equal(errored.element('message').classList.contains('error'), true);
  assert.equal(errored.element('screen').hidden, true);
  const errorClosed = errorSocket.closed;
  selectTheme(errored, 'dark');
  assert.equal(errored.element('state').dataset.state, 'error');
  assert.equal(errored.element('message').classList.contains('error'), true);
  assert.equal(errorSocket.closed, errorClosed);
  assert.equal(errored.sockets.length, 1);

  const { browser, socket } = await connectedBrowser();
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(browser.element('screen').hidden, false);
  assert.equal(browser.element('empty').hidden, true);
  assert.ok(browser.keyButtons.every((button) => !button.disabled));
  const decoder = browser.FakeVideoDecoder.latest;
  const created = browser.FakeVideoDecoder.created;
  const sentBefore = socket.sent.length;
  selectTheme(browser, 'dark');
  selectTheme(browser, 'system');
  decoder.emit();
  assert.equal(browser.FakeVideoDecoder.latest, decoder);
  assert.equal(browser.FakeVideoDecoder.created, created);
  assert.equal(decoder.state, 'configured');
  assert.equal(socket.closed, undefined);
  assert.equal(browser.sockets.length, 1);
  assert.equal(socket.sent.length, sentBefore);
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(browser.element('resolution').textContent, '720 × 1280');
  browser.element('screen').handlers.keydown(keyEvent('a'));
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'a' });

  await browser.fullscreen.handlers.click();
  assert.equal(browser.dock.classList.contains('is-fullscreen'), true);
  selectTheme(browser, 'light');
  selectTheme(browser, 'dark');
  decoder.emit();
  assert.equal(browser.dock.classList.contains('is-fullscreen'), true);
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.equal(browser.FakeVideoDecoder.created, created);
  assert.equal(socket.closed, undefined);
  browser.element('screen').handlers.keydown(keyEvent('Enter'));
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'enter' });
});

test('repeated theme toggles do not accumulate listeners, rebuild the decoder, or write on frames', async () => {
  const { browser, socket } = await connectedBrowser();
  assert.equal(browser.listenerCounts.themeChange, 1);
  const documentCounts = { ...browser.listenerCounts.document };
  const windowCounts = { ...browser.listenerCounts.window };
  const decoder = browser.FakeVideoDecoder.latest;
  const writesBefore = browser.storage.writes;
  for (let i = 0; i < 20; i += 1) selectTheme(browser, i % 2 ? 'dark' : 'light');
  for (let i = 0; i < 40; i += 1) decoder.emit();
  assert.equal(browser.listenerCounts.themeChange, 1);
  assert.deepEqual(browser.listenerCounts.document, documentCounts);
  assert.deepEqual(browser.listenerCounts.window, windowCounts);
  assert.equal(browser.FakeVideoDecoder.latest, decoder);
  assert.equal(browser.FakeVideoDecoder.created, 1);
  assert.equal(decoder.state, 'configured');
  assert.equal(socket.closed, undefined);
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.ok(browser.keyButtons.every((button) => !button.disabled));
  assert.equal(browser.storage.writes, writesBefore + 20);
  assert.equal(browser.storage.data['droiddock.theme'], 'dark');
  const beforeInput = socket.sent.length;
  browser.element('screen').handlers.keydown(keyEvent('a'));
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'a' });
  assert.equal(socket.sent.length, beforeInput + 1);
});
