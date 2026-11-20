import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, lstatSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import YAML from 'yaml';

const policy = 'SECURITY.md';
const source = 'config/review/security-common.md';
const answers = '.copier-answers.yml';
const begin = '<!-- BEGIN SPLRAD COMMON SECURITY -->';
const end = '<!-- END SPLRAD COMMON SECURITY -->';
const releaseTag = /^v?\d+(?:\.\d+)+$/;
export const securityPolicyController = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function requirePolicy(ok, reason) {
  if (!ok) throw new Error('SECURITY_POLICY_' + reason);
}

function git(repo, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=', ...args], {cwd:repo, windowsHide:true});
}

function blob(repo, sha, path) {
  const entry = git(repo, 'ls-tree', '-z', sha, '--', path).toString();
  if (!entry) return null;
  requirePolicy(entry.startsWith('100644 blob '), 'FILE_MODE');
  return git(repo, 'cat-file', 'blob', sha + ':' + path);
}

function common(repo, sha) {
  const value = blob(repo, sha, source);
  if (value) checkCommon(value);
  return value;
}

function checkCommon(bytes) {
  const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
  requirePolicy(text.startsWith('## 组织公共规则\n') && text.endsWith('\n') && !text.endsWith('\n\n')
    && !text.includes('\r') && !text.includes(begin) && !text.includes(end), 'COMMON_FORMAT');
}

// latin1 preserves byte offsets, including for UTF-8 text before either marker.
export function sections(bytes) {
  const text = bytes.toString('latin1');
  const markers = marker => [...text.matchAll(new RegExp('^' + marker + '\\r?(?:\\n|$)', 'gm'))];
  const starts = markers(begin), ends = markers(end);
  requirePolicy(starts.length === 1 && ends.length === 1 && starts[0].index < ends[0].index, 'MARKERS');
  const left = starts[0].index + starts[0][0].length, right = ends[0].index;
  return [bytes.subarray(0,left), bytes.subarray(left,right), bytes.subarray(right)];
}

function initial(body) {
  return Buffer.concat([Buffer.from('# 安全政策\n\n' + begin + '\n'), body, Buffer.from(end + '\n\n## 项目特有规则\n')]);
}

export function updated(current, previous, next) {
  if (!current) {
    requirePolicy(!previous, 'ADOPTED_FILE_MISSING');
    return initial(next);
  }
  const [prefix, body, suffix] = sections(current);
  requirePolicy(body.equals(next) || previous && body.equals(previous), 'COMMON_EDITED');
  return Buffer.concat([prefix, next, suffix]);
}

function adopted(target, revision, trusted, trustedHead) {
  const data = blob(target, revision, answers);
  if (!data) return null;
  const value = YAML.parse(data.toString('utf8'));
  if (value?._src_path !== 'https://github.com/splrad/steward.git') return null;
  requirePolicy(typeof value._commit === 'string' && /^v?\d[0-9a-z.!+_-]*$/i.test(value._commit), 'ANSWERS');
  const sha = git(trusted, 'rev-parse', '--verify', 'refs/tags/' + value._commit + '^{commit}').toString().trim();
  git(trusted, 'merge-base', '--is-ancestor', sha, trustedHead);
  return common(trusted, sha);
}

// Policy-only PRs leave the whole-repository Copier answers at their real version.
// The block itself identifies its exact bytes. Verify them against a reachable
// release tag of the trusted controller; the adoption PR records the selected tag.
function marked(bytes) {
  return bytes && (bytes.includes(begin) || bytes.includes(end));
}

function released(body, trusted, ceiling) {
  const tags = git(trusted,'tag','--merged',ceiling,'--sort=-version:refname').toString().trim().split('\n');
  for (const tag of tags) {
    if (!releaseTag.test(tag)) continue;
    const ref = 'refs/tags/'+tag+'^{commit}';
    if (blob(trusted,ref,source)?.equals(body) && blob(trusted,ref,'copier.yml')) {
      checkCommon(body);
      return ref;
    }
  }
  return null;
}

