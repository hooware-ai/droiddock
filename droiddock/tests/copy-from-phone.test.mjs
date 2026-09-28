import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { CLIPBOARD_TEXT_MAX_BYTES, COPY_MESSAGES, DeviceMessageParser, DeviceProtocolError, encodeControl, encodeGetClipboard } from '../../dist/droiddock/protocol.js';
import { ScrcpySession } from '../../dist/droiddock/session.js';
import { loadBrowser, startConnect, deliverSyntheticFrame, dispatchKey, keyEvent } from './accessibility.test.mjs';

const MARKER = 'SYNTHETIC_CLIPBOARD_TEXT';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const frame = text => { const body = Buffer.from(text); const header = Buffer.alloc(5); header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); };

test('GET_CLIPBOARD serializes to fixed bytes and never produces CUT', () => {
  assert.equal(encodeGetClipboard('selection').toString('hex'), '0801');
  assert.equal(encodeGetClipboard('clipboard').toString('hex'), '0800');
  for (const source of ['cut', 2, undefined, '']) assert.throws(() => encodeGetClipboard(source), /Unsupported copy source/);
  // The generic input path cannot send clipboard requests.
  assert.throws(() => encodeControl({ type: 'copyFromPhone', source: 'selection' }), /Unsupported control message/);
});

test('device parser handles fragments, bounds, and unexpected messages', () => {
  const byteByByte = new DeviceMessageParser();
  const bytes = Buffer.concat([frame('héllo 🙂'), frame('')]);
  const texts = [];
  for (const byte of bytes) texts.push(...byteByByte.push(Buffer.from([byte])));
  assert.deepEqual(texts, ['héllo 🙂', '']);
  assert.deepEqual(new DeviceMessageParser().push(Buffer.concat([frame('a'), frame('b'), frame('c')])), ['a', 'b', 'c']);
  const max = new DeviceMessageParser().push(frame('x'.repeat(CLIPBOARD_TEXT_MAX_BYTES)));
  assert.equal(max[0].length, CLIPBOARD_TEXT_MAX_BYTES);
  // An oversize length is rejected from the 5-byte header, before any text is buffered.
  const oversize = Buffer.alloc(5); oversize.writeUInt32BE(CLIPBOARD_TEXT_MAX_BYTES + 1, 1);
  assert.throws(() => new DeviceMessageParser().push(oversize), DeviceProtocolError);
  for (const type of [1, 2, 3, 255]) assert.throws(() => new DeviceMessageParser().push(Buffer.from([type, 0, 0, 0, 0])), DeviceProtocolError);
  const invalidUtf8 = Buffer.from([0, 0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => new DeviceMessageParser().push(invalidUtf8), DeviceProtocolError);
});

// A real loopback socket pair stands in for the scrcpy control socket.
async function controlPair(t) {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = createConnection({ host: '127.0.0.1', port: server.address().port });
  const [phone] = await accepted;
  const failures = [];
  const session = new ScrcpySession('.', () => {}, message => failures.push(message));
  session.attachControl(client);
  const received = [];
  phone.on('data', chunk => received.push(...chunk));
  t.after(async () => { session.closed = true; client.destroy(); phone.destroy(); await new Promise(done => server.close(done)); });
  return { session, phone, received, failures };
}
const settle = () => new Promise(done => setTimeout(done, 30));

test('a copy request resolves with its reply and the socket stays reusable', async t => {
  const { session, phone, received } = await controlPair(t);
  const first = session.copyFromPhone('selection');
  await settle();
  assert.deepEqual(received, [8, 1]);
  phone.write(frame(MARKER));
  assert.equal(await first, MARKER);
  const second = session.copyFromPhone('clipboard');
  await assert.rejects(session.copyFromPhone('clipboard'), { message: COPY_MESSAGES.busy });
  phone.write(frame('second'));
  assert.equal(await second, 'second');
});

test('after a timeout the control socket refuses copies and drops the late reply', async t => {
  const { session, phone } = await controlPair(t);
  await assert.rejects(session.copyFromPhone('selection', 20), { message: COPY_MESSAGES.timeout });
  phone.write(frame(MARKER));
  await settle();
  // The late reply is never attributed to a later request.
  await assert.rejects(session.copyFromPhone('clipboard'), { message: COPY_MESSAGES.reconnect });
  assert.ok(!COPY_MESSAGES.timeout.includes(MARKER));
});

test('cancelling a pending copy also locks the socket, and stop cancels', async t => {
  const pair = await controlPair(t);
  const pending = pair.session.copyFromPhone('selection');
  pair.session.cancelCopy();
  await assert.rejects(pending, { message: COPY_MESSAGES.reconnect });
  await assert.rejects(pair.session.copyFromPhone('selection'), { message: COPY_MESSAGES.reconnect });
  const other = await controlPair(t);
  const stopping = other.session.copyFromPhone('clipboard');
  await other.session.stop();
  await assert.rejects(stopping, { message: COPY_MESSAGES.reconnect });
});

test('a protocol error disables copy but keeps input and the control socket working', async t => {
  const { session, phone, received, failures } = await controlPair(t);
  const pending = session.copyFromPhone('selection');
  phone.write(Buffer.from([2, 0, 1, 0, 0]));
  await assert.rejects(pending, { message: COPY_MESSAGES.reconnect });
  await assert.rejects(session.copyFromPhone('selection'), { message: COPY_MESSAGES.reconnect });
  await settle();
  assert.deepEqual(received, [8, 1], 'only the original request was written');
  received.length = 0;
  session.input({ type: 'key', key: 'back' });
  await settle();
  assert.equal(received.length, 28);
  assert.deepEqual(failures, []);
});

function clipboardGlobals({ write = 'resolve', writeText = 'resolve', clipboardItem = true } = {}) {
  const calls = { write: 0, writeText: [], items: [] };
  const outcome = kind => kind === 'resolve' ? Promise.resolve() : Promise.reject(new Error('NotAllowedError'));
  const clipboard = {
    write(items) { calls.write++; calls.items.push(...items); return items[0].data.then(() => outcome(write)); },
    writeText(text) { calls.writeText.push(text); return outcome(writeText); },
  };
  class ClipboardItem { constructor(data) { this.data = data['text/plain']; } }
  return { calls, globals: { navigator: { clipboard }, ...(clipboardItem ? { ClipboardItem } : {}), Blob: class { constructor(parts) { this.parts = parts; } } } };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)); };

