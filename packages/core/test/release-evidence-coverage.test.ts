import { it, expect } from 'vitest';
import { releaseEvidenceCoverage, validateReleaseEvidence } from '../src/release-bundle.js';
import { canonicalReleaseJson, receiptDigest } from '../src/release-note-receipt.js';
import { frozenFixture } from './release-receipt-fixture.js';

it('binds large coverage without duplicating paths into the bounded evidence object', () => {
  const source = { commits: [{ sha: 'a'.repeat(40) }], changes: Array.from({ length: 20000 }, (_, i) => ({ path: 'long/path/'.repeat(8) + i })) };
  const frozen = frozenFixture();
  const evidence = { schemaVersion: 2, sourceDigest: frozen.sourceDigest, internalChanges: [], unknowns: [], coverage: releaseEvidenceCoverage(source) };
  const bytes = Buffer.from(canonicalReleaseJson(evidence));
  frozen.evidenceDigest = receiptDigest(bytes);
  expect(bytes.length).toBeLessThan(1024);
  expect(() => validateReleaseEvidence(bytes, frozen, source)).not.toThrow();
  for (const changes of [source.changes.slice(1), [...source.changes, source.changes[0]], [{ path: 'changed' }, ...source.changes.slice(1)]]) {
    expect(() => validateReleaseEvidence(bytes, frozen, { ...source, changes })).toThrow('EVIDENCE_COVERAGE');
  }
});
it('continues to validate legacy explicit coverage', () => {
  const source = { commits: [{ sha: 'a'.repeat(40) }], changes: [{ path: 'VERSION' }] }, frozen = frozenFixture();
  const bytes = Buffer.from(canonicalReleaseJson({ schemaVersion: 1, sourceDigest: frozen.sourceDigest, internalChanges: [], unknowns: [],
    coverage: { commitShas: ['a'.repeat(40)], paths: ['VERSION'] } }));
  frozen.evidenceDigest = receiptDigest(bytes);
  expect(() => validateReleaseEvidence(bytes, frozen, source)).not.toThrow();
});
