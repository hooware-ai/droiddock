import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadBrowser, startConnect, deliverSyntheticFrame } from './accessibility.test.mjs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const statsSource = readFileSync(new URL('../public/stream-stats.js', import.meta.url), 'utf8');

function loadCollector() {
  const sandbox = { performance: { now() { return 0; } } };
  sandbox.globalThis = sandbox;
  runInNewContext(statsSource, sandbox);
  return sandbox.DroidDockStreamStats;
}

function mediaPacket(payloadSize = 100, { keyframe = true, timestamp = 0n } = {}) {
  const buffer = new ArrayBuffer(12 + payloadSize);
  const view = new DataView(buffer);
  let flags = timestamp;
  if (keyframe) flags |= (1n << 62n);
  view.setBigUint64(0, flags);
  view.setUint32(8, payloadSize);
  return buffer;
}

function countTextWrites(node) {
  let writes = 0;
  let value = node.textContent;
  Object.defineProperty(node, 'textContent', {
    get() { return value; },
    set(next) {
      writes += 1;
      value = next;
    },
    configurable: true,
  });
  return () => writes;
}

function enableStats(browser) {
  const toggle = browser.element('stream-stats-enabled');
  toggle.checked = true;
  toggle.handlers.change();
}

function openDetails(browser) {
  browser.more.open = true;
  browser.more.handlers.toggle();
}

function closeDetails(browser) {
  browser.more.open = false;
  browser.more.handlers.toggle();
}

function sliceBetween(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0, `missing ${startMark}`);
  assert.ok(end > start, `missing ${endMark} after ${startMark}`);
  return source.slice(start, end);
}

function median(values) {
  const ordered = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return ordered[Math.floor(ordered.length / 2)];
}

function nsToMs(value) {
  return Number(value) / 1e6;
}

test('Details offers optional local statistics with precise labels and no live region', () => {
  assert.match(html, /<script src="\/stream-stats.js" defer>/);
  assert.match(html, /<label class="stream-stats-toggle" for="stream-stats-enabled">/);
  assert.match(html, /<input id="stream-stats-enabled" type="checkbox">/);
  assert.match(html, /id="stream-stats-panel" hidden/);
  assert.match(html, /<dt>Media bytes received<\/dt>/);
  assert.match(html, /<dt>Decoded frames drawn<\/dt>/);
  assert.match(html, /<dt>Decode queue length<\/dt>/);
  assert.match(html, /Configured encoder limits \(not measurements\): max 1280 px, up to 60 fps, 6 Mbps H\.264\./);
  assert.match(html, /Rates are the last completed 1-second period of observed local events/);
  assert.match(html, /The first second shows Collecting/);
  assert.match(html, /Media bytes received is not frames per second/);
  assert.match(html, /These numbers are not end-to-end latency/);
  assert.match(html, /A still phone screen may produce few frames; that is not a failure/);
  assert.match(html, /They are not sent anywhere and do not include phone content/);
  assert.doesNotMatch(html, /id="stream-stats-[^"]*"[^>]*aria-live/);
  assert.doesNotMatch(html, /id="stream-stats-panel"[^>]*role="status"/);
  const statsBlock = html.slice(html.indexOf('id="stream-stats-enabled"'), html.indexOf('id="text-form"'));
  assert.doesNotMatch(statsBlock, /FPS/);
  assert.doesNotMatch(appSource, /localStorage|sessionStorage|navigator\.sendBeacon|aria-live:\s*'polite'/);
});

