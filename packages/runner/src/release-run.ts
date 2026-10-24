import type { ReleaseIdentity } from './release-artifacts.js';
import type { ReleaseUnit } from '../../core/src/release-descriptor.js';

export interface RunIdentity { repositoryId: number; unitId: string; sourceSha: string; policySha: string; runId: number; attempt: number }
export interface ProducerJob { id: number; runId: number; attempt: number; buildId: string; sourceSha: string; policySha: string; status: string; conclusion: string | null }
export interface ProducerArtifact { id: number; runId: number; name: string; expired: boolean; digest: string }
function fail(reason: string): never { throw new Error(`RELEASE_RUN: ${reason}`); }
export function producerArtifactName(identity: RunIdentity, buildId: string, attempt: number): string {
  return `release-${identity.repositoryId}-${identity.unitId}-${buildId}-${identity.sourceSha}-${identity.runId}-${attempt}`;
}
/** Select IDs from complete native job/artifact inventories, never from name search order. */
export function selectReleaseProducers(unit: ReleaseUnit, identity: RunIdentity, input: {
  complete: boolean; jobs: ProducerJob[]; artifacts: ProducerArtifact[];
  frozen?: { producers: ReleaseIdentity['producers']; digests: Record<string, string> };
}): { producers: ReleaseIdentity['producers']; digests: Record<string, string> } {
  if (!input.complete || unit.id !== identity.unitId || ![identity.repositoryId, identity.runId, identity.attempt].every(n => Number.isSafeInteger(n) && n > 0)
    || ![identity.sourceSha, identity.policySha].every(sha => /^[a-f0-9]{40}$/.test(sha))) fail('identity or incomplete inventory');
  if (new Set(input.jobs.map(job => job.id)).size !== input.jobs.length || new Set(input.artifacts.map(artifact => artifact.id)).size !== input.artifacts.length) fail('duplicate native ID');
  const producers: ReleaseIdentity['producers'] = [], digests: Record<string, string> = {};
  for (const build of unit.builds) {
    const jobs = input.jobs.filter(job => job.buildId === build.id);
    if (jobs.some(job => job.runId !== identity.runId || job.sourceSha !== identity.sourceSha || job.policySha !== identity.policySha
      || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.attempt > identity.attempt || !Number.isSafeInteger(job.id) || job.id < 1)) fail('producer source identity');
    if (new Set(jobs.map(job => job.attempt)).size !== jobs.length) fail('ambiguous job attempt');
    const job = jobs.filter(job => job.status === 'completed' && job.conclusion === 'success').sort((a, b) => b.attempt - a.attempt)[0];
    if (!job) fail('missing successful build');
    if (jobs.some(other => other.status !== 'completed' && other.attempt >= job.attempt)) fail('producer still active');
    const matches = input.artifacts.filter(artifact => artifact.name === producerArtifactName(identity, build.id, job.attempt));
    if (matches.length !== 1) fail('missing or duplicate producer artifact');
    const artifact = matches[0]!;
    if (artifact.runId !== identity.runId || artifact.expired || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      || !Number.isSafeInteger(artifact.id) || artifact.id < 1) fail('artifact source or digest');
    producers.push({ buildId: build.id, jobId: job.id, attempt: job.attempt, artifactId: artifact.id }); digests[String(artifact.id)] = artifact.digest;
  }
  const result = { producers, digests };
  if (input.frozen && JSON.stringify(input.frozen) !== JSON.stringify(result)) fail('frozen release producers changed');
  return result;
}

export function assertReleaseJobResults(mode: 'build' | 'verify', signing: ReleaseUnit['signingPolicy'], results: Record<string, string>) {
  if (results.identity !== 'success') fail('identity did not succeed');
  const production = ['build', 'collect', 'sign', 'inspect', 'attest', 'publish'];
  for (const job of production) {
    const expected = mode === 'verify' || (job === 'sign' && signing === 'none') ? 'skipped' : 'success';
    if (results[job] !== expected) fail(`unexpected ${job} result`);
  }
}
