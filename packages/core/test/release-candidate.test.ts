import { expect, it } from 'vitest';
import { candidateId, candidatePhase, selectReleaseContributors, renderReleaseContributors } from '../src/release-candidate.js';
const actor = (id: number, login = `user-${id}`) => ({ id, login, type: 'User', profileUrl: `https://github.com/${login}`, avatarUrl: `https://avatars.githubusercontent.com/u/${id}` });
it('deduplicates native human IDs, excludes renamed authors and bots, and retains unresolved identities', () => {
  expect(selectReleaseContributors([actor(9), actor(4), actor(9, 'renamed-user'), actor(7, 'renamed-author'), { ...actor(10), type: 'Bot' }, null], [{ id: 7, evidence: 'Explicit author confirmation' }]))
    .toEqual({ contributors: [{ ...actor(4), alt: 'user-4', type: undefined }, { ...actor(9, 'renamed-user'), alt: 'renamed-user', type: undefined }].map(({ type, ...value }) => value), unresolved: 1 });
});
it('rejects absent author evidence and non-native profile URLs', () => {
  expect(() => selectReleaseContributors([], [])).toThrow('AUTHOR_IDENTITY_UNVERIFIED');
  expect(() => selectReleaseContributors([actor(1)], [{ id: 7, evidence: '' }])).toThrow('AUTHOR_IDENTITY_UNVERIFIED');
  expect(() => selectReleaseContributors([{ ...actor(1), avatarUrl: 'https://example.invalid/a' }], [{ id: 7, evidence: 'Confirmed' }])).toThrow('CONTRIBUTOR_NATIVE_PROFILE_REQUIRED');
});
it('excludes the native web-flow service identity while retaining human authors and committers', () => {
  const actors = [actor(19864447, 'web-flow'), actor(19864447, 'renamed-service'), actor(41, 'human-author'),
    actor(42, 'human-committer'), actor(43, 'web-flow-helper'), actor(7, 'repository-author'), null];
  const original = structuredClone(actors);
  const result = selectReleaseContributors(actors, [{ id: 7, evidence: 'Verified repository author' }]);
  expect(result.contributors.map(c => c.id)).toEqual([41, 42, 43]); expect(result.unresolved).toBe(1);
  expect(actors).toEqual(original);
  expect(renderReleaseContributors(result.contributors)).not.toContain('alt="web-flow"');
});
it('candidate identity is stable within a cycle and changes after completion; PREPARING is derived', async () => {
  const id = await candidateId(1, 'steward/release-candidate', 'a'.repeat(40), null);
  expect(id).toMatch(/^[a-f0-9]{64}$/); expect(await candidateId(1, 'steward/release-candidate', 'a'.repeat(40), null)).toBe(id);
  expect(await candidateId(1, 'steward/release-candidate', 'a'.repeat(40), 'pr-1-' + 'b'.repeat(40))).not.toBe(id);
  expect(candidatePhase({ prNumber: null, publishedHead: null, pendingWrite: null }, false)).toBe('PREPARING');
});
it('hides an empty contributors section and escapes native attributes with Mustache', () => {
  expect(renderReleaseContributors([])).toBe('');
  const contributors = selectReleaseContributors([{ ...actor(1), avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=32&x="quoted"' }], [{ id: 7, evidence: 'Verified' }]).contributors;
  const text = renderReleaseContributors(contributors); expect(text).toContain('## 贡献者'); expect(text).toContain('&amp;x&#x3D;&quot;quoted&quot;');
  expect(text).toContain('alt="user-1"'); expect(text).not.toContain('email');
});