test('Ctrl+C on the live screen copies the selection through the gesture-started clipboard write', async () => {
  const { calls, globals } = clipboardGlobals();
  const browser = loadBrowser({ globals });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const screen = browser.element('screen');
  const event = dispatchKey(browser, screen, keyEvent('c', { ctrlKey: true }));
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'copyFromPhone', source: 'selection' });
  assert.equal(calls.write, 1, 'the write starts inside the key gesture');
  socket.receive({ type: 'phoneClipboard', text: MARKER });
  await flush();
  assert.equal(browser.element('message').textContent, 'Copied from phone.');
  assert.deepEqual(calls.writeText, []);
  assert.equal(browser.element('phone-copy-fallback').hidden, true);
  assert.ok(!browser.element('message').textContent.includes(MARKER));
});

test('copy falls back to writeText, then to a manual field that clears on disconnect', async () => {
  const noItem = clipboardGlobals({ clipboardItem: false });
  let browser = loadBrowser({ globals: noItem.globals });
  let socket = deliverSyntheticFrame(browser, await startConnect(browser));
  browser.element('copy-from-phone').handlers.click();
  assert.deepEqual(socket.sent.at(-1), { type: 'copyFromPhone', source: 'clipboard' });
  socket.receive({ type: 'phoneClipboard', text: MARKER });
  await flush();
  assert.deepEqual(noItem.calls.writeText, [MARKER]);
  assert.equal(browser.element('message').textContent, 'Copied from phone.');

  const refused = clipboardGlobals({ write: 'reject', writeText: 'reject' });
  browser = loadBrowser({ globals: refused.globals });
  socket = deliverSyntheticFrame(browser, await startConnect(browser));
  browser.element('copy-from-phone').handlers.click();
  socket.receive({ type: 'phoneClipboard', text: MARKER });
  await flush();
  assert.equal(browser.element('phone-copy-fallback').hidden, false);
  assert.equal(browser.element('phone-copy-text').value, MARKER);
  assert.equal(browser.more.open, true);
  assert.match(browser.element('message').textContent, /didn.t allow automatic copy/);
  await browser.element('connect').handlers.click();
  assert.equal(browser.element('phone-copy-fallback').hidden, true);
  assert.equal(browser.element('phone-copy-text').value, '');
});

