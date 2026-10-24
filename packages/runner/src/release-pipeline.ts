import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, copyFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeControlPlane } from './native-control-plane.js';
import { nativeGhCommand, NativeGitHubRelease, type GhCommand } from './gh-release.js';
import { validateReleaseSource, admitReleaseIdentity, type AdmissionInput, type AdmittedUnit } from './release-admission.js';
import { localGitSnapshot } from './managed-sync-preview.js';
import { buildNativeProduct } from './native-product-build.js';
import { selectReleaseProducers, producerArtifactName } from './release-run.js';
import { inspectReleaseArtifacts, sealReleaseArtifacts, verifySealedArtifacts, validateReleaseManifest, fileDigest, type ReleaseManifest } from './release-artifacts.js';
import { nativeReleaseInspector } from './release-native.js';
import { committedVersionNotes, parseSupplementalNotes, renderCommittedReleaseNotes } from '../../core/src/release-template.js';
import { parseRepositoryCatalog, releaseWriteAuthority } from '../../core/src/repository-policy.js';
import { downloadNativeArtifact } from './native-artifact-download.js';

function fail(reason: string): never { throw new Error(`RELEASE_PIPELINE: ${reason}`); }
const positive = (value: string | undefined) => { if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('positive native ID'); return Number(value); };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface PipelineRecord {
  repositoryId: number; fullName: string; releaseId: number; releasePr: number; sourceSha: string; policySha: string;
  observationSha: string; runId: number; attempt: number; mode: 'build' | 'verify'; admitted: AdmittedUnit; toolLocks: Record<string, string>;
}
export async function pipelineIdentity(input: { unit: string; tag: string; releaseId: number; releasePr: number; policySha: string; sourceDirectory: string; policyDirectory: string },
  environment: NodeJS.ProcessEnv = process.env, gh: GhCommand = nativeGhCommand): Promise<PipelineRecord> {
  const repositoryId = positive(environment.GITHUB_REPOSITORY_ID), runId = positive(environment.GITHUB_RUN_ID), attempt = positive(environment.GITHUB_RUN_ATTEMPT);
  const fullName = environment.GITHUB_REPOSITORY!, sourceSha = environment.GITHUB_SHA!;
  if (!/^[a-f0-9]{40}$/.test(input.policySha)) fail('invalid policy SHA');
  const current = await new NativeControlPlane(gh).catalog();
  const policyBytes = await localGitSnapshot.file(input.policyDirectory, input.policySha, 'config/repositories.json');
  if (!policyBytes) fail('missing bound catalog');
  const catalog = parseRepositoryCatalog(JSON.parse(policyBytes.toString('utf8')));
  const admission: AdmissionInput = { repository: fullName, repositoryId, sourceSha, policySha: input.policySha, sourceDirectory: input.sourceDirectory, policyDirectory: input.policyDirectory, centralConfig: catalog };
  const admitted = (await validateReleaseSource(admission)).find(unit => unit.unit.id === input.unit);
  if (!admitted || admitted.tag !== input.tag) fail('unit/tag mapping');
  const get = async (path: string) => JSON.parse(await gh(['api', path]));
  const [repository, release, pull, tag, history] = await Promise.all([
    get(`repos/${fullName}`), get(`repos/${fullName}/releases/${input.releaseId}`), get(`repos/${fullName}/pulls/${input.releasePr}`),
    get(`repos/${fullName}/commits/${encodeURIComponent(input.tag)}`), get(`repos/splrad/steward/compare/${input.policySha}...${current.observationSha}`),
  ]);
  const unitPolicy = catalog.repositories[String(repositoryId)]!.release.units[input.unit]!;
  const boundary = unitPolicy.adoptedAfterTag ? (await get(`repos/${fullName}/commits/${encodeURIComponent(unitPolicy.adoptedAfterTag)}`)).sha : unitPolicy.adoptedFromSha;
  if (!boundary || !/^[a-f0-9]{40}$/.test(boundary)) fail('adoption commit');
  const ancestry = await get(`repos/${fullName}/compare/${boundary}...${sourceSha}`);
  const caller = await localGitSnapshot.file(input.sourceDirectory, sourceSha, '.github/workflows/steward-release-publish.yml');
  if (!caller) fail('missing source caller');
  const mode = admitReleaseIdentity(admission, admitted, { releaseId: input.releaseId, releasePr: input.releasePr }, {
    complete: true, repository: { id: repository.id, fullName: repository.full_name, defaultBranch: repository.default_branch },
    githubSha: sourceSha, githubRef: environment.GITHUB_REF!, resolvedTagSha: tag.sha,
    policyOnProtectedMain: ['ahead', 'identical'].includes(history.status) && history.merge_base_commit?.sha === input.policySha,
    adoptionAncestor: ancestry.status === 'ahead' && ancestry.merge_base_commit?.sha === boundary,
    release: { id: release.id, tag: release.tag_name, draft: release.draft, authorId: release.author?.id }, pull: { number: pull.number, merged: pull.merged,
      mergeSha: pull.merge_commit_sha, baseRef: pull.base?.ref, baseRepositoryId: pull.base?.repo?.id }, caller: caller.toString('utf8'),
  }, current.catalog);
  const toolLocks: Record<string, string> = {};
  for (const [directory, sha, path, key] of [[input.policyDirectory, input.policySha, 'mise.lock', 'policy/mise.lock'],
    [input.sourceDirectory, sourceSha, 'global.json', 'source/global.json']] as const) {
    const bytes = await localGitSnapshot.file(directory, sha, path); if (!bytes) fail('missing native tool lock'); toolLocks[key] = hash(bytes);
  }
  return { repositoryId, fullName, releaseId: input.releaseId, releasePr: input.releasePr, sourceSha, policySha: input.policySha, observationSha: current.observationSha, runId, attempt, mode, admitted, toolLocks };
}
export async function pipelineBuild(record: PipelineRecord, buildId: string, sourceDirectory: string, outputDirectory: string, home: string) {
  if (record.mode !== 'build') fail('verify-only cannot build');
  const report = await buildNativeProduct({ admitted: record.admitted, buildId, sourceSha: record.sourceSha, sourceDirectory, outputDirectory, home });
  return { ...report, artifactName: producerArtifactName({ ...record, unitId: record.admitted.unit.id }, buildId, record.attempt) };
}
async function nativePages(gh: GhCommand, path: string, collection: string) {
  const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', path]));
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page[collection]) || page.total_count !== pages[0].total_count)) fail('pagination');
  const result = pages.flatMap(page => page[collection]);
  if (result.length !== pages[0].total_count || new Set(result.map(item => item.id)).size !== result.length) fail('incomplete pagination');
  return result;
}
export async function pipelineProducers(record: PipelineRecord, gh: GhCommand = nativeGhCommand) {
  if (record.mode !== 'build' || record.attempt > 100) fail('build attempt');
  const run = JSON.parse(await gh(['api', `repos/${record.fullName}/actions/runs/${record.runId}`]));
  if (run.id !== record.runId || run.repository?.id !== record.repositoryId || run.head_repository?.id !== record.repositoryId
    || run.head_sha !== record.sourceSha || run.event !== 'workflow_dispatch' || run.run_attempt !== record.attempt) fail('run identity');
  const jobs: Parameters<typeof selectReleaseProducers>[2]['jobs'] = [];
  for (let attempt = 1; attempt <= record.attempt; attempt++) {
    for (const job of await nativePages(gh, `repos/${record.fullName}/actions/runs/${record.runId}/attempts/${attempt}/jobs?per_page=100`, 'jobs')) {
      const build = record.admitted.unit.builds.find(build => job.name === `publish / build-${build.id}`); if (!build) continue;
      if (job.run_id !== record.runId || job.head_sha !== record.sourceSha) fail('producer job source');
      jobs.push({ id: job.id, runId: job.run_id, attempt, buildId: build.id, sourceSha: job.head_sha, policySha: record.policySha, status: job.status, conclusion: job.conclusion });
    }
  }
  const artifacts = await nativePages(gh, `repos/${record.fullName}/actions/runs/${record.runId}/artifacts?per_page=100`, 'artifacts');
  return selectReleaseProducers(record.admitted.unit, { ...record, unitId: record.admitted.unit.id }, { complete: true, jobs,
    artifacts: artifacts.map(artifact => ({ id: artifact.id, name: artifact.name, runId: artifact.workflow_run?.id, expired: artifact.expired, digest: artifact.digest })) });
}
export async function pipelineCollect(record: PipelineRecord, selection: Awaited<ReturnType<typeof pipelineProducers>>, rawDirectory: string, outputDirectory: string) {
  if (record.mode !== 'build') fail('verify-only cannot collect');
  await mkdir(outputDirectory, { recursive: false });
  const names = record.admitted.assets;
  for (const producer of selection.producers) {
    const build = record.admitted.unit.builds.find(build => build.id === producer.buildId); if (!build) fail('unknown producer');
    const directory = join(rawDirectory, producerArtifactName({ ...record, unitId: record.admitted.unit.id }, build.id, producer.attempt));
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) fail('producer directory');
    const expected = build.expectedArtifacts.map(id => names.find(asset => asset.id === id)!.name).sort();
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) fail('producer file set');
    for (const name of expected) { await fileDigest(directory, name); await copyFile(join(directory, name), join(outputDirectory, name), 1); }
  }
  if (JSON.stringify((await readdir(outputDirectory)).sort()) !== JSON.stringify(names.map(asset => asset.name).sort())) fail('collected file set');
}
export async function pipelineDownloadProducers(record: PipelineRecord, selection: Awaited<ReturnType<typeof pipelineProducers>>, rawDirectory: string, policyDirectory: string, home: string) {
  if (record.mode !== 'build') fail('verify-only cannot download producer assets');
  await mkdir(rawDirectory, { recursive: false }); await mkdir(home, { recursive: false });
  for (const producer of selection.producers) {
    const build = record.admitted.unit.builds.find(item => item.id === producer.buildId); if (!build) fail('unknown producer');
    await downloadNativeArtifact({ fullName: record.fullName, artifactId: producer.artifactId, digest: selection.digests[String(producer.artifactId)]!,
      names: build.expectedArtifacts.map(id => record.admitted.assets.find(asset => asset.id === id)!.name),
      directory: join(rawDirectory, producerArtifactName({ ...record, unitId: record.admitted.unit.id }, build.id, producer.attempt)),
      policyDirectory, home: join(home, String(producer.artifactId)) });
  }
}
export async function pipelineNotes(record: PipelineRecord, sourceDirectory: string, policyDirectory: string) {
  const read = async (directory: string, sha: string, path: string) => { const bytes = await localGitSnapshot.file(directory, sha, path); if (!bytes) fail('missing notes input'); return bytes.toString('utf8'); };
  const catalog = parseRepositoryCatalog(JSON.parse(await read(policyDirectory, record.policySha, 'config/repositories.json')));
  const policy = catalog.repositories[String(record.repositoryId)];
  if (!policy || policy.fullName !== record.fullName) fail('notes repository');
  const unit = record.admitted.unit, unitPolicy = policy.release.units[record.admitted.unit.id];
  if (!unitPolicy) fail('notes unit');
  const channels = unit.channels.map(channel => {
    const configured = unitPolicy.channels[channel.id];
    if (!configured || configured.kind !== channel.kind) fail('notes channel');
    return { name: channel.id, status: '待分发' as const, location: configured.destination };
  });
  const supplemental = parseSupplementalNotes(await read(sourceDirectory, record.sourceSha, unit.notesPath));
  const versionNotes = committedVersionNotes(await read(sourceDirectory, record.sourceSha, unit.changelogPath), record.admitted.version, record.fullName, record.sourceSha, record.admitted.tag);
  const template = await read(policyDirectory, record.policySha, 'config/templates/release.md.mustache');
  if (hash(Buffer.from(template)) !== record.admitted.templateSha256) fail('template digest');
  return renderCommittedReleaseNotes(template, { ...supplemental, ...versionNotes, productName: unit.displayName, version: record.admitted.version,
    sourceSha: record.sourceSha, policySha: record.policySha,
    downloads: record.admitted.assets.map(asset => `- [${asset.name}](https://github.com/${record.fullName}/releases/download/${encodeURIComponent(record.admitted.tag)}/${asset.name})`).join('\n'),
    channels });
}
export async function pipelineInspect(record: PipelineRecord, selection: Awaited<ReturnType<typeof pipelineProducers>>, directory: string, policyDirectory: string, home: string) {
  if (record.mode !== 'build') fail('verify-only cannot inspect new assets');
  await mkdir(home, { recursive: false });
  const inspector = nativeReleaseInspector(join(policyDirectory, 'scripts/inspect-native-release.ps1'), home);
  return inspectReleaseArtifacts(record.admitted.unit, directory, { repositoryId: record.repositoryId, fullName: record.fullName, unitId: record.admitted.unit.id,
    version: record.admitted.version, packageVersion: record.admitted.packageVersion, tag: record.admitted.tag, sourceSha: record.sourceSha, policySha: record.policySha,
    descriptorSha256: record.admitted.descriptorSha256, templateSha256: record.admitted.templateSha256, runId: record.runId, attempt: record.attempt,
    toolLocks: record.toolLocks, producers: selection.producers }, file => inspector.inspectPath!(file) as Promise<string | { resourceOnly: 'font-archive' }>);
}
export async function pipelineSeal(directory: string, pending: ReleaseManifest) { return sealReleaseArtifacts(directory, pending); }
export async function pipelinePublish(record: PipelineRecord, directory: string, gh: GhCommand = nativeGhCommand) {
  const manifest = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8')); validateReleaseManifest(manifest);
  if (manifest.repositoryId !== record.repositoryId || manifest.fullName !== record.fullName || manifest.unitId !== record.admitted.unit.id
    || manifest.sourceSha !== record.sourceSha || manifest.policySha !== record.policySha || manifest.tag !== record.admitted.tag
    || manifest.descriptorSha256 !== record.admitted.descriptorSha256 || manifest.templateSha256 !== record.admitted.templateSha256) fail('final manifest identity');
  if (record.mode === 'build' && (manifest.runId !== record.runId || manifest.attempt > record.attempt)) fail('final manifest run');
  await verifySealedArtifacts(directory, manifest);
  const release = new NativeGitHubRelease(gh), target = { manifest, directory, releaseId: record.releaseId };
  if (record.mode === 'verify') return release.verify(target);
  return release.publish(target, async () => {
    const current = await new NativeControlPlane(gh).catalog();
    releaseWriteAuthority(current.catalog, record.repositoryId, record.fullName, record.admitted.unit.id, record.policySha);
  });
}
export async function pipelineVerifyPublished(record: PipelineRecord, directory: string, gh: GhCommand = nativeGhCommand) {
  await mkdir(directory, { recursive: false });
  const release = JSON.parse(await gh(['api', `repos/${record.fullName}/releases/${record.releaseId}`]));
  if (release.id !== record.releaseId || release.tag_name !== record.admitted.tag || release.draft !== false || release.immutable !== true) fail('published release identity');
  await gh(['release', 'download', record.admitted.tag, '--repo', record.fullName, '--dir', directory]);
  return pipelinePublish({ ...record, mode: 'verify' }, directory, gh);
}
export async function pipelineDownloadPhase(record: PipelineRecord, artifactId: number, digest: string, phase: 'collected' | 'final', directory: string, policyDirectory: string, home: string, gh: GhCommand = nativeGhCommand) {
  if (!['collected', 'final'].includes(phase) || !Number.isSafeInteger(artifactId) || artifactId < 1) fail('phase artifact identity');
  const artifact = JSON.parse(await gh(['api', `repos/${record.fullName}/actions/artifacts/${artifactId}`]));
  const prefix = `${phase}-${record.repositoryId}-${record.admitted.unit.id}-${record.sourceSha}-${record.runId}-`;
  const attempt = typeof artifact.name === 'string' && artifact.name.startsWith(prefix) ? artifact.name.slice(prefix.length) : '';
  if (artifact.id !== artifactId || artifact.workflow_run?.id !== record.runId || artifact.workflow_run?.head_sha !== record.sourceSha || artifact.expired !== false
    || !/^[1-9][0-9]*$/.test(attempt) || Number(attempt) > record.attempt || artifact.digest !== digest) fail('phase artifact source');
  const names = record.admitted.assets.map(asset => asset.name);
  if (phase === 'final') names.push('sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS');
  await downloadNativeArtifact({ fullName: record.fullName, artifactId, digest, names, directory, policyDirectory, home });
  if (phase === 'final') {
    const manifest = JSON.parse(await readFile(join(directory, 'artifact-manifest.json'), 'utf8')); validateReleaseManifest(manifest);
    if (manifest.runId !== record.runId || manifest.attempt !== Number(attempt) || manifest.sourceSha !== record.sourceSha || manifest.policySha !== record.policySha
      || manifest.repositoryId !== record.repositoryId || manifest.fullName !== record.fullName || manifest.unitId !== record.admitted.unit.id || manifest.tag !== record.admitted.tag
      || manifest.version !== record.admitted.version || manifest.packageVersion !== record.admitted.packageVersion
      || manifest.descriptorSha256 !== record.admitted.descriptorSha256 || manifest.templateSha256 !== record.admitted.templateSha256
      || JSON.stringify(manifest.toolLocks) !== JSON.stringify(record.toolLocks)) fail('downloaded manifest identity');
    await verifySealedArtifacts(directory, manifest);
  }
  return { artifactId, digest, phase, producerAttempt: Number(attempt) };
}

