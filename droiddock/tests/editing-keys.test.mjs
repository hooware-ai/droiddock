import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrowser, startConnect, deliverSyntheticFrame, dispatchKey, keyEvent } from './accessibility.test.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('focused keyboard editing keys reach Android while rail Home stays Android Home', async () => {
  const browser = loadBrowser();
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const screen = browser.element('screen');
  for (const [key, name] of Object.entries({ Home: 'moveHome', End: 'moveEnd', Delete: 'forwardDelete', PageUp: 'pageUp', PageDown: 'pageDown' })) {
    const event = dispatchKey(browser, screen, keyEvent(key));
    assert.equal(event.defaultPrevented, true, key);
    assert.deepEqual(socket.sent.at(-1), { type: 'key', key: name }, key);
  }
  assert.equal(socket.sent.some(message => message.type === 'key' && message.key === 'home'), false);
  browser.keyButtons.find(button => button.dataset.key === 'home').handlers.click();
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'home' });
});

test('Tab, Escape, and modifier-held shortcuts keep their existing behavior', async () => {
  const browser = loadBrowser();
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const screen = browser.element('screen');
  const before = socket.sent.length;
  assert.equal(dispatchKey(browser, screen, keyEvent('Tab')).defaultPrevented, false);
  assert.equal(socket.sent.length, before);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(dispatchKey(browser, screen, keyEvent('Home', { [modifier]: true })).defaultPrevented, false);
    assert.equal(socket.sent.length, before);
  }
  assert.equal(dispatchKey(browser, screen, keyEvent('Escape')).defaultPrevented, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'back' });
});

test('Shift is forwarded only with navigation keys for text selection', async () => {
  const browser = loadBrowser();
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const screen = browser.element('screen');
  const navigation = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'moveHome', End: 'moveEnd', PageUp: 'pageUp', PageDown: 'pageDown' };
  for (const [key, name] of Object.entries(navigation)) {
    assert.equal(dispatchKey(browser, screen, keyEvent(key, { shiftKey: true })).defaultPrevented, true, key);
    assert.deepEqual(socket.sent.at(-1), { type: 'key', key: name, shift: true }, key);
    dispatchKey(browser, screen, keyEvent(key));
    assert.deepEqual(socket.sent.at(-1), { type: 'key', key: name }, key);
  }
  for (const [key, name] of Object.entries({ Enter: 'enter', Backspace: 'backspace', Delete: 'forwardDelete' })) {
    dispatchKey(browser, screen, keyEvent(key, { shiftKey: true }));
    assert.deepEqual(socket.sent.at(-1), { type: 'key', key: name }, key);
  }
  dispatchKey(browser, screen, keyEvent('A', { shiftKey: true }));
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'A' });
  const before = socket.sent.length;
  assert.equal(dispatchKey(browser, screen, keyEvent('Tab', { shiftKey: true })).defaultPrevented, false);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(dispatchKey(browser, screen, keyEvent('ArrowLeft', { shiftKey: true, [modifier]: true })).defaultPrevented, false, modifier);
  }
  assert.equal(socket.sent.length, before);
  assert.equal(dispatchKey(browser, screen, keyEvent('Escape', { shiftKey: true })).defaultPrevented, true);
  assert.deepEqual(socket.sent.at(-1), { type: 'key', key: 'back' });
});

test('Help documents editing keys and distinguishes keyboard Home from rail Home', () => {
  assert.match(html, /Backspace, Delete, Enter, arrows, Home, End, Page Up, and Page Down/);
  assert.match(html, /Keyboard Home moves to the start of a line in supported text fields/);
  assert.match(html, /rail's Home button to open the Android launcher/);
  assert.match(html, /Hold Shift with an arrow, Home, End, Page Up, or Page Down to extend a text selection/);
  assert.match(html, /Shift is not forwarded with other keys/);
});
