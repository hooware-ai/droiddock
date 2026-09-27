import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestFiles } from './install-tests.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const installationId = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
const configPath = join(root, 'config.local.json');

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--no-launch') options.noLaunch = true;
    else if (['--adb', '--device-serial', '--port'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
    else throw new Error('Unknown or incomplete setup option. Use --adb, --device-serial, --port, or --no-launch.');
  }
  if (options.port !== undefined && (!/^\d+$/.test(options.port) || Number(options.port) < 1024 || Number(options.port) > 65535)) throw new Error('Port must be an integer from 1024 to 65535.');
  if (options['device-serial'] && !/^[A-Za-z0-9]+$/.test(options['device-serial'])) throw new Error('Invalid permanent device serial.');
  return options;
}

export function chooseDevice(devices, requested) {
  const unique = [...new Map(devices.map(d => [d.serial, d])).values()];
  if (requested) return unique.find(d => d.serial === requested) ?? null;
  const phones = unique.filter(d => !d.excluded);
  return phones.length === 1 ? phones[0] : null;
}

function run(command, args, timeout = 15000, label = 'Required command') {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, shell: false });
  // spawnSync reports an exceeded limit as ETIMEDOUT; keep that distinct from a failing command.
  if (result.error?.code === 'ETIMEDOUT') throw Object.assign(new Error(`${label} did not finish within ${timeout / 1000} seconds. Check the local prerequisites and rerun; command output was withheld to protect local details.`), { timedOut: true });
  if (result.error || result.status !== 0) throw new Error(`${label} failed. Check the local prerequisites and rerun; command output was withheld to protect local details.`);
  return result.stdout?.trim() ?? '';
}

// The installation subset took about 5.5 s on a Windows 11 host (issue #77), so this
// limit leaves wide headroom for slower or busy machines without adding retries.
export const INSTALL_TEST_TIMEOUT = 120000;

// Runs the runtime/installation test subset. Publication tooling stays in npm test and CI.
export function runInstallTests(timeout = INSTALL_TEST_TIMEOUT, files = installTestFiles()) {
  try { run(process.execPath, ['--test', ...files], timeout, 'Offline tests'); }
  catch (error) {
    if (error.timedOut) throw Object.assign(new Error(`Offline tests did not finish within ${timeout / 1000} seconds, so setup stopped before configuring a phone. The computer may be busy, for example with a security scan. Rerun setup when it is less busy; command output was withheld to protect local details.`), { stage: 'offline_tests_timeout' });
    throw Object.assign(new Error('Offline tests failed, so setup stopped before configuring a phone. Run npm run test:install in this checkout to see which test failed; command output was withheld to protect local details.'), { stage: 'offline_tests_failed' });
  }
}

export async function inspectPort(port, expectedId = installationId) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    const value = await response.json();
    if (response.ok && value.app === 'DroidDock' && value.installationId === expectedId) return { kind: 'ours', status: value };
  } catch {}
  return await new Promise(resolvePort => {
    const probe = createServer();
    probe.once('error', () => resolvePort({ kind: 'occupied' }));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort({ kind: 'free' })));
  });
}

async function selectPort(preferred, explicit) {
  for (let port = preferred; port <= Math.min(preferred + (explicit ? 0 : 99), 65535); port++) {
    if ((await inspectPort(port)).kind !== 'occupied') return port;
  }
  throw new Error(explicit ? 'Requested port is occupied by another service. Choose a different -Port; do not stop unrelated processes.' : 'No free local port found. Rerun with an available -Port.');
}

