import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

function setInput(browser, value) {
  const input = browser.element('text-input');
  input.value = value;
  input.handlers.input();
  return input;
}

function submitText(browser) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  browser.element('text-form').handlers.submit(event);
  return event;
}

async function connectedBrowser() {
  const browser = loadBrowser();
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  return { browser, socket };
}

const cases = [
  { name: 'ASCII below the limit', text: 'a'.repeat(299) },
  { name: 'ASCII at the limit', text: 'a'.repeat(300) },
  { name: 'ASCII above the limit', text: 'a'.repeat(301) },
  { name: 'multibyte below the limit', text: 'é'.repeat(149) },
  { name: 'multibyte at the limit', text: 'é'.repeat(150) },
  { name: 'multibyte above the limit', text: 'é'.repeat(151) },
  { name: 'emoji below the limit', text: '🙂'.repeat(74) },
  { name: 'emoji at the limit', text: '🙂'.repeat(75) },
  { name: 'emoji above the limit', text: '🙂'.repeat(76) },
];

test('fallback field associates static help with a silent UTF-8 byte counter', () => {
  assert.match(html, /<label for="text-input">Fallback text input<\/label>/);
  assert.match(html, /id="text-input"[^>]*aria-describedby="text-input-help text-byte-count"/);
  assert.match(html, /<p id="text-byte-count" class="text-byte-count">0 \/ 300 bytes<\/p>/);
  assert.match(html, /id="text-input-help" class="text-help"/);
  assert.match(html, /Limited to 300 UTF-8 bytes per send/);
  assert.match(html, /not every Unicode character/);
  assert.doesNotMatch(html, /id="text-byte-count"[^>]*aria-live/);
  assert.doesNotMatch(html, /id="text-input-help"[^>]*aria-live/);
  assert.match(html, /id="message" class="message" role="status" aria-live="polite"/);
  assert.match(css, /\.text-byte-count\.over-limit\{/);
  assert.match(css, /font-weight:600/);
  assert.doesNotMatch(appSource, /sessionStorage/);
  assert.match(appSource, /THEME_STORAGE_KEY = 'droiddock\.theme'/);
  assert.doesNotMatch(appSource, /localStorage[\s\S]{0,80}(?:text-input|pin-input)/);
  assert.doesNotMatch(appSource, /(?:text-input|pin-input)[\s\S]{0,80}localStorage/);
  assert.doesNotMatch(appSource, /console\.(?:log|info|debug|warn|error)/);
});

test('disconnected fallback input stays gated and keeps typed text', () => {
  const browser = loadBrowser();
  assert.equal(browser.element('text-input').disabled, true);
  assert.equal(browser.element('send-text').disabled, true);
  assert.equal(browser.element('text-byte-count').textContent, '0 / 300 bytes');
  assert.equal(browser.element('text-input').getAttribute('aria-invalid'), 'false');
  const draft = 'keep this draft';
  setInput(browser, draft);
  assert.equal(browser.element('text-byte-count').textContent, `${utf8Bytes(draft)} / 300 bytes`);
  const submit = submitText(browser);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(browser.sockets.length, 0);
  assert.equal(browser.element('text-input').value, draft);
  assert.equal(browser.element('text-input').disabled, true);
  assert.equal(browser.element('send-text').disabled, true);
});

for (const fixture of cases) {
  test(`fallback counter and Send agree for ${fixture.name}`, async () => {
    const { browser, socket } = await connectedBrowser();
    const bytes = utf8Bytes(fixture.text);
    const over = bytes > 300;
    const messageBefore = browser.element('message').textContent;
    assert.equal(browser.element('text-input').disabled, false);
    assert.equal(browser.element('send-text').disabled, false);

    setInput(browser, fixture.text);
    const count = browser.element('text-byte-count');
    if (over) {
      assert.equal(count.textContent, `${bytes} / 300 bytes — over limit`);
      assert.equal(count.classList.contains('over-limit'), true);
      assert.equal(browser.element('text-input').getAttribute('aria-invalid'), 'true');
    } else {
      assert.equal(count.textContent, `${bytes} / 300 bytes`);
      assert.equal(count.classList.contains('over-limit'), false);
      assert.equal(browser.element('text-input').getAttribute('aria-invalid'), 'false');
    }
    assert.equal(browser.element('message').textContent, messageBefore);

    const sentBefore = socket.sent.length;
    submitText(browser);
    if (over) {
      assert.equal(socket.sent.length, sentBefore);
      assert.equal(browser.element('text-input').value, fixture.text);
      assert.match(browser.element('message').textContent, /too long/);
      assert.equal(browser.element('message').classList.contains('error'), true);
      assert.equal(browser.element('text-input').focused, true);
      assert.equal(count.textContent, `${bytes} / 300 bytes — over limit`);
    } else {
      assert.deepEqual(socket.sent.at(-1), { type: 'text', text: fixture.text });
      assert.equal(browser.element('text-input').value, '');
      assert.equal(count.textContent, '0 / 300 bytes');
      assert.equal(count.classList.contains('over-limit'), false);
      assert.equal(browser.element('text-input').getAttribute('aria-invalid'), 'false');
    }
  });
}

test('successful send resets the counter and disconnect preserves over-limit text', async () => {
  const { browser, socket } = await connectedBrowser();
  setInput(browser, 'ok');
  assert.equal(browser.element('text-byte-count').textContent, '2 / 300 bytes');
  submitText(browser);
  assert.deepEqual(socket.sent.at(-1), { type: 'text', text: 'ok' });
  assert.equal(browser.element('text-input').value, '');
  assert.equal(browser.element('text-byte-count').textContent, '0 / 300 bytes');

  const over = 'é'.repeat(151);
  setInput(browser, over);
  assert.equal(browser.element('text-byte-count').textContent, '302 / 300 bytes — over limit');
  const sentBefore = socket.sent.length;
  await browser.element('connect').handlers.click();
  assert.equal(browser.element('text-input').disabled, true);
  assert.equal(browser.element('send-text').disabled, true);
  assert.equal(browser.element('text-input').value, over);
  assert.equal(browser.element('text-byte-count').textContent, '302 / 300 bytes — over limit');
  submitText(browser);
  assert.equal(socket.sent.length, sentBefore);
  assert.equal(browser.element('text-input').value, over);
});
