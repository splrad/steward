import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertBuildPath, buildFail, buildLimits, canonicalBuildManifest, checkBuildNativeVersion, decodeBuildJson, matchBuildFiles,
  type BuildArtifact, type BuildManifest, type BuildPlan } from '../../core/src/build-manifest.js';

export type NativeVersionInspector = (bytes: Uint8Array, file: string) => Promise<string | null>;
export interface BuildExecutionContext { buildRunId: string; outputDirectory: string; sourceDirectory: string }
function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function readArtifactBytes(handle: FileHandle, expectedSize: number, retain: boolean): Promise<{ bytes: Uint8Array; size: number; sha256: string }> {
  const buffer = Buffer.alloc(Math.min(64 * 1024, expectedSize + 1));
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let size = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - size + 1), null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > expectedSize) buildFail('RN_BUILD_DIGEST');
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (retain) chunks.push(Buffer.from(chunk));
  }
  if (size !== expectedSize) buildFail('RN_BUILD_DIGEST');
  return { bytes: retain ? Buffer.concat(chunks, size) : new Uint8Array(), size, sha256: hash.digest('hex') };
}
async function verifyFileStates(root: string, states: ReadonlyMap<string, Stats>): Promise<void> {
  for (const [path, before] of states) {
    const file = await assertBuildSourcePath(root, path);
    const after = await lstat(file);
    if (!after.isFile() || after.nlink !== 1 || !unchanged(before, after)) buildFail('RN_BUILD_PATH');
  }
}
function within(root: string, target: string): void {
  const path = relative(root, target);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(root, path) !== target) buildFail('RN_BUILD_PATH');
}
export async function assertBuildSourcePath(root: string, path: string, options: { root?: boolean } = {}): Promise<string> {
  assertBuildPath(path, options);
  const base = resolve(root);
  if ((await lstat(base)).isSymbolicLink() || await realpath(base) !== base) buildFail('RN_BUILD_PATH');
  let target = base;
  for (const part of path === '.' ? [] : path.split('/')) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) buildFail('RN_BUILD_PATH');
  }
  const actual = await realpath(target); within(base, actual);
  return actual;
}
export function assertBuildDirectoriesSeparate(source: string, output: string, paths: { relative: typeof relative; isAbsolute: typeof isAbsolute; sep: string } = { relative, isAbsolute, sep }): void {
  const nested = (from: string, to: string) => {
    const path = paths.relative(from, to);
    return !path || (!paths.isAbsolute(path) && path !== '..' && !path.startsWith(`..${paths.sep}`));
  };
  if (nested(source, output) || nested(output, source)) buildFail('RN_BUILD_PATH');
}
export async function validateBuildExecutionContext(context: BuildExecutionContext): Promise<void> {
  if (typeof context.buildRunId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(context.buildRunId)) buildFail('RN_BUILD_INVALID');
  const source = await assertBuildSourcePath(context.sourceDirectory, '.', { root: true });
  const output = await assertBuildSourcePath(context.outputDirectory, '.', { root: true });
  if (!(await lstat(source)).isDirectory() || !(await lstat(output)).isDirectory()) buildFail('RN_BUILD_PATH');
  assertBuildDirectoriesSeparate(source, output);
}
export async function validateBuildInputs(plan: BuildPlan, context: BuildExecutionContext): Promise<void> {
  await validateBuildExecutionContext(context);
  for (const field of ['project', 'directory', 'lockfile', 'context', 'dockerfile', 'entrypoint']) {
    const value = plan.inputs[field];
    if (typeof value !== 'string') continue;
    const path = await assertBuildSourcePath(context.sourceDirectory, value, { root: ['directory', 'context'].includes(field) });
    const stat = await lstat(path);
    if (['directory', 'context'].includes(field) ? !stat.isDirectory() : !stat.isFile()) buildFail('RN_BUILD_PATH');
  }
}
async function enumerate(root: string): Promise<string[]> {
  const files: string[] = [];
  let directories = 0;
  async function walk(path: string): Promise<void> {
    if (++directories > buildLimits.maxFiles * 4) buildFail('RN_BUILD_LIMIT');
    for (const entry of await readdir(path)) {
      const file = join(path, entry); const stat = await lstat(file);
      const name = relative(root, file).split(sep).join('/'); assertBuildPath(name);
      if (stat.isSymbolicLink()) buildFail('RN_BUILD_PATH');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile() && stat.nlink === 1) {
        files.push(name);
        if (files.length > buildLimits.maxFiles) buildFail('RN_BUILD_LIMIT');
      } else buildFail('RN_BUILD_PATH');
    }
  }
  await walk(root);
  return files.sort();
}
export async function collectFileBuildManifest(plan: BuildPlan, outputDirectory: string, inspectNativeVersion?: NativeVersionInspector): Promise<BuildManifest> {
  if (plan.profile === 'oci-image-v1') buildFail('RN_BUILD_INVALID');
  const root = await assertBuildSourcePath(outputDirectory, '.', { root: true });
  const files = await enumerate(root);
  const assignments = matchBuildFiles(plan, files);
  const artifacts: BuildArtifact[] = [];
  const states = new Map<string, Stats>();
  let total = 0;
  for (const assignment of assignments) {
    const file = await assertBuildSourcePath(root, assignment.file);
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > buildLimits.maxFileBytes) buildFail('RN_BUILD_LIMIT');
    total += before.size; if (total > buildLimits.maxTotalBytes) buildFail('RN_BUILD_LIMIT');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!unchanged(before, await handle.stat())) buildFail('RN_BUILD_PATH');
      const { bytes, size, sha256 } = await readArtifactBytes(handle, before.size, true);
      if (!unchanged(before, await handle.stat())) buildFail('RN_BUILD_DIGEST');
      checkBuildNativeVersion(plan, inspectNativeVersion ? await inspectNativeVersion(bytes, assignment.file) : null);
      artifacts.push({ ...assignment, kind: 'file', size, sha256 });
    } finally { await handle.close(); }
    if (await assertBuildSourcePath(root, assignment.file) !== file || !unchanged(before, await lstat(file))) buildFail('RN_BUILD_PATH');
    states.set(assignment.file, before);
  }
  if (JSON.stringify(await enumerate(root)) !== JSON.stringify(files)) buildFail('RN_BUILD_OUTPUT');
  await verifyFileStates(root, states);
  const manifest: BuildManifest = { schemaVersion: 1, repositoryId: plan.repositoryId, fullName: plan.fullName, buildId: plan.buildId,
    profile: plan.profile, targetSha: plan.targetSha, policySha: plan.policySha, version: plan.version, inputsSha256: plan.inputsSha256, artifacts };
  canonicalBuildManifest(manifest);
  return manifest;
}
export async function verifyDownloadedFileBuild(plan: BuildPlan, expected: BuildManifest, directory: string, inspectNativeVersion?: NativeVersionInspector): Promise<void> {
  const actual = await collectFileBuildManifest(plan, directory, inspectNativeVersion);
  if (canonicalBuildManifest(actual) !== canonicalBuildManifest(expected)) buildFail('RN_BUILD_DIGEST');
}

