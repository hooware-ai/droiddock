import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('paste helper installer honors environment overrides and environment-only phone configuration',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dd-helper-installer-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const scripts = join(root, 'scripts');
    const project = join(root, 'android', 'paste-helper');
    const sdk = join(root, 'sdk');
    await mkdir(scripts, { recursive: true });
    await mkdir(join(project, 'build', 'outputs', 'apk', 'debug'), { recursive: true });
    await mkdir(join(sdk, 'platforms', 'android-36'), { recursive: true });
    await copyFile(join('scripts', 'Install-PasteHelper.ps1'), join(scripts, 'Install-PasteHelper.ps1'));
    await writeFile(join(project, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
    await writeFile(join(project, 'build', 'outputs', 'apk', 'debug', 'DroidDockPasteHelper-debug.apk'), 'synthetic');
    const adb = join(root, 'synthetic-adb.cmd');
    await writeFile(adb, `@echo off\r\nif "%1"=="devices" (\r\n echo List of devices attached\r\n echo OLD device\r\n echo NEW device\r\n exit /b 0\r\n)\r\nif "%1"=="-s" (\r\n if "%3"=="shell" if "%4"=="getprop" (\r\n  if "%2"=="OLD" echo OLDID\r\n  if "%2"=="NEW" echo NEWID\r\n  exit /b 0\r\n )\r\n if "%3"=="install" (\r\n  echo %2>>"%FAKE_INSTALL_LOG%"\r\n  exit /b 0\r\n )\r\n if "%3"=="shell" if "%4"=="pm" (\r\n  echo package:synthetic\r\n  exit /b 0\r\n )\r\n)\r\nexit /b 1\r\n`);
    const configPath = join(root, 'config.local.json');
    await writeFile(configPath, JSON.stringify({ deviceSerial: 'OLDID', adb: 'missing-adb-from-config' }));
    const log = join(root, 'installed.txt');
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'Install-PasteHelper.ps1')], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, DROIDDOCK_DEVICE_SERIAL: 'NEWID', DROIDDOCK_ADB: adb, ANDROID_HOME: sdk, JAVA_HOME: root, FAKE_INSTALL_LOG: log },
    });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split(/\r?\n/), ['NEW']);
    await rm(configPath);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split(/\r?\n/), ['NEW', 'NEW']);
  });
