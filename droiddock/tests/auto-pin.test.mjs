import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrowser, startConnect, deliverSyntheticFrame, dispatchKey, keyEvent } from './accessibility.test.mjs';

const identity = { installationId: '0123456789abcdef', configurationId: 'fedcba9876543210' };
const preferenceKey = `droiddock.auto-pin.${identity.installationId}.${identity.configurationId}`;
function storage(values = []) {
  const entries = new Map(values);
  const writes = [];
  return { entries, writes, getItem: key => entries.get(key) ?? null, setItem(key, value) { writes.push([key, value]); entries.set(key, value); } };
}
function toggle(b, enabled) {
  b.element('auto-pin').checked = enabled;
  b.element('auto-pin').handlers.change();
}
function lock(socket, state, suspended = false) { socket.receive({ type: 'lockState', state, suspended }); }
function subscriptions(socket) { return socket.sent.filter(packet => packet.type === 'lockSubscription'); }
async function connected(options = {}) {
  const b = loadBrowser(options);
  const socket = await startConnect(b);
  socket.receive({ type: 'status', state: 'connecting', ...identity });
  deliverSyntheticFrame(b, socket);
  return { b, socket };
}

test('automatic PIN entry is default-off, has an accessible direct control, and sends no phone input', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="pin-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="pin-controls"/);
  assert.match(html, /<section id="pin-controls"[^>]*role="dialog"[^>]*aria-labelledby="pin-title"[^>]*hidden/);
  assert.match(html, /<label[^>]*><input id="auto-pin" type="checkbox">/);
  const { b, socket } = await connected();
  assert.equal(b.element('auto-pin').checked, false);
  assert.equal(b.element('pin-controls').hidden, true);
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: false, visible: true });
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
  b.element('pin-toggle').handlers.click();
  assert.equal(b.element('pin-controls').hidden, false);
  assert.equal(b.element('pin-input').focused, true);
  assert.equal(b.element('pin-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(socket.sent.some(packet => ['key', 'pin', 'touch', 'text', 'paste'].includes(packet.type)), false);
});

test('automatic preference persists only a boolean under validated installation/configuration scope', async () => {
  const saved = storage();
  const { b, socket } = await connected({ localStorage: saved });
  toggle(b, true);
  assert.deepEqual(saved.writes, [[preferenceKey, 'true']]);
  assert.equal(subscriptions(socket).at(-1).enabled, true);
  b.element('pin-toggle').handlers.click();
  b.element('pin-input').value = '0123';
  b.element('pin-form').handlers.submit({ preventDefault() {} });
  assert.deepEqual(saved.writes, [[preferenceKey, 'true']]);
  const reloaded = await connected({ localStorage: saved });
  assert.equal(reloaded.b.element('auto-pin').checked, true);
  reloaded.socket.receive({ type: 'status', snapshot: true, ...identity, configurationId: '1111111111111111' });
  assert.equal(reloaded.b.element('auto-pin').checked, false);
  reloaded.socket.receive({ type: 'status', snapshot: true, ...identity });
  assert.equal(reloaded.b.element('auto-pin').checked, true);
  reloaded.socket.receive({ type: 'status', snapshot: true, ...identity, installationId: '2222222222222222' });
  assert.equal(reloaded.b.element('auto-pin').checked, false);
  const invalid = loadBrowser({ localStorage: saved });
  const badSocket = await startConnect(invalid);
  badSocket.receive({ type: 'status', snapshot: true, installationId: 'not-an-id', configurationId: identity.configurationId });
  toggle(invalid, true);
  assert.equal(saved.writes.length, 1);
});

test('storage errors retain session preference per identity and a fresh page remains default-off', async () => {
  const unavailable = { getItem() { throw Error('Storage unavailable'); }, setItem() { throw Error('Storage unavailable'); } };
  const { b, socket } = await connected({ localStorage: unavailable });
  toggle(b, true);
  socket.receive({ type: 'status', snapshot: true, ...identity, configurationId: '1111111111111111' });
  assert.equal(b.element('auto-pin').checked, false);
  socket.receive({ type: 'status', snapshot: true, ...identity });
  assert.equal(b.element('auto-pin').checked, true);
  const fresh = await connected({ localStorage: unavailable });
  assert.equal(fresh.b.element('auto-pin').checked, false);
});

