import { expect, it, vi } from 'vitest';
import { GitHubClient } from '../src/client.js';
import { readReleaseContributors, verifyReleaseCommitRange } from '../src/release-candidate.js';
import { releaseSourceFrontier } from '../../core/src/release-bundle.js';

const base = 'a'.repeat(40), target = 'b'.repeat(40), reverted = 'c'.repeat(40);
const source = (ids: string[]) => ({ boundary: { kind: 'tag', sha: base }, targetSha: target, commits: ids.map(sha => ({ sha })) });
it('reads 100 contributor commits in bounded groups of four', async () => {
  vi.useFakeTimers();
  let active = 0, peak = 0;
  const getCommit = async (_o: string, _r: string, sha: string) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1000)); active--;
    return { sha, author: { id: Number(sha), login: `user${sha}`, type: 'User' } };
  };
  try {
    const pending = readReleaseContributors({ getCommit }, 'o', 'r', Array.from({ length: 100 }, (_, n) => ({ sha: String(n + 1) })));
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await pending).size).toBe(100); expect(peak).toBe(4); expect(active).toBe(0);
  } finally { vi.useRealTimers(); }
});
function client() {
  return new GitHubClient('test', 'https://api.github.com', async url => {
    const page = String(url).includes('page=2');
    const paginated = String(url).includes('?');
    return Response.json({ status: 'ahead', base_commit: { sha: base }, merge_base_commit: { sha: base }, total_commits: 2,
      commits: (page ? [target] : [reverted]).map(sha => ({ sha })) }, { headers: paginated && !page
      ? { link: `<https://api.github.com/repos/o/r/compare/${base}...${target}?per_page=100&page=2>; rel="next"` } : {} });
  });
}
it('reads every comparison page including reverted commits', async () => {
  await expect(verifyReleaseCommitRange(client(), 'o', 'r', source([target, reverted]), target)).resolves.toBeUndefined();
});
it.each([[], [target], [target, reverted, base]].map(ids => ({ ids })))('rejects omitted or extra commits: $ids', async ({ ids }) => {
  await expect(verifyReleaseCommitRange(client(), 'o', 'r', source(ids), target)).rejects.toThrow('SOURCE_COMMIT_COVERAGE');
});
it('requires complete reachable full-tree history and rejects disconnected objects', () => {
  const tree = { targetSha: target, boundary: { kind: 'full-tree' }, commits: [{ sha: target, parents: [base] }, { sha: base, parents: [] }] };
  expect(releaseSourceFrontier(tree)).toEqual([]);
  expect(() => releaseSourceFrontier({ ...tree, commits: tree.commits.slice(0, 1) })).toThrow('SOURCE_COMMIT_COVERAGE');
  expect(() => releaseSourceFrontier({ ...tree, commits: [...tree.commits, { sha: reverted, parents: [] }] })).toThrow('SOURCE_COMMIT_COVERAGE');
});