test('collector rates use a controlled clock, burst/idle windows, and constant space', () => {
  const api = loadCollector();
  let time = 0;
  const stats = api.createStreamStats({ now: () => time });
  assert.equal(Number(stats.capacity().buckets), 2);
  assert.equal(stats.snapshot().complete, false);
  assert.equal(api.formatSnapshot(stats.snapshot(), null, 'unavailable').bytes, '—');
  assert.equal(api.formatSnapshot(stats.snapshot(), null, 'active').bytes, 'Collecting');

  for (let i = 0; i < 10; i++) {
    stats.recordMediaBytes(1000, time);
    stats.recordDrawnFrame(time);
  }
  time = 500;
  assert.equal(stats.snapshot().complete, false);
  assert.equal(stats.snapshot().mediaBytesPerSecond, null);

  time = 1000;
  const burst = stats.snapshot();
  assert.equal(burst.complete, true);
  assert.equal(burst.mediaBytesPerSecond, 10000);
  assert.equal(burst.decodedFramesDrawnPerSecond, 10);
  assert.equal(api.formatSnapshot(burst, 3, 'active').bytes, '10000 B / s');
  assert.equal(api.formatSnapshot(burst, 3, 'active').frames, '10 frames / s');
  assert.equal(api.formatSnapshot(burst, 3, 'active').queue, '3');

  time = 2500;
  const idle = stats.snapshot();
  assert.equal(idle.complete, true);
  assert.equal(idle.mediaBytesPerSecond, 0);
  assert.equal(idle.decodedFramesDrawnPerSecond, 0);

  const firstView = stats.snapshot();
  stats.recordMediaBytes(1, time);
  const secondView = stats.snapshot();
  assert.equal(firstView, secondView);

  for (let i = 0; i < 100000; i++) {
    time += 1;
    stats.recordMediaBytes(8, time);
    stats.recordDrawnFrame(time);
  }
  const cap = stats.capacity();
  assert.equal(Number(cap.buckets), 2);
  assert.equal(Number(cap.bytes), 1);
  assert.equal(Number(cap.frames), 1);

  const generation = stats.generation;
  stats.reset();
  assert.equal(stats.generation, generation + 1);
  assert.equal(stats.snapshot().mediaBytesPerSecond, null);
  assert.equal(api.formatSnapshot(stats.snapshot(), null).queue, '—');
});

test('enabled Details distinguishes arrival, drawn frames, and queue without failing on idle', async () => {
  const browser = loadBrowser();
  const bytesWrites = countTextWrites(browser.element('stream-stats-bytes'));
  const framesWrites = countTextWrites(browser.element('stream-stats-frames'));
  const queueWrites = countTextWrites(browser.element('stream-stats-queue'));
  enableStats(browser);
  assert.equal(browser.element('stream-stats-panel').hidden, false);
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  browser.FakeVideoDecoder.latest.decodeQueueSize = 2;
  openDetails(browser);

  socket.onmessage({ data: mediaPacket(2048) });
  browser.FakeVideoDecoder.latest.emit();
  browser.setTime(1000);
  browser.tickIntervals();
  assert.equal(browser.element('stream-stats-bytes').textContent, '2048 B / s');
  assert.equal(browser.element('stream-stats-frames').textContent, '2 frames / s');
  assert.equal(browser.element('stream-stats-queue').textContent, '2');
  assert.doesNotMatch(browser.element('stream-stats-bytes').textContent, /FPS|fps/);
  assert.equal(browser.element('state').dataset.state, 'connected');

  const writesAfterBurst = bytesWrites() + framesWrites() + queueWrites();
  browser.advanceTime(1500);
  browser.tickIntervals();
  assert.equal(browser.element('stream-stats-bytes').textContent, '0 B / s');
  assert.equal(browser.element('stream-stats-frames').textContent, '0 frames / s');
  assert.equal(browser.element('state').dataset.state, 'connected');
  assert.ok(browser.keyButtons.every((button) => !button.disabled));
  assert.ok(bytesWrites() + framesWrites() + queueWrites() > writesAfterBurst);
});

