import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pasteMime, stagePasteFile, MAX_PASTE_FILE_BYTES } from '../../dist/droiddock/file-paste.js';

function request(chunks, headers = {}) {
  return Object.assign(Readable.from(chunks), { headers });
}

test('file paste accepts one bounded MIME and stages exact bytes with no filename', async () => {
  assert.equal(pasteMime('IMAGE/PNG'), 'image/png');
  for (const value of ['', 'image/png; charset=utf-8', 'bad\nname/type', ['image/png']]) {
    assert.throws(() => pasteMime(value), { status: 415 });
  }
  const bytes = Buffer.from([0, 1, 2, 255]);
  const path = await stagePasteFile(request([bytes], { 'content-length': '4' }), new AbortController().signal);
  try { assert.deepEqual(await readFile(path), bytes); }
  finally { await unlink(path); }
});

test('oversized, empty and cancelled uploads leave no staged file', async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('droiddock-paste-')));
  await assert.rejects(stagePasteFile(request([], { 'content-length': String(MAX_PASTE_FILE_BYTES + 1) }), new AbortController().signal), { status: 413 });
  await assert.rejects(stagePasteFile(request([]), new AbortController().signal), { status: 400 });
  await assert.rejects(stagePasteFile(request([Buffer.alloc(MAX_PASTE_FILE_BYTES + 1)]), new AbortController().signal), { status: 413 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stagePasteFile(request([Buffer.from('x')]), controller.signal));
  const stalled = new Readable({ read() {} });
  stalled.headers = {};
  const live = new AbortController();
  const pending = stagePasteFile(stalled, live.signal);
  live.abort();
  await assert.rejects(pending);
  const after = (await readdir(tmpdir())).filter(name => name.startsWith('droiddock-paste-'));
  assert.deepEqual(after.filter(name => !before.has(name)), []);
});
