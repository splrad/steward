import * as downloads from '../src/native-artifact-download.js';
import { sealReleaseArtifacts, fileDigest, type ReleaseManifest } from '../src/release-artifacts.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipelineRecoverFinal, findFrozenFinal, pipelineProducers, pipelineCollect, type PipelineRecord } from '../src/release-pipeline.js';
import { producerArtifactName } from '../src/release-run.js';
import type { GhCommand } from '../src/gh-release.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
const record: PipelineRecord = { repositoryId: 1, fullName: 'fixture/product', releaseId: 3, releasePr: 4, sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), observationSha: 'c'.repeat(40), runId: 42, attempt: 2, mode: 'build', toolLocks: { mise: 'd'.repeat(64) },
  admitted: { version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', descriptorSha256: 'e'.repeat(64), templateSha256: 'f'.repeat(64), assets: [{ id: 'app', name: 'app.exe' }],
    unit: { id: 'app', displayName: 'App', path: '.', releasePleasePath: '.', ecosystem: 'native', versionFile: 'VERSION', changelogPath: 'CHANGELOG.md', notesPath: '.release-notes/app.md', signingPolicy: 'none', channels: [], artifacts: [{ id: 'app', file: 'app.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', build: 'windows', required: true }], builds: [{ id: 'windows', os: 'windows', arch: 'x64', entrypoint: 'build.ps1', args: [], expectedArtifacts: ['app'] }] } } };
function observation() {
  const run = { id: 42, repository: { id: 1 }, head_repository: { id: 1 }, head_sha: record.sourceSha, event: 'workflow_dispatch', run_attempt: 2 };
  const first = { total_count: 1, jobs: [{ id: 11, name: 'publish / build-windows', run_id: 42, head_sha: record.sourceSha, status: 'completed', conclusion: 'success' }] };
  const second = { total_count: 1, jobs: [{ id: 21, name: 'publish / build-windows', run_id: 42, head_sha: record.sourceSha, status: 'completed', conclusion: 'failure' }] };
  const artifacts = { total_count: 1, artifacts: [{ id: 100, name: producerArtifactName({ ...record, unitId: 'app' }, 'windows', 1), workflow_run: { id: 42 }, expired: false, digest: 'sha256:' + 'c'.repeat(64) }] };
  const calls: readonly string[][] = [];
  const gh: GhCommand = async args => {
    (calls as string[][]).push([...args]); const path = args.at(-1)!;
    if (path.endsWith('/42')) return JSON.stringify(run);
    if (path.includes('/attempts/1/jobs')) return JSON.stringify([first]);
    if (path.includes('/attempts/2/jobs')) return JSON.stringify([second]);
    if (path.includes('/artifacts?')) return JSON.stringify([artifacts]);
    throw new Error('Unexpected API');
  };
  return { run, first, second, artifacts, gh, calls };
}
it('selects native IDs from all attempts and retains the last successful producer', async () => {
  const f = observation(), selection = await pipelineProducers(record, f.gh);
  expect(selection.producers).toEqual([{ buildId: 'windows', jobId: 11, attempt: 1, artifactId: 100 }]);
  expect(f.calls).toHaveLength(4);
  expect(f.calls.every(call => call[0] === 'api' && !call.includes('--method'))).toBe(true);
  const root = await mkdtemp(join(tmpdir(), 'pipeline-')); roots.push(root);
  const raw = join(root, 'raw'), producer = join(raw, f.artifacts.artifacts[0]!.name); await mkdir(producer, { recursive: true });
  await writeFile(join(producer, 'app.exe'), 'fixture bytes');
  await pipelineCollect(record, selection, raw, join(root, 'out'));
  expect(await readFile(join(root, 'out/app.exe'), 'utf8')).toBe('fixture bytes');
  await writeFile(join(producer, 'unexpected.txt'), 'extra');
  await expect(pipelineCollect(record, selection, raw, join(root, 'bad'))).rejects.toThrow('producer file set');
});
it.each(['run', 'repository', 'fork', 'sha', 'event', 'attempt', 'job-source', 'partial-jobs', 'partial-artifacts', 'artifact-run', 'cancelled', 'verify'])('blocks %s evidence', async kind => {
  const f = observation(), input = structuredClone(record);
  if (kind === 'run') f.run.id++;
  if (kind === 'repository') f.run.repository.id++;
  if (kind === 'fork') f.run.head_repository.id++;
  if (kind === 'sha') f.run.head_sha = 'd'.repeat(40);
  if (kind === 'event') f.run.event = 'pull_request';
  if (kind === 'attempt') f.run.run_attempt++;
  if (kind === 'job-source') f.first.jobs[0]!.head_sha = 'd'.repeat(40);
  if (kind === 'partial-jobs') f.first.total_count++;
  if (kind === 'partial-artifacts') f.artifacts.total_count++;
  if (kind === 'artifact-run') f.artifacts.artifacts[0]!.workflow_run.id++;
  if (kind === 'cancelled') f.first.jobs[0]!.conclusion = 'cancelled';
  if (kind === 'verify') input.mode = 'verify';
  await expect(pipelineProducers(input, f.gh)).rejects.toThrow();
});

