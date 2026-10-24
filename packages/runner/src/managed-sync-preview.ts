import { parseReleaseDescriptor } from '../../core/src/release-descriptor.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import onboardingSchema from '../../../schema/onboarding.schema.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { mergeManagedFile, type ManagedFileRule, type MergeText } from './managed-file-merge.js';
import { generateReviewInstructionSet } from '../../core/src/review-instructions.js';

export interface AdoptionFile { path: string; sourceRepository: string; sourceSha: string; sourceBlob: string; targetBlob: string; targetSha256: string }
export interface Adoption { schemaVersion: 1; repositoryId: number; policySha: string; files: AdoptionFile[] }
export interface OnboardingManifest {
  schemaVersion: 1; repositoryId: number; fullName: string; defaultBranch: string; expectedBaseSha: string; mode: 'onboard';
  files: { targetPath: string; beforeBlob: string | null; payloadPath: string; sha256: string }[]; initializeManifest: boolean;
}
export interface SourceRule extends ManagedFileRule { sourceRepository: string; sourceSha: string; renderer?: 'review' | 'policy-ref' | 'release-please'; profile?: string; adoptionBeforeBlob?: string }
export interface GitSnapshot {
  head(directory: string): Promise<string>;
  file(directory: string, sha: string, path: string): Promise<Buffer | null>;
  blob(directory: string, id: string): Promise<Buffer>;
}
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function fail(reason: string): never { throw new Error(`MANAGED_SYNC: ${reason}`); }
export function safeManagedPath(path: string) {
  if (!path || path.length > 240 || path.includes('\\') || !/^[A-Za-z0-9._/-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail('unsafe path');
}
async function git(directory: string, args: string[]) {
  return (await promisify(execFile)('git', ['--no-replace-objects', '-C', directory, ...args], {
    encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
}
export const localGitSnapshot: GitSnapshot = {
  async head(directory) { return (await git(directory, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('ascii').trim(); },
  async file(directory, commit, path) {
    if (!sha(commit)) fail('invalid source commit'); safeManagedPath(path);
    const entry = (await git(directory, ['ls-tree', '-z', commit, '--', path])).toString('utf8');
    if (!entry) return null;
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[2] !== path) fail('source must be a regular Git blob');
    return this.blob(directory, match[1]!);
  },
  async blob(directory, id) { if (!sha(id)) fail('invalid blob'); return git(directory, ['cat-file', 'blob', id]); },
};
function text(bytes: Buffer) { const value = bytes.toString('utf8'); if (value.includes('\0') || !Buffer.from(value).equals(bytes)) fail('binary managed file'); return value; }
async function renderedSource(rule: SourceRule, directory: string, snapshots: GitSnapshot, input: PreviewInput) {
  const source = await snapshots.file(directory, rule.sourceSha, rule.source); if (!source) fail('missing source blob');
  if (rule.renderer === undefined) return source;
  if (rule.sourceRepository !== 'splrad/steward') fail('renderer must use central policy');
  if (rule.renderer === 'policy-ref') {
    if (!await snapshots.file(directory, rule.sourceSha, '.github/workflows/product-release.yml')) fail('policy release entrypoint missing');
    const value = text(source);
    const references = [...value.matchAll(/splrad\/steward\/\.github\/workflows\/product-release\.yml@[a-f0-9]{40}/g)];
    if (references.length !== 1 || rule.profile !== undefined) fail('policy template contract');
    return Buffer.from(value.replace(references[0]![0], `splrad/steward/.github/workflows/product-release.yml@${rule.sourceSha}`));
  }
  if (rule.renderer === 'release-please') {
    if (rule.source !== 'config/release/defaults.json' || rule.destination !== 'release-please-config.json') fail('release configuration source');
    let descriptor = await snapshots.file(input.targetDirectory, input.expectedBaseSha, '.github/steward-release.json');
    if (!descriptor && input.onboarding) {
      validateOnboardingManifest(input.onboarding.manifest);
      const file = input.onboarding.manifest.files.find(file => file.targetPath === '.github/steward-release.json');
      if (file) { descriptor = await payload(input.onboarding.directory, file.payloadPath); if (hash(descriptor) !== file.sha256) fail('descriptor payload digest'); }
    }
    if (!descriptor) fail('missing product descriptor');
    const { units } = parseReleaseDescriptor(JSON.parse(text(descriptor)));
    if (units.some(unit => unit.ecosystem !== 'native')) fail('release renderer adapter not admitted');
    const boundaries = await snapshots.file(directory, rule.sourceSha, 'config/release/bootstrap.json');
    if (!boundaries) fail('missing bootstrap configuration');
    const boundary = JSON.parse(text(boundaries))[String(input.repositoryId)];
    if (!sha(boundary)) fail('missing reviewed bootstrap commit');
    const defaults = JSON.parse(text(source));
    return Buffer.from(JSON.stringify({ ...defaults, 'bootstrap-sha': boundary, packages: Object.fromEntries(units.map(unit => [unit.releasePleasePath,
      { 'release-type': 'simple', 'version-file': unit.versionFile, 'changelog-path': unit.changelogPath }])) }, null, 2) + '\n');
  }
  if (rule.renderer !== 'review' || rule.source !== 'config/review/rules.json' || !rule.profile) fail('unknown renderer');
  const profiles = await snapshots.file(directory, rule.sourceSha, 'config/review/profiles.json'); if (!profiles) fail('missing review profiles');
  const { $schema: _rulesSchema, ...rules } = JSON.parse(text(source));
  const { $schema: _profilesSchema, ...registry } = JSON.parse(text(profiles));
  const generated = await generateReviewInstructionSet(rule.profile, registry, rules);
  const file = generated.files.find(file => file.path === rule.destination); if (!file) fail('review path requires explicit retirement');
  return Buffer.from(rule.mode === 'section' ? `${rule.startMarker}\n${file.content.trimEnd()}\n${rule.endMarker}\n` : file.content);
}
function exact(value: object, keys: string[]) { if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail('unexpected manifest fields'); }
const validateOnboardingSchema = new Ajv2020({ allErrors: true, strict: false }).compile(onboardingSchema);
export function validateOnboardingManifest(manifest: OnboardingManifest) {
  if (!validateOnboardingSchema(manifest)) fail('onboarding schema');
  exact(manifest, ['schemaVersion', 'repositoryId', 'fullName', 'defaultBranch', 'expectedBaseSha', 'mode', 'files', 'initializeManifest']);
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'onboard' || !Number.isSafeInteger(manifest.repositoryId) || manifest.repositoryId < 1
    || !/^splrad\/[\w.-]+$/.test(manifest.fullName) || manifest.defaultBranch !== 'main' || !sha(manifest.expectedBaseSha)
    || typeof manifest.initializeManifest !== 'boolean' || !Array.isArray(manifest.files) || !manifest.files.length) fail('invalid onboarding manifest');
  const paths = new Set<string>();
  for (const file of manifest.files) {
    exact(file, ['targetPath', 'beforeBlob', 'payloadPath', 'sha256']); safeManagedPath(file.targetPath); safeManagedPath(file.payloadPath);
    if (!file.payloadPath.startsWith('files/') || !/^[a-f0-9]{64}$/.test(file.sha256) || file.beforeBlob !== null && !sha(file.beforeBlob)
      || paths.has(file.targetPath.toLowerCase()) || file.targetPath === '.github/steward-adoption.json') fail('invalid onboarding file');
    paths.add(file.targetPath.toLowerCase());
  }
}
async function payload(directory: string, path: string) {
  safeManagedPath(path); let cursor = resolve(directory);
  for (const part of path.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) fail('payload symlink'); }
  if (!(await lstat(cursor)).isFile()) fail('payload not a file');
  const bytes = await readFile(cursor);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/.test(text(bytes))) fail('credential in onboarding payload');
  return bytes;
}
export interface PreviewInput {
  repositoryId: number; fullName: string; defaultBranch: string; expectedBaseSha: string; policySha: string;
  configuredPolicySha: string | null; revokedPolicyShas: string[]; mode: 'onboard' | 'sync';
  targetDirectory: string; sourceDirectories: Record<string, string>; rules: SourceRule[];
  onboarding?: { directory: string; manifest: OnboardingManifest }; outputDirectory: string;
}
export async function previewManagedSync(input: PreviewInput, snapshots: GitSnapshot = localGitSnapshot, merge?: MergeText) {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1 || !/^splrad\/[\w.-]+$/.test(input.fullName)
    || input.defaultBranch !== 'main' || !sha(input.policySha) || !sha(input.expectedBaseSha)
    || input.configuredPolicySha !== input.policySha || input.revokedPolicyShas.includes(input.policySha)) fail('policy or repository identity');
  const currentHead = await snapshots.head(input.targetDirectory);
  const out = resolve(input.outputDirectory);
  for (const directory of [input.targetDirectory, ...Object.values(input.sourceDirectories)]) {
    const relation = relative(resolve(directory), out);
    if (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) fail('output inside input checkout');
  }
  try { await lstat(out); fail('output already exists'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (input.mode === 'onboard' && input.onboarding) {
    const raw = await snapshots.file(input.targetDirectory, currentHead, '.github/steward-adoption.json');
    if (raw) {
      const adopted: Adoption = JSON.parse(text(raw));
      exact(adopted, ['schemaVersion', 'repositoryId', 'policySha', 'files']);
      if (adopted.schemaVersion !== 1 || adopted.repositoryId !== input.repositoryId || adopted.policySha !== input.policySha
        || !Array.isArray(adopted.files) || adopted.files.length !== input.rules.length) fail('partial or different adoption');
      const seen = new Set<string>();
      for (const rule of input.rules) {
        const entry = adopted.files.find(file => file.path === rule.destination);
        if (!entry || seen.has(entry.path) || entry.sourceRepository !== rule.sourceRepository || entry.sourceSha !== rule.sourceSha) fail('partial or different adoption');
        exact(entry, ['path', 'sourceRepository', 'sourceSha', 'sourceBlob', 'targetBlob', 'targetSha256']); seen.add(entry.path);
        safeManagedPath(entry.path);
        if (![entry.sourceSha, entry.sourceBlob, entry.targetBlob].every(sha) || !/^[a-f0-9]{64}$/.test(entry.targetSha256)) fail('adoption digest');
        const sourceDirectory = input.sourceDirectories[rule.sourceRepository];
        if (!sourceDirectory || !['splrad/steward', 'splrad/.github'].includes(rule.sourceRepository)
          || rule.sourceRepository === 'splrad/steward' && rule.sourceSha !== input.policySha) fail('untrusted template source');
        if (gitBlob(await renderedSource(rule, sourceDirectory, snapshots, { ...input, expectedBaseSha: currentHead })) !== entry.sourceBlob) fail('adoption source changed');
        const current = await snapshots.file(input.targetDirectory, currentHead, entry.path);
        if (!current || gitBlob(current) !== entry.targetBlob || hash(current) !== entry.targetSha256) fail('adopted file changed');
      }
      const { manifest, directory } = input.onboarding; validateOnboardingManifest(manifest);
      if (manifest.repositoryId !== input.repositoryId || manifest.fullName !== input.fullName || manifest.defaultBranch !== input.defaultBranch) fail('onboarding identity');
      const descriptorBytes = await snapshots.file(input.targetDirectory, currentHead, '.github/steward-release.json');
      const units = descriptorBytes ? parseReleaseDescriptor(JSON.parse(text(descriptorBytes))).units : [];
      const versionPaths = new Set(units.flatMap(unit => [unit.versionFile, unit.changelogPath]));
      if (units.length) {
        const seed = await snapshots.file(input.targetDirectory, currentHead, '.release-please-manifest.json');
        if (!seed) fail('adopted release manifest missing');
        const versions = JSON.parse(text(seed));
        if (JSON.stringify(Object.keys(versions).sort()) !== JSON.stringify(units.map(unit => unit.releasePleasePath).sort())) fail('adopted version mapping');
        for (const unit of units) {
          const current = await snapshots.file(input.targetDirectory, currentHead, unit.versionFile);
          if (!current || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\n$/.test(text(current)) || text(current).trim() !== versions[unit.releasePleasePath]) fail('adopted version mismatch');
        }
        versionPaths.add('.release-please-manifest.json');
      }
      for (const file of manifest.files) {
        if (hash(await payload(directory, file.payloadPath)) !== file.sha256) fail('payload digest');
        const current = await snapshots.file(input.targetDirectory, currentHead, file.targetPath);
        if (!current || !versionPaths.has(file.targetPath) && hash(current) !== file.sha256) fail('partially adopted payload');
      }
      const report = { schemaVersion: 1, repositoryId: input.repositoryId, fullName: input.fullName, mode: input.mode,
        expectedBaseSha: currentHead, policySha: input.policySha, remoteWrites: 0, files: [], reason: 'already-adopted' };
      await mkdir(out, { recursive: false });
      await writeFile(join(out, 'preview.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      await writeFile(join(out, 'sync-body.md'), `受管配置已采用：${input.fullName}\n`, { flag: 'wx' });
      return report;
    }
  }
  if (currentHead !== input.expectedBaseSha) fail('target main changed');
  const changes = new Map<string, { before: Buffer | null; after: Buffer }>();
  const adopted: AdoptionFile[] = [];
  let previous: Adoption | undefined;
  if (input.mode === 'sync') {
    if (input.onboarding) fail('sync cannot consume onboarding payload');
    const bytes = await snapshots.file(input.targetDirectory, input.expectedBaseSha, '.github/steward-adoption.json');
    if (!bytes) fail('missing adopted baseline');
    previous = JSON.parse(text(bytes));
    if (!previous || previous.schemaVersion !== 1 || previous.repositoryId !== input.repositoryId || !sha(previous.policySha) || !Array.isArray(previous.files)) fail('adoption identity');
    exact(previous, ['schemaVersion', 'repositoryId', 'policySha', 'files']);
    for (const file of previous.files) {
      exact(file, ['path', 'sourceRepository', 'sourceSha', 'sourceBlob', 'targetBlob', 'targetSha256']); safeManagedPath(file.path);
      if (![file.sourceSha, file.sourceBlob, file.targetBlob].every(sha) || !/^[a-f0-9]{64}$/.test(file.targetSha256)) fail('adoption digest');
    }
    if (new Set(previous.files.map(file => file.path.toLowerCase())).size !== previous.files.length) fail('duplicate adopted path');
  } else if (input.mode !== 'onboard' || !input.onboarding) fail('missing onboarding input');
  for (const rule of input.rules) {
    safeManagedPath(rule.source); safeManagedPath(rule.destination);
    if (changes.has(rule.destination) || [...changes.keys()].some(path => path.toLowerCase() === rule.destination.toLowerCase())
      || rule.destination === '.github/steward-adoption.json') fail('duplicate managed writer');
    if (!['splrad/steward', 'splrad/.github'].includes(rule.sourceRepository) || !sha(rule.sourceSha)
      || rule.sourceRepository === 'splrad/steward' && rule.sourceSha !== input.policySha) fail('untrusted template source');
    const sourceDirectory = input.sourceDirectories[rule.sourceRepository]; if (!sourceDirectory) fail('missing source checkout');
    const next = await renderedSource(rule, sourceDirectory, snapshots, input);
    const current = await snapshots.file(input.targetDirectory, input.expectedBaseSha, rule.destination);
    let after: Buffer;
    if (previous) {
      const adoption = previous.files.find(file => file.path === rule.destination);
      if (!adoption || !current || adoption.sourceRepository !== rule.sourceRepository) fail('unproven base requires migration');
      const base = await snapshots.blob(input.targetDirectory, adoption.targetBlob);
      if (gitBlob(base) !== adoption.targetBlob || hash(base) !== adoption.targetSha256) fail('adopted base digest');
      after = Buffer.from(await mergeManagedFile(text(current), text(base), text(next), rule, merge));
    } else {
      // Existing human content requires an explicit reviewed payload; it is never overwritten on first adoption.
      if (current && !current.equals(next) && !(rule.renderer === 'review' && rule.destination === 'AGENTS.md' && rule.mode === 'section' && rule.adoptionBeforeBlob === gitBlob(current))) fail('existing unadopted file requires migration');
      after = next;
    }
    changes.set(rule.destination, { before: current, after });
    adopted.push({ path: rule.destination, sourceRepository: rule.sourceRepository, sourceSha: rule.sourceSha,
      sourceBlob: gitBlob(next), targetBlob: gitBlob(after), targetSha256: hash(after) });
  }
  if (previous?.files.some(file => !changes.has(file.path))) fail('managed deletion requires migration');
  if (input.onboarding) {
    const { directory, manifest } = input.onboarding; validateOnboardingManifest(manifest);
    if (manifest.repositoryId !== input.repositoryId || manifest.fullName !== input.fullName || manifest.defaultBranch !== input.defaultBranch
      || manifest.expectedBaseSha !== input.expectedBaseSha) fail('onboarding identity');
    for (const file of manifest.files) {
      if ([...changes.keys()].some(path => path.toLowerCase() === file.targetPath.toLowerCase())) fail('payload and renderer overlap');
      if (file.targetPath === '.release-please-manifest.json' && !manifest.initializeManifest) fail('manifest initialization not authorized');
      const before = await snapshots.file(input.targetDirectory, input.expectedBaseSha, file.targetPath);
      if ((before ? gitBlob(before) : null) !== file.beforeBlob) fail('payload baseline changed');
      const after = await payload(directory, file.payloadPath); if (hash(after) !== file.sha256) fail('payload digest');
      changes.set(file.targetPath, { before, after });
    }
  }
  const adoption: Adoption = { schemaVersion: 1, repositoryId: input.repositoryId, policySha: input.policySha, files: adopted.sort((a, b) => a.path.localeCompare(b.path)) };
  changes.set('.github/steward-adoption.json', { before: await snapshots.file(input.targetDirectory, input.expectedBaseSha, '.github/steward-adoption.json'), after: Buffer.from(JSON.stringify(adoption, null, 2) + '\n') });
  const changed = [...changes].filter(([, file]) => !file.before?.equals(file.after)).sort(([a], [b]) => a.localeCompare(b));
  const report = { schemaVersion: 1, repositoryId: input.repositoryId, fullName: input.fullName, mode: input.mode, expectedBaseSha: input.expectedBaseSha,
    policySha: input.policySha, remoteWrites: 0, files: changed.map(([path, file]) => ({ path, beforeBlob: file.before ? gitBlob(file.before) : null,
      beforeSha256: file.before ? hash(file.before) : null, afterBlob: gitBlob(file.after), afterSha256: hash(file.after) })) };
  await mkdir(out, { recursive: false });
  for (const [path, file] of changed) { const destination = join(out, 'files', path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, file.after, { flag: 'wx' }); }
  await writeFile(join(out, 'preview.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(out, 'sync-body.md'), `受管文件同步：${input.fullName}\n\n基线：${input.expectedBaseSha}\n策略：${input.policySha}\n\n${report.files.map(file => `- ${file.path}: ${file.beforeSha256 ?? 'new'} → ${file.afterSha256}`).join('\n')}\n`, { flag: 'wx' });
  return report;
}