test('statistics reset on disconnect, handoff, rotation, and ignore stale decoder output', async () => {
  const browser = loadBrowser();
  enableStats(browser);
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  openDetails(browser);
  socket.onmessage({ data: mediaPacket(512) });
  browser.FakeVideoDecoder.latest.emit();
  browser.setTime(1000);
  browser.tickIntervals();
  assert.match(browser.element('stream-stats-bytes').textContent, /512 B \/ s/);

  const stale = browser.FakeVideoDecoder.latest;
  socket.receive({ type: 'moved' });
  assert.equal(browser.element('stream-stats-bytes').textContent, '—');
  assert.equal(browser.element('stream-stats-frames').textContent, '—');
  assert.equal(browser.intervals.size, 0);
  stale.emit({ displayWidth: 720, displayHeight: 1280, close() {} });
  browser.setTime(2500);
  browser.tickIntervals();
  assert.equal(browser.element('stream-stats-bytes').textContent, '—');
  assert.equal(browser.element('stream-stats-frames').textContent, '—');

  const retryBrowser = loadBrowser();
  enableStats(retryBrowser);
  const retry = deliverSyntheticFrame(retryBrowser, await startConnect(retryBrowser));
  openDetails(retryBrowser);
  retry.onmessage({ data: mediaPacket(256) });
  retryBrowser.FakeVideoDecoder.latest.emit();
  retryBrowser.setTime(1000);
  retryBrowser.tickIntervals();
  assert.equal(retryBrowser.element('stream-stats-bytes').textContent, '256 B / s');

  retry.receive({ type: 'video' });
  assert.equal(retryBrowser.element('stream-stats-bytes').textContent, '—');
  assert.equal(retryBrowser.element('state').dataset.state, 'connected');
  assert.equal(retryBrowser.element('screen').hidden, true);

  retryBrowser.element('connect').handlers.click();
  assert.equal(retryBrowser.element('stream-stats-bytes').textContent, '—');
  assert.equal(retryBrowser.intervals.size, 0);
});

test('refresh stops when the panel is closed, the tab is hidden, or the option is off', async () => {
  const browser = loadBrowser();
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  const bytesWrites = countTextWrites(browser.element('stream-stats-bytes'));
  socket.onmessage({ data: mediaPacket(128) });
  browser.FakeVideoDecoder.latest.emit();
  browser.setTime(1000);
  browser.tickIntervals();
  assert.equal(bytesWrites(), 0);
  assert.equal(browser.intervals.size, 0);
  assert.equal(browser.element('stream-stats-panel').hidden, true);

  enableStats(browser);
  openDetails(browser);
  assert.equal(browser.intervals.size, 1);
  assert.equal([...browser.intervals.values()][0].ms, 1000);
  const afterOpen = bytesWrites();
  socket.onmessage({ data: mediaPacket(64) });
  browser.FakeVideoDecoder.latest.emit();
  assert.equal(bytesWrites(), afterOpen);

  closeDetails(browser);
  assert.equal(browser.intervals.size, 0);
  const afterClose = bytesWrites();
  browser.advanceTime(1000);
  browser.tickIntervals();
  assert.equal(bytesWrites(), afterClose);

  openDetails(browser);
  assert.equal(browser.intervals.size, 1);
  browser.documentState.hidden = true;
  browser.documentHandlers.visibilitychange();
  assert.equal(browser.intervals.size, 0);
  const afterHide = bytesWrites();
  browser.advanceTime(1000);
  browser.tickIntervals();
  assert.equal(bytesWrites(), afterHide);

  browser.documentState.hidden = false;
  browser.documentHandlers.visibilitychange();
  assert.equal(browser.intervals.size, 1);
  browser.element('stream-stats-enabled').checked = false;
  browser.element('stream-stats-enabled').handlers.change();
  assert.equal(browser.element('stream-stats-panel').hidden, true);
  assert.equal(browser.intervals.size, 0);
});

