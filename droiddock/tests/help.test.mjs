import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function keyEvent(key, extras = {}) {
  return {
    key, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...extras,
  };
}

function dispatchKey(browser, target, event) {
  target?.handlers.keydown?.(event);
  browser.documentHandlers.keydown?.(event);
  return event;
}

function sliceBetween(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0, `missing ${startMark}`);
  assert.ok(end > start, `missing ${endMark} after ${startMark}`);
  return source.slice(start, end);
}

async function connectedBrowser() {
  const browser = loadBrowser();
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  return { browser, socket };
}

test('Help is a named static panel that documents pointer, keyboard, paste, and fallback text', () => {
  assert.match(html, /<details id="help-controls"/);
  assert.match(html, /<summary class="icon-button" aria-label="Help"/);
  assert.match(html, /<h2 id="help-title">Help<\/h2>/);
  assert.match(html, /<button id="close-help" type="button" aria-label="Close help">Close<\/button>/);
  assert.match(html, /Opening Help does not send input to the phone/);
  assert.match(html, /Help stays available while disconnected/);
  assert.match(html, /Tap, drag, long-press, and scroll/);
  assert.match(html, /unavailable until a live frame appears/);
  assert.match(html, /Focus the phone screen to type/);
  assert.match(html, /Tab stays in the browser/);
  assert.match(html, /does not add global shortcut interception/);
  assert.match(html, /Escape closes Help and returns focus to Help/);
  assert.match(html, /Escape then closes Details/);
  assert.match(html, /Escape that exits fullscreen does not send Android Back/);
  assert.match(html, /Escape sends Back/);
  assert.match(html, /Ctrl\+V over the focused phone screen/);
  assert.match(html, /64 KiB of UTF-8/);
  assert.match(html, /Images and files are not supported/);
  assert.match(html, /300 UTF-8 bytes per send/);
  assert.match(html, /ASCII and some accented letters/);
  assert.match(html, /N \/ 300 bytes/);
  assert.match(html, /optional local stream statistics/);
  assert.match(html, /not end-to-end latency/);
  assert.match(css, /\.help-panel h2\{/);
  assert.match(css, /max-height:calc\(100dvh - 16px\)/);
  assert.match(css, /width:min\(270px,calc\(100vw - var\(--rail\) - 16px\)\)/);
  assert.doesNotMatch(html, /id="help-controls"[^>]*disabled/);
  assert.doesNotMatch(html, /id="close-help"[^>]*disabled/);
  assert.doesNotMatch(appSource, /localStorage|sessionStorage/);
});

test('Help stays usable while disconnected and restores focus without phone commands', () => {
  const browser = loadBrowser();
  assert.equal(browser.help.open, false);
  assert.equal(browser.element('close-help').disabled, false);
  assert.ok(browser.keyButtons.every((button) => button.disabled));
  assert.equal(browser.element('text-input').disabled, true);
  assert.equal(browser.sockets.length, 0);

  browser.help.open = true;
  const close = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  browser.element('close-help').handlers.click(close);
  assert.equal(close.defaultPrevented, true);
  assert.equal(browser.help.open, false);
  assert.equal(browser.helpSummary.focused, true);
  assert.equal(browser.sockets.length, 0);

  browser.help.open = true;
  browser.helpSummary.focused = false;
  const escape = dispatchKey(browser, browser.element('connect'), keyEvent('Escape'));
  assert.equal(escape.defaultPrevented, true);
  assert.equal(browser.help.open, false);
  assert.equal(browser.helpSummary.focused, true);
  assert.equal(browser.more.open, false);
  assert.equal(browser.sockets.length, 0);
});

test('Help actions send no phone commands and close before Details or Android Back', async () => {
  const { browser, socket } = await connectedBrowser();
  assert.equal(browser.element('close-help').disabled, false);
  const beforeHelp = socket.sent.length;

  browser.help.open = true;
  dispatchKey(browser, browser.element('screen'), keyEvent('Tab'));
  browser.documentHandlers.pointerdown({ target: browser.element('connect') });
  assert.equal(browser.help.open, false);
  assert.equal(socket.sent.length, beforeHelp);

  browser.help.open = true;
  browser.documentHandlers.pointerdown({ target: browser.element('help-panel') });
  assert.equal(browser.help.open, true);
  browser.element('close-help').handlers.click({ preventDefault() {} });
  assert.equal(browser.help.open, false);
  assert.equal(browser.helpSummary.focused, true);
  assert.equal(socket.sent.length, beforeHelp);

  browser.help.open = true;
  browser.more.open = true;
  const beforeEscape = socket.sent.length;
  const first = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(first.defaultPrevented, true);
  assert.equal(browser.help.open, false);
  assert.equal(browser.more.open, true);
  assert.equal(browser.helpSummary.focused, true);
  assert.equal(socket.sent.length, beforeEscape);

  const second = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(second.defaultPrevented, true);
  assert.equal(browser.more.open, false);
  assert.equal(browser.summary.focused, true);
  assert.equal(socket.sent.length, beforeEscape);

  const back = dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
  assert.equal(back.defaultPrevented, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'back' });
});

test('opening and closing Help does not add listeners or disrupt synthetic frames and input', async () => {
  const { browser, socket } = await connectedBrowser();
  const documentKeys = Object.keys(browser.documentHandlers);
  const windowKeys = Object.keys(browser.windowHandlers);
  for (let cycle = 0; cycle < 20; cycle++) {
    browser.help.open = true;
    dispatchKey(browser, browser.element('screen'), keyEvent('Escape'));
    assert.equal(browser.help.open, false);
  }
  assert.deepEqual(Object.keys(browser.documentHandlers), documentKeys);
  assert.deepEqual(Object.keys(browser.windowHandlers), windowKeys);

  browser.FakeVideoDecoder.latest.emit({ displayWidth: 800, displayHeight: 600, close() {} });
  assert.equal(browser.element('screen').hidden, false);
  assert.equal(browser.element('resolution').textContent, '800 × 600');
  const before = socket.sent.length;
  dispatchKey(browser, browser.element('screen'), keyEvent('a'));
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'a' });
  assert.equal(socket.sent.length, before + 1);
  assert.ok(browser.keyButtons.every((button) => !button.disabled));
});

test('Help stays off the packet, decoder, and pointer-move paths', () => {
  const decode = sliceBetween(appSource, 'function decodePacket', 'function coordinates');
  const move = sliceBetween(appSource, 'canvas.addEventListener(\'pointermove\'', 'canvas.addEventListener(\'pointerup\'');
  const closeHelp = sliceBetween(appSource, 'function closeHelpControls', 'function closeMoreControls');
  assert.doesNotMatch(decode, /help-controls|close-help|help-panel/);
  assert.doesNotMatch(move, /help-controls|close-help|help-panel/);
  assert.doesNotMatch(closeHelp, /addEventListener|setInterval|setTimeout|requestAnimationFrame|send\(/);
  assert.match(appSource, /function closeHelpControls/);
  assert.equal((appSource.match(/\$\('help-controls'\)\.addEventListener/g) || []).length, 1);
  assert.equal((appSource.match(/\$\('close-help'\)\.addEventListener/g) || []).length, 1);
  assert.doesNotMatch(decode, /setInterval\(/);
  assert.doesNotMatch(move, /setInterval\(/);
});
