import { expect, it } from 'vitest';
import { selectReleaseProducers, producerArtifactName, assertReleaseJobResults, type RunIdentity, type ProducerJob, type ProducerArtifact } from '../src/release-run.js';
import type { ReleaseUnit } from '../../core/src/release-descriptor.js';
const unit = { id: 'app', builds: [{ id: 'windows' }, { id: 'linux' }] } as ReleaseUnit;
const identity: RunIdentity = { repositoryId: 1, unitId: 'app', sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), runId: 42, attempt: 2 };
const job = (buildId: string, attempt: number, conclusion = 'success'): ProducerJob => ({ id: attempt * 10 + (buildId === 'windows' ? 1 : 2), runId: 42, attempt, buildId, sourceSha: identity.sourceSha, policySha: identity.policySha, status: 'completed', conclusion });
const artifact = (buildId: string, attempt: number): ProducerArtifact => ({ id: attempt * 100 + (buildId === 'windows' ? 1 : 2), runId: 42, name: producerArtifactName(identity, buildId, attempt), expired: false, digest: 'sha256:' + 'c'.repeat(64) });
function observation() { return { complete: true, jobs: [job('windows', 1), job('linux', 1, 'failure'), job('linux', 2)], artifacts: [artifact('windows', 1), artifact('linux', 2)] }; }
it('retains successful rows from earlier attempts in the same run', () => {
  const result = selectReleaseProducers(unit, identity, observation());
  expect(result.producers.map(p => [p.buildId, p.attempt, p.artifactId])).toEqual([['windows', 1, 101], ['linux', 2, 202]]);
  expect(selectReleaseProducers(unit, identity, { ...observation(), frozen: result })).toEqual(result);
});
it('selects the last successful result and refuses to replace frozen producers', () => {
  const input = observation(), frozen = selectReleaseProducers(unit, identity, input);
  input.jobs.push(job('windows', 2)); input.artifacts.push(artifact('windows', 2));
  expect(selectReleaseProducers(unit, identity, input).producers[0]!.artifactId).toBe(201);
  expect(() => selectReleaseProducers(unit, identity, { ...input, frozen })).toThrow('frozen');
});
it.each(['partial', 'cross-run', 'source', 'policy', 'expired', 'missing', 'duplicate-artifact', 'duplicate-job', 'cancelled', 'future', 'digest', 'active'])('rejects %s producer evidence', kind => {
  const input = observation();
  if (kind === 'partial') input.complete = false;
  if (kind === 'cross-run') input.artifacts[0]!.runId++;
  if (kind === 'source') input.jobs[0]!.sourceSha = 'd'.repeat(40);
  if (kind === 'policy') input.jobs[0]!.policySha = 'd'.repeat(40);
  if (kind === 'expired') input.artifacts[0]!.expired = true;
  if (kind === 'missing') input.artifacts.pop();
  if (kind === 'duplicate-artifact') input.artifacts.push({ ...input.artifacts[0]!, id: 999 });
  if (kind === 'duplicate-job') input.jobs.push({ ...input.jobs[0]!, id: 999 });
  if (kind === 'cancelled') input.jobs[0]!.conclusion = 'cancelled';
  if (kind === 'future') input.jobs[0]!.attempt = 3;
  if (kind === 'digest') input.artifacts[0]!.digest = 'unknown';
  if (kind === 'active') input.jobs[0]!.status = 'in_progress';
  expect(() => selectReleaseProducers(unit, identity, input)).toThrow('RELEASE_RUN');
});
it('allows only deliberate signing skips and verify-only production skips', () => {
  const results = { identity: 'success', build: 'success', collect: 'success', sign: 'skipped', inspect: 'success', attest: 'success', publish: 'success' };
  expect(() => assertReleaseJobResults('build', 'none', results)).not.toThrow();
  for (const key of ['identity', 'build', 'collect', 'inspect', 'attest', 'publish']) {
    for (const status of ['skipped', 'failure', 'cancelled', '']) expect(() => assertReleaseJobResults('build', 'none', { ...results, [key]: status })).toThrow();
  }
  expect(() => assertReleaseJobResults('build', 'authenticode', results)).toThrow();
  expect(() => assertReleaseJobResults('verify', 'none', { identity: 'success', build: 'skipped', collect: 'skipped', sign: 'skipped', inspect: 'skipped', attest: 'skipped', publish: 'skipped' })).not.toThrow();
});
