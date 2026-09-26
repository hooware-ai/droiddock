import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

function gesture(files, text = '') {
  return { prevented: false, preventDefault() { this.prevented = true; }, clipboardData: { files, getData() { return text; } } };
}

test('file paste is gesture-only, one file, bounded, capability-scoped and leaves text paste intact', async () => {
  const posts = [];
  const browser = loadBrowser({ fetchImpl: (url, options) => {
    if (url === '/api/paste-file') posts.push({ url, options });
    return Promise.resolve({ ok: true, json: async () => ({ message: 'Sent to focused app.' }) });
  } });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const screen = browser.element('screen');
  const file = { size: 4, type: 'image/png' };
  screen.handlers.paste(gesture([file]));
  assert.equal(posts.length, 0, 'no upload without current owner capability');
  socket.receive({ type: 'pasteCapability', value: 'a'.repeat(64) });
  screen.handlers.paste(gesture([file, file]));
  screen.handlers.paste(gesture([{ size: 16 * 1024 * 1024 + 1, type: 'image/png' }]));
  assert.equal(posts.length, 0);
  const event = gesture([file]); screen.handlers.paste(event);
  assert.equal(event.prevented, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/paste-file');
  assert.equal(posts[0].options.body, file);
  assert.equal(posts[0].options.headers['x-paste-capability'], 'a'.repeat(64));
  await Promise.resolve(); await Promise.resolve();
  screen.handlers.paste(gesture([], 'plain text'));
  assert.ok(socket.sent.some(value => value.type === 'paste' && value.text === 'plain text'));
  assert.equal(posts.length, 1);
});

test('controller handoff aborts an in-flight file upload', async () => {
  let request;
  const browser = loadBrowser({ fetchImpl: (url, options) => {
    request = options;
    return new Promise(() => {});
  } });
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  socket.receive({ type: 'pasteCapability', value: 'b'.repeat(64) });
  browser.element('screen').handlers.paste(gesture([{ size: 1, type: 'image/png' }]));
  assert.equal(request.signal.aborted, false);
  socket.receive({ type: 'moved', message: 'Phone opened elsewhere.' });
  assert.equal(request.signal.aborted, true);
});
