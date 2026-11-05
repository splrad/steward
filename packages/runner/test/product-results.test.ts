import { expect, it } from 'vitest';
import { evidenceFixture, NOW } from './native-evidence-fixture.js';
import { productBusinessResults } from '../src/release-run.js';
import { nativeRunFact, jobFact, inspectNativeCycle } from '../src/native-release-evidence.js';
it.each(['success', 'failure', 'cancelled', 'skipped'])('binds %s receipt to the actual native business step', conclusion => {
  const f = evidenceFixture(); f.jobs.get(1)![0].steps[0].conclusion = conclusion;
  const results = productBusinessResults(f.context, f.request, nativeRunFact(f.runs.get(1)), jobFact(f.jobs.get(1)![0]), 'app', NOW);
  expect(results).toHaveLength(1);
  expect(results[0]!.execution).toMatchObject({ jobId: 1000, runId: 100, runAttempt: 1, businessStartedProven: conclusion !== 'skipped',
    outcome: conclusion === 'success' ? 'EFFECT_CONFIRMED' : conclusion === 'skipped' ? 'REJECTED_BEFORE_BUSINESS' : 'BUSINESS_FAILED' });
  expect(results[0]!.execution.invocationKey).toBe(f.results.get(1)!.execution.invocationKey);
});
it('a completed read guard returning UNKNOWN is zero business, with the native failed step preserved', () => {
  const f = evidenceFixture();
  const results = productBusinessResults(f.context, f.request, nativeRunFact(f.runs.get(1)), jobFact(f.jobs.get(1)![0]), 'app', NOW, [], [2]);
  expect(results[0]!.execution).toMatchObject({ businessStartedProven: false, outcome: 'REJECTED_BEFORE_BUSINESS' });
  expect(f.jobs.get(1)![0].steps[0].conclusion).toBe('failure');
});
it.each(['actor', 'duplicate', 'job-source', 'attempt', 'unit'])('rejects %s result source', kind => {
  const f = evidenceFixture();
  if (kind === 'actor') f.runs.get(1).actor.id = 7;
  if (kind === 'duplicate') f.request.canonicalRunId = 101;
  if (kind === 'job-source') f.jobs.get(1)![0].head_sha = 'c'.repeat(40);
  if (kind === 'attempt') f.jobs.get(1)![0].run_attempt = 2;
  expect(() => productBusinessResults(f.context, f.request, nativeRunFact(f.runs.get(1)), jobFact(f.jobs.get(1)![0]), kind === 'unit' ? 'missing' : 'app', NOW)).toThrow();
});
it('post-step native receipts round-trip through original log evidence without a failure budget', async () => {
  const f = evidenceFixture(2);
  for (const [attempt, raw] of f.runs) f.results.set(attempt, productBusinessResults(f.context, f.request, nativeRunFact(raw), jobFact(f.jobs.get(attempt)![0]), 'app', NOW)[0]!);
  const observed = await inspectNativeCycle(f.context, [], f.io, NOW);
  expect(observed.currentFacts).toMatchObject({unknownEvidence:[],conflictEvidence:[],inFlightWaveKeys:[]});
  expect(observed.native.attempts).toHaveLength(2);
});
