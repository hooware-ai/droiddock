import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseDevice, parseArgs, inspectPort, runInstallTests, INSTALL_TEST_TIMEOUT, setup, installationId, root } from '../../scripts/setup.mjs';
import { installTestFiles, publicationTests } from '../../scripts/install-tests.mjs';
import { buildIdentity } from '../../dist/droiddock/build-id.js';

test('setup selects one physical phone, never a watch/emulator or ambiguous phones', () => {
  const phone = { serial: 'PHONE1', name: 'Phone', excluded: false };
  const watch = { serial: 'WATCH1', name: 'Watch', excluded: true };
  assert.equal(chooseDevice([watch]), null);
  assert.deepEqual(chooseDevice([watch, phone, { ...phone }]), phone);
  assert.equal(chooseDevice([phone, { ...phone, serial: 'PHONE2' }]), null);
  assert.equal(chooseDevice([phone], 'MISSING'), null);
  assert.equal(chooseDevice([watch, phone], 'PHONE1'), phone);
});

test('Windows installer refresh keeps tool precedence without multiplying PATH', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/Install-DroidDock.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { exit 1 }
    $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Refresh-DroidPath' }, $true)
    Invoke-Expression $function.Extent.Text
    $env:Path = 'C:\\DroidDockTest;C:\\droiddocktest\\;' + ((@($env:Path) * 3) -join ';')
    Refresh-DroidPath
    $first = $env:Path
    Refresh-DroidPath
    @{ stable=($first -eq $env:Path); first=($env:Path -split ';')[0]; copies=@(($env:Path -split ';') | Where-Object { $_.TrimEnd('\\') -ieq 'C:\\DroidDockTest' }).Count } | ConvertTo-Json -Compress
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.stable, true);
  assert.equal(actual.first, 'C:\\DroidDockTest');
  assert.equal(actual.copies, 1);
});

test('detached launcher returns promptly and leaves a healthy service that can shut down', { timeout: 15000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const result = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding:'utf8', env:{...process.env, DROIDDOCK_PORT:String(port), DROIDDOCK_DEVICE_SERIAL:'TESTONLY'}, timeout:10000, windowsHide:true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${origin}/`);
    assert.equal((await inspectPort(port)).kind, 'ours');
    const again = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding:'utf8', env:{...process.env, DROIDDOCK_PORT:String(port), DROIDDOCK_DEVICE_SERIAL:'DIFFERENT'}, timeout:5000, windowsHide:true });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /different configuration/);
  } finally {
    if ((await inspectPort(port)).kind === 'ours') await fetch(`${origin}/api/shutdown`, { method:'POST', headers:{'X-DroidDock':'1'} });
  }
});

test('setup rejects malformed and incomplete explicit configuration', () => {
  for (const args of [['--port','0'], ['--port','65536'], ['--port','3210.5'], ['--port'], ['--device-serial','bad;command'], ['--unknown']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['--port','3211','--adb','C:\\Program Files\\adb.exe','--no-launch']), {port:'3211', adb:'C:\\Program Files\\adb.exe', noLaunch:true});
});

test('setup CLI does not disclose a failed executable path or unknown argument', () => {
  const privateMarker = 'SYNTHETIC_PRIVATE_VALUE';
  for (const args of [['--adb', `${privateMarker}/nonexistent-adb`], [`--${privateMarker}`]]) {
    const result = spawnSync(process.execPath, ['scripts/setup.mjs', ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'error');
    assert.equal(JSON.parse(result.stdout.trim()).stage, 'setup');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(privateMarker));
  }
});

test('setup never reuses another checkout or an unrelated service', async () => {
  let identity = 'other';
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ app:'DroidDock', installationId:identity, state:'idle' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  try {
    assert.equal((await inspectPort(port, 'ours')).kind, 'occupied');
    identity = 'ours';
    assert.equal((await inspectPort(port, 'ours')).kind, 'ours');
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal((await inspectPort(port, 'ours')).kind, 'free');
});

test('setup preserves a connected session and never reports an unbuilt update as ready', { skip: process.platform !== 'win32' }, async () => {
  const previousName = process.env.DROIDDOCK_DEVICE_NAME;
  process.env.DROIDDOCK_DEVICE_NAME = 'Android phone';
  let buildId = '0000000000000000';
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      app: 'DroidDock', installationId, state: 'connected', buildId,
      configurationId: createHash('sha256').update(JSON.stringify(['SYNTHETIC', 'git', 'Android phone', server.address().port])).digest('hex').slice(0, 16),
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const options = { adb: 'git', 'device-serial': 'SYNTHETIC', port: String(server.address().port) };
    const stale = await setup(options);
    assert.equal(stale.status, 'needs_action');
    assert.equal(stale.stage, 'restart_needed');
    buildId = buildIdentity(root);
    const matchingBuiltFiles = await setup(options);
    assert.equal(matchingBuiltFiles.status, 'needs_action');
    assert.equal(matchingBuiltFiles.stage, 'active_session');
    assert.ok(paths.every(path => path === '/api/status'));
  } finally {
    if (previousName === undefined) delete process.env.DROIDDOCK_DEVICE_NAME;
    else process.env.DROIDDOCK_DEVICE_NAME = previousName;
    await new Promise(resolve => server.close(resolve));
  }
});

test('setup gate covers runtime tests and leaves only publication tooling to npm test', async () => {
  const files = installTestFiles().map(file => file.replaceAll('\\', '/'));
  const all = (await readdir(new URL('.', import.meta.url))).filter(name => name.endsWith('.test.mjs'));
  assert.deepEqual([...publicationTests], ['release.test.mjs']);
  assert.deepEqual(files.map(file => file.split('/').at(-1)).sort(), all.filter(name => !publicationTests.includes(name)).sort());
  for (const runtime of ['protocol', 'http', 'server-security', 'handoff', 'process', 'setup', 'diagnostics']) {
    assert.ok(files.includes(`droiddock/tests/${runtime}.test.mjs`), runtime);
  }
  const scripts = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(scripts.test, 'node --test droiddock/tests/*.test.mjs');
  assert.equal(scripts['test:install'], 'node scripts/install-tests.mjs');
  assert.equal(INSTALL_TEST_TIMEOUT, 120000);
});

test('setup reports a timed-out test gate separately from a failing one without echoing output', { timeout: 30000 }, async () => {
  const privateMarker = 'SYNTHETIC_PRIVATE_VALUE';
  const dir = await mkdtemp(join(tmpdir(), 'droiddock-gate-'));
  // A nested `node --test` reports to this runner instead of running files when this is inherited.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const slow = join(dir, 'slow.test.mjs'), failing = join(dir, 'failing.test.mjs');
    await writeFile(slow, "import { test } from 'node:test';\ntest('slow', () => new Promise(done => setTimeout(done, 5000)));\n");
    await writeFile(failing, `import { test } from 'node:test';\ntest('fails', () => { console.log('${privateMarker}'); throw new Error('${privateMarker}'); });\n`);
    const outcome = (files, timeout) => { try { runInstallTests(timeout, files); return null; } catch (error) { return error; } };
    const timedOut = outcome([slow], 1000);
    const failed = outcome([failing], 20000);
    assert.equal(timedOut?.stage, 'offline_tests_timeout');
    assert.match(timedOut.message, /did not finish within 1 seconds/);
    assert.equal(failed?.stage, 'offline_tests_failed');
    assert.match(failed.message, /npm run test:install/);
    assert.notEqual(timedOut.message, failed.message);
    for (const error of [timedOut, failed]) assert.ok(!error.message.includes(privateMarker) && !error.message.includes(dir));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
