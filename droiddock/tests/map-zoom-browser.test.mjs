import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowser, startConnect, deliverSyntheticFrame, dispatchKey, keyEvent } from './accessibility.test.mjs';

function wheel(deltaY, deltaMode = 0, clientX = 360, ctrlKey = false) {
  return { clientX, clientY: 400, deltaX: 0, deltaY, deltaMode, ctrlKey, prevented: false,
    preventDefault() { this.prevented = true; } };
}

async function connected() {
  const browser = loadBrowser({ clock: true });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  return { browser, socket, screen: browser.element('screen'), button: browser.element('map-zoom') };
}

test('map zoom is opt-in; wheel pinch has two bounded pointers and leaves normal scrolling intact', async () => {
  const { browser, socket, screen, button } = await connected();
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'Map zoom off. Shortcut: Left Ctrl + wheel over the phone.');
  screen.handlers.wheel(wheel(-120));
  assert.equal(socket.sent.at(-1).type, 'scroll');
  button.handlers.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.title, 'Map zoom on. Wheel zooms the phone. Shortcut when off: Left Ctrl + wheel.');
  const start = socket.sent.length;
  const event = wheel(-120); screen.handlers.wheel(event);
  assert.equal(event.prevented, true);
  screen.handlers.wheel(wheel(-120));
  assert.deepEqual(socket.sent.slice(start).map(({ type, pointerId, action }) => [type, pointerId, action]),
    [['touch', 1, 0], ['touch', 2, 0]], 'a burst starts only one gesture');
  for (let i = 0; i < 3; i++) assert.equal(browser.runTimer(), true);
  const sequence = socket.sent.slice(start);
  assert.deepEqual(sequence.map(({ pointerId, action }) => [pointerId, action]),
    [[1, 0], [2, 0], [1, 2], [2, 2], [1, 2], [2, 2], [2, 1], [1, 1]]);
  assert.ok(sequence[1].x - sequence[0].x < sequence[5].x - sequence[4].x, 'wheel up moves fingers apart');
  for (const message of sequence) {
    assert.ok(message.x >= 0 && message.x < message.width);
    assert.ok(message.y >= 0 && message.y < message.height);
  }
  button.handlers.click();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.title, 'Map zoom off. Shortcut: Left Ctrl + wheel over the phone.');
  screen.handlers.wheel(wheel(120));
  assert.equal(socket.sent.at(-1).type, 'scroll');
});

test('wheel down pinches inward; active drag and video frames cannot start extra gestures', async () => {
  const { browser, socket, screen, button } = await connected();
  button.handlers.click();
  screen.handlers.pointerdown({ button: 0, pointerId: 9, clientX: 360, clientY: 400, preventDefault() {} });
  const dragged = socket.sent.length;
  screen.handlers.wheel(wheel(120));
  assert.equal(socket.sent.length, dragged);
  screen.handlers.pointerup({ pointerId: 9, clientX: 360, clientY: 400 });
  const start = socket.sent.length;
  screen.handlers.wheel(wheel(120));
  assert.equal(socket.sent.slice(start).length, 2);
  browser.FakeVideoDecoder.latest.emit();
  assert.equal(socket.sent.slice(start).length, 2, 'video frames do not generate zoom controls');
  for (let i = 0; i < 3; i++) browser.runTimer();
  const sequence = socket.sent.slice(start);
  assert.ok(sequence[1].x - sequence[0].x > sequence[5].x - sequence[4].x, 'wheel down moves fingers inward');
});

test('blur and controller handoff release both synthetic fingers without replay', async () => {
  const { browser, socket, screen, button } = await connected();
  button.handlers.click();
  screen.handlers.wheel(wheel(-120));
  const before = socket.sent.length;
  browser.windowHandlers.blur();
  assert.deepEqual(socket.sent.slice(before).filter(message => message.type === 'touch').map(({ pointerId, action }) => [pointerId, action]), [[2, 1], [1, 1]]);
  assert.equal(browser.runTimer(), false, 'zoom timers were cancelled');
  const second = await connected();
  second.button.handlers.click();
  second.screen.handlers.wheel(wheel(-120));
  const handoff = second.socket.sent.length;
  second.socket.receive({ type: 'moved', message: 'Phone opened elsewhere.' });
  assert.deepEqual(second.socket.sent.slice(handoff).filter(message => message.type === 'touch').map(({ pointerId, action }) => [pointerId, action]), [[2, 1], [1, 1]]);
  assert.equal(second.button.getAttribute('aria-pressed'), 'false');
});

test('pinch stays near the wheel pointer and a hidden tab cancels it', async () => {
  const { browser, socket, screen, button } = await connected();
  button.handlers.click();
  screen.handlers.wheel(wheel(-120, 0, 540));
  const [first, second] = socket.sent.slice(-2);
  assert.ok((first.x + second.x) / 2 > first.width * 0.7, 'gesture follows the pointer');
  const before = socket.sent.length;
  browser.documentState.hidden = true;
  browser.documentHandlers.visibilitychange();
  assert.deepEqual(socket.sent.slice(before).filter(({ type }) => type === 'touch').map(({ pointerId, action }) => [pointerId, action]), [[2, 1], [1, 1]]);
  assert.equal(browser.runTimer(), false);
});