// The merged HEAD is the immutable input, even when Copier already updated answers on disk.
export function prepare(target, trusted, templateSha, trustedHead) {
  git(trusted, 'merge-base', '--is-ancestor', templateSha, trustedHead);
  const next = common(trusted, templateSha);
  const previous = adopted(target, 'HEAD', trusted, trustedHead);
  requirePolicy(!previous || next, 'SOURCE_REMOVED');
  if (!next) return '';
  const tags = git(trusted, 'tag', '--points-at', templateSha).toString().trim().split('\n');
  requirePolicy(tags.some(tag => releaseTag.test(tag)) && blob(trusted, templateSha, 'copier.yml'),
    'RELEASE_TAG_REQUIRED');
  const current = blob(target, 'HEAD', policy);
  const path = join(target, policy);
  requirePolicy(!git(target, 'status', '--porcelain=v1', '--untracked-files=all', '--', policy).length,
    'WORKTREE_DIRTY');
  const info = lstatSync(path, {throwIfNoEntry:false});
  requirePolicy(current ? info?.isFile() : !info, 'WORKTREE_TYPE');
  requirePolicy(!blob(target,'HEAD','.github/SECURITY.md') && (current || !blob(target,'HEAD','docs/SECURITY.md')),
    'EXISTING_POLICY_REQUIRES_MIGRATION');
  let accepted = previous;
  if (marked(current)) {
    const body = sections(current)[1];
    if (!body.equals(next)) {
      requirePolicy(released(body, trusted, templateSha), 'POLICY_DOWNGRADE_OR_DRIFT');
      accepted = body;
    }
  }
  const expected = updated(current, accepted, next);
  if (!current?.equals(expected)) writeFileSync(path, expected);
  return hash(expected);
}

export function verify(target, base, head, trusted, trustedHead, sync, central) {
  const previous = adopted(target, base, trusted, trustedHead);
  const next = adopted(target, head, trusted, trustedHead);
  requirePolicy(!previous || next, 'ADOPTION_REMOVED');
  // Central periodically reviews its source and its own rendered copy together before a tag exists.
  const proposed = central ? common(target, head) : null;
  if (central && common(target,base)) requirePolicy(proposed, 'CENTRAL_SOURCE_REMOVED');
  const expected = next ?? proposed;
  const before = blob(target,base,policy);
  const after = blob(target,head,policy);
  if (!expected && !marked(before) && !marked(after)) return;
  requirePolicy(!blob(target,head,'.github/SECURITY.md'), 'SHADOWED');
  requirePolicy(after, 'FILE_MISSING');
  const [prefix, body, suffix] = sections(after);
  const old = marked(before) ? sections(before) : null;
  // Independently adopted policy remains governed when answers refer to a
  // legacy template or to a different set of managed repository files.
  const separate = !expected?.equals(body);
  const changed = old && !old[1].equals(body);
  const candidateSource = central && proposed?.equals(body) && !next;
  if (separate || changed && !candidateSource) {
    const ref = released(body,trusted,trustedHead);
    requirePolicy(ref, 'COMMON_MISMATCH');
    if (separate && next) requirePolicy(released(next,trusted,ref), 'POLICY_BEFORE_COPIER_VERSION');
    if (changed) requirePolicy(released(old[1],trusted,ref), 'POLICY_DOWNGRADE_OR_DRIFT');
  }
  if (sync || changed || next && !previous?.equals(next) || !old && separate) {
    if (old) {
      requirePolicy(prefix.equals(old[0]) && suffix.equals(old[2]), 'OUTSIDE_CHANGED');
    } else if (!before) {
      requirePolicy(!previous && after.equals(initial(body)), 'INITIAL_CONTENT');
    } else {
      // Existing unmarked prose requires a human-reviewed migration. A
      // managed synchronization may never decide how to divide legacy text.
      requirePolicy(!sync && !previous, 'EXISTING_POLICY_REQUIRES_MIGRATION');
    }
  }
}

export function verifyLocalSource(target) {
  const expected = readFileSync(join(target,source));
  checkCommon(expected);
  const body = sections(readFileSync(join(target,policy)))[1];
  // A future source can be reviewed before the central repository adopts its new tag.
  if (!body.equals(expected)) {
    const previous = adopted(target,'HEAD',target,'HEAD');
    requirePolicy(previous?.equals(body) || released(body,target,'HEAD'), 'SOURCE_MISMATCH');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, target, ...args] = process.argv.slice(2);
    if (mode === 'prepare') process.stdout.write(prepare(target,...args));
    else if (mode === 'source') verifyLocalSource(target);
    else throw Error('unknown security policy operation');
  } catch (error) {
    const code = /^SECURITY_POLICY_[A-Z_]+$/.test(error.message) ? error.message : 'SECURITY_POLICY_CHECK_FAILED';
    console.error(code);
    process.exitCode = 1;
  }
}
