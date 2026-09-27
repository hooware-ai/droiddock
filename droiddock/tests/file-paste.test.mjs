import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { open, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostPasteCleanup, pasteMime, stagePasteFile, MAX_PASTE_FILE_BYTES } from '../../dist/droiddock/file-paste.js';

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
  await assert.rejects(stagePasteFile(request([Buffer.from('x')]), new AbortController().signal,
    () => { throw new Error('synthetic tracking failure'); }), /tracking failure/);
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

const SYNTHETIC_DIRECTORY = ['C:', 'Users', 'SyntheticUser', 'AppData', 'Local', 'Temp'].join('\\');
const stagingMessage = 'DroidDock could not prepare this file on the computer. Check free space and try again.';

function systemError(syscall, code = 'EACCES') {
  const path = `${SYNTHETIC_DIRECTORY}\\droiddock-paste-synthetic`;
  return Object.assign(new Error(`${code}: synthetic failure, ${syscall} '${path}'`), { code, errno: -13, syscall, path });
}

// Injected host filesystem with a controllable handle; no real files are touched.
function stagingIo({ open, write, close, unlink } = {}) {
  const calls = { unlink: [], closed: 0 };
  const io = {
    directory: () => SYNTHETIC_DIRECTORY,
    open: async () => {
      if (open) throw open;
      return {
        write: async (buffer, offset, length) => { if (write) throw write; return { bytesWritten: length }; },
        close: async () => { calls.closed++; if (close) throw close; },
      };
    },
    unlink: async path => { calls.unlink.push(path); if (unlink) throw unlink; },
  };
  return { io, calls };
}

function assertSanitized(error, status) {
  assert.equal(error.status, status);
  for (const secret of ['SyntheticUser', 'droiddock-paste-synthetic', 'EACCES', 'EPERM', 'open', 'write', 'close', 'unlink'])
    assert.ok(!error.message.includes(secret), `message must not include ${secret}`);
  return true;
}

test('host staging failures report fixed text without paths, accounts or syscalls', async () => {
  const signal = new AbortController().signal;
  for (const failure of ['open', 'write', 'close']) {
    const { io, calls } = stagingIo({ [failure]: systemError(failure) });
    const tracked = [];
    await assert.rejects(stagePasteFile(request([Buffer.from('x')]), signal, path => tracked.push(path), io), error => {
      assert.equal(error.message, stagingMessage);
      return assertSanitized(error, 500);
    });
    // A handle that was opened is closed once and its partial file removed.
    if (failure !== 'open') {
      assert.equal(calls.closed, 1);
      assert.deepEqual(calls.unlink, tracked);
    } else assert.deepEqual([calls.unlink, tracked], [[], []]);
  }
});

test('a missing real temporary directory is reported without its path', async () => {
  const missing = join(tmpdir(), `droiddock-missing-${randomUUID()}`);
  const io = { directory: () => missing, open, unlink };
  await assert.rejects(stagePasteFile(request([Buffer.from('x')]), new AbortController().signal, () => {}, io), error => {
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes(missing) && !error.message.includes('ENOENT'));
    return true;
  });
});

test('cleanup failure never masks the original staging error', async () => {
  const signal = new AbortController().signal;
  const oversize = request([Buffer.alloc(MAX_PASTE_FILE_BYTES + 1)]);
  const { io, calls } = stagingIo({ unlink: systemError('unlink', 'EPERM') });
  const tracked = [];
  await assert.rejects(stagePasteFile(oversize, signal, path => tracked.push(path), io),
    { status: 413, message: 'Paste one file up to 16 MiB.' });
  // The tracked path stays owned by HostPasteCleanup for a later retry.
  assert.equal(tracked.length, 1);
  assert.deepEqual(calls.unlink, tracked);

  const empty = stagingIo({ unlink: systemError('unlink', 'EPERM') });
  await assert.rejects(stagePasteFile(request([]), signal, () => {}, empty.io), { status: 400, message: 'The clipboard file is empty.' });
  const failedWrite = stagingIo({ write: systemError('write'), unlink: systemError('unlink', 'EPERM') });
  await assert.rejects(stagePasteFile(request([Buffer.from('x')]), signal, () => {}, failedWrite.io), error => assertSanitized(error, 500));
});

test('an untracked leftover fails closed with fixed text, while a vanished file keeps the original error', async () => {
  const signal = new AbortController().signal;
  const untrack = () => { throw new Error('synthetic tracking failure'); };
  const locked = stagingIo({ unlink: systemError('unlink', 'EPERM') });
  await assert.rejects(stagePasteFile(request([Buffer.from('x')]), signal, untrack, locked.io), error => assertSanitized(error, 500));
  const vanished = stagingIo({ unlink: systemError('unlink', 'ENOENT') });
  await assert.rejects(stagePasteFile(request([Buffer.from('x')]), signal, untrack, vanished.io), /tracking failure/);
});

test('failed host cleanup remains owned and blocks reuse until retry succeeds', async () => {
  let fail = true;
  const removed = [];
  const cleanup = new HostPasteCleanup(async path => {
    if (fail) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    removed.push(path);
  });
  cleanup.track('SYNTHETIC_STAGED_FILE');
  assert.equal(await cleanup.retry(), false);
  assert.equal(cleanup.pending, true);
  fail = false;
  assert.equal(await cleanup.retry(), true);
  assert.equal(cleanup.pending, false);
  assert.deepEqual(removed, ['SYNTHETIC_STAGED_FILE']);
});
