import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPublic, git, sha256 } from '../../scripts/check-public.mjs';
import { packageRelease, readStoredZip } from '../../scripts/package-release.mjs';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'droiddock-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Hooware']);
  git(cwd, ['config', 'user.email', 'hooware-ai@users.noreply.github.com']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, '.gitignore'), 'artifacts/\nconfig.local.json\n');
  writeFileSync(join(cwd, 'README.md'), '# Public source\n');
  writeFileSync(join(cwd, 'package.json'), '{"name":"droiddock","version":"1.2.3"}\n');
  git(cwd, ['add', '.']);
  return cwd;
}
function commit(cwd) { git(cwd, ['commit', '-m', 'Public release']); }
function stage(cwd, path, content) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), content);
  git(cwd, ['add', '-f', '--', path]);
}
const rules = result => result.findings.map(item => item.rule);
const isolated = { DROIDDOCK_PUBLIC_DENY_JSON: '', DROIDDOCK_PUBLIC_DENY_FILE: '' };
const check = (cwd, options = {}) => checkPublic({ cwd, env: isolated, ...options });
const pack = (cwd, options = {}) => packageRelease({ cwd, env: isolated, ...options });

test('privacy reads the exact index rather than unstaged worktree text', t => {
  const cwd = repository(t);
  const secret = ['ghp', '_', 'A'.repeat(36)].join('');
  writeFileSync(join(cwd, 'README.md'), secret);
  assert.equal(check(cwd).ok, true);
  git(cwd, ['add', 'README.md']);
  writeFileSync(join(cwd, 'README.md'), '# Sanitized only in the worktree\n');
  assert.ok(rules(check(cwd)).includes('credential-pattern'));
  assert.ok(!JSON.stringify(check(cwd)).includes(secret));
});

test('original files reject personal email and home paths, accept documented placeholders', t => {
  const cwd = repository(t);
  for (const value of [
    ['person', '@', 'mailbox', '.', 'dev'].join(''),
    ['C:', '\\', 'Users', '\\', 'Example Person', '\\', 'Desktop'].join(''),
    ['/', 'home', '/', 'example-person', '/', 'work'].join(''),
  ]) {
    stage(cwd, 'README.md', value);
    assert.equal(check(cwd).ok, false);
    assert.ok(!JSON.stringify(check(cwd)).includes(value));
  }
  stage(cwd, 'README.md', 'person@example.test person@example.com C:\\Users\\<user>\\work /home/<user>/work');
  assert.equal(check(cwd).ok, true);
});

test('private deny patterns cover names, handles, filenames, and commit metadata without echo', t => {
  const cwd = repository(t);
  const identity = 'Example Person';
  const env = { ...isolated, DROIDDOCK_PUBLIC_DENY_JSON: JSON.stringify([identity, 'private-handle']) };
  stage(cwd, 'README.md', identity);
  const result = check(cwd, { env });
  assert.ok(rules(result).includes('private-deny-pattern'));
  assert.ok(!JSON.stringify(result).includes(identity));
  stage(cwd, 'README.md', '# Public source');
  stage(cwd, 'docs/private-handle.md', '# Note');
  assert.ok(check(cwd, { env }).findings.some(item => item.path === '[redacted-path]'));
  git(cwd, ['rm', '-f', 'docs/private-handle.md']);
  git(cwd, ['config', 'user.name', identity]);
  commit(cwd);
  assert.equal(check(cwd).ok, true); // Ordinary PR mode allows contributor attribution.
  assert.ok(rules(check(cwd, { env })).includes('private-deny-pattern'));
  assert.ok(rules(check(cwd, { initialRelease: true })).includes('initial-release-brand-identity'));
});

