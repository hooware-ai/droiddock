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

test('Help documents editing keys and distinguishes keyboard Home from rail Home', () => {
  assert.match(html, /Backspace, Delete, Enter, arrows, Home, End, Page Up, and Page Down/);
  assert.match(html, /Keyboard Home moves to the start of a line in supported text fields/);
  assert.match(html, /rail's Home button to open the Android launcher/);
});
