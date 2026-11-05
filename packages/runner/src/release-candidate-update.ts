import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { ManifestPlugin } from 'release-please/build/src/plugin.js';
import { Manifest } from 'release-please/build/src/manifest.js';
import { buildStrategy } from 'release-please/build/src/factory.js';
import type { Scm } from 'release-please/build/src/scm.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import { validateCandidateFiles, type CandidateFile, type CandidateSnapshot } from '../../core/src/release-candidate.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sha = (value: string) => { if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('CANDIDATE_SHA_INVALID'); return value; };
export interface CandidateGenerationFacts {
  baseSha: string; defaultBranch: string; config: string; manifest: string; commitCount: number;
  releases: { id: number; tag: string; sha: string; bodyDigest: string; draft: boolean }[];
  tags: { tag: string; sha: string }[];
  boundaries: { path: string; kind: 'tag' | 'baseline' | 'full-tree'; sha: string | null; reference: string | null; found: boolean }[];
  releaseInventoryComplete: boolean; protectionsEvidencePath: string;
}
export interface CandidateGenerator {
  configPath: string; manifestPath: string;
  units: { id: string; path: string }[];
  readFacts(): Promise<CandidateGenerationFacts>;
  /** A fresh client holding only repository contents/pull-request read permission. */
  createReadClient(): Promise<Scm>;
}
const writes = new Set(['createPullRequest', 'updatePullRequest', 'createRelease', 'commentOnIssue', 'removeIssueLabels', 'addIssueLabels', 'createFileOnNewBranch', 'generateReleaseNotes']);
export function readOnlyReleasePlease(client: Scm): Scm {
  return new Proxy(client, { get(target, key, receiver) {
    if (writes.has(String(key))) return () => { throw new Error('RELEASE_PLEASE_WRITE_FORBIDDEN'); };
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
/** Release Please owns version decisions and CompositeUpdater semantics. No lifecycle writes. */
export async function generateCandidate(B: string, rpConfig: CandidateGenerator) {
  sha(B);
  const before = await rpConfig.readFacts();
  if (before.baseSha !== B) return { status: 'DRIFT' as const };
  if (!before.defaultBranch || /^[a-f0-9]{40}$/.test(before.defaultBranch) || !before.releaseInventoryComplete
    || !before.protectionsEvidencePath || !Number.isSafeInteger(before.commitCount) || before.commitCount < 1
    || before.boundaries.some(b => !b.found || b.kind !== 'full-tree' && (!b.sha || !b.reference))) throw new Error('CANDIDATE_HISTORY_UNVERIFIED');
  const config = JSON.parse(before.config) as Record<string, unknown>;
  if (config['separate-pull-requests'] !== false) throw new Error('CANDIDATE_SINGLE_PR_REQUIRED');
  const client = readOnlyReleasePlease(await rpConfig.createReadClient());
  const baselineCommits = new Map<string, number>();
  const baselines = before.boundaries.filter(boundary => boundary.kind === 'baseline');
  const github = baselines.length ? new Proxy(client, { get(target, key, receiver) {
    if (key === 'mergeCommitIterator') return async function* (...args: Parameters<Scm['mergeCommitIterator']>) {
      for await (const commit of target.mergeCommitIterator(...args)) {
        baselineCommits.set(commit.sha, baselineCommits.size); yield commit;
      }
    };
    return Reflect.get(target, key, receiver);
  } }) : client;
  const previousManifest = JSON.parse(before.manifest) as Record<string, string>;
  const firstLayerScape = github.repository.owner === 'splrad' && github.repository.repo === 'LayerScape'
    && (!Object.hasOwn(previousManifest, '.') || previousManifest['.'] === '0.0.0'
      || before.boundaries.some(boundary => boundary.kind === 'full-tree'));
  if (firstLayerScape && (before.releases.length || before.tags.length || Object.keys(previousManifest).length
    || (config.packages as Record<string, Record<string, unknown>>)?.['.']?.['initial-version'] !== '1.0.0'
    || ['bootstrap-sha', 'draft', 'force-tag-creation'].some(key => Object.hasOwn(config, key)
      || Object.hasOwn((config.packages as Record<string, Record<string, unknown>>)?.['.'] ?? {}, key))
    || before.boundaries.some(boundary => boundary.kind !== 'full-tree'))) throw new Error('CANDIDATE_FIRST_RELEASE_INPUT');
  if (github.repository.defaultBranch !== before.defaultBranch) throw new Error('CANDIDATE_DEFAULT_BRANCH_DRIFT');
  const manifest = await Manifest.fromManifest(github, before.defaultBranch, rpConfig.configPath, rpConfig.manifestPath,
    { releaseSearchDepth: before.releases.length + 1, commitSearchDepth: before.commitCount + 1, separatePullRequests: false });
  const paths = Object.keys(manifest.repositoryConfig).sort();
  if (JSON.stringify(paths) !== JSON.stringify(rpConfig.units.map(u => u.path).sort())
    || JSON.stringify(paths) !== JSON.stringify(before.boundaries.map(b => b.path).sort())) throw new Error('CANDIDATE_UNIT_COVERAGE');
  // RP owns path splitting, version strategies, workspace propagation and PR merging.
  // Apply each verified baseline before those strategies; a global bootstrap SHA
  // would truncate other units or replay already released commits.
  if (baselines.length) manifest.plugins.unshift(new class extends ManifestPlugin {
    override async preconfigure(...args: Parameters<ManifestPlugin['preconfigure']>) {
      const [strategies, commitsByPath] = args;
      for (const boundary of baselines) {
        const end = baselineCommits.get(boundary.sha!);
        if (end === undefined) throw new Error('CANDIDATE_BASELINE_NOT_REACHED');
        commitsByPath[boundary.path] = (commitsByPath[boundary.path] ?? []).filter(commit => {
          const index = baselineCommits.get(commit.sha);
          if (index === undefined) throw new Error('CANDIDATE_BASELINE_COMMIT_UNKNOWN');
          return index < end;
        });
      }
      return strategies;
    }
  }(github, before.defaultBranch, manifest.repositoryConfig));
  const candidates = await manifest.buildPullRequests();
  if (candidates.length > 1) throw new Error('CANDIDATE_MULTIPLE_PRS');
  const candidate = candidates[0];
  if (!candidate) {
    if (JSON.stringify(before) !== JSON.stringify(await rpConfig.readFacts())) return { status: 'DRIFT' as const };
    return { status: 'UNCHANGED' as const };
  }
  const changes = await github.buildChangeSet(candidate.updates, B);
  const files: CandidateFile[] = [];
  for (const [path, change] of changes) {
    if (!['100644', '100755'].includes(change.mode)) throw new Error('CANDIDATE_UNSUPPORTED_MODE');
    files.push({ path, mode: change.mode as CandidateFile['mode'], content: change.content });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); validateCandidateFiles(files);
  const nextManifest = files.find(f => f.path === rpConfig.manifestPath);
  if (!nextManifest?.content) throw new Error('CANDIDATE_NATIVE_MANIFEST_REQUIRED');
  const versions = JSON.parse(nextManifest.content) as Record<string, string>, previous = JSON.parse(before.manifest) as Record<string, string>;
  const units: CandidateSnapshot['units'] = [];
  for (const unit of rpConfig.units) {
    const value = versions[unit.path];
    if (!value || value === previous[unit.path]) continue;
    const settings = manifest.repositoryConfig[unit.path]!;
    const strategy = await buildStrategy({ ...settings, github, path: unit.path, targetBranch: before.defaultBranch });
    // Project only the freshly generated upstream response. Never parse a
    // human-edited PR body, synthesize language-specific version/tag rules or
    // invoke the release lifecycle. The native manifest and strategy must agree.
    const projected = await strategy.buildReleases({ number: 0, headBranchName: candidate.headRefName,
      baseBranchName: before.defaultBranch, title: candidate.title.toString(), body: candidate.body.toString(),
      labels: candidate.labels, files: files.map(file => file.path), sha: B });
    if (projected.length !== 1 || projected[0]!.tag.version.toString() !== value) throw new Error('CANDIDATE_VERSION_PROJECTION_MISMATCH');
    units.push({ ...unit, version: value, tag: projected[0]!.tag.toString() });
  }
  if (!units.length) throw new Error('CANDIDATE_VERSION_PROJECTION_REQUIRED');
  // Reject conflicting Release-As before the pure snapshot can be persisted or merged with H.
  if (firstLayerScape && (units.length !== 1 || units[0]!.id !== 'layerscape' || units[0]!.path !== '.'
    || units[0]!.version !== '1.0.0' || units[0]!.tag !== 'v1.0.0')) throw new Error('CANDIDATE_FIRST_RELEASE_VERSION');
  if (JSON.stringify(before) !== JSON.stringify(await rpConfig.readFacts())) return { status: 'DRIFT' as const };
  const snapshot: CandidateSnapshot = { schemaVersion: 1, baseSha: B, files, units,
    configDigest: hash(before.config + '\0' + before.manifest), sourceDigest: hash(JSON.stringify(before)) };
  return { status: 'READY' as const, snapshot, title: candidate.title.toString(), body: candidate.body.toString() };
}

async function git(directory: string, profile: string, args: string[], input?: string | Buffer) {
  // execFile has no stdin option; object writes use a private literal file instead.
  if (input !== undefined) throw new Error('CANDIDATE_UNEXPECTED_STDIN');
  return (await promisify(execFile)('git', ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', ...args], { cwd: directory, env: isolatedBuildEnvironment(process.env, profile),
    encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
async function tree(workspace: string, profile: string, commit: string) {
  sha(commit);
  const entries = (await git(workspace, profile, ['ls-tree', '-r', '-z', commit])).toString('utf8').split('\0').filter(Boolean);
  const files: { path: string; mode: string; content: string }[] = [];
  for (const entry of entries) {
    const match = /^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('CANDIDATE_TREE_MODE_UNSUPPORTED');
    // Only changed/managed paths are decoded later; binary product files remain native objects.
    files.push({ path: match[3]!, mode: match[1]!, content: match[2]! });
  }
  return new Map(files.map(f => [f.path, f]));
}
export interface CandidateMerge {
  status: 'READY' | 'CONFLICT'; files: CandidateFile[]; conflictPaths: string[];
  adoption: null | { humanHead: string; generatedBase: string; differences: CandidateFile[] };
}
/** Compare the current PR with the previous generated files; stop on human differences. */
export async function mergeCandidate(workspace: string, G: CandidateSnapshot | null, H: string, N: CandidateSnapshot, temporaryRoot = tmpdir()): Promise<CandidateMerge> {
  sha(H); sha(N.baseSha); validateCandidateFiles(N.files); if (G) validateCandidateFiles(G.files);
  const directory = await mkdtemp(join(temporaryRoot, 'steward-candidate-merge-'));
  try {
    const human = await tree(workspace, directory, H), base = await tree(workspace, directory, N.baseSha);
    const oldBase = await tree(workspace, directory, G?.baseSha ?? N.baseSha);
    const previous = new Map((G?.files ?? N.files).map(f => [f.path, f]));
    const next = new Map(N.files.map(f => [f.path, f]));
    const managed = new Set([...previous.keys(), ...next.keys()]);
    const sameObject = (a: { content: string; mode: string } | undefined, b: { content: string; mode: string } | undefined) => a?.content === b?.content && a?.mode === b?.mode;
    const read = async (entry: { path: string; content: string; mode: string } | undefined): Promise<CandidateFile | null> => {
      if (!entry) return null;
      if (!['100644', '100755'].includes(entry.mode)) throw new Error('CANDIDATE_MANAGED_MODE_UNSUPPORTED');
      const bytes = await git(workspace, directory, ['cat-file', 'blob', entry.content!]);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('CANDIDATE_BINARY_TEXT');
      return { ...entry, content, mode: entry.mode as CandidateFile['mode'] };
    };
    const conflicts: string[] = [], files: CandidateFile[] = [];
    // Any human code outside the generator's exact output must already be present in B.
    for (const path of new Set([...human.keys(), ...oldBase.keys()])) {
      if (!managed.has(path) && !sameObject(human.get(path), oldBase.get(path)) && !sameObject(human.get(path), base.get(path))) conflicts.push(path);
    }
    for (const path of [...managed].sort()) {
      const actual = await read(human.get(path));
      const old = previous.get(path) ?? await read(oldBase.get(path));
      const desired = next.get(path) ?? await read(base.get(path));
      const equal = (a: CandidateFile | null | undefined, b: CandidateFile | null | undefined) =>
        (a?.content ?? null) === (b?.content ?? null) && (a?.content == null || a?.mode === b?.mode);
      if (equal(actual, desired)) { if (desired) files.push(desired); continue; }
      if (equal(actual, old)) { files.push(desired ?? { path, mode: old?.mode ?? '100644', content: null }); continue; }
      if (equal(actual, await read(base.get(path)))) { files.push(desired ?? { path, mode: actual?.mode ?? '100644', content: null }); continue; }
      // A human difference is never merged or replayed over a generated draft.
      conflicts.push(path);
    }
    return { status: conflicts.length ? 'CONFLICT' : 'READY', files, conflictPaths: [...new Set(conflicts)].sort(),
      adoption: null };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export interface PreparedCandidateWrite {
  expectedHead: string | null; baseSha: string; proposedCommit: string; generatedDigest: string;
  /** Immutable Git objects allow recovery after the preparing process/directory is lost. */
  objects: { oid: string; type: 'blob' | 'tree' | 'commit'; bytes: string }[];
}
export async function prepareCandidateWrite(workspace: string, H: string | null, N: CandidateSnapshot, merged: CandidateMerge,
  identity: { name: string; email: string }, temporaryRoot = tmpdir()): Promise<PreparedCandidateWrite> {
  if (merged.status !== 'READY') throw new Error('CANDIDATE_CONFLICT');
  validateCandidateFiles(merged.files); sha(N.baseSha); if (H) sha(H);
  if (!identity.name || !identity.email || /[\r\n<>\0]/.test(identity.name + identity.email)) throw new Error('CANDIDATE_SIGNOFF_IDENTITY');
  const directory = await mkdtemp(join(temporaryRoot, 'steward-candidate-write-'));
  try {
    await git(directory, directory, ['init']);
    const objectPath = (await git(workspace, directory, ['rev-parse', '--git-path', 'objects'])).toString().trim();
    await writeFile(join(directory, '.git/objects/info/alternates'), resolve(workspace, objectPath).replaceAll('\\', '/') + '\n');
    await git(directory, directory, ['config', 'user.name', identity.name]);
    await git(directory, directory, ['config', 'user.email', identity.email]);
    await git(directory, directory, ['update-ref', 'HEAD', H ?? N.baseSha]);
    // No checkout, filters, product hooks, or product code: populate the index directly from B.
    await git(directory, directory, ['read-tree', N.baseSha]);
    for (const file of merged.files) {
      if (file.content === null) { await git(directory, directory, ['update-index', '--force-remove', '--', file.path]); continue; }
      const literal = join(directory, 'object-input'); await writeFile(literal, file.content);
      const oid = sha((await git(directory, directory, ['hash-object', '-w', '--no-filters', literal])).toString().trim());
      await git(directory, directory, ['update-index', '--add', '--cacheinfo', `${file.mode},${oid},${file.path}`]);
    }
    if (H && H !== N.baseSha) {
      await writeFile(join(directory, '.git/MERGE_HEAD'), N.baseSha + '\n');
      // Keep both audited parents even when one is already an ancestor.
      await writeFile(join(directory, '.git/MERGE_MODE'), 'no-ff');
    }
    await git(directory, directory, ['commit', '--signoff', '--allow-empty', '-m', 'chore: update release candidate']);
    const proposedCommit = sha((await git(directory, directory, ['rev-parse', 'HEAD'])).toString().trim());
    const parents = (await git(directory, directory, ['show', '-s', '--format=%P', 'HEAD'])).toString().trim();
    if (parents !== [...new Set([H ?? N.baseSha, N.baseSha])].join(' ')) throw new Error('CANDIDATE_COMMIT_PARENTS');
    const message = (await git(directory, directory, ['show', '-s', '--format=%B', 'HEAD'])).toString();
    if (message.match(/^Signed-off-by:/gm)?.length !== 1 || !message.includes(`Signed-off-by: ${identity.name} <${identity.email}>`)) throw new Error('CANDIDATE_SIGNOFF_INVALID');
    const ids = (await git(directory, directory, ['rev-list', '--objects', proposedCommit, `^${N.baseSha}`, ...(H ? [`^${H}`] : [])])).toString().trim().split('\n').filter(Boolean).map(v => v.split(' ')[0]!);
    const objects: PreparedCandidateWrite['objects'] = [];
    for (const oid of ids) {
      sha(oid); const type = (await git(directory, directory, ['cat-file', '-t', oid])).toString().trim();
      if (!['blob', 'tree', 'commit'].includes(type)) throw new Error('CANDIDATE_OBJECT_TYPE');
      objects.push({ oid, type: type as 'blob' | 'tree' | 'commit', bytes: (await git(directory, directory, ['cat-file', type, oid])).toString('base64') });
    }
    return { expectedHead: H, baseSha: N.baseSha, proposedCommit, generatedDigest: hash(JSON.stringify(N)), objects };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export interface CandidateWritePort {
  read(): Promise<{ head: string | null; editing: boolean; closed: boolean; baseSha: string }>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  push(prepared: PreparedCandidateWrite): Promise<void>;
  /** Must atomically compare/write state before sending the candidate push. */
  persistPending(prepared: PreparedCandidateWrite): Promise<void>;
  finish(prepared: PreparedCandidateWrite, observedHead: string): Promise<void>;
}
export async function candidateTreeMatches(workspace: string, head: string, baseSha: string, files: CandidateFile[], temporaryRoot = tmpdir()) {
  const profile = await mkdtemp(join(temporaryRoot, 'steward-candidate-compare-'));
  try {
    const actual = await tree(workspace, profile, head), expected = await tree(workspace, profile, baseSha);
    for (const file of files) {
      if (file.content === null) expected.delete(file.path);
      else {
        const bytes = Buffer.from(file.content), oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        expected.set(file.path, { path: file.path, mode: file.mode, content: oid });
      }
    }
    return actual.size === expected.size && [...expected].every(([path, value]) => JSON.stringify(actual.get(path)) === JSON.stringify(value));
  } finally { await rm(profile, { recursive: true, force: true }); }
}
/** Restore exact archived objects in an isolated repository, then normal fast-forward push only. */
export async function pushPreparedCandidate(workspace: string, remote: string, branch: string, prepared: PreparedCandidateWrite,
  token: string | undefined, temporaryRoot = tmpdir()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.endsWith('.lock')) throw new Error('CANDIDATE_BRANCH_INVALID');
  const remoteUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(remote);
  if (!remoteUrl && !/^(?:[A-Za-z]:[\\/]|\/)/.test(remote)) throw new Error('CANDIDATE_REMOTE_INVALID');
  if (remoteUrl && (!token || /[\r\n\0]/.test(token))) throw new Error('CANDIDATE_WRITE_CREDENTIAL_REQUIRED');
  const directory = await mkdtemp(join(temporaryRoot, 'steward-candidate-push-'));
  try {
    await git(directory, directory, ['init']);
    const objectPath = (await git(workspace, directory, ['rev-parse', '--git-path', 'objects'])).toString().trim();
    await writeFile(join(directory, '.git/objects/info/alternates'), resolve(workspace, objectPath).replaceAll('\\', '/') + '\n');
    for (const object of prepared.objects) {
      sha(object.oid); if (!['blob', 'tree', 'commit'].includes(object.type)) throw new Error('CANDIDATE_OBJECT_TYPE');
      const bytes = Buffer.from(object.bytes, 'base64');
      if (bytes.toString('base64') !== object.bytes) throw new Error('CANDIDATE_OBJECT_ENCODING');
      const raw = Buffer.concat([Buffer.from(`${object.type} ${bytes.length}\0`), bytes]);
      if (createHash('sha1').update(raw).digest('hex') !== object.oid) throw new Error('CANDIDATE_OBJECT_DIGEST');
      const parent = join(directory, '.git/objects', object.oid.slice(0, 2)); await mkdir(parent, { recursive: true });
      await writeFile(join(parent, object.oid.slice(2)), deflateSync(raw));
    }
    await git(directory, directory, ['update-ref', 'HEAD', sha(prepared.proposedCommit)]);
    const parents = (await git(directory, directory, ['show', '-s', '--format=%P', 'HEAD'])).toString().trim();
    if (parents !== [...new Set([prepared.expectedHead ?? prepared.baseSha, prepared.baseSha])].join(' ')) throw new Error('CANDIDATE_COMMIT_PARENTS');
    const env = isolatedBuildEnvironment(process.env, directory);
    if (remoteUrl) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${remote}.extraheader`, GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64') });
    try { await promisify(execFile)('git', ['-c', 'core.hooksPath=', '-c', 'credential.helper=', 'push', '--porcelain', remote, `HEAD:refs/heads/${branch}`],
      { cwd: directory, env, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error('CANDIDATE_PUSH_UNKNOWN'); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function resumeCandidateWrite(prepared: PreparedCandidateWrite, port: CandidateWritePort) {
  const reconcile = async () => {
    const current = await port.read();
    if (current.head && (current.head === prepared.proposedCommit || await port.isAncestor(prepared.proposedCommit, current.head))) {
      await port.finish(prepared, current.head); return { status: 'APPLIED' as const, head: current.head };
    }
    return { status: 'PENDING' as const, current };
  };
  const first = await reconcile(); if (first.status === 'APPLIED') return first;
  if (first.current.closed) return { status: 'CLOSED' as const };
  if (first.current.editing) return { status: 'EDITING' as const, head: first.current.head };
  if (first.current.head !== prepared.expectedHead || first.current.baseSha !== prepared.baseSha) return { status: 'CONFLICT' as const };
  await port.persistPending(prepared);
  const last = await reconcile(); if (last.status === 'APPLIED') return last;
  if (last.current.closed || last.current.editing || last.current.head !== prepared.expectedHead || last.current.baseSha !== prepared.baseSha)
    return { status: 'CHANGED_BEFORE_PUSH' as const };
  try { await port.push(prepared); } catch { /* Native readback decides whether a lost response was accepted. */ }
  const result = await reconcile();
  return result.status === 'APPLIED' ? result : { status: 'UNKNOWN' as const };
}
