import test from 'node:test';
import assert from 'node:assert/strict';
import { LockStateMonitor, parseLockState } from '../../dist/droiddock/lock-state.js';
import { runCommand } from '../../dist/process.js';

const dump = (overrides = {}) => `WINDOW MANAGER POLICY STATE\n  KeyguardServiceDelegate\n${Object.entries({
  showing: 'true', occluded: 'false', screenState: 'SCREEN_STATE_ON', interactiveState: 'INTERACTIVE_STATE_AWAKE', ...overrides,
}).map(([key, value]) => `    ${key}=${value}`).join('\n')}\n  OtherPolicy\n    showing=false\n`;

test('only a complete, unambiguous supported keyguard section yields lock evidence', () => {
  assert.equal(parseLockState(dump()), 'locked-awake');
  assert.equal(parseLockState(dump({ showing: 'false' })), 'unlocked');
  assert.equal(parseLockState(dump({ occluded: 'true' })), 'other');
  assert.equal(parseLockState(dump({ screenState: 'SCREEN_STATE_OFF', interactiveState: 'INTERACTIVE_STATE_SLEEP' })), 'other');
  for (const screenState of ['SCREEN_STATE_TURNING_ON', 'SCREEN_STATE_TURNING_OFF']) {
    assert.equal(parseLockState(dump({ screenState })), 'other');
  }
  for (const interactiveState of ['INTERACTIVE_STATE_WAKING', 'INTERACTIVE_STATE_GOING_TO_SLEEP']) {
    assert.equal(parseLockState(dump({ interactiveState })), 'other');
  }
  for (const output of [
    '', 'showing=true\noccluded=false\nscreenState=SCREEN_STATE_ON\ninteractiveState=INTERACTIVE_STATE_AWAKE',
    dump().replace('    occluded=false\n', ''), dump({ showing: 'maybe' }), dump({ screenState: '2' }),
    dump({ interactiveState: 'AWAKE' }), dump() + dump(),
    dump({ screenState: 'SCREEN_STATE_OFF' }), dump({ interactiveState: 'INTERACTIVE_STATE_SLEEP' }),
    'mKeyguardOccluded=true\n' + dump(), 'mKeyguardOccluded=unknown\n' + dump(),
    'mKeyguardOccluded=false\nmKeyguardOccluded=false\n' + dump(),
    dump().replace('    showing=true', '    showing=true\n    showing=false'),
    dump().replace('    showing=true', '    showing=true\n    showing=true'),
    dump().replace('    showing=true', '    showing = true'),
    dump().replace('    showing=true', '  showing=true'),
    dump().replace('    showing=true', '    showing=true false'),
    'x'.repeat(65536) + dump(),
  ]) assert.equal(parseLockState(output), 'unknown', output.slice(0, 150));
  assert.equal(parseLockState(dump().replace('KeyguardServiceDelegate', 'KeyguardServiceDelegate:')), 'locked-awake');
  assert.equal(parseLockState(dump().replaceAll('\n', '\r\n')), 'locked-awake');
  assert.equal(parseLockState('  mKeyguardOccluded=false mKeyguardOccludedChanged=false\n' + dump()), 'locked-awake');
});

function fixture(reader = async () => 'locked-awake') {
  let now = 0, nextId = 0;
  const jobs = new Map(), updates = [];
  const clock = {
    now: () => now,
    schedule: (callback, ms) => { const id = ++nextId; jobs.set(id, { at: now + ms, callback }); return id; },
    cancel: id => jobs.delete(id),
  };
  const monitor = new LockStateMonitor(update => updates.push(update), clock);
  async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  async function advance(ms = 0) {
    const end = now + ms;
    while (true) {
      const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; jobs.delete(next[0]); next[1].callback(); await flush();
    }
    now = end; await flush();
  }
  return { monitor, updates, advance, flush, jobs, reader, now: () => now };
}

test('sampling is opt-in, connected and visible; starts immediately and emits only changes', async () => {
  let calls = 0, result = 'locked-awake';
  const f = fixture();
  f.monitor.connected(async () => { calls++; return result; });
  await f.advance(20000); assert.equal(calls, 0);
  f.monitor.subscribe(true, false); await f.advance(20000); assert.equal(calls, 0);
  f.monitor.subscribe(true, true); await f.advance(); assert.equal(calls, 1);
  assert.deepEqual(f.updates, [
    { type: 'lockState', state: 'unknown', suspended: false },
    { type: 'lockState', state: 'locked-awake', suspended: false },
  ]);
  await f.advance(1999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2); assert.equal(f.updates.length, 2);
  result = 'unlocked'; await f.advance(2000); assert.equal(f.updates.at(-1).state, 'unlocked');
  f.monitor.subscribe(false, true); await f.advance(20000); assert.equal(calls, 3);
  assert.equal(f.updates.at(-1).state, 'unknown');
});