test('a lock opens once without stealing focus; dismissal holds until an observed unlock rearms it', async () => {
  const { b, socket } = await connected();
  toggle(b, true);
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, false);
  assert.equal(b.element('pin-input').focused, false);
  assert.equal(b.more.open, false);
  b.element('pin-input').value = '0123';
  b.element('close-pin').handlers.click();
  assert.equal(b.element('pin-input').value, '');
  assert.equal(b.element('pin-toggle').getAttribute('aria-expanded'), 'false');
  for (const state of ['locked-awake', 'unknown', 'other', 'locked-awake']) lock(socket, state);
  assert.equal(b.element('pin-controls').hidden, true);
  b.element('pin-toggle').handlers.click();
  assert.equal(b.element('pin-controls').hidden, false);
  b.element('close-pin').handlers.click();
  lock(socket, 'unlocked');
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, false);
});

test('hidden tabs suppress subscriptions and stale popups; blurred windows wait for a fresh lock report', async () => {
  const { b, socket } = await connected();
  toggle(b, true);
  b.windowHandlers.blur();
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: false });
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
  b.windowHandlers.focus();
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: true });
  assert.equal(b.element('pin-controls').hidden, true);
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, false);
  b.element('pin-input').value = '0123';
  b.documentState.hidden = true;
  b.documentHandlers.visibilitychange();
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: false });
  assert.equal(b.element('pin-controls').hidden, true);
  assert.equal(b.element('pin-input').value, '');
  lock(socket, 'unlocked');
  lock(socket, 'locked-awake');
  b.documentState.hidden = false;
  b.documentHandlers.visibilitychange();
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: true });
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
  lock(socket, 'unlocked');
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, false);
});

test('Escape and outside dismissal clear the popup without Android Back and preserve manual reopening', async () => {
  const { b, socket } = await connected();
  toggle(b, true);
  lock(socket, 'locked-awake');
  b.element('pin-input').value = '0123';
  const before = socket.sent.length;
  const escape = dispatchKey(b, b.element('screen'), keyEvent('Escape'));
  assert.equal(escape.defaultPrevented, true);
  assert.equal(b.element('pin-controls').hidden, true);
  assert.equal(b.element('pin-input').value, '');
  assert.equal(socket.sent.length, before);
  b.element('pin-toggle').handlers.click();
  b.element('pin-input').value = '0123';
  b.documentHandlers.pointerdown({ target: b.element('pin-input') });
  assert.equal(b.element('pin-controls').hidden, false);
  b.documentHandlers.pointerdown({ target: b.element('connect') });
  assert.equal(b.element('pin-controls').hidden, true);
  assert.equal(b.element('pin-input').value, '');
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
});

test('unknown or suspended detection keeps manual entry available and never sends a PIN automatically', async () => {
  const { b, socket } = await connected();
  toggle(b, true);
  for (const state of ['other', 'unknown', 'unsupported']) {
    lock(socket, state, state === 'unknown');
    assert.equal(b.element('pin-controls').hidden, true);
    b.element('pin-toggle').handlers.click();
    assert.equal(b.element('pin-controls').hidden, false);
    assert.match(b.element('lock-status').textContent, /Manual entry|Waiting/);
    b.element('pin-input').value = '0123';
    b.element('close-pin').handlers.click();
  }
  lock(socket, 'unknown', true);
  assert.match(b.element('lock-status').textContent, /paused.*Manual entry/);
  assert.equal(socket.sent.some(packet => packet.type === 'pin'), false);
});

test('repeated video frames do not touch PIN DOM, issue HTTP probes, or resend subscriptions', async () => {
  const { b, socket } = await connected();
  toggle(b, true);
  lock(socket, 'locked-awake');
  b.element('pin-input').value = '0123';
  let writes = 0;
  for (const [id, property] of [['pin-controls', 'hidden'], ['pin-input', 'value'], ['pin-input', 'disabled'], ['lock-status', 'textContent'], ['pin-status', 'textContent'], ['auto-pin', 'checked']]) {
    const value = b.element(id)[property];
    Object.defineProperty(b.element(id), property, { get: () => value, set() { writes++; }, configurable: true });
  }
  const before = socket.sent.length;
  for (let i = 0; i < 120; i++) b.FakeVideoDecoder.latest.emit();
  assert.equal(writes, 0);
  assert.equal(socket.sent.length, before);
  assert.deepEqual(b.requests, ['/api/status']);
});