export async function collectOciBuildManifest(plan: BuildPlan, outputDirectory: string): Promise<BuildManifest> {
  if (plan.profile !== 'oci-image-v1') buildFail('RN_BUILD_INVALID');
  const root = await assertBuildSourcePath(outputDirectory, '.', { root: true });
  const files = await enumerate(root); const consumed = new Set(['oci-layout', 'index.json']);
  const states = new Map<string, Stats>();
  let total = 0;
  const bytesAt = async (path: string, limit: number, retainBytes = true) => {
    const file = await assertBuildSourcePath(root, path);
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > limit) buildFail('RN_BUILD_LIMIT');
    const previous = states.get(path);
    if (previous && !unchanged(previous, before)) buildFail('RN_BUILD_PATH');
    if (!previous) total += before.size;
    if (total > buildLimits.maxTotalBytes) buildFail('RN_BUILD_LIMIT');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!unchanged(before, await handle.stat())) buildFail('RN_BUILD_PATH');
      const result = await readArtifactBytes(handle, before.size, retainBytes);
      if (!unchanged(before, await handle.stat()) || !unchanged(before, await lstat(file))) buildFail('RN_BUILD_DIGEST');
      states.set(path, before);
      return result;
    } finally { await handle.close(); }
  };
  const jsonAt = async (path: string) => {
    const { bytes } = await bytesAt(path, 512 * 1024);
    return decodeBuildJson(bytes, 'oci') as any;
  };
  if ((await jsonAt('oci-layout')).imageLayoutVersion !== '1.0.0') buildFail('RN_BUILD_INVALID');
  const verifiedBlobs = new Map<string, Uint8Array>();
  const verifiedSizes = new Map<string, number>();
  const blob = async (descriptor: { digest: string; size: number; mediaType: string }, retainBytes = true) => {
    if (typeof descriptor?.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest) || descriptor.digest.length !== 71 || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > buildLimits.maxFileBytes) buildFail('RN_BUILD_INVALID');
    if (retainBytes && descriptor.size > 512 * 1024) buildFail('RN_BUILD_LIMIT');
    const cached = verifiedBlobs.get(descriptor.digest);
    const verifiedSize = verifiedSizes.get(descriptor.digest);
    if (verifiedSize !== undefined) {
      if (verifiedSize !== descriptor.size) buildFail('RN_BUILD_DIGEST');
      if (!retainBytes) return new Uint8Array();
    }
    if (cached) { if (cached.byteLength !== descriptor.size) buildFail('RN_BUILD_DIGEST'); return cached; }
    const path = `blobs/sha256/${descriptor.digest.slice(7)}`;
    const { bytes, size, sha256 } = await bytesAt(path, retainBytes ? 512 * 1024 : buildLimits.maxFileBytes, retainBytes);
    if (size !== descriptor.size || `sha256:${sha256}` !== descriptor.digest) buildFail('RN_BUILD_DIGEST');
    consumed.add(path);
    verifiedSizes.set(descriptor.digest, size);
    if (retainBytes) verifiedBlobs.set(descriptor.digest, bytes);
    return bytes;
  };
  const parse = (bytes: Uint8Array) => {
    if (bytes.length > 512 * 1024) buildFail('RN_BUILD_LIMIT');
    return decodeBuildJson(bytes, 'oci') as any;
  };
  const index = await jsonAt('index.json');
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== plan.outputs.length) buildFail('RN_BUILD_OUTPUT');
  const artifacts: BuildArtifact[] = [];
  for (const rule of plan.outputs) {
    const matches = index.manifests.filter((descriptor: any) => descriptor.annotations?.['org.opencontainers.image.ref.name'] === rule.id);
    if (matches.length !== 1) buildFail('RN_BUILD_OUTPUT');
    const descriptor = matches[0];
    const platforms = new Set<string>();
    const inspect = async (current: any, depth: number): Promise<void> => {
      if (depth > 8) buildFail('RN_BUILD_LIMIT');
      const image = parse(await blob(current));
      if (image?.schemaVersion !== 2) buildFail('RN_BUILD_INVALID');
      if (current.mediaType === 'application/vnd.oci.image.index.v1+json') {
        if (!Array.isArray(image.manifests) || !image.manifests.length || image.manifests.length > buildLimits.maxFiles) buildFail('RN_BUILD_INVALID');
        for (const child of image.manifests) await inspect(child, depth + 1);
        return;
      }
      if (current.mediaType !== 'application/vnd.oci.image.manifest.v1+json' || image.config?.mediaType !== 'application/vnd.oci.image.config.v1+json' || !Array.isArray(image.layers) || image.layers.length > buildLimits.maxFiles) buildFail('RN_BUILD_INVALID');
      const config = parse(await blob(image.config));
      if (typeof config.os !== 'string' || typeof config.architecture !== 'string') buildFail('RN_BUILD_INVALID');
      if (current.platform !== undefined && (current.platform?.os !== config.os || current.platform?.architecture !== config.architecture)) buildFail('RN_BUILD_INVALID');
      const platform = `${config.os}/${config.architecture}`;
      if (!(plan.inputs.platforms as string[]).includes(platform) || platforms.has(platform)) buildFail('RN_BUILD_INVALID');
      platforms.add(platform);
      checkBuildNativeVersion(plan, config.config?.Labels?.['org.opencontainers.image.version'] ?? null);
      for (const layer of image.layers) {
        if (!['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd'].includes(layer.mediaType)) buildFail('RN_BUILD_INVALID');
        await blob(layer, false);
      }
    };
    await inspect(descriptor, 0);
    if (platforms.size !== (plan.inputs.platforms as string[]).length) buildFail('RN_BUILD_OUTPUT');
    artifacts.push({ id: rule.id, kind: 'oci-image', reference: `${plan.fullName.toLowerCase()}@${descriptor.digest}`, digest: descriptor.digest });
  }
  if (files.length !== consumed.size || files.some(file => !consumed.has(file)) || JSON.stringify(await enumerate(root)) !== JSON.stringify(files)) buildFail('RN_BUILD_OUTPUT');
  await verifyFileStates(root, states);
  const manifest: BuildManifest = { schemaVersion: 1, repositoryId: plan.repositoryId, fullName: plan.fullName, buildId: plan.buildId,
    profile: plan.profile, targetSha: plan.targetSha, policySha: plan.policySha, version: plan.version, inputsSha256: plan.inputsSha256, artifacts };
  canonicalBuildManifest(manifest); return manifest;
}
export async function verifyDownloadedOciBuild(plan: BuildPlan, expected: BuildManifest, directory: string): Promise<void> {
  const actual = await collectOciBuildManifest(plan, directory);
  if (canonicalBuildManifest(actual) !== canonicalBuildManifest(expected)) buildFail('RN_BUILD_DIGEST');
}
