import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

test('local HTTP and WebSocket boundary rejects foreign websites and a second controller', { timeout: 15000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist/droiddock/server.js'], { env: { ...process.env, DROIDDOCK_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let owner;
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${origin}/api/status`); ready = r.ok; } catch {}
      if (ready) break; await delay(100);
    }
    assert.ok(ready, 'test server ready');
    const initial = await (await fetch(`${origin}/api/status`)).json();
    assert.equal(initial.app, 'DroidDock'); assert.equal(initial.state, 'idle');
    assert.match(initial.installationId, /^[a-f0-9]{16}$/);
    assert.match(initial.configurationId, /^[a-f0-9]{16}$/);
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const req = request(origin, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(origin, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/connect`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${origin}/api/shutdown`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${origin}/api/connect`, { method: 'POST', headers: { 'X-DroidDock': '1' } })).status, 409);
    assert.equal((await fetch(`${origin}/package.json`)).status, 404);
    assert.equal((await fetch(`${origin}/stream-stats.js`)).status, 200);
    const page = await fetch(origin);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);

    async function rejected(wsOrigin) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, wsOrigin ? { origin: wsOrigin } : {});
      ws.on('error', () => {});
      const [error] = await once(ws, 'error');
      assert.match(error.message, /403/); ws.terminate();
    }
    await rejected('https://evil.example'); await rejected(undefined);
    owner = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin });
    const initialMessage = once(owner, 'message'); await once(owner, 'open');
    assert.equal(JSON.parse((await initialMessage)[0].toString()).state, 'idle');
    assert.equal((await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' } })).status, 409);
    await rejected(origin);
    const inputError = once(owner, 'message'); owner.send(JSON.stringify({ type: 'key', key: 'home' }));
    assert.equal(JSON.parse((await inputError)[0].toString()).type, 'inputError');
    // JSON can expand a valid 64KiB paste beyond the old 4KiB message ceiling.
    const largePasteError = once(owner, 'message');
    owner.send(JSON.stringify({ type: 'paste', text: '\u0000'.repeat(65536) }));
    assert.equal(JSON.parse((await largePasteError)[0].toString()).type, 'inputError');
    assert.equal(owner.readyState, WebSocket.OPEN);
    const closed = once(owner, 'close'); owner.close(); await closed;
    const disconnect = await fetch(`${origin}/api/disconnect`, { method: 'POST', headers: { 'X-DroidDock': '1' } });
    assert.equal(disconnect.status, 200);
    assert.equal((await disconnect.json()).state, 'idle');
    const exited = once(server, 'exit');
    assert.equal((await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' } })).status, 200);
    await exited;
  } finally {
    owner?.terminate(); if (server.exitCode === null) { server.kill(); await once(server, 'exit').catch(() => {}); }
  }
});
