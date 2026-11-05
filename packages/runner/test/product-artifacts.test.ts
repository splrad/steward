import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipelineIdentity, pipelineRecoverFinal, pipelineRecoverCycleFinal } from '../src/release-pipeline.js';
import { nativeRequestIdentity } from '../src/native-release-evidence.js';
import { pipelineSource } from '../src/release-pipeline-record.js';
import { inspectProductArtifacts, sealProductArtifacts, verifySealedArtifacts, validateProductManifest } from '../src/release-artifacts.js';
import { productPipelineFixture } from './product-pipeline-fixture.js';
import { fixtureNativePages } from './native-pagination-fixture.js';
import * as downloads from '../src/native-artifact-download.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const f = productPipelineFixture(), admission = await pipelineIdentity(f.input, f.environment, f.gh, f.io);
  if (admission.status !== 'ADMITTED') throw new Error('fixture admission');
  const record = admission.record, root = await mkdtemp(join(tmpdir(), 'product-final-')); roots.push(root);
  const directory = join(root, 'final'); await mkdir(directory);
  await writeFile(join(directory, 'app-1.0.0.exe'), 'original native producer bytes; metadata parser has its separate real PE fixture');
  const unit = record.delivery.units[0]!;
  const identity = { repositoryId: record.repositoryId, fullName: record.fullName, cycleId: record.cycleId, requestKey: record.requestKey, unitId: unit.id,
    sourceSha: record.sourceSha, controllerSha: record.controllerSha, buildRef: record.buildRef, version: '1.0.0', packageVersion: '1.0.0', tag: 'v1.0.0',
    deliverySha256: record.deliverySha256, templateSha256: record.templateSha256, runId: 100, attempt: 1, toolLocks: record.toolLocks,
    producers: [{ buildId: 'windows-x64', jobId: 101, attempt: 1, artifactId: 201 }] };
  return { record, root, directory, unit, identity, native: f };
}
it.each(['same-attempt', 'later-attempt', 'continuation', 'tampered', 'controller', 'asset-set', 'future-producer'])('reuses the exact schema 3 frozen artifact: %s', async kind => {
  const f = await fixture();
  const pending = await inspectProductArtifacts(f.unit, f.directory, f.identity, async () => '1.0.0');
  if (kind === 'controller') pending.controllerSha = 'e'.repeat(40);
  if (kind === 'future-producer') pending.producers[0]!.attempt = 2;
  await writeFile(join(f.directory, 'sbom.spdx.json'), '{"spdxVersion":"SPDX-2.3","SPDXID":"SPDXRef-DOCUMENT","packages":[]}');
  await writeFile(join(f.directory, 'release-notes.md'), `Fixture 1.0.0 ${pending.sourceSha} ${pending.controllerSha}`);
  const manifest = await sealProductArtifacts(f.directory, pending);
  await verifySealedArtifacts(f.directory, manifest);
  const final = { id: 202, name: `final-1-app-${f.record.sourceSha}-100-1`, created_at: '2026-10-26T00:01:00Z', digest: 'sha256:' + 'd'.repeat(64), expired: false, workflow_run: { id: 100, head_sha: f.record.sourceSha } };
  const gh = async (args: readonly string[]) => JSON.stringify(args.at(-1)!.includes('/jobs?')
    ? [{ total_count: 1, jobs: [{ id: 102, name: 'freeze/app', run_id: 100, head_sha: f.record.sourceSha, status: 'completed', started_at: '2026-10-26T00:00:00Z', completed_at: '2026-10-26T00:02:00Z' }] }]
    : args.includes('--paginate') ? [{ total_count: 1, artifacts: [final] }] : final);
  const download = vi.spyOn(downloads, 'downloadNativeArtifact').mockImplementation(async input => {
    expect(input.artifactId).toBe(202); expect(input.digest).toBe(final.digest);
    await mkdir(input.directory); for (const name of await readdir(f.directory)) await copyFile(join(f.directory, name), join(input.directory, name));
    if (kind === 'tampered') await writeFile(join(input.directory, 'app-1.0.0.exe'), 'rebuilt different bytes');
    if (kind === 'asset-set') await writeFile(join(input.directory, 'extra.txt'), 'extra');
  });
  if (kind === 'later-attempt') f.record.runAttempt = 2;
  const recovered = join(f.root, 'recovered');
  if (['same-attempt', 'later-attempt', 'continuation'].includes(kind)) {
    if (kind === 'continuation') {
      const cycle = f.native.context.cycle, request = { ...structuredClone(f.native.request), canonicalRunId: 200, continuationOfRunId: 100 };
      Object.assign(request, nativeRequestIdentity(1, cycle, request)); request.inputs.operation_key = request.operationKey; cycle.dispatches.push(request);
      f.record.runId = 200; f.record.requestKey = request.requestKey;
      const current = { ...structuredClone(f.native.runs.get(1)), id: 200, display_title: `Build ${request.operationKey}` };
      const original = { ...structuredClone(f.native.runs.get(1)), status: 'completed', conclusion: 'failure' };
      const nativeGh = async (args: readonly string[]) => args.at(-1)!.endsWith('users/splrad-steward%5Bbot%5D') ? f.native.gh(args)
        : args.at(-1)!.endsWith('/actions/runs/200') ? JSON.stringify(current) : args.at(-1)!.endsWith('/actions/runs/100') ? JSON.stringify(original) : gh(args);
      const pages = async (path: string, collection: 'jobs' | 'artifacts') => path.includes('/runs/200/') ? [] : fixtureNativePages(gh)(path, collection);
      expect(await pipelineRecoverCycleFinal(f.record, 'app', cycle, recovered, f.root, join(f.root, 'home'), nativeGh, pages))
        .toEqual({ found: true, artifactId: 202, digest: final.digest, producerRunId: 100 });
    } else expect(await pipelineRecoverFinal(pipelineSource(f.record, 'app'), recovered, f.root, join(f.root, 'home'), gh, fixtureNativePages(gh))).toEqual({ found: true, artifactId: 202, digest: final.digest });
    for (const name of await readdir(f.directory)) expect(await readFile(join(recovered, name))).toEqual(await readFile(join(f.directory, name)));
    expect(JSON.parse(await readFile(join(recovered, 'artifact-manifest.json'), 'utf8')).attempt).toBe(1);
  } else await expect(pipelineRecoverFinal(pipelineSource(f.record, 'app'), recovered, f.root, join(f.root, 'home'), gh, fixtureNativePages(gh))).rejects.toThrow();
  expect(download).toHaveBeenCalledOnce();
});
it.each(['wrong-version', 'absent-producer', 'mutated-source', 'future-producer'])('new inspection rejects %s', async kind => {
  const f = await fixture();
  if (kind === 'absent-producer') f.identity.producers = [];
  if (kind === 'future-producer') f.identity.producers[0]!.attempt = 2;
  await expect(inspectProductArtifacts(f.unit, f.directory, f.identity, async () => {
    if (kind === 'mutated-source') await writeFile(join(f.directory, 'app-1.0.0.exe'), 'changed');
    return kind === 'wrong-version' ? '2.0.0' : '1.0.0';
  })).rejects.toThrow();
});
it('freezes caller metadata during inspection and rejects unknown manifest fields', async () => {
  const f = await fixture(), expected = f.identity.sourceSha;
  const manifest = await inspectProductArtifacts(f.unit, f.directory, f.identity, async () => { f.identity.sourceSha = 'e'.repeat(40); return '1.0.0'; });
  expect(manifest.sourceSha).toBe(expected);
  expect(() => validateProductManifest({ ...manifest, command: 'untrusted' })).toThrow('schema');
});
