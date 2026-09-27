import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildIdentity, PUBLIC_ASSETS } from '../../dist/droiddock/build-id.js';

// A copied checkout under .setup resolves ws from the repository's node_modules.
async function checkout(t) {
  const base = resolve('.setup');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'build-id-'));
  await cp('dist', join(root, 'dist'), { recursive: true });
  await cp('droiddock/public', join(root, 'droiddock/public'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  for (const name of ['launch.mjs', 'setup.mjs', 'install-tests.mjs']) await copyFile(join('scripts', name), join(root, 'scripts', name));
  const installationId = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16);
  let port, origin;
  const launch = () => spawnSync(process.execPath, [join(root, 'scripts/launch.mjs')], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'TESTONLY', LOCALAPPDATA: join(root, '.logs') } });
  const status = async () => (await fetch(`${origin}/api/status`)).json();
  // Only this fixture's service may be stopped; a reused port can belong to another test.
  const ours = async () => { try { return origin && (await status()).installationId === installationId; } catch { return false; } };
  // Tests run in parallel, so another test can take a released port before the launcher binds it.
  const start = async (attemptLaunch = launch) => {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
      port = reservation.address().port;
      await new Promise(done => reservation.close(done));
      origin = `http://127.0.0.1:${port}`;
      result = attemptLaunch();
      if (result.status === 0 && await ours()) break;
      // A readiness timeout can leave a detached child starting in the background.
      // Only a confirmed pre-launch port collision is safe to retry.
      if (result.status !== 1 || !result.stderr?.includes('Port occupied by another service or checkout.')) break;
    }
    return result;
  };
  t.after(async () => {
    if (await ours()) {
      try { await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' } }); } catch {}
      for (let attempt = 0; attempt < 40 && await ours(); attempt++) await new Promise(done => setTimeout(done, 100));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, start, launch, status, get origin() { return origin; } };
}

test('the build-id fixture retries only a confirmed pre-launch port collision', async t => {
  const fixture = await checkout(t);
  for (const [failure, expectedAttempts] of [
    [{ status: 1, stderr: 'Port occupied by another service or checkout.' }, 3],
    [{ status: 1, stderr: 'DroidDock did not become ready.' }, 1],
    [{ status: null, stderr: '' }, 1],
  ]) {
    let attempts = 0;
    const result = await fixture.start(() => { attempts++; return failure; });
    assert.equal(result, failure);
    assert.equal(attempts, expectedAttempts);
  }
});

test('build identity covers compiled server code and served assets only', async t => {
  const { root } = await checkout(t);
  const initial = buildIdentity(root);
  assert.match(initial, /^[a-f0-9]{16}$/);
  assert.equal(initial, buildIdentity(resolve('.')), 'a clean copy of the same build matches');
  await appendFile(join(root, 'dist/droiddock/server.js.map'), '\n');
  await appendFile(join(root, 'dist/droiddock/server.d.ts'), '\n');
  assert.equal(buildIdentity(root), initial, 'maps and declarations are not running code');
  await appendFile(join(root, 'dist/droiddock/protocol.js'), '\n// changed server code\n');
  const serverChanged = buildIdentity(root);
  assert.notEqual(serverChanged, initial);
  await appendFile(join(root, 'droiddock/public/styles.css'), '\n/* changed client */\n');
  assert.notEqual(buildIdentity(root), serverChanged);
});

test('a running service keeps serving its startup assets and launch refuses to reuse a stale build', { timeout: 20000 }, async t => {
  const fixture = await checkout(t);
  const { root, launch, status } = fixture;
  const original = new Map();
  for (const name of PUBLIC_ASSETS) original.set(name, await readFile(join(root, 'droiddock/public', name)));
  const started = await fixture.start();
  const origin = fixture.origin;
  assert.equal(started.status, 0, started.stderr);
  const initial = await status();
  assert.equal(initial.buildId, buildIdentity(root));
  const page = await fetch(origin);
  const headers = [...page.headers].filter(([name]) => ['content-security-policy', 'cache-control', 'x-content-type-options', 'referrer-policy', 'content-type'].includes(name));

  for (const name of PUBLIC_ASSETS) await appendFile(join(root, 'droiddock/public', name), '\n<!-- newer client on disk -->\n');
  assert.notEqual(buildIdentity(root), initial.buildId);
  for (const [path, name] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css']]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original.get(name), name);
  }
  const later = await fetch(origin);
  assert.deepEqual([...later.headers].filter(([name]) => headers.some(([kept]) => kept === name)), headers);
  assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  assert.equal((await status()).buildId, initial.buildId);

  const stale = launch();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /different build of this checkout\. Restart needed/);
  assert.ok(!stale.stderr.includes(root) && !stale.stdout.includes(root));
  const after = await status();
  assert.equal(after.state, 'idle');
  assert.equal(after.buildId, initial.buildId, 'the stale service was left running and unchanged');
});