async function discover(adb, requested) {
  const listing = run(adb, ['devices', '-l']);
  const transports = listing.split(/\r?\n/).flatMap(line => { const match = line.match(/^(\S+)\s+device(?:\s|$)/); return match ? [match[1]] : []; });
  const devices = [];
  for (const transport of transports) {
    try {
      const prop = name => run(adb, ['-s', transport, 'shell', 'getprop', name], 3000);
      const serial = prop('ro.serialno');
      if (!/^[A-Za-z0-9]+$/.test(serial)) continue;
      const characteristics = prop('ro.build.characteristics');
      const emulator = transport.startsWith('emulator-') || prop('ro.kernel.qemu') === '1';
      devices.push({ serial, name: prop('ro.product.model') || 'Android phone', excluded: emulator || /watch|tv|automotive/i.test(characteristics) });
    } catch { /* Offline transports must not select an unverified device. */ }
  }
  // A configured device can reconnect through mDNS even if not in adb devices yet.
  if (requested && !devices.some(d => d.serial === requested)) {
    try {
      const transport = run('pwsh', ['-NoProfile', '-File', join(root, 'scripts/Find-DroidDockDevice.ps1'), '-DeviceSerial', requested, '-AdbPath', adb, '-WaitSeconds', '15'], 20000);
      const serial = run(adb, ['-s', transport, 'shell', 'getprop', 'ro.serialno']);
      if (serial === requested) devices.push({ serial, name: run(adb, ['-s', transport, 'shell', 'getprop', 'ro.product.model']) || 'Android phone', excluded: false });
    } catch {}
  }
  return { devices, unauthorized: /\sunauthorized(?:\s|$)/m.test(listing) };
}