/** A previously uploaded final set is immutable even when its job response was lost. */
export async function findFrozenFinal(record: PipelineRecord, gh: GhCommand = nativeGhCommand) {
  if (record.mode !== 'build') fail('verify-only cannot recover build artifacts');
  const artifacts = await nativePages(gh, `repos/${record.fullName}/actions/runs/${record.runId}/artifacts?per_page=100`, 'artifacts');
  const prefix = `final-${record.repositoryId}-${record.admitted.unit.id}-${record.sourceSha}-${record.runId}-`;
  const candidates = artifacts.filter(artifact => typeof artifact.name === 'string' && artifact.name.startsWith(prefix));
  if (!candidates.length) return null;
  if (candidates.length !== 1) fail('ambiguous frozen final set');
  const candidate = candidates[0], attempt = candidate.name.slice(prefix.length);
  if (!Number.isSafeInteger(candidate.id) || candidate.id < 1 || candidate.workflow_run?.id !== record.runId
    || candidate.workflow_run?.head_sha !== record.sourceSha || candidate.expired !== false
    || !/^[1-9][0-9]*$/.test(attempt) || Number(attempt) > record.attempt || !/^sha256:[a-f0-9]{64}$/.test(candidate.digest)) fail('frozen final identity');
  // Build jobs can upload artifacts too: bind recovery to the completed trusted
  // inspect job's server timestamps, after every product build has terminated.
  const jobs = await nativePages(gh, `repos/${record.fullName}/actions/runs/${record.runId}/attempts/${attempt}/jobs?per_page=100`, 'jobs');
  const inspections = jobs.filter(job => job.name === 'publish / inspect');
  if (inspections.length !== 1) fail('frozen inspect job identity');
  const inspection = inspections[0], created = Date.parse(candidate.created_at), started = Date.parse(inspection.started_at), completed = Date.parse(inspection.completed_at);
  if (inspection.run_id !== record.runId || inspection.head_sha !== record.sourceSha || inspection.status !== 'completed'
    || ![created, started, completed].every(Number.isFinite) || started >= created || created > completed || Number(attempt) >= record.attempt) fail('frozen inspect job provenance');
  return { artifactId: candidate.id as number, digest: candidate.digest as string };
}
export async function pipelineRecoverFinal(record: PipelineRecord, directory: string, policyDirectory: string, home: string, gh: GhCommand = nativeGhCommand) {
  const frozen = await findFrozenFinal(record, gh);
  if (!frozen) return { found: false as const };
  await pipelineDownloadPhase(record, frozen.artifactId, frozen.digest, 'final', directory, policyDirectory, home, gh);
  return { found: true as const, ...frozen };
}
