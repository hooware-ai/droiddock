import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('browser retries after an old error snapshot but displays a current connection error', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, style: {}, handlers: {}, textContent: '',
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute() {}, getContext() { return { clearRect() {} }; },
    });
    return elements.get(id);
  };
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  class Observer { observe() {} }
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), {
    document: { hasFocus: () => true, getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, location: { protocol: 'http:', host: '127.0.0.1:3210' },
    WebSocket: FakeWebSocket, VideoDecoder: class {}, EncodedVideoChunk: class {},
    MutationObserver: Observer, ResizeObserver: Observer,
    setTimeout: () => 1, clearTimeout() {},
    fetch: () => new Promise(() => {}),
    TextEncoder,
  });
  await element('connect').handlers.click();
  const socket = sockets[0];
  socket.onopen();
  assert.equal(socket.sent[0].type, 'connect');
  socket.receive({ type: 'status', state: 'error', snapshot: true, message: 'Old cleanup failed.' });
  assert.equal(socket.closed, undefined);
  assert.equal(element('state').dataset.state, 'connecting');
  socket.receive({ type: 'status', state: 'connecting', message: 'Retrying cleanup.' });
  assert.equal(element('message').textContent, 'Retrying cleanup.');
  socket.receive({ type: 'status', state: 'error', message: 'Current connection failed.' });
  assert.equal(socket.closed, true);
  assert.equal(element('state').dataset.state, 'error');
  assert.equal(element('message').textContent, 'Current connection failed.');
});