export async function setup(options) {
  if (process.platform !== 'win32') throw new Error('Automated setup currently supports Windows only. See docs/SETUP.md.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required. Run scripts/Install-DroidDock.ps1.');
  let local = {};
  try { local = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid config.local.json. Repair it without discarding existing settings.'); }
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('config.local.json must be an object.');
  const adb = options.adb ?? process.env.DROIDDOCK_ADB ?? local.adb ?? 'adb';
  let requested = options['device-serial'] ?? process.env.DROIDDOCK_DEVICE_SERIAL ?? local.deviceSerial;
  if (requested === 'YOUR_DEVICE_SERIAL') requested = undefined;
  if (requested && !/^[A-Za-z0-9]+$/.test(requested)) throw new Error('Invalid configured permanent device serial.');
  const preferred = Number(options.port ?? process.env.DROIDDOCK_PORT ?? local.port ?? 3210);
  if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535) throw new Error('Invalid configured port.');
  run(adb, ['version']);
  run('pwsh', ['-NoProfile', '-Command', 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }']);
  const manifest = JSON.parse(await readFile(join(root, 'droiddock/vendor/scrcpy-4.1/upstream.json'), 'utf8'));
  const vendor = await readFile(join(root, 'droiddock/vendor/scrcpy-4.1/scrcpy-server'));
  if (createHash('sha256').update(vendor).digest('hex') !== manifest.sha256) throw new Error('Pinned scrcpy server checksum mismatch. Restore it from the repository.');
  const port = await selectPort(preferred, options.port !== undefined || process.env.DROIDDOCK_PORT !== undefined);
  const service = await inspectPort(port);
  if (service.kind === 'ours' && service.status.state !== 'idle') {
    const wantedId = createHash('sha256').update(JSON.stringify([requested ?? '', adb, process.env.DROIDDOCK_DEVICE_NAME ?? local.deviceName ?? 'Android phone', port])).digest('hex').slice(0, 16);
    if (service.status.state === 'connected' && service.status.configurationId === wantedId) {
      let builtId;
      try {
        const { buildIdentity } = await import('../dist/droiddock/build-id.js');
        builtId = buildIdentity(root);
      } catch { /* A missing or incomplete build cannot prove the running service is current. */ }
      if (service.status.buildId !== builtId || !builtId) return { status: 'needs_action', stage: 'restart_needed', message: 'Restart needed. Finish the active phone session before updating; the existing service was left untouched.', url: `http://127.0.0.1:${port}/` };
      // Even matching built files may be older than source changes not compiled yet.
      return { status: 'needs_action', stage: 'active_session', message: 'Finish the active phone session before updating; the existing service was left untouched.', url: `http://127.0.0.1:${port}/` };
    }
    return { status: 'needs_action', stage: 'active_session', message: 'This installation has an active or unsettled session. Finish it before updating; the existing service was left untouched.', url: `http://127.0.0.1:${port}` };
  }
  if (service.kind === 'ours') {
    const stopped = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' }, signal: AbortSignal.timeout(5000) });
    if (!stopped.ok) return { status: 'needs_action', stage: 'active_session', message: 'Close this installation’s controlling browser tab before updating; no files were changed.' };
    for (let attempt = 0; attempt < 20 && (await inspectPort(port)).kind !== 'free'; attempt++) await delay(100);
    if ((await inspectPort(port)).kind !== 'free') throw new Error('The previous DroidDock server has not stopped yet. Wait for shutdown before rerunning.');
  }
  // npm's JS entry point avoids cmd.exe quoting and PowerShell execution-policy issues.
  const npmCandidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const npmCli = npmCandidates.find(existsSync);
  if (!npmCli) throw new Error('npm is missing beside Node. Repair the official Node.js installation and rerun.');
  console.log('Installing locked dependencies and building DroidDock...');
  run(process.execPath, [npmCli, 'ci', '--ignore-scripts'], 300000, 'Dependency installation');
  run(process.execPath, [npmCli, 'run', 'build'], 120000, 'TypeScript build');
  runInstallTests();
  // A fresh Windows ADB daemon must not inherit captured ancestor output pipes.
  run('pwsh', ['-NoProfile', '-File', join(root, 'scripts/Start-DroidDockAdb.ps1'), '-AdbPath', adb], 20000);
  const discovery = await discover(adb, requested);
  const selected = chooseDevice(discovery.devices, requested);
  if (!selected) {
    const candidates = discovery.devices.filter(d => !d.excluded).map(({ name, serial }) => ({ name, serial }));
    return { status: 'needs_action', stage: requested ? 'configured_phone_unreachable' : candidates.length > 1 ? 'choose_phone' : 'authorize_phone', candidates,
      message: requested ? 'The configured phone is unavailable. Reconnect or authorize it; rerun with -DeviceSerial only to explicitly change devices.' : candidates.length > 1 ? 'Ask which phone to use, then rerun with -DeviceSerial from the candidates.' : discovery.unauthorized ? 'Unlock the phone and approve USB debugging, then rerun.' : 'Connect your phone by USB and enable/approve USB debugging, or complete wireless pairing using docs/SETUP.md; then rerun.' };
  }
  const next = { ...local, adb, deviceSerial: selected.serial, deviceName: local.deviceSerial === selected.serial && local.deviceName ? local.deviceName : selected.name, port };
  await mkdir(join(root, '.setup'), { recursive: true });
  await writeFile(join(root, '.setup/config.tmp'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(join(root, '.setup/config.tmp'), configPath);
  if (!options.noLaunch) {
    // Explicit selections override inherited environment for this launch too.
    process.env.DROIDDOCK_ADB = adb;
    process.env.DROIDDOCK_DEVICE_SERIAL = selected.serial;
    process.env.DROIDDOCK_PORT = String(port);
    run(process.execPath, [join(root, 'scripts/launch.mjs')], 15000);
    if ((await inspectPort(port)).kind !== 'ours') throw new Error('DroidDock launcher did not start this installation. Check local logs.');
  }
  return { status: 'ready', stage: options.noLaunch ? 'configured' : 'http_ready', url: `http://127.0.0.1:${port}/`, installationId,
    next: 'Run node scripts/Test-DroidDock.mjs --live, open the URL in Codex’s right browser panel, click Connect, and verify visible decoded phone frames. HTTP readiness alone is not setup completion.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await setup(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'ready' ? 0 : 2;
  } catch (error) { console.log(JSON.stringify({ status: 'error', stage: error.stage ?? 'setup', message: error.message })); process.exitCode = 1; }
}