test('blur pauses detection; focus requests fresh state and ignores queued unlocks from the blurred interval', async () => {
  const { b, socket } = await connected();
  toggle(b, true);
  lock(socket, 'locked-awake');
  b.element('pin-input').value = '0123';
  b.windowHandlers.blur();
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: false });
  assert.equal(b.element('pin-input').value, '');
  assert.equal(b.element('pin-controls').hidden, true);
  b.windowHandlers.focus();
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: true });
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
  b.windowHandlers.blur();
  lock(socket, 'unlocked');
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
  b.windowHandlers.focus();
  assert.deepEqual(subscriptions(socket).slice(-2), [
    { type: 'lockSubscription', enabled: true, visible: false },
    { type: 'lockSubscription', enabled: true, visible: true },
  ]);
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, true);
  lock(socket, 'unlocked');
  lock(socket, 'locked-awake');
  assert.equal(b.element('pin-controls').hidden, false);
});

test('an initially unfocused page cannot open PIN entry or send PIN controls', async () => {
  const { b, socket } = await connected({ focused: false });
  toggle(b, true);
  assert.deepEqual(subscriptions(socket).at(-1), { type: 'lockSubscription', enabled: true, visible: false });
  lock(socket, 'locked-awake');
  b.element('pin-toggle').handlers.click();
  assert.equal(b.element('pin-controls').hidden, true);
  const before = socket.sent.length;
  b.element('pin-input').value = '0123';
  b.element('pin-form').handlers.submit({ preventDefault() {} });
  b.element('pin-enter').handlers.click();
  assert.equal(socket.sent.length, before);
  assert.equal(b.element('pin-input').value, '');
});

test('blur runs both pointer-release and PIN-clearing listeners', async () => {
  const { b, socket } = await connected();
  b.element('screen').handlers.pointerdown({ button: 0, pointerId: 1, clientX: 10, clientY: 10, preventDefault() {} });
  b.element('pin-toggle').handlers.click();
  b.element('pin-input').value = '0123';
  b.windowHandlers.blur();
  assert.deepEqual(socket.sent.filter(packet => packet.type === 'touch').map(packet => packet.action), [0, 1]);
  assert.equal(b.element('pin-input').value, '');
  assert.equal(b.element('pin-controls').hidden, true);
});


test('unlock, unknown state, opt-out, stream failure, and handoff clear an automatic PIN draft', async () => {
  for (const end of [
    (_b, socket) => lock(socket, 'unlocked'),
    (_b, socket) => lock(socket, 'unknown'),
    b => toggle(b, false),
    (_b, socket) => socket.receive({ type: 'status', state: 'error' }),
    (_b, socket) => socket.receive({ type: 'moved' }),
  ]) {
    const { b, socket } = await connected();
    toggle(b, true);
    lock(socket, 'locked-awake');
    b.element('pin-input').value = '0123';
    end(b, socket);
    assert.equal(b.element('pin-controls').hidden, true);
    assert.equal(b.element('pin-input').value, '');
    assert.equal(socket.sent.some(packet => packet.type === 'pin'), false);
  }
});


test('PIN draft, submit, and every clearing path never persist digits or any data beyond the opt-in boolean', async () => {
  const saved = storage();
  const { b, socket } = await connected({ localStorage: saved });
  toggle(b, true);
  const expected = [[preferenceKey, 'true']];
  for (const clear of [
    () => b.element('pin-form').handlers.submit({ preventDefault() {} }),
    () => b.element('close-pin').handlers.click(),
    () => b.windowHandlers.blur(),
    () => { b.documentState.hidden = true; b.documentHandlers.visibilitychange(); },
    () => lock(socket, 'unlocked'),
  ]) {
    b.documentState.hidden = false;
    b.documentHandlers.visibilitychange();
    b.windowHandlers.focus();
    if (b.element('pin-controls').hidden) b.element('pin-toggle').handlers.click();
    b.element('pin-input').value = '9081726354';
    assert.deepEqual(saved.writes, expected);
    clear();
    assert.equal(b.element('pin-input').value, '');
    assert.deepEqual(saved.writes, expected);
    assert.deepEqual([...saved.entries], expected);
  }
  toggle(b, false);
  assert.deepEqual(saved.writes, [...expected, [preferenceKey, 'false']]);
});


