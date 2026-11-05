import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Version } from 'release-please/build/src/version.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import { validateReleaseSourceManifest } from '../../core/src/release-bundle.js';
import { assertDeliveryPath } from '../../core/src/delivery-config.js';
import { assertSourceIdentity, sourceFailure, sourceSha, type ReleaseSourceIdentity, type ReleaseBoundary, type ReleaseSourceUnit } from '../../core/src/release-notes-input.js';

export type GitReleaseBoundary = ReleaseBoundary;
export interface GitReleaseInputOptions {
  workspace: string;
  identity: ReleaseSourceIdentity;
  unit: ReleaseSourceUnit;
  boundary: GitReleaseBoundary;
  contextPaths?: readonly string[];
  limits?: { commits?: number; files?: number; objectBytes?: number; totalBytes?: number; chunkBytes?: number };
  /** Trusted collector sink; bytes are usable only after the returned manifest verifies all objects. */
  retainObjectChunk?: (chunk: { oid: string; type: 'commit' | 'blob'; start: number; bytes: Uint8Array }) => Promise<void>;
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
export async function freezeReleaseGitInput(options: GitReleaseInputOptions) {
  const deadline = Date.now() + 5 * 60_000;
  const { identity, boundary, unit } = options;
  const targetTag = unit.tag;
  assertSourceIdentity(identity);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unit.id)) sourceFailure('unit identity');
  assertDeliveryPath(unit.path, { root: true });
  const version = (value: string) => {
    try { const parsed = Version.parse(value); if (parsed.toString() !== value || parsed.compare(parsed) !== 0) return sourceFailure('unit version'); return parsed; }
    catch { return sourceFailure('unit version'); }
  };
  const targetVersion = version(unit.version);
  if (!['tag', 'baseline', 'full-tree'].includes(boundary.kind)) sourceFailure('boundary kind');
  if (boundary.kind !== 'full-tree') {
    sourceSha(boundary.sha);
    if (!boundary.reference || /[\x00-\x1f\x7f]/.test(boundary.reference)) sourceFailure('boundary reference');
    if (boundary.kind === 'tag') {
      if (targetVersion.compare(version(boundary.version)) <= 0) sourceFailure('target version must increase');
    }
  }
  const limits = { commits: 10_000, files: 20_000, chunkBytes: 1024 * 1024, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) sourceFailure('Git input budget');
  if (limits.chunkBytes > 1024 * 1024) sourceFailure('Git chunk budget');
  const home = mkdtempSync(join(tmpdir(), 'steward-source-git-'));
  const environment = { ...isolatedBuildEnvironment(process.env, home), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' };
  const gitArgs = ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'diff.renames=false', '-c', 'core.hooksPath='];
  let batch: ReturnType<typeof spawn> | undefined;
  let batchClosed: Promise<void> | undefined;
  try {
  const git = (...args: string[]): Buffer => {
    if (Date.now() > deadline) return sourceFailure('Git collection time budget');
    try {
      return execFileSync('git', [...gitArgs, ...args], {
        cwd: resolve(options.workspace), windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return sourceFailure(`Git read failed: ${args[0]}`); }
  };
  const line = (...args: string[]) => decode(git(...args)).trim();
  git('check-ref-format', `refs/tags/${targetTag}`);
  if (boundary.kind === 'tag') git('check-ref-format', `refs/tags/${boundary.reference}`);
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
  const objects = new Map<string, { oid: string; type: 'commit' | 'blob'; size: number; sha256: string; encoding: 'utf8' | 'binary'; chunks: { start: number; end: number; sha256: string }[]; lfsPointer: boolean }>();
  const commitHeaders = new Map<string, string[]>();
  batch = spawn('git', [...gitArgs, 'cat-file', '--batch'], { cwd: resolve(options.workspace), env: environment, windowsHide: true, timeout: Math.max(1, deadline - Date.now()), stdio: ['pipe', 'pipe', 'pipe'] });
  batch.stderr!.resume(); batch.stdin!.on('error', () => {});
  batchClosed = new Promise<void>((done, reject) => {
    batch!.once('error', () => reject(new Error('Git batch process failed')));
    batch!.once('close', code => code === 0 ? done() : reject(new Error('Git batch process failed')));
  });
  void batchClosed.catch(() => {});
  const iterator = batch.stdout![Symbol.asyncIterator]();
  let buffer: Buffer = Buffer.alloc(0);
  const read = async (size: number) => {
    const parts: Buffer[] = []; let remaining = size;
    while (remaining) {
      if (!buffer.length) { const part = await iterator.next(); if (part.done) return sourceFailure('Git batch truncated'); buffer = Buffer.from(part.value); }
      const count = Math.min(remaining, buffer.length);
      parts.push(buffer.subarray(0, count)); buffer = buffer.subarray(count); remaining -= count;
    }
    return Buffer.concat(parts, size);
  };
  const headerLine = async () => {
    const bytes: number[] = [];
    while (bytes.length < 256) { const byte = (await read(1))[0]!; if (byte === 10) return Buffer.from(bytes).toString('ascii'); bytes.push(byte); }
    return sourceFailure('Git batch header');
  };
  let totalBytes = 0;
  const readObject = async (type: 'commit' | 'blob', oid: string) => {
    sourceSha(oid);
    const known = objects.get(oid);
    if (known) { if (known.type !== type) sourceFailure('Git object type'); return known; }
    if (Date.now() > deadline) return sourceFailure('Git collection time budget');
    await new Promise<void>((done, reject) => batch!.stdin!.write(oid + '\n', error => error ? reject(new Error('Git batch input failed')) : done()));
    const match = /^([a-f0-9]{40}) (commit|blob) ([0-9]+)$/.exec(await headerLine());
    if (!match || match[1] !== oid || match[2] !== type || !Number.isSafeInteger(Number(match[3]))) return sourceFailure('Git batch identity');
    const size = Number(match[3]);
    if ((limits.objectBytes !== undefined && size > limits.objectBytes) || (limits.totalBytes !== undefined && totalBytes + size > limits.totalBytes)) return sourceFailure('Git object coverage budget');
    const sha1 = createHash('sha1').update(`${type} ${size}\0`), sha256 = createHash('sha256');
    const chunks: { start: number; end: number; sha256: string }[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let encoding: 'utf8' | 'binary' = 'utf8';
    let prefix: Buffer = Buffer.alloc(0), headers: Buffer = Buffer.alloc(0), headersComplete = type !== 'commit';
    for (let start = 0; start < size;) {
      const bytes = await read(Math.min(limits.chunkBytes, size - start));
      await options.retainObjectChunk?.({ oid, type, start, bytes });
      sha1.update(bytes); sha256.update(bytes);
      if (prefix.length < 128) prefix = Buffer.concat([prefix, bytes.subarray(0, 128 - prefix.length)]);
      if (!headersComplete) {
        headers = Buffer.concat([headers, bytes]); const separator = headers.indexOf('\n\n');
        if (separator >= 0) { headers = headers.subarray(0, separator); headersComplete = true; }
        else if (headers.length > 1024 * 1024) sourceFailure('Git commit header budget');
      }
      if (encoding === 'utf8') { try { decoder.decode(bytes, { stream: true }); if (bytes.includes(0)) encoding = 'binary'; } catch { encoding = 'binary'; } }
      chunks.push({ start, end: start + bytes.length, sha256: hash(bytes) }); start += bytes.length;
    }
    if (encoding === 'utf8') { try { decoder.decode(); } catch { encoding = 'binary'; } }
    if ((await read(1))[0] !== 10 || sha1.digest('hex') !== oid) return sourceFailure('Git object integrity');
    if (type === 'commit') { if (!headersComplete) sourceFailure('Git commit headers'); commitHeaders.set(oid, decode(headers).split('\n')); }
    totalBytes += size;
    const object = { oid, type, size, sha256: sha256.digest('hex'), encoding, chunks, lfsPointer: prefix.toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1') };
    objects.set(oid, object); return object;
  };
  const treeOf = (id: string) => sourceSha(line('rev-parse', '--verify', `${id}^{tree}`));
  const productTree = treeOf(identity.targetSha);
  const commits: { sha: string; tree: string; parents: string[]; objectSha256: string }[] = [];
  for (const id of sorted(ids)) {
    sourceSha(id);
    const object = await readObject('commit', id);
    const header = commitHeaders.get(id)!;
    const tree = sourceSha(header.find(value => value.startsWith('tree '))?.slice(5));
    const parents = header.filter(value => value.startsWith('parent ')).map(value => sourceSha(value.slice(7)));
    commits.push({ sha: id, tree, parents, objectSha256: object.sha256 });
  }
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
  const retain = async (path: string, entry: { mode: string; oid: string }) => {
    if (entry.mode === '160000') { gaps.push({ path, oid: entry.oid, reason: 'submodule-reference-only' }); return; }
    if (!['100644', '100755', '120000'].includes(entry.mode)) return sourceFailure('Git file mode');
    const object = await readObject('blob', entry.oid);
    if (entry.mode === '120000') gaps.push({ path, oid: entry.oid, reason: 'symlink-target-not-followed' });
    else if (object.lfsPointer) gaps.push({ path, oid: entry.oid, reason: 'lfs-pointer-only' });
    else if (objects.get(entry.oid)?.encoding === 'binary') gaps.push({ path, oid: entry.oid, reason: 'binary-semantics-unread' });
  };
  for (const change of changes) {
    if (change.before) await retain(change.previousPath ?? change.path, change.before);
    if (change.after) await retain(change.path, change.after);
  }
  const contextPaths = sorted([...new Set(options.contextPaths ?? ['README.md'])]);
  const context: { path: string; oid: string | null }[] = [];
  for (const path of contextPaths) {
    if (!path || /[\x00\r\n]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '..' || part === '.')) sourceFailure('context path');
    const entry = targetEntries.find(entry => entry.path === path);
    if (entry) await retain(path, entry);
    else gaps.push({ path, oid: null, reason: 'context-not-present' });
    context.push({ path, oid: entry?.oid ?? null });
  }
  // Re-read mutable tag references before returning the immutable snapshot.
  if (boundary.kind === 'tag' && line('rev-parse', '--verify', `refs/tags/${boundary.reference}^{commit}`) !== boundary.sha) sourceFailure('boundary tag drift');
  if (line('for-each-ref', '--format=%(refname)', `refs/tags/${targetTag}`) && line('rev-parse', '--verify', `refs/tags/${targetTag}^{commit}`) !== identity.targetSha) sourceFailure('target tag drift');
  const input = {
    schemaVersion: 3 as const, repositoryId: identity.repositoryId, defaultBranch: identity.defaultBranch,
    targetSha: identity.targetSha, controllerSha: identity.controllerSha, unit: structuredClone(unit),
    boundary: structuredClone(boundary),
    productTree, boundaryTree: boundary.kind === 'full-tree' ? null : treeOf(boundary.sha),
    commits, changes, context, gaps: [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()]
      .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0),
    objects: [...objects.values()].sort((a, b) => a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0),
    coverage: { commits: commits.length, changedFiles: changes.length, retainedObjects: objects.size, retainedBytes: totalBytes },
  };
  const bytes = JSON.stringify(input) + '\n';
  batch.stdin!.end(); await batchClosed;
  const inputSha256 = hash(Buffer.from(bytes));
  validateReleaseSourceManifest(Buffer.from(bytes), { ...identity, unit, productTree, boundary, sourceDigest: inputSha256 });
  return { input, bytes, inputSha256 };
  } finally {
    if (batch && batch.exitCode === null) batch.kill();
    // Close unread pipes too: a rejected header/body must not leave close waiting
    // for an async iterator that the failing caller will never consume again.
    batch?.stdin?.destroy(); batch?.stdout?.destroy(); batch?.stderr?.destroy();
    if (batchClosed) await batchClosed.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}