test('external deny configuration must be outside checkout and valid', t => {
  const cwd = repository(t);
  const outside = mkdtempSync(join(tmpdir(), 'droiddock-deny-test-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const file = join(outside, 'deny.json');
  writeFileSync(file, JSON.stringify(['Example Person']));
  stage(cwd, 'README.md', 'Example Person');
  assert.ok(rules(check(cwd, { env: { ...isolated, DROIDDOCK_PUBLIC_DENY_FILE: file } })).includes('private-deny-pattern'));
  assert.throws(() => check(cwd, { env: { ...isolated, DROIDDOCK_PUBLIC_DENY_FILE: join(cwd, 'deny.json') } }), /invalid-private/);
  assert.throws(() => check(cwd, { env: { ...isolated, DROIDDOCK_PUBLIC_DENY_JSON: '{}' } }), /invalid-private/);
});

test('release path policy excludes runtime files, machine config, and unexpected binary', t => {
  const cwd = repository(t);
  for (const path of ['config.local.json', '.env', 'logs/run.log', 'docs/screenshot.png', 'dist/server.js', '.vscode/settings.json', 'scripts/secret.key']) {
    stage(cwd, path, 'private');
    assert.ok(check(cwd).findings.some(item => item.path === path && item.rule === 'release-path-not-allowed'));
    git(cwd, ['rm', '-f', '--', path]);
  }
  stage(cwd, 'docs/binary.md', Buffer.from([0, 1, 2]));
  assert.ok(rules(check(cwd)).includes('unexpected-binary'));
});

test('symlinks and submodules are rejected from index modes on every platform', t => {
  const cwd = repository(t);
  commit(cwd);
  const blob = git(cwd, ['rev-parse', 'HEAD:README.md']).toString().trim();
  git(cwd, ['update-index', '--add', '--cacheinfo', `120000,${blob},docs/link.md`]);
  const head = git(cwd, ['rev-parse', 'HEAD']).toString().trim();
  git(cwd, ['update-index', '--add', '--cacheinfo', `160000,${head},docs/module.md`]);
  assert.equal(check(cwd).findings.filter(item => item.rule === 'non-regular-file').length, 2);
});

test('history remains scanned after sensitive file is removed, and initial release requires one commit', t => {
  const cwd = repository(t);
  assert.ok(rules(check(cwd, { initialRelease: true })).includes('initial-release-requires-single-commit'));
  stage(cwd, 'docs/old.md', ['-----BEGIN ', 'PRIVATE KEY-----'].join(''));
  commit(cwd);
  git(cwd, ['rm', 'docs/old.md']);
  commit(cwd);
  assert.ok(rules(check(cwd)).includes('credential-pattern'));
  assert.ok(rules(check(cwd, { initialRelease: true })).includes('initial-release-requires-single-commit'));
});

test('brand-only initial commit passes; normal forks pass but publication remotes stay canonical', t => {
  const cwd = repository(t);
  commit(cwd);
  assert.equal(check(cwd, { initialRelease: true }).ok, true);
  git(cwd, ['remote', 'add', 'origin', 'https://github.com/hooware-ai/droiddock.git']);
  assert.equal(check(cwd).ok, true);
  git(cwd, ['remote', 'set-url', '--push', 'origin', 'https://github.com/example-person/private.git']);
  assert.equal(check(cwd).ok, true);
  assert.ok(rules(check(cwd, { initialRelease: true })).includes('unexpected-public-remote'));
  assert.throws(() => pack(cwd), /unexpected-public-remote/);
  assert.ok(!JSON.stringify(check(cwd)).includes('example-person'));
});

test('fork remotes accept supported GitHub transports and still honor private deny patterns', t => {
  const cwd = repository(t);
  git(cwd, ['remote', 'add', 'origin', 'https://github.com/example-contributor/droiddock.git']);
  for (const url of ['https://github.com/example-contributor/droiddock.git', ['git', '@', 'github.com:example-contributor/droiddock.git'].join(''), ['ssh://git', '@', 'github.com/example-contributor/renamed-fork'].join('')]) {
    git(cwd, ['remote', 'set-url', 'origin', url]);
    assert.equal(check(cwd).ok, true);
  }
  const env = { ...isolated, DROIDDOCK_PUBLIC_DENY_JSON: JSON.stringify(['example-contributor']) };
  const result = check(cwd, { env });
  assert.ok(rules(result).includes('private-deny-pattern'));
  assert.ok(!JSON.stringify(result).includes('example-contributor'));
});

test('remote policy rejects credentials and unsafe endpoints without disclosing their values', t => {
  const cwd = repository(t);
  git(cwd, ['remote', 'add', 'origin', 'https://github.com/hooware-ai/droiddock.git']);
  for (const url of [
    ['https://synthetic-token', '@', 'github.com/example-contributor/droiddock.git'].join(''),
    'http://github.com/example-contributor/droiddock.git',
    'https://github.com.invalid/example-contributor/droiddock.git',
    'https://github.com:443/example-contributor/droiddock.git',
    'https://github.com/example-contributor/droiddock.git?token=synthetic-token',
    'https://github.com/example-contributor/droiddock.git#fragment',
    '../other-checkout',
  ]) {
    git(cwd, ['remote', 'set-url', 'origin', url]);
    const result = check(cwd);
    assert.ok(rules(result).includes('unexpected-public-remote'));
    assert.ok(!JSON.stringify(result).includes(url));
  }
});

test('packaging selects committed HEAD, verifies source hashes, excludes ignored files, and is deterministic', t => {
  const cwd = repository(t);
  commit(cwd);
  writeFileSync(join(cwd, 'config.local.json'), 'private local state');
  const result = pack(cwd, { initialRelease: true });
  const directory = join(cwd, result.directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  const zip = readFileSync(join(directory, manifest.archive));
  assert.equal(manifest.commit, git(cwd, ['rev-parse', 'HEAD']).toString().trim());
  assert.deepEqual(manifest.files.map(file => file.path), ['.gitignore', 'README.md', 'package.json']);
  const archived = readStoredZip(zip);
  for (const file of manifest.files) {
    const data = archived.get(manifest.archive.slice(0, -4) + '/' + file.path);
    assert.equal(sha256(data), file.sha256);
  }
  assert.ok(readFileSync(join(directory, 'SHA256SUMS'), 'utf8').includes(sha256(zip)));
  assert.throws(() => pack(cwd), /already-exists/);
  rmSync(directory, { recursive: true });
  pack(cwd);
  assert.deepEqual(readFileSync(join(directory, manifest.archive)), zip);
  writeFileSync(join(cwd, 'README.md'), '# Uncommitted\n');
  assert.throws(() => pack(cwd), /clean-committed-head/);
  git(cwd, ['add', 'README.md']);
  assert.throws(() => pack(cwd), /clean-committed-head/);
  commit(cwd);
  const newer = pack(cwd);
  assert.notEqual(newer.commit, result.commit);
  const newerManifest = JSON.parse(readFileSync(join(cwd, newer.directory, 'manifest.json')));
  assert.equal(newerManifest.files.find(file => file.path === 'README.md').sha256, sha256(Buffer.from('# Uncommitted\n')));
  writeFileSync(join(cwd, 'untracked.md'), 'untracked');
  assert.throws(() => pack(cwd), /clean-committed-head/);
});

test('archive transformations cannot silently omit or rewrite committed sources', t => {
  const cwd = repository(t);
  commit(cwd);
  writeFileSync(join(cwd, '.git', 'info', 'attributes'), 'README.md export-ignore\n');
  assert.throws(() => pack(cwd), /archive-does-not-match/);
  writeFileSync(join(cwd, '.git', 'info', 'attributes'), '');
  stage(cwd, '.gitattributes', 'README.md export-subst\n');
  assert.ok(rules(check(cwd)).includes('archive-content-transform'));
});

test('annotated tags and ref names are checked without suppressing normal contributors', t => {
  const cwd = repository(t);
  commit(cwd);
  git(cwd, ['config', 'user.name', 'Example Person']);
  git(cwd, ['tag', '-a', 'v1.2.3', '-m', 'Public release']);
  assert.equal(check(cwd).ok, true);
  assert.ok(rules(check(cwd, { initialRelease: true })).includes('initial-release-brand-identity'));
  const env = { ...isolated, DROIDDOCK_PUBLIC_DENY_JSON: JSON.stringify(['Example Person']) };
  assert.ok(rules(check(cwd, { env })).includes('private-deny-pattern'));
});

test('pinned vendor content cannot be replaced with arbitrary binary or license text', t => {
  const cwd = repository(t);
  for (const file of ['LICENSE', 'scrcpy-server']) {
    stage(cwd, `droiddock/vendor/scrcpy-4.1/${file}`, 'replacement');
  }
  assert.equal(check(cwd).findings.filter(item => item.rule === 'pinned-vendor-hash').length, 2);
});

test('another branch changing a pinned binary does not fail unrelated checks, but its text is still privacy-scanned', t => {
  const cwd = repository(t);
  commit(cwd);
  const jar = 'android/paste-helper/gradle/wrapper/gradle-wrapper.jar';
  git(cwd, ['checkout', '-q', '-b', 'dependency-update']);
  stage(cwd, jar, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]));
  commit(cwd);
  git(cwd, ['checkout', '-q', 'main']);
  assert.equal(check(cwd).ok, true, 'a pending pinned-file update on another branch is that branch\'s check');
  git(cwd, ['checkout', '-q', 'dependency-update']);
  assert.ok(rules(check(cwd)).includes('pinned-vendor-hash'), 'the branch itself still fails its own check');
  git(cwd, ['checkout', '-q', '-b', 'text-replacement', 'main']);
  stage(cwd, 'droiddock/vendor/scrcpy-4.1/LICENSE', ['ghp', '_', 'B'.repeat(36)].join(''));
  commit(cwd);
  git(cwd, ['checkout', '-q', 'main']);
  const other = rules(check(cwd));
  assert.ok(!other.includes('pinned-vendor-hash'));
  assert.ok(other.includes('credential-pattern'), other.join(','));
});

test('a replaced pinned file in HEAD history still fails after it is removed from the index', t => {
  const cwd = repository(t);
  stage(cwd, 'droiddock/vendor/scrcpy-4.1/scrcpy-server', Buffer.from([0, 1, 2, 3]));
  commit(cwd);
  git(cwd, ['rm', '-q', '--', 'droiddock/vendor/scrcpy-4.1/scrcpy-server']);
  commit(cwd);
  assert.deepEqual(check(cwd).findings.filter(item => item.rule === 'pinned-vendor-hash').map(item => item.path), ['droiddock/vendor/scrcpy-4.1/scrcpy-server']);
});

test('an earlier reviewed pin is accepted in HEAD history but never in the index', t => {
  const cwd = repository(t);
  const path = 'android/paste-helper/gradle/wrapper/gradle-wrapper.jar';
  const older = Buffer.from([0, 9, 8, 7]), newer = Buffer.from([0, 1, 2, 3]);
  const pins = new Map([[path, sha256(newer)]]);
  const earlierPins = new Map([[path, [sha256(older)]]]);
  stage(cwd, path, older);
  commit(cwd);
  stage(cwd, path, newer);
  commit(cwd);
  assert.equal(check(cwd, { pins, earlierPins }).ok, true, 'an upgrade needs no history rewrite');
  assert.ok(rules(check(cwd, { pins })).includes('pinned-vendor-hash'), 'unlisted old bytes in history still fail');
  stage(cwd, path, older);
  assert.ok(rules(check(cwd, { pins, earlierPins })).includes('pinned-vendor-hash'), 'the index must match the current pin');
});

test('shallow history is rejected', t => {
  const cwd = repository(t);
  commit(cwd);
  const head = git(cwd, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(cwd, '.git', 'shallow'), head + '\n');
  assert.ok(rules(check(cwd, { initialRelease: true })).includes('full-history-required'));
});