test('Left Ctrl temporarily zooms in and out without changing the persistent Zoom button', async () => {
  const { browser, socket, screen, button } = await connected();
  const beforeKey = socket.sent.length;
  dispatchKey(browser, screen, keyEvent('Control', { code: 'ControlLeft', ctrlKey: true }));
  assert.equal(socket.sent.length, beforeKey, 'Ctrl alone sends no Android input');
  const zoomIn = wheel(-120, 0, 540, true);
  screen.handlers.wheel(zoomIn);
  assert.equal(zoomIn.prevented, true);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(socket.sent.slice(beforeKey).map(({ type, pointerId, action }) => [type, pointerId, action]),
    [['touch', 1, 0], ['touch', 2, 0]]);
  for (let i = 0; i < 3; i++) assert.equal(browser.runTimer(), true);
  const zoomInSequence = socket.sent.slice(beforeKey);
  assert.ok(zoomInSequence[1].x - zoomInSequence[0].x < zoomInSequence[5].x - zoomInSequence[4].x);
  browser.documentHandlers.keyup(keyEvent('Control', { code: 'ControlLeft' }));
  const afterRelease = socket.sent.length;
  screen.handlers.wheel(wheel(-120));
  assert.equal(socket.sent.at(-1).type, 'scroll');
  assert.equal(socket.sent.length, afterRelease + 1);

  dispatchKey(browser, screen, keyEvent('Control', { code: 'ControlLeft', ctrlKey: true }));
  const zoomOutStart = socket.sent.length;
  screen.handlers.wheel(wheel(120, 0, 360, true));
  for (let i = 0; i < 3; i++) assert.equal(browser.runTimer(), true);
  const zoomOutSequence = socket.sent.slice(zoomOutStart);
  assert.ok(zoomOutSequence[1].x - zoomOutSequence[0].x > zoomOutSequence[5].x - zoomOutSequence[4].x);
  browser.documentHandlers.keyup(keyEvent('Control', { code: 'ControlLeft' }));
  button.handlers.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  const persistentStart = socket.sent.length;
  screen.handlers.wheel(wheel(-120));
  assert.equal(socket.sent.slice(persistentStart)[0].type, 'touch', 'persistent mode still works without Ctrl');
});

test('right Ctrl and touchpad-style Ctrl wheel do not activate the Left Ctrl shortcut', async () => {
  const { browser, socket, screen } = await connected();
  browser.documentHandlers.keydown(keyEvent('Control', { code: 'ControlRight', ctrlKey: true }));
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  assert.equal(socket.sent.at(-1).type, 'scroll');
  browser.documentHandlers.keyup(keyEvent('Control', { code: 'ControlRight' }));
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  assert.equal(socket.sent.at(-1).type, 'scroll');
  assert.equal(browser.element('message').handlers.wheel, undefined, 'wheel shortcut has no page-wide listener');
});

test('releasing Left Ctrl, losing focus, hiding the tab, and handoff clear temporary zoom', async () => {
  const { browser, socket, screen } = await connected();
  const press = () => browser.documentHandlers.keydown(keyEvent('Control', { code: 'ControlLeft', ctrlKey: true }));
  const expectReleased = (from) => {
    assert.deepEqual(socket.sent.slice(from).filter(({ type }) => type === 'touch').map(({ pointerId, action }) => [pointerId, action]), [[2, 1], [1, 1]]);
    assert.equal(browser.runTimer(), false);
  };
  press(); screen.handlers.wheel(wheel(-120, 0, 360, true));
  let from = socket.sent.length;
  browser.documentHandlers.keyup(keyEvent('Control', { code: 'ControlLeft' }));
  expectReleased(from);
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  assert.equal(socket.sent.at(-1).type, 'scroll');

  press(); screen.handlers.wheel(wheel(-120, 0, 360, true));
  from = socket.sent.length;
  browser.windowHandlers.blur();
  expectReleased(from);
  browser.windowHandlers.focus();
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  assert.equal(socket.sent.at(-1).type, 'scroll');

  press(); screen.handlers.wheel(wheel(-120, 0, 360, true));
  from = socket.sent.length;
  browser.documentState.hidden = true;
  browser.documentHandlers.visibilitychange();
  expectReleased(from);
  browser.documentState.hidden = false;
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  assert.equal(socket.sent.at(-1).type, 'scroll');

  press(); screen.handlers.wheel(wheel(-120, 0, 360, true));
  from = socket.sent.length;
  socket.receive({ type: 'moved', message: 'Phone opened elsewhere.' });
  expectReleased(from);
  assert.equal(browser.element('map-zoom').getAttribute('aria-pressed'), 'false');
});

test('disconnect releases temporary pinch and reconnect does not inherit a held shortcut', async () => {
  const { browser, socket, screen } = await connected();
  browser.documentHandlers.keydown(keyEvent('Control', { code: 'ControlLeft', ctrlKey: true }));
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  const from = socket.sent.length;
  browser.element('connect').handlers.click();
  assert.deepEqual(socket.sent.slice(from).filter(({ type }) => type === 'touch').map(({ pointerId, action }) => [pointerId, action]), [[2, 1], [1, 1]]);
  assert.equal(browser.runTimer(), false);
  const next = deliverSyntheticFrame(browser, await startConnect(browser));
  screen.handlers.wheel(wheel(-120, 0, 360, true));
  assert.equal(next.sent.at(-1).type, 'scroll');
});