test('failures back off ten seconds and suspend after three; visibility cannot reset them', async () => {
  let calls = 0;
  const f = fixture();
  f.monitor.connected(async () => { calls++; if (calls === 2) throw new Error('SYNTHETIC_PRIVATE'); return 'unknown'; });
  f.monitor.subscribe(true, true); await f.advance(); assert.equal(calls, 1);
  f.monitor.subscribe(true, false); f.monitor.subscribe(true, true);
  await f.advance(9999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2);
  f.monitor.subscribe(true, false); f.monitor.subscribe(true, true);
  await f.advance(10000); assert.equal(calls, 3);
  assert.deepEqual(f.updates.at(-1), { type: 'lockState', state: 'unknown', suspended: true });
  f.monitor.subscribe(true, false); f.monitor.subscribe(true, true);
  await f.advance(100000); assert.equal(calls, 3); assert.equal(f.updates.at(-1).suspended, true);
  f.monitor.subscribe(false, true); f.monitor.subscribe(true, true);
  await f.advance(); assert.equal(calls, 4); assert.equal(f.updates.at(-1).suspended, false);
  assert.doesNotMatch(JSON.stringify(f.updates), /SYNTHETIC_PRIVATE/);
});

test('a successful sample resets consecutive failures; reconnect releases suspension', async () => {
  let calls = 0;
  const f = fixture();
  f.monitor.connected(async () => ++calls === 3 ? 'unlocked' : 'unknown');
  f.monitor.subscribe(true, true);
  await f.advance(20000); assert.equal(calls, 3); assert.equal(f.updates.at(-1).state, 'unlocked');
  await f.advance(22000); assert.equal(calls, 6); assert.equal(f.updates.at(-1).suspended, true);
  f.monitor.connected();
  f.monitor.connected(async () => { calls++; return 'locked-awake'; });
  await f.advance(2000); assert.equal(calls, 7); assert.equal(f.updates.at(-1).suspended, false);
});

test('hide, disable, disconnect and ownership reset abort and reject stale samples without overlap', async () => {
  for (const change of ['hide', 'disable', 'disconnect', 'handoff']) {
    const f = fixture();
    const pending = [];
    const reader = signal => new Promise(resolve => pending.push({ resolve, signal }));
    f.monitor.connected(reader); f.monitor.subscribe(true, true); await f.advance();
    assert.equal(pending.length, 1);
    if (change === 'hide') { f.monitor.subscribe(true, false); f.monitor.subscribe(true, true); }
    if (change === 'disable') { f.monitor.subscribe(false, true); f.monitor.subscribe(true, true); }
    if (change === 'disconnect') { f.monitor.connected(); f.monitor.connected(reader); }
    if (change === 'handoff') { f.monitor.reset(); f.monitor.connected(reader); f.monitor.subscribe(true, true); }
    assert.equal(pending[0].signal.aborted, true, change);
    await f.advance(20000); assert.equal(pending.length, 1, `${change}: no overlapping read`);
    pending[0].resolve('locked-awake'); await f.flush();
    assert.equal(f.updates.some(update => update.state === 'locked-awake'), false, `${change}: stale result rejected`);
    await f.advance(); assert.equal(pending.length, 2);
    pending[1].resolve('unlocked'); await f.flush();
    assert.equal(f.updates.at(-1).state, 'unlocked');
    f.monitor.reset();
  }
});

test('preference and visibility churn cannot accelerate the two second cadence', async () => {
  let calls = 0;
  const f = fixture();
  f.monitor.connected(async () => { calls++; return 'locked-awake'; });
  f.monitor.subscribe(true, true); await f.advance();
  for (let i = 0; i < 10; i++) {
    f.monitor.subscribe(false, false); f.monitor.subscribe(true, true); await f.advance(100);
  }
  assert.equal(calls, 1);
  await f.advance(1000); assert.equal(calls, 2);
  f.monitor.reset(); await f.advance(20000); assert.equal(calls, 2);
});

test('cancelled commands remain bounded and do not expose command content', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const command = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'SYNTHETIC_PRIVATE'], { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(command, error => {
    assert.match(error.message, /cancelled/); assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/); return true;
  });
  assert.ok(Date.now() - start < 2000);
  await assert.rejects(runCommand('SYNTHETIC_PRIVATE_MISSING', [], { signal: controller.signal }), /cancelled/);
});

test('lock sampling command bounds reject timeout and combined output over 64 KiB', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 1000, maxOutputBytes: 64 * 1024 }), /timed out/);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(40000));process.stderr.write("y".repeat(40000))'], { timeoutMs: 1000, maxOutputBytes: 64 * 1024 }), /too much output/);
});
