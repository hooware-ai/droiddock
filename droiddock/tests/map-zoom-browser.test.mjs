import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

function wheel(deltaY, deltaMode = 0) {
  return { clientX: 360, clientY: 400, deltaX: 0, deltaY, deltaMode, prevented: false,
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
  screen.handlers.wheel(wheel(-120));
  assert.equal(socket.sent.at(-1).type, 'scroll');
  button.handlers.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
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
