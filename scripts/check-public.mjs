import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const brandEmail = 'hooware-ai@users.noreply.github.com';
const vendor = 'droiddock/vendor/scrcpy-4.1/';
const pinned = new Map([
  [vendor + 'scrcpy-server', 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae'],
  [vendor + 'LICENSE', '01c12035bf35af37241298dc7ad538eb2a07e5c940437bc6876feeaa9d1951d0'],
  ['android/paste-helper/gradle/wrapper/gradle-wrapper.jar', '497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7'],
]);
const rootFiles = new Set(['.gitattributes', '.gitignore', 'AGENTS.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'config.example.json']);
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function git(cwd, args, { optional = false } = {}) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd, encoding: null, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error('git-operation-failed'); // Git stderr can contain private paths or identity.
  }
  return result.stdout;
}

function privatePatterns(cwd, env) {
  const patterns = [];
  try {
    if (env.DROIDDOCK_PUBLIC_DENY_JSON) patterns.push(...JSON.parse(env.DROIDDOCK_PUBLIC_DENY_JSON));
    if (env.DROIDDOCK_PUBLIC_DENY_FILE) {
      const file = env.DROIDDOCK_PUBLIC_DENY_FILE;
      const rel = relative(realpathSync(cwd), realpathSync(file));
      if (!isAbsolute(file) || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error();
      patterns.push(...JSON.parse(readFileSync(file, 'utf8')));
    }
    if (patterns.some(value => typeof value !== 'string' || value.length < 3)) throw new Error();
  } catch { throw new Error('invalid-private-deny-configuration'); }
  return patterns.map(value => value.toLowerCase());
}

function allowedPath(path) {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(path) || path.split('/').some(part => part === '..' || part === '.')) return false;
  if (rootFiles.has(path) || pinned.has(path) || path === vendor + 'upstream.json') return true;
  if (/(?:^|\/)(?:node_modules|dist|artifacts|logs|screenshots|\.setup|\.vscode|\.idea|\.env[^/]*)(?:\/|$)/i.test(path)) return false;
  if (/(?:^|\/)(?:config\.local|credentials?|secrets?|id_rsa|id_ed25519)(?:[./]|$)|\.(?:log|pem|key|pfx|p12|png|jpe?g|webp|gif|zip|map)$/i.test(path)) return false;
  return /^(?:src\/.*\.ts|scripts\/[^/]+\.(?:mjs|ps1)|droiddock\/tests\/[^/]+\.test\.mjs|droiddock\/public\/[^/]+\.(?:html|css|js)|docs\/.*\.md|android\/paste-helper\/(?:gradlew(?:\.bat)?|(?:build|settings)\.gradle\.kts|gradle\/wrapper\/gradle-wrapper\.properties|(?:src|test-target\/src)\/main\/(?:AndroidManifest\.xml|java\/ai\/hooware\/droiddock\/(?:paste|pastetest)\/[A-Za-z]+\.java)|test-target\/build\.gradle\.kts)|\.github\/(?:workflows\/[^/]+\.ya?ml|ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml)|(?:PULL_REQUEST_TEMPLATE|pull_request_template)\.md|(?:FUNDING|dependabot)\.yml))$/.test(path);
}

function textRules(text, deny, { attribution = false } = {}) {
  const rules = [];
  if (deny.some(value => text.toLowerCase().includes(value))) rules.push('private-deny-pattern');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{35})\b/.test(text)) rules.push('credential-pattern');
  if (/\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["'][^"'\s]{12,}["']/i.test(text)) rules.push('credential-assignment');
  // Placeholder paths use <user>, ${USER}, or %USERNAME%, never concrete home names.
  if (/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/home\/|\/Users\/)(?!<|\$|%)[A-Za-z0-9_. -]+/.test(text)) rules.push('personal-home-path');
  if (!attribution) {
    const emails = text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi) ?? [];
    if (emails.some(email => {
      const lower = email.toLowerCase().replace(/^['`]+/, '');
      const domain = lower.split('@').at(-1);
      return lower !== brandEmail && !/^(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org|test)|invalid|test)$/.test(domain);
    })) rules.push('personal-email');
  }
  return rules;
}

export function entries(cwd, revision) {
  const raw = git(cwd, revision ? ['ls-tree', '-rz', '--full-tree', revision] : ['ls-files', '--stage', '-z']).toString('utf8');
  return raw.split('\0').filter(Boolean).map(record => {
    const split = record.indexOf('\t');
    const [mode, middle, last] = record.slice(0, split).split(' ');
    return { mode, oid: revision ? last : middle, stage: revision ? '0' : last, path: record.slice(split + 1) };
  });
}

