import { releaseAssert } from '../../core/src/release-note-receipt.js';
import type { GitHubClient } from './client.js';
import { comparePublicVersions, parsePublicVersion } from '../../core/src/release-version.js';

// Read-only public version queries; candidate lifecycle is owned by Release Please.
export async function assertIncreasingReleaseVersion(gh: Pick<GitHubClient, 'listReleases'>, owner: string, repo: string, tag: string, ownReleaseId?: number | null): Promise<void> {
  const target = parsePublicVersion(tag.slice(1));
  for (const release of await gh.listReleases(owner, repo)) {
    if (release.draft || release.prerelease || release.id === ownReleaseId) continue;
    releaseAssert(/^v\d+\.\d+\.\d+$/.test(release.tag_name)
      && comparePublicVersions(target, parsePublicVersion(release.tag_name.slice(1))) > 0, 'VERSION_NOT_INCREASING');
  }
}

export async function highestStableRelease(gh: Pick<GitHubClient, 'listReleases'>, owner: string, repo: string): Promise<any | null> {
  let highest: any | null = null;
  for (const release of await gh.listReleases(owner, repo)) {
    if (release.draft || release.prerelease) continue;
    releaseAssert(/^v\d+\.\d+\.\d+$/.test(release.tag_name), 'VERSION_NOT_INCREASING');
    const version = parsePublicVersion(release.tag_name.slice(1));
    if (!highest || comparePublicVersions(version, parsePublicVersion(highest.tag_name.slice(1))) > 0) highest = release;
  }
  return highest;
}

export async function verifyReleaseCommitRange(gh: GitHubClient, owner: string, repo: string, source: any, targetSha: string): Promise<void> {
  if (source.boundary.kind !== 'full-tree') {
    const ancestry = await gh.compare(owner, repo, source.boundary.sha, targetSha);
    releaseAssert(['ahead', 'identical'].includes(ancestry.status) && ancestry.base_commit?.sha === source.boundary.sha
      && ancestry.merge_base_commit?.sha === source.boundary.sha, 'SOURCE_BOUNDARY_ANCESTRY');
    const commits = await gh.paginate<any>(`/repos/${owner}/${repo}/compare/${source.boundary.sha}...${targetSha}?per_page=100`, value => (value as any).commits, { maxItems: 10_000 });
    const ids = commits.map(c => c.sha);
    releaseAssert(ids.length === ancestry.total_commits && new Set(ids).size === ids.length
      && JSON.stringify(ids.sort()) === JSON.stringify(source.commits.map((c: any) => c.sha).sort()), 'SOURCE_COMMIT_COVERAGE');
  }
}

export async function readReleaseContributors(gh: Pick<GitHubClient, 'getCommit'>, owner: string, repo: string, commits: { sha: string }[]): Promise<Map<number, string>> {
  releaseAssert(commits.length <= 100, 'CONTRIBUTOR_LIMIT');
  const humans = new Map<number, string>();
  for (let offset = 0; offset < commits.length; offset += 4) {
    const actuals = await Promise.all(commits.slice(offset, offset + 4).map(async c => {
      const actual = await gh.getCommit(owner, repo, c.sha); releaseAssert(actual.sha === c.sha, 'CONTRIBUTOR_SOURCE'); return actual;
    }));
    for (const actual of actuals) if (actual.author?.type === 'User') humans.set(actual.author.id, actual.author.login);
  }
  return humans;
}