test('PIN has first Escape priority before Help and Details and restores its control without Android Back', async () => {
  const { b, socket } = await connected();
  b.element('pin-toggle').handlers.click();
  b.element('pin-input').value = '0123';
  // Exercise an overlapping state before the native details toggle events settle.
  b.help.open = true;
  b.more.open = true;
  const before = socket.sent.length;
  const pinEscape = dispatchKey(b, b.element('screen'), keyEvent('Escape'));
  assert.equal(pinEscape.defaultPrevented, true);
  assert.equal(b.element('pin-controls').hidden, true);
  assert.equal(b.element('pin-input').value, '');
  assert.equal(b.element('pin-toggle').focused, true);
  assert.equal(b.help.open, true);
  assert.equal(b.more.open, true);
  assert.equal(socket.sent.length, before);
  dispatchKey(b, b.element('screen'), keyEvent('Escape'));
  assert.equal(b.help.open, false);
  assert.equal(b.helpSummary.focused, true);
  assert.equal(b.more.open, true);
  assert.equal(socket.sent.length, before);
  dispatchKey(b, b.element('screen'), keyEvent('Escape'));
  assert.equal(b.more.open, false);
  assert.equal(b.summary.focused, true);
  assert.equal(socket.sent.length, before);
  dispatchKey(b, b.element('screen'), keyEvent('Escape'));
  assert.deepEqual(socket.sent.slice(before), [{ type: 'key', key: 'back' }]);
});

test('opening Help or Details dismisses and clears PIN without reopening the same detected lock', async () => {
  for (const panelName of ['help', 'more']) {
    const { b, socket } = await connected();
    toggle(b, true);
    lock(socket, 'locked-awake');
    b.element('pin-input').value = '0123';
    b[panelName].open = true;
    b[panelName].handlers.toggle();
    assert.equal(b.element('pin-controls').hidden, true);
    assert.equal(b.element('pin-input').value, '');
    assert.equal(b.element('pin-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(b[panelName].open, true);
    assert.equal(b[panelName === 'help' ? 'more' : 'help'].open, false);
    lock(socket, 'locked-awake');
    assert.equal(b.element('pin-controls').hidden, true);
    assert.equal(b[panelName].open, true);
    assert.equal(socket.sent.some(packet => ['pin', 'key'].includes(packet.type)), false);
  }
});

test('manual and automatic PIN opening close Help and Details and preserve their focus contract', async () => {
  for (const automatic of [false, true]) {
    const { b, socket } = await connected();
    if (automatic) toggle(b, true);
    b.help.open = true;
    b.more.open = true;
    if (automatic) lock(socket, 'locked-awake');
    else b.element('pin-toggle').handlers.click();
    assert.equal(b.element('pin-controls').hidden, false);
    assert.equal(b.help.open, false);
    assert.equal(b.more.open, false);
    assert.equal(b.element('pin-input').focused, !automatic);
    assert.equal(b.helpSummary.focused, false);
    assert.equal(b.summary.focused, false);
    b.element('pin-input').value = '0123';
    b.element('close-pin').handlers.click();
    assert.equal(b.element('pin-input').value, '');
    assert.equal(b.element('pin-toggle').focused, true);
    assert.equal(socket.sent.some(packet => ['pin', 'key'].includes(packet.type)), false);
  }
});

test('Help and Details remain mutually exclusive when their native toggle events fire', () => {
  const b = loadBrowser();
  b.more.open = true;
  b.help.open = true;
  b.help.handlers.toggle();
  assert.equal(b.help.open, true);
  assert.equal(b.more.open, false);
  b.more.open = true;
  b.more.handlers.toggle();
  assert.equal(b.more.open, true);
  assert.equal(b.help.open, false);
});