export function checkPublic({ cwd = process.cwd(), initialRelease = false, canonicalRemotes = false, env = process.env } = {}) {
  cwd = resolve(cwd);
  const deny = privatePatterns(cwd, env);
  const findings = [];
  const add = (path, rule) => findings.push({ path, rule });
  const checked = new Set();
  if (git(cwd, ['rev-parse', '--is-shallow-repository']).toString('utf8').trim() !== 'false') add('[history]', 'full-history-required');
  function scan(entry) {
    const { path, oid, mode, stage } = entry;
    // Do not echo a denied identity embedded in a filename.
    const pathRules = textRules(path, deny);
    const label = pathRules.length ? '[redacted-path]' : path;
    for (const rule of pathRules) add(label, rule);
    if (!allowedPath(path)) add(label, 'release-path-not-allowed');
    if (stage !== '0') add(label, 'unmerged-index-entry');
    if (!['100644', '100755'].includes(mode)) { add(label, 'non-regular-file'); return; }
    const key = path + ':' + oid;
    if (checked.has(key)) return;
    checked.add(key);
    const data = git(cwd, ['cat-file', 'blob', oid]);
    if (pinned.has(path)) {
      if (sha256(data) !== pinned.get(path)) add(label, 'pinned-vendor-hash');
      return;
    }
    if (data.includes(0)) { add(label, 'unexpected-binary'); return; }
    const text = data.toString('utf8');
    for (const rule of textRules(text, deny)) add(label, rule);
    if (path.endsWith('.gitattributes') && /\bexport-(?:ignore|subst)\b/.test(text)) add(label, 'archive-content-transform');
  }
  const index = entries(cwd);
  if (!index.length) add('[index]', 'empty-index');
  index.forEach(scan);
  const revisions = git(cwd, ['rev-list', '--all']).toString('utf8').trim().split('\n').filter(Boolean);
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD'], { optional: true })?.toString('utf8').trim();
  if (head && !revisions.includes(head)) revisions.push(head);
  if (initialRelease && (revisions.length !== 1 || !head)) add('[history]', 'initial-release-requires-single-commit');
  for (const revision of revisions) {
    entries(cwd, revision).forEach(scan);
    const metadata = git(cwd, ['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', revision]).toString('utf8');
    for (const rule of textRules(metadata, deny, { attribution: true })) add('[history]', rule);
    if (initialRelease) {
      const [author, email, committer, committerEmail] = metadata.split('\0');
      if (author !== 'Hooware' || committer !== 'Hooware' || email !== brandEmail || committerEmail !== brandEmail) add('[history]', 'initial-release-brand-identity');
      for (const rule of textRules(metadata.split('\0').slice(4).join('\0'), deny)) add('[history]', rule);
    }
  }
  const refs = git(cwd, ['for-each-ref', '--format=%(refname)%00%(objecttype)%00%(taggername)%00%(taggeremail)%00%(contents)%00END']).toString('utf8');
  for (const rule of textRules(refs, deny, { attribution: true })) add('[references]', rule);
  if (initialRelease) {
    for (const ref of refs.split('\0END\n').filter(Boolean)) {
      const [, type, tagger, email] = ref.split('\0');
      if (type === 'tag' && (tagger !== 'Hooware' || email !== `<${brandEmail}>`)) add('[references]', 'initial-release-brand-identity');
    }
  }
  for (const remote of git(cwd, ['remote']).toString('utf8').trim().split('\n').filter(Boolean)) {
    const urls = git(cwd, ['remote', 'get-url', '--all', remote]).toString('utf8').trim().split('\n');
    const pushUrls = git(cwd, ['remote', 'get-url', '--push', '--all', remote]).toString('utf8').trim().split('\n');
    const rawUrls = git(cwd, ['config', '--get-all', `remote.${remote}.url`]).toString('utf8').trim().split('\n');
    const rawPush = git(cwd, ['config', '--get-all', `remote.${remote}.pushurl`], { optional: true });
    const allUrls = [...urls, ...pushUrls, ...rawUrls, ...(rawPush ? rawPush.toString('utf8').trim().split('\n') : [])];
    for (const rule of textRules([remote, ...allUrls].join('\n'), deny, { attribution: true })) add('[remotes]', rule);
    const canonical = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)hooware-ai\/droiddock(?:\.git)?$/;
    // A normal contribution checkout may use a fork. No URL credentials, ports,
    // query strings, fragments, local paths, or non-GitHub hosts are accepted.
    const fork = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
    const permitted = initialRelease || canonicalRemotes ? canonical : fork;
    if (allUrls.some(url => !permitted.test(url))) add('[remotes]', 'unexpected-public-remote');
  }
  return { ok: findings.length === 0, findings: [...new Map(findings.map(item => [JSON.stringify(item), item])).values()], files: index.length, commits: revisions.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--initial-release')) throw new Error('unknown-option');
    const result = checkPublic({ initialRelease: process.argv.includes('--initial-release') });
    for (const item of result.findings) console.error(`${JSON.stringify(item.path)}: ${item.rule}`);
    if (result.ok) console.log(`Public check passed: ${result.files} indexed files, ${result.commits} commits.`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
