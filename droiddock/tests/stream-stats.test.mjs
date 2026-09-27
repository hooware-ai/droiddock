import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function packet(index = 0) {
  const payload = Uint8Array.from([0, 0, 0, 1, index ? 0x41 : 0x65, index]);
  const buffer = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buffer);
  view.setBigUint64(0, index ? 0n : 1n << 62n);
  view.setUint32(8, payload.length);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

function configuration() {
  const payload = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e]);
  const buffer = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buffer);
  view.setBigUint64(0, 1n << 63n);
  view.setUint32(8, payload.length);
  new Uint8Array(buffer, 12).set(payload);
  return buffer;
}

async function setup() {
  let now = 0;
  const browser = loadBrowser({ clock: true, now: () => now });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const toggle = browser.element('stream-stats-toggle');
  const values = () => ['bytes', 'frames', 'queue'].map(name => browser.element(`stream-stats-${name}`).textContent);
  const advance = (ms = 1000) => { now += ms; return browser.runTimer(); };
  const open = () => { browser.more.open = true; browser.more.handlers.toggle(); toggle.checked = true; toggle.handlers.change(); };
  const draw = () => browser.FakeVideoDecoder.latest.emit();
  return { browser, socket, toggle, values, advance, open, draw };
}

test('statistics are opt-in, local, and silent to assistive technology', async () => {
  assert.match(html, /id="stream-stats-toggle" type="checkbox" aria-label="Show local statistics"/);
  assert.match(html, /id="stream-stats-title">Stream statistics/);
  assert.doesNotMatch(html.match(/<section class="stream-stats"[^>]*>/)[0], /aria-live/);
  const s = await setup();
  assert.deepEqual(s.values(), ['—', '—', '—']);
  s.socket.onmessage({ data: packet() });
  s.draw();
  assert.equal(s.advance(), false, 'no sampler exists while disabled');
  assert.deepEqual(s.values(), ['—', '—', '—']);
  assert.ok(s.socket.sent.every(message => message.type !== 'statistics'));
});

test('monotonic samples distinguish received bytes, drawn frames, and queue depth across burst and idle', async () => {
  const s = await setup();
  s.open();
  assert.deepEqual(s.values(), ['Collecting…', 'Collecting…', 'Collecting…']);
  for (let index = 0; index < 5; index++) s.socket.onmessage({ data: packet(index) });
  for (let index = 0; index < 3; index++) s.draw();
  s.browser.FakeVideoDecoder.latest.decodeQueueSize = 2;
  assert.deepEqual(s.values(), ['Collecting…', 'Collecting…', 'Collecting…'], 'packets and frames do not write DOM');
  assert.equal(s.advance(2000), true);
  assert.deepEqual(s.values(), ['15 B/s', '1.5 drawn/s', '2']);
  s.browser.FakeVideoDecoder.latest.decodeQueueSize = 0;
  assert.equal(s.advance(), true);
  assert.deepEqual(s.values(), ['0 B/s', '0.0 drawn/s', '0'], 'static screen is not called a failure');
});

test('closing, hiding, disconnecting, and handoff stop sampling and clear values', async () => {
  const s = await setup();
  s.open();
  s.browser.more.open = false;
  s.browser.more.handlers.toggle();
  assert.equal(s.advance(), false);
  assert.deepEqual(s.values(), ['—', '—', '—']);
  s.browser.more.open = true;
  s.browser.more.handlers.toggle();
  s.browser.documentState.hidden = true;
  s.browser.documentHandlers.visibilitychange();
  assert.equal(s.advance(), false);
  s.browser.documentState.hidden = false;
  s.browser.documentHandlers.visibilitychange();
  assert.equal(s.advance(), true);
  const obsoleteSample = s.browser.lastTimerCallback();
  s.socket.receive({ type: 'moved' });
  assert.equal(s.advance(), false);
  assert.deepEqual(s.values(), ['—', '—', '—']);
  obsoleteSample();
  assert.deepEqual(s.values(), ['—', '—', '—'], 'cancelled sample cannot report a stale session');
  const oldDecoder = s.browser.FakeVideoDecoder.latest;
  oldDecoder.emit();
  assert.deepEqual(s.values(), ['—', '—', '—']);
  const replacement = deliverSyntheticFrame(s.browser, await startConnect(s.browser));
  assert.notEqual(replacement, s.socket);
  assert.equal(s.advance(), true, 'fresh connection starts a new sample');
  s.browser.element('connect').handlers.click();
  assert.equal(s.advance(), false);
  assert.deepEqual(s.values(), ['—', '—', '—']);
});

test('codec reset, toggle off, and loss of focus clear the current window', async () => {
  const s = await setup();
  s.open();
  s.socket.onmessage({ data: packet() });
  s.socket.receive({ type: 'video' });
  assert.equal(s.advance(), false);
  assert.deepEqual(s.values(), ['—', '—', '—']);
  s.socket.onmessage({ data: configuration() });
  s.draw();
  assert.equal(s.advance(), true);
  assert.equal(s.values()[0], '0 B/s');
  s.toggle.checked = false;
  s.toggle.handlers.change();
  assert.equal(s.advance(), false);
  s.toggle.checked = true;
  s.toggle.handlers.change();
  s.browser.windowHandlers.blur();
  assert.equal(s.advance(), false);
  assert.deepEqual(s.values(), ['—', '—', '—']);
});
