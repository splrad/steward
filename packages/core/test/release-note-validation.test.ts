import { describe, expect, it } from 'vitest';
import { assertFragmentIdentity, validatePullRequestFragments } from '../src/release-note-validation.js';
import type { FragmentPathChange } from '../src/release-note-fragment.js';

const identity = { repositoryId: 1, pullRequestNumber: 2, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), policySha: 'c'.repeat(40) };
const path = '.release-notes/fragments/new-fact.json';
const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, status: 'not-user-facing', reason: 'Only internal test fixtures have changed.' }));
const profile = { fragmentDirectory: '.release-notes/fragments', required: ['src/**'], reviewRequired: [], ignored: ['tests/**'] };
const input = { identity, profile, expectedFileCount: 2, classification: null,
  changes: [{ status: 'modified', path: 'src/a.ts' }, { status: 'added', path }] as FragmentPathChange[],
  fragments: [{ path, bytes, existsInBase: false }] };

describe('T05: validation identity', () => {
  it('returns a deterministic result bound to base, head and policy', () => {
    const result = validatePullRequestFragments(input);
    expect(result).toEqual(validatePullRequestFragments(input));
    expect(result.identity).toEqual(identity);
    expect(result.identity).not.toBe(identity);
    expect(result.decision.classificationState).toBe('missing');
  });
  it.each(['repositoryId', 'pullRequestNumber', 'baseSha', 'headSha', 'policySha'] as const)('rejects changed %s', key => {
    expect(() => assertFragmentIdentity(identity, { ...identity, [key]: typeof identity[key] === 'number' ? 99 : 'd'.repeat(40) })).toThrow('RN_SOURCE_STALE');
  });
  it('rejects incomplete identities', () => {
    expect(() => validatePullRequestFragments({ ...input, identity: { ...identity, policySha: '' } })).toThrow('RN_SOURCE_INCOMPLETE');
  });
});

describe('T06: fragment lifecycle', () => {
  it.each(['modified', 'removed', 'renamed'] as const)('rejects historical %s', status => {
    const change: FragmentPathChange = status === 'renamed' ? { status, path: 'other.txt', previousPath: path } : { status, path };
    expect(() => validatePullRequestFragments({ ...input, changes: [change], expectedFileCount: 1 })).toThrow('RN_FRAGMENT_LIFECYCLE');
  });
  it('rejects renames into the fragment directory', () => {
    expect(() => validatePullRequestFragments({ ...input, changes: [{ status: 'renamed', path, previousPath: 'other.txt' }], expectedFileCount: 1 })).toThrow('RN_FRAGMENT_LIFECYCLE');
  });
  it('rejects multiple additions and additions already in base', () => {
    expect(() => validatePullRequestFragments({ ...input, changes: [{ status: 'added', path }, { status: 'added', path: path.replace('new-fact', 'new-fact-two') }] })).toThrow('RN_FRAGMENT_LIFECYCLE');
    expect(() => validatePullRequestFragments({ ...input, fragments: [{ path, bytes, existsInBase: true }] })).toThrow('RN_FRAGMENT_LIFECYCLE');
  });
  it.each([1, 3, 3001, -1, NaN])('rejects incomplete file count %s', expectedFileCount => {
    expect(() => validatePullRequestFragments({ ...input, expectedFileCount })).toThrow('RN_SOURCE_INCOMPLETE');
  });
  it('rejects duplicate paths and missing bytes', () => {
    expect(() => validatePullRequestFragments({ ...input, changes: [input.changes[0]!, input.changes[0]!] })).toThrow('RN_SOURCE_INCOMPLETE');
    expect(() => validatePullRequestFragments({ ...input, fragments: [] })).toThrow('RN_SOURCE_INCOMPLETE');
  });
  it('validates an optional fragment in an ignored PR', () => {
    const ignored = { ...input, changes: [{ status: 'added', path }] as FragmentPathChange[], expectedFileCount: 1 };
    expect(validatePullRequestFragments(ignored).decision.requirement).toBe('ignored');
    expect(() => validatePullRequestFragments({ ...ignored, fragments: [{ path, bytes: new Uint8Array(), existsInBase: false }] })).toThrow('RN_FRAGMENT_JSON');
  });
  it('requires a fragment for product paths and classifies risks independently', () => {
    expect(() => validatePullRequestFragments({ ...input, changes: [input.changes[0]!], fragments: [], expectedFileCount: 1 })).toThrow('RN_FRAGMENT_REQUIRED');
    expect(() => validatePullRequestFragments({ ...input, classification: { primaryKind: 'bug', riskFlags: ['security'] } })).toThrow('RN_FACT_CONFLICT');
  });
});