test('copy is one request at a time, reports fixed errors, and ignores stale replies', async () => {
  const { calls, globals } = clipboardGlobals();
  const browser = loadBrowser({ globals });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const screen = browser.element('screen');
  dispatchKey(browser, screen, keyEvent('c', { ctrlKey: true }));
  const sent = socket.sent.length;
  dispatchKey(browser, screen, keyEvent('c', { ctrlKey: true }));
  assert.equal(socket.sent.length, sent, 'a second copy is not queued');
  assert.equal(browser.element('message').textContent, 'A copy from the phone is already in progress.');
  socket.receive({ type: 'copyError', message: COPY_MESSAGES.timeout });
  assert.equal(browser.element('message').textContent, COPY_MESSAGES.timeout);
  assert.equal(browser.element('message').classList.contains('error'), true);
  socket.receive({ type: 'phoneClipboard', text: MARKER });
  await flush();
  assert.equal(calls.writeText.length, 0, 'an unrequested reply is ignored');
  assert.equal(browser.element('message').textContent, COPY_MESSAGES.timeout);
  browser.element('copy-from-phone').handlers.click();
  socket.receive({ type: 'phoneClipboard', text: '' });
  await flush();
  assert.equal(browser.element('message').textContent, 'Phone clipboard is empty.');
});

test('Ctrl+C is not taken without a live screen, and other shortcuts keep their behavior', async () => {
  const { globals } = clipboardGlobals();
  const browser = loadBrowser({ globals });
  const socket = await startConnect(browser);
  socket.onopen();
  const screen = browser.element('screen');
  assert.equal(dispatchKey(browser, screen, keyEvent('c', { ctrlKey: true })).defaultPrevented, false);
  deliverSyntheticFrame(browser, socket);
  const before = socket.sent.length;
  for (const extras of [{ ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { metaKey: true }, { ctrlKey: true, repeat: true }]) {
    assert.equal(dispatchKey(browser, screen, keyEvent('c', extras)).defaultPrevented, false, JSON.stringify(extras));
  }
  assert.equal(dispatchKey(browser, screen, keyEvent('x', { ctrlKey: true })).defaultPrevented, false, 'cut is not forwarded');
  assert.equal(socket.sent.length, before);
});

test('Help documents explicit copy, its limits, and the reconnect rule', () => {
  assert.match(html, /<h3>Copy from phone<\/h3>/);
  assert.match(html, /Press Ctrl\+C over the focused phone screen/);
  assert.match(html, /Nothing is copied automatically/);
  assert.match(html, /sends nothing back, so the copy waits 5 seconds and then asks you to disconnect and connect again/);
});

test('device parser holds at most one bounded frame, whatever the chunking', () => {
  const bound = 5 + CLIPBOARD_TEXT_MAX_BYTES;
  const big = frame('y'.repeat(CLIPBOARD_TEXT_MAX_BYTES));
  const small = [];
  let tail = Buffer.from(big.subarray(bound - 1));
  while (tail.length < 65536 - 8) { small.push(`s${small.length}`); tail = Buffer.concat([tail, frame(small.at(-1))]); }
  const after = frame('after');
  const chunks = [big.subarray(0, bound - 1), Buffer.concat([tail, after.subarray(0, 3)]), after.subarray(3)];
  // Record every buffer the parser creates during push, including transient ones.
  const sizes = [];
  const original = { concat: Buffer.concat, alloc: Buffer.alloc, allocUnsafe: Buffer.allocUnsafe, from: Buffer.from };
  Buffer.concat = (...args) => { const out = original.concat.apply(Buffer, args); sizes.push(out.length); return out; };
  Buffer.alloc = (...args) => { sizes.push(args[0]); return original.alloc.apply(Buffer, args); };
  Buffer.allocUnsafe = (...args) => { sizes.push(args[0]); return original.allocUnsafe.apply(Buffer, args); };
  Buffer.from = (...args) => { const out = original.from.apply(Buffer, args); sizes.push(out.length); return out; };
  const parser = new DeviceMessageParser();
  let texts;
  try { texts = chunks.flatMap(chunk => parser.push(chunk)); }
  finally { Object.assign(Buffer, original); }
  assert.ok(Math.max(0, ...sizes) <= bound, `largest parser buffer ${Math.max(...sizes)} exceeds ${bound}`);
  assert.equal(texts.length, 2 + small.length);
  assert.equal(texts[0].length, CLIPBOARD_TEXT_MAX_BYTES);
  assert.deepEqual(texts.slice(1, -1), small);
  assert.equal(texts.at(-1), 'after');
  assert.equal(parser.bufferedBytes, 0);
});

function controlledClipboard() {
  const writes = [], writeTexts = [];
  const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); promise.catch(() => {}); return { promise, resolve, reject }; };
  const clipboard = {
    write() { const d = deferred(); writes.push(d); return d.promise; },
    writeText(text) { const d = deferred(); d.text = text; writeTexts.push(d); return d.promise; },
  };
  class ClipboardItem { constructor(data) { this.data = data; } }
  return { writes, writeTexts, globals: { navigator: { clipboard }, ClipboardItem, Blob: class {} } };
}

