import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSourceIdentity, sourceFailure, sourceSha, type ReleaseSourceIdentity } from '../../core/src/release-notes-input.js';

export type GitReleaseBoundary = { kind: 'tag' | 'baseline'; sha: string; reference: string } | { kind: 'full-tree' };
export interface GitReleaseInputOptions {
  workspace: string;
  identity: ReleaseSourceIdentity;
  targetTag: string;
  boundary: GitReleaseBoundary;
  contextPaths?: readonly string[];
  limits?: { commits?: number; files?: number; objectBytes?: number; totalBytes?: number };
}
interface TreeEntry { mode: string; oid: string; path: string }
interface GitChange {
  status: string; path: string; previousPath: string | null;
  before: { mode: string; oid: string } | null;
  after: { mode: string; oid: string } | null;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array): string => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return sourceFailure('non-UTF-8 Git metadata or path'); }
};
const sorted = (values: readonly string[]) => [...values].sort();

/** Read immutable objects only. Never execute product scripts, diff drivers, filters or hooks.
 * PR associations are supplementary evidence and are deliberately not a prerequisite.
 * This snapshot is input evidence, not a publication approval or a generated user narrative.
 */
export function freezeReleaseGitInput(options: GitReleaseInputOptions) {
  const deadline = Date.now() + 5 * 60_000;
  const { identity, boundary, targetTag } = options;
  assertSourceIdentity(identity);
  const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stableTag.test(targetTag)) sourceFailure('target version');
  if (!['tag', 'baseline', 'full-tree'].includes(boundary.kind)) sourceFailure('boundary kind');
  if (boundary.kind !== 'full-tree') {
    sourceSha(boundary.sha);
    if (!boundary.reference || /[\x00-\x1f\x7f]/.test(boundary.reference)) sourceFailure('boundary reference');
    if (boundary.kind === 'tag') {
      if (!stableTag.test(boundary.reference)) sourceFailure('stable boundary tag');
      const a = targetTag.slice(1).split('.').map(BigInt), b = boundary.reference.slice(1).split('.').map(BigInt);
      const first = a.findIndex((value, index) => value !== b[index]);
      if (first < 0 || a[first]! < b[first]!) sourceFailure('target version must increase');
    }
  }
  const limits = { commits: 10_000, files: 20_000, objectBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 256 * 1024 * 1024) sourceFailure('Git input budget');
  const git = (...args: string[]): Buffer => {
    if (Date.now() > deadline) return sourceFailure('Git collection time budget');
    try {
      return execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'diff.renames=false', ...args], {
        cwd: resolve(options.workspace), windowsHide: true, timeout: 30_000, maxBuffer: Math.max(limits.totalBytes + 1, 1024 * 1024),
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return sourceFailure(`Git read failed: ${args[0]}`); }
  };
  const line = (...args: string[]) => decode(git(...args)).trim();
  if (line('rev-parse', '--is-shallow-repository') !== 'false') sourceFailure('shallow Git history');
  if (line('rev-parse', '--show-object-format') !== 'sha1') sourceFailure('unsupported Git object format');
  const grafts = resolve(options.workspace, line('rev-parse', '--git-path', 'info/grafts'));
  if (existsSync(grafts)) sourceFailure('grafted Git history');
  const commitId = (id: string) => {
    if (line('rev-parse', '--verify', `${id}^{commit}`) !== id) sourceFailure('Git commit identity');
  };
  commitId(identity.targetSha);
  if (boundary.kind !== 'full-tree') {
    commitId(boundary.sha);
    git('merge-base', '--is-ancestor', boundary.sha, identity.targetSha);
    if (boundary.kind === 'tag' && line('rev-parse', '--verify', `refs/tags/${boundary.reference}^{commit}`) !== boundary.sha) sourceFailure('boundary tag drift');
  }
  // An existing target tag must already name the frozen product, never candidate merge HEAD.
  const targetRefs = line('for-each-ref', '--format=%(refname)', `refs/tags/${targetTag}`);
  if (targetRefs && line('rev-parse', '--verify', `refs/tags/${targetTag}^{commit}`) !== identity.targetSha) sourceFailure('target tag drift');
  const range = boundary.kind === 'full-tree' ? [identity.targetSha] : [identity.targetSha, `^${boundary.sha}`];
  const ids = line('rev-list', ...range).split('\n').filter(Boolean);
  if (ids.length > limits.commits || new Set(ids).size !== ids.length) sourceFailure('Git commit coverage budget');
  const objects = new Map<string, { oid: string; type: 'commit' | 'blob'; size: number; sha256: string; rawBase64: string; encoding: 'utf8' | 'binary' }>();
  let totalBytes = 0;
  const readObject = (type: 'commit' | 'blob', oid: string) => {
    sourceSha(oid);
    const known = objects.get(oid);
    if (known) return Buffer.from(known.rawBase64, 'base64');
    const sizeText = line('cat-file', '-s', oid);
    if (!/^\d+$/.test(sizeText)) return sourceFailure('Git object size');
    const size = Number(sizeText);
    if (size > limits.objectBytes || totalBytes + size > limits.totalBytes) return sourceFailure('Git object coverage budget');
    const bytes = git('cat-file', type, oid);
    if (bytes.length !== size || createHash('sha1').update(`${type} ${size}\0`).update(bytes).digest('hex') !== oid) return sourceFailure('Git object integrity');
    totalBytes += size;
    let encoding: 'utf8' | 'binary' = 'utf8';
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (bytes.includes(0)) encoding = 'binary'; }
    catch { encoding = 'binary'; }
    objects.set(oid, { oid, type, size, sha256: hash(bytes), rawBase64: bytes.toString('base64'), encoding });
    return bytes;
  };
  const treeOf = (id: string) => sourceSha(line('rev-parse', '--verify', `${id}^{tree}`));
  const productTree = treeOf(identity.targetSha);
  const commits = sorted(ids).map(id => {
    sourceSha(id);
    const raw = readObject('commit', id);
    const separator = raw.indexOf('\n\n');
    if (separator < 0) return sourceFailure('Git commit headers');
    const header = decode(raw.subarray(0, separator)).split('\n');
    const tree = sourceSha(header.find(value => value.startsWith('tree '))?.slice(5));
    const parents = header.filter(value => value.startsWith('parent ')).map(value => sourceSha(value.slice(7)));
    return { sha: id, tree, parents, objectSha256: hash(raw) };
  });
  const treeEntries = (tree: string): TreeEntry[] => {
    const entries = decode(git('ls-tree', '-r', '-z', tree)).split('\0').filter(Boolean).map(value => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(value);
      if (!match) return sourceFailure('Git tree entry');
      return { mode: match[1]!, oid: match[3]!, path: match[4]! };
    });
    if (entries.length > limits.files) sourceFailure('Git tree coverage budget');
    return entries;
  };
  const targetEntries = treeEntries(productTree);
  const changes: GitChange[] = [];
  if (boundary.kind === 'full-tree') {
    changes.push(...targetEntries.map(entry => ({ status: 'A', path: entry.path, previousPath: null, before: null, after: { mode: entry.mode, oid: entry.oid } })));
  } else {
    const fields = decode(git('diff-tree', '-r', '--raw', '-z', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '-l0', boundary.sha, identity.targetSha)).split('\0');
    for (let index = 0; index < fields.length - 1;) {
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT]|R\d+)$/.exec(fields[index++]!);
      if (!match) return sourceFailure('Git net diff record');
      const oldPath = fields[index++];
      const renamed = match[5]!.startsWith('R');
      const path = renamed ? fields[index++] : oldPath;
      if (!oldPath || !path) return sourceFailure('Git net diff path');
      changes.push({ status: match[5]!, path, previousPath: renamed ? oldPath : null,
        before: match[1] === '000000' ? null : { mode: match[1]!, oid: match[3]! },
        after: match[2] === '000000' ? null : { mode: match[2]!, oid: match[4]! } });
    }
  }
  if (changes.length > limits.files) sourceFailure('Git diff coverage budget');
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const gaps: { path: string; oid: string | null; reason: string }[] = [];
  const retain = (path: string, entry: { mode: string; oid: string }) => {
    if (entry.mode === '160000') { gaps.push({ path, oid: entry.oid, reason: 'submodule-reference-only' }); return; }
    if (!['100644', '100755', '120000'].includes(entry.mode)) return sourceFailure('Git file mode');
    const bytes = readObject('blob', entry.oid);
    if (entry.mode === '120000') gaps.push({ path, oid: entry.oid, reason: 'symlink-target-not-followed' });
    else if (bytes.subarray(0, 43).toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1')) gaps.push({ path, oid: entry.oid, reason: 'lfs-pointer-only' });
    else if (objects.get(entry.oid)?.encoding === 'binary') gaps.push({ path, oid: entry.oid, reason: 'binary-semantics-unread' });
  };
  for (const change of changes) {
    if (change.before) retain(change.previousPath ?? change.path, change.before);
    if (change.after) retain(change.path, change.after);
  }
  const contextPaths = sorted([...new Set(options.contextPaths ?? ['README.md'])]);
  const context = contextPaths.map(path => {
    if (!path || /[\x00\r\n]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '..' || part === '.')) sourceFailure('context path');
    const entry = targetEntries.find(entry => entry.path === path);
    if (entry) retain(path, entry);
    else gaps.push({ path, oid: null, reason: 'context-not-present' });
    return { path, oid: entry?.oid ?? null };
  });
  // Re-read mutable tag references before returning the immutable snapshot.
  if (boundary.kind === 'tag' && line('rev-parse', '--verify', `refs/tags/${boundary.reference}^{commit}`) !== boundary.sha) sourceFailure('boundary tag drift');
  if (line('for-each-ref', '--format=%(refname)', `refs/tags/${targetTag}`) && line('rev-parse', '--verify', `refs/tags/${targetTag}^{commit}`) !== identity.targetSha) sourceFailure('target tag drift');
  const input = {
    schemaVersion: 2, repositoryId: identity.repositoryId, defaultBranch: identity.defaultBranch,
    targetSha: identity.targetSha, policySha: identity.policySha, targetTag,
    boundary: boundary.kind === 'full-tree' ? { kind: boundary.kind } : { kind: boundary.kind, sha: boundary.sha, reference: boundary.reference },
    productTree, boundaryTree: boundary.kind === 'full-tree' ? null : treeOf(boundary.sha),
    commits, changes, context, gaps: [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()]
      .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0),
    objects: [...objects.values()].sort((a, b) => a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0),
    coverage: { commits: commits.length, changedFiles: changes.length, retainedObjects: objects.size, retainedBytes: totalBytes },
  };
  const bytes = JSON.stringify(input) + '\n';
  if (Buffer.byteLength(bytes, 'utf8') > 32 * 1024 * 1024) sourceFailure('serialized source exceeds 32 MiB');
  return { input, bytes, inputSha256: hash(Buffer.from(bytes)) };
}