it.each(['present', 'absent', 'expired', 'duplicate', 'wrong-run', 'wrong-source', 'future-attempt', 'digest', 'partial', 'build-upload', 'ambiguous-time', 'wrong-inspector', 'active-inspector'])('frozen final discovery handles %s without regenerating bytes', async kind => {
  const name = `final-1-app-${record.sourceSha}-42-1`;
  const artifact = { id: 101, name, created_at: '2026-10-24T01:01:00Z', digest: 'sha256:' + 'e'.repeat(64), expired: false, workflow_run: { id: 42, head_sha: record.sourceSha } };
  const page = { total_count: 1, artifacts: [artifact] };
  if (kind === 'absent') { page.total_count = 0; page.artifacts = []; }
  if (kind === 'expired') artifact.expired = true;
  if (kind === 'duplicate') { page.artifacts.push({ ...artifact, id: 102 }); page.total_count = 2; }
  if (kind === 'wrong-run') artifact.workflow_run.id++;
  if (kind === 'wrong-source') artifact.workflow_run.head_sha = 'f'.repeat(40);
  if (kind === 'future-attempt') artifact.name = name.slice(0, -1) + '3';
  if (kind === 'digest') artifact.digest = '';
  if (kind === 'partial') page.total_count++;
  const inspection = { id: 44, name: 'publish / inspect', run_id: 42, head_sha: record.sourceSha, status: 'completed', started_at: '2026-10-24T01:00:00Z', completed_at: '2026-10-24T01:02:00Z' };
  if (kind === 'build-upload') artifact.created_at = '2026-10-24T00:59:59Z';
  if (kind === 'ambiguous-time') artifact.created_at = inspection.started_at;
  if (kind === 'wrong-inspector') inspection.name = 'publish / build-windows';
  if (kind === 'active-inspector') inspection.status = 'in_progress';
  const calls: string[][] = [];
  const gh: GhCommand = async args => { calls.push([...args]); return JSON.stringify([args.at(-1)!.includes('/jobs?') ? { total_count: 1, jobs: [inspection] } : page]); };
  if (kind === 'present') expect(await findFrozenFinal(record, gh)).toEqual({ artifactId: 101, digest: artifact.digest });
  else if (kind === 'absent') expect(await findFrozenFinal(record, gh)).toBeNull();
  else await expect(findFrozenFinal(record, gh)).rejects.toThrow();
  expect(calls[0]).toEqual(['api', '--paginate', '--slurp', 'repos/fixture/product/actions/runs/42/artifacts?per_page=100']);
  expect(calls.every(call => call[0] === 'api' && !call.includes('--method'))).toBe(true);
});

it.each(['valid', 'tampered-bytes', 'different-policy', 'different-descriptor'])('recovers and verifies frozen final bytes: %s', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-final-')); roots.push(root);
  const original = join(root, 'original'); await mkdir(original);
  await writeFile(join(original, 'app.exe'), 'original producer bytes');
  await writeFile(join(original, 'sbom.spdx.json'), '{"spdxVersion":"SPDX-2.3","SPDXID":"SPDXRef-DOCUMENT","packages":[]}');
  await writeFile(join(original, 'release-notes.md'), `# App 1.2.3\n${record.sourceSha}\n${kind === 'different-policy' ? 'f'.repeat(40) : record.policySha}\n`);
  const pending: ReleaseManifest = { schemaVersion: 2, repositoryId: record.repositoryId, fullName: record.fullName, unitId: 'app', version: '1.2.3', packageVersion: '1.2.3',
    tag: record.admitted.tag, sourceSha: record.sourceSha, policySha: kind === 'different-policy' ? 'f'.repeat(40) : record.policySha,
    descriptorSha256: kind === 'different-descriptor' ? 'a'.repeat(64) : record.admitted.descriptorSha256, templateSha256: record.admitted.templateSha256,
    runId: 42, attempt: 1, toolLocks: record.toolLocks, producers: [{ buildId: 'windows', jobId: 11, attempt: 1, artifactId: 100 }],
    artifacts: [{ id: 'app', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', ...await fileDigest(original, 'app.exe') }], evidence: [] };
  await sealReleaseArtifacts(original, pending);
  const frozen = { id: 101, created_at: '2026-10-24T01:01:00Z', name: `final-1-app-${record.sourceSha}-42-1`, digest: 'sha256:' + 'e'.repeat(64), expired: false, workflow_run: { id: 42, head_sha: record.sourceSha } };
  const gh: GhCommand = async args => JSON.stringify(args.at(-1)!.includes('/jobs?') ? [{ total_count: 1, jobs: [{ id: 44, name: 'publish / inspect', run_id: 42, head_sha: record.sourceSha, status: 'completed', started_at: '2026-10-24T01:00:00Z', completed_at: '2026-10-24T01:02:00Z' }] }] : args.includes('--paginate') ? [{ total_count: 1, artifacts: [frozen] }] : frozen);
  const download = vi.spyOn(downloads, 'downloadNativeArtifact').mockImplementation(async input => {
    expect(input.artifactId).toBe(101); expect(input.digest).toBe(frozen.digest);
    await mkdir(input.directory);
    for (const name of await readdir(original)) await copyFile(join(original, name), join(input.directory, name));
    if (kind === 'tampered-bytes') await writeFile(join(input.directory, 'app.exe'), 'regenerated different bytes');
  });
  const output = join(root, 'recovered');
  if (kind === 'valid') {
    expect(await pipelineRecoverFinal(record, output, root, join(root, 'home'), gh)).toEqual({ found: true, artifactId: 101, digest: frozen.digest });
    for (const name of await readdir(original)) expect(await readFile(join(output, name))).toEqual(await readFile(join(original, name)));
    expect(JSON.parse(await readFile(join(output, 'artifact-manifest.json'), 'utf8')).attempt).toBe(1);
  } else await expect(pipelineRecoverFinal(record, output, root, join(root, 'home'), gh)).rejects.toThrow();
  expect(download).toHaveBeenCalledOnce();
});