test('a delayed failure from an older copy never replaces a newer copy result', async () => {
  const board = controlledClipboard();
  const browser = loadBrowser({ globals: board.globals });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  browser.element('copy-from-phone').handlers.click();
  socket.receive({ type: 'phoneClipboard', text: 'OLDER_TEXT' });
  await flush();
  dispatchKey(browser, browser.element('screen'), keyEvent('c', { ctrlKey: true }));
  socket.receive({ type: 'phoneClipboard', text: 'NEWER_TEXT' });
  board.writes[1].resolve();
  await flush();
  assert.equal(browser.element('message').textContent, 'Copied from phone.');
  board.writes[0].reject(new Error('NotAllowedError'));
  await flush();
  assert.equal(board.writeTexts.length, 0, 'the older request stops at its first stale check');
  assert.equal(browser.element('message').textContent, 'Copied from phone.');
  assert.equal(browser.element('phone-copy-fallback').hidden, true);
  assert.equal(browser.element('phone-copy-text').value, '');
});

test('a delayed success from an older copy never hides a newer fallback', async () => {
  const board = controlledClipboard();
  const browser = loadBrowser({ globals: board.globals });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  browser.element('copy-from-phone').handlers.click();
  socket.receive({ type: 'phoneClipboard', text: 'OLDER_TEXT' });
  await flush();
  browser.element('copy-from-phone').handlers.click();
  socket.receive({ type: 'phoneClipboard', text: 'NEWER_TEXT' });
  board.writes[1].reject(new Error('NotAllowedError'));
  await flush();
  board.writeTexts[0].reject(new Error('NotAllowedError'));
  await flush();
  assert.equal(browser.element('phone-copy-text').value, 'NEWER_TEXT');
  assert.equal(browser.element('phone-copy-fallback').hidden, false);
  const fallbackStatus = browser.element('message').textContent;
  board.writes[0].resolve();
  await flush();
  assert.equal(browser.element('message').textContent, fallbackStatus);
  assert.equal(browser.element('phone-copy-text').value, 'NEWER_TEXT');
  assert.equal(browser.element('phone-copy-fallback').hidden, false);
});

test('blur during a pending clipboard write never brings the fallback text back', async () => {
  const board = controlledClipboard();
  const browser = loadBrowser({ globals: board.globals });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  browser.element('copy-from-phone').handlers.click();
  socket.receive({ type: 'phoneClipboard', text: MARKER });
  await flush();
  browser.windowHandlers.blur();
  assert.match(browser.element('message').textContent, /interrupted because the window lost focus/);
  board.writes[0].reject(new Error('NotAllowedError'));
  await flush();
  assert.equal(board.writeTexts.length, 0);
  browser.windowHandlers.focus?.();
  await flush();
  assert.equal(browser.element('phone-copy-fallback').hidden, true);
  assert.equal(browser.element('phone-copy-text').value, '');
  assert.ok(!browser.element('message').textContent.includes(MARKER));
});