test('decode and input paths stay free of stats DOM writes and telemetry', () => {
  const decode = sliceBetween(appSource, 'function decodePacket', 'function coordinates');
  const sendFn = sliceBetween(appSource, 'function send(', 'async function connect');
  const output = sliceBetween(appSource, 'output(frame)', 'error(error)');
  const mediaPath = decode.slice(decode.lastIndexOf('if (statsCanRecord())'));
  assert.match(decode, /statsCanRecord\(\)/);
  assert.match(decode, /recordMediaBytes\(size\)/);
  assert.match(output, /statsCanRecord\(\)/);
  assert.doesNotMatch(mediaPath, /assignText|setInterval|requestAnimationFrame|paintStreamStats/);
  assert.match(output, /recordDrawnFrame/);
  assert.doesNotMatch(output, /stream-stats-bytes|setInterval|requestAnimationFrame|paintStreamStats/);
  assert.doesNotMatch(sendFn, /streamStats|recordMediaBytes|recordDrawnFrame/);
  assert.doesNotMatch(appSource, /send\(\{[^}]*stats/);
  assert.doesNotMatch(appSource, /fetch\([^)]*stats/);
  assert.match(appSource, /setInterval\(refreshStreamStats, 1000\)/);
  assert.match(appSource, /document\.hidden/);
  assert.match(appSource, /statsRefreshGeneration !== generation/);
});

test('configured encoder limits stay tied to the session server settings', () => {
  const session = readFileSync(new URL('../../src/droiddock/session.ts', import.meta.url), 'utf8');
  assert.match(session, /max_size=1280/);
  assert.match(session, /max_fps=60/);
  assert.match(session, /video_bit_rate=6000000/);
  assert.match(html, /max 1280 px, up to 60 fps, 6 Mbps H\.264/);
  assert.match(statsSource, /max 1280 px, up to 60 fps, 6 Mbps H\.264/);
});

test('hidden-tab packets are not kept, and a stale refresh callback cannot paint', async () => {
  const browser = loadBrowser();
  enableStats(browser);
  const socket = deliverSyntheticFrame(browser, await startConnect(browser));
  openDetails(browser);
  socket.onmessage({ data: mediaPacket(900) });
  browser.FakeVideoDecoder.latest.emit();
  browser.documentState.hidden = true;
  browser.documentHandlers.visibilitychange();
  socket.onmessage({ data: mediaPacket(8000) });
  browser.FakeVideoDecoder.latest.emit();
  browser.documentState.hidden = false;
  browser.documentHandlers.visibilitychange();
  browser.setTime(1000);
  browser.tickIntervals();
  assert.equal(browser.element('stream-stats-bytes').textContent, 'Collecting');

  const leftover = [...browser.intervals.values()][0];
  socket.receive({ type: 'moved' });
  leftover?.fn();
  assert.equal(browser.element('stream-stats-bytes').textContent, '—');
  assert.equal(browser.intervals.size, 0);
});

function summarize(samples, pick) {
  const values = samples.map(pick);
  const ordered = [...values].sort((left, right) => left - right);
  return {
    median: ordered[Math.floor(ordered.length / 2)],
    min: ordered[0],
    max: ordered[ordered.length - 1],
  };
}

test('synthetic main/disabled/enabled overhead is a screening measurement only', async () => {
  const mainApp = execSync('git show origin/main:droiddock/public/app.js', { encoding: 'utf8' });
  const api = loadCollector();
  const packets = 400;
  const key = {
    key: 'a', isComposing: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };

  function runCollector(enabled) {
    let time = 0;
    const stats = api.createStreamStats({ now: () => time });
    const wall0 = process.hrtime.bigint();
    const cpu0 = process.cpuUsage();
    let drawn = 0;
    for (let i = 0; i < 10000; i++) {
      time = i;
      if (enabled) {
        stats.recordMediaBytes(1024, time);
        stats.recordDrawnFrame(time);
      }
      drawn += 1;
    }
    const cpu = process.cpuUsage(cpu0);
    return {
      wallMs: nsToMs(process.hrtime.bigint() - wall0),
      cpuMs: (cpu.user + cpu.system) / 1000,
      drawn,
      buckets: Number(stats.capacity().buckets),
      bytes: Number(stats.capacity().bytes),
    };
  }

  async function runBrowser(kind) {
    const browser = kind === 'main' ? loadBrowser({ appSource: mainApp }) : loadBrowser();
    const socket = deliverSyntheticFrame(browser, await startConnect(browser));
    if (kind === 'enabled') {
      enableStats(browser);
      openDetails(browser);
    }
    const writes = countTextWrites(browser.element('stream-stats-bytes'));
    const drawsBefore = browser.element('screen').drawCount;
    const wall0 = process.hrtime.bigint();
    const cpu0 = process.cpuUsage();
    let handlerNs = 0n;
    for (let i = 0; i < packets; i++) {
      socket.onmessage({ data: mediaPacket(1024) });
      browser.FakeVideoDecoder.latest.emit();
      if (i % 2 === 0) {
        const input0 = process.hrtime.bigint();
        browser.element('screen').handlers.keydown(key);
        handlerNs += process.hrtime.bigint() - input0;
      }
    }
    const cpu = process.cpuUsage(cpu0);
    return {
      wallMs: nsToMs(process.hrtime.bigint() - wall0),
      cpuMs: (cpu.user + cpu.system) / 1000,
      handlerMs: nsToMs(handlerNs),
      draws: browser.element('screen').drawCount - drawsBefore,
      sent: socket.sent.filter((item) => item.type === 'text').length,
      statsWrites: writes(),
    };
  }

  for (let i = 0; i < 4; i++) {
    runCollector(false);
    runCollector(true);
    await runBrowser('main');
    await runBrowser('disabled');
    await runBrowser('enabled');
  }

  const collectorOff = [];
  const collectorOn = [];
  const mainSamples = [];
  const disabledSamples = [];
  const enabledSamples = [];
  const order = ['main', 'enabled', 'disabled', 'disabled', 'main', 'enabled', 'main', 'disabled', 'enabled'];
  for (const kind of order) {
    if (kind === 'main') mainSamples.push(await runBrowser(kind));
    if (kind === 'disabled') disabledSamples.push(await runBrowser(kind));
    if (kind === 'enabled') enabledSamples.push(await runBrowser(kind));
    collectorOff.push(runCollector(false));
    collectorOn.push(runCollector(true));
  }

  for (const sample of [...mainSamples, ...disabledSamples, ...enabledSamples]) {
    assert.equal(sample.draws, packets);
    assert.equal(sample.sent, packets / 2);
  }
  for (const sample of disabledSamples) assert.equal(sample.statsWrites, 0);
  const lastOn = collectorOn.at(-1);
  assert.equal(lastOn.drawn, 10000);
  assert.equal(lastOn.buckets, 2);
  assert.equal(lastOn.bytes, 1);

  const report = {
    environment: 'node-vm-synthetic',
    notChrome: true,
    notLivePhone: true,
    notEndToEndLatency: true,
    retention: 'unverified-by-heapUsed; constant-space counters only',
    collector: {
      disabled: summarize(collectorOff, (sample) => sample.cpuMs),
      enabled: summarize(collectorOn, (sample) => sample.cpuMs),
      disabledWall: summarize(collectorOff, (sample) => sample.wallMs),
      enabledWall: summarize(collectorOn, (sample) => sample.wallMs),
    },
    browser: {
      main: summarize(mainSamples, (sample) => sample.cpuMs),
      disabled: summarize(disabledSamples, (sample) => sample.cpuMs),
      enabled: summarize(enabledSamples, (sample) => sample.cpuMs),
      mainWall: summarize(mainSamples, (sample) => sample.wallMs),
      disabledWall: summarize(disabledSamples, (sample) => sample.wallMs),
      enabledWall: summarize(enabledSamples, (sample) => sample.wallMs),
      handlerMain: summarize(mainSamples, (sample) => sample.handlerMs),
      handlerDisabled: summarize(disabledSamples, (sample) => sample.handlerMs),
      handlerEnabled: summarize(enabledSamples, (sample) => sample.handlerMs),
    },
  };
  console.log(JSON.stringify(report));

  const extraCpu = report.collector.enabled.median - report.collector.disabled.median;
  const extraWall = report.collector.enabled.median - report.collector.disabled.median;
  assert.ok(extraCpu <= Math.max(report.collector.disabled.median * 0.1, 2) || extraWall <= 2, `collector extra cpu ${extraCpu}`);
  assert.equal(mainSamples[0].draws, enabledSamples[0].draws);
});
