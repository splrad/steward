import { expect, it } from 'vitest';
import { GitHubClient } from '../src/client.js';
import { assertIncreasingReleaseVersion } from '../src/release-candidate.js';

it('checks every page rather than the manually selected latest release', async () => {
  const calls: string[] = [];
  const gh = new GitHubClient('fixture', 'https://api.github.com', (async url => {
    calls.push(String(url));
    const second = String(url).includes('page=2');
    return Response.json(second ? [{ id: 2, tag_name: 'v3.0.0', draft: false, prerelease: false }]
      : [{ id: 1, tag_name: 'v1.0.0', draft: false, prerelease: false }],
    { headers: second ? {} : { link: '<https://api.github.com/repos/sample/product/releases?per_page=100&page=2>; rel="next"' } });
  }) as typeof fetch);
  await expect(assertIncreasingReleaseVersion(gh, 'sample', 'product', 'v2.0.0')).rejects.toThrow('VERSION_NOT_INCREASING');
  expect(calls).toHaveLength(2);
  expect(calls.some(url => url.endsWith('/latest'))).toBe(false);
});
it('ignores drafts, prereleases and the bound release but refuses equal or higher stable versions', async () => {
  const releases = [{ id: 1, tag_name: 'v9.0.0', draft: true, prerelease: false },
    { id: 2, tag_name: 'v9.0.0-rc1', draft: false, prerelease: true },
    { id: 3, tag_name: 'v2.0.0', draft: false, prerelease: false }];
  const gh = { listReleases: async () => releases };
  await expect(assertIncreasingReleaseVersion(gh, 'sample', 'product', 'v2.0.0', 3)).resolves.toBeUndefined();
  await expect(assertIncreasingReleaseVersion(gh, 'sample', 'product', 'v2.0.0')).rejects.toThrow('VERSION_NOT_INCREASING');
  await expect(assertIncreasingReleaseVersion(gh, 'sample', 'product', 'v3.0.0')).resolves.toBeUndefined();
});
