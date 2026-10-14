import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubRequestError } from '../../github/src/index.js';
import { collectReleaseRange, configuredReleaseSourcePolicy, collectReleaseSources, assertReleaseSourcesUnchanged } from '../src/release-notes-input.js';
import { attributeReleaseSources, type ManagedReviewRecord } from '../../core/src/release-notes-input.js';
import { selectPreviousRelease } from '../../core/src/release-notes.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const identity = { repositoryId: 123, defaultBranch: 'main', targetSha: sha(2), policySha: sha(99) };
function fixture(count = 1) {
  const releases = [{ tag_name: 'v1.0.0', draft: false, prerelease: false }];
  const pulls = Array.from({ length: count }, (_, i) => ({ number: i + 1, merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: sha(i + 2), changed_files: 1, commits: 1, title: 'title', body: '', user: { id: 42, login: 'alice', type: 'User' }, head: { sha: sha(i + 102), ref: 'feature', repo: { id: 123 } }, base: { ref: 'main', sha: sha(i + 1), repo: { id: 123 } } }));
  const gh = {
    listReleases: async () => releases,
    getGitRef: async () => ({ object: { type: 'commit', sha: sha(1) } }),
    getGitTag: async () => ({ object: { type: 'commit', sha: sha(1) } }),
    getCommit: async (_o: string, _r: string, s: string) => ({ sha: s, parents: s === sha(1) ? [] : [{ sha: sha(parseInt(s, 16) - 1) }] }),
    listPullsForCommit: async (_o: string, _r: string, s: string) => pulls.filter(p => p.merge_commit_sha === s),
    getPullRequest: async (_o: string, _r: string, n: number) => pulls[n - 1]!,
    listPullFiles: async () => [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
    listPullCommits: async (_o: string, _r: string, n: number) => [{ sha: sha(n + 101), commit: { message: 'change' } }],
    listLabels: async () => [{ name: 'bug' }],
  };
  return { gh, pulls, releases };
}
const collect = (gh: Parameters<typeof collectReleaseSources>[0]) => collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0');

describe('R02 发布来源', () => {
  it.each(['stable', 'adoption'])('允许恰好 10000 条区间提交，超过上限时停止读取：%s', async mode => {
    const { gh, releases } = fixture();
    let reads = 0;
    const original = gh.getCommit;
    gh.getCommit = async (...args) => { reads++; return original(...args); };
    const policy = mode === 'adoption' ? { adoption: { mode: 'start-at-adoption' as const, repositoryId: 123, policySha: sha(99), boundarySha: sha(1), reference: 'migration-limit' } } : {};
    const listed = mode === 'adoption' ? [] : releases;
    const result = await collectReleaseRange(gh, 'o', 'r', sha(10_001), listed, 'v2.0.0', policy);
    expect(result.commits).toHaveLength(10_000);
    expect(result.boundary.sha).toBe(sha(1));
    expect(reads).toBe(10_000);
    reads = 0;
    await expect(collectReleaseRange(gh, 'o', 'r', sha(10_002), listed, 'v2.0.0', policy)).rejects.toMatchObject({ code: 'RN_SOURCE_INCOMPLETE', message: 'RN_SOURCE_INCOMPLETE: first-parent limit' });
    expect(reads).toBe(10_000);
  });
  it('中央配置绑定仓库和策略，拒绝未知字段、冲突边界和候选文件自授权', () => {
    expect(configuredReleaseSourcePolicy(undefined, identity)).toEqual({});
    expect(configuredReleaseSourcePolicy({ adoption: { mode: 'start-at-adoption', boundarySha: sha(1), reference: 'approved-migration' } }, identity).adoption).toMatchObject({ repositoryId: 123, policySha: sha(99), boundarySha: sha(1) });
    expect(() => configuredReleaseSourcePolicy({ reviews: [] }, identity)).toThrow('unknown');
    expect(() => configuredReleaseSourcePolicy({ previousStableTag: 'v1', adoption: { mode: 'start-at-adoption', boundarySha: sha(1), reference: 'record' } }, identity)).toThrow('conflicting');
    expect(() => configuredReleaseSourcePolicy({ adoption: { mode: 'start-at-adoption', boundarySha: 'main', reference: 'record' } }, identity)).toThrow('SHA');
  });
  it('固定区间、唯一 PR 和输入摘要，API 对象变化不修改已有快照', async () => {
    const { gh, pulls } = fixture(); const before = await collect(gh);
    expect(before.input.boundary).toEqual({ kind: 'stable-release', sha: sha(1), reference: 'v1.0.0' });
    expect(before.input.commits).toEqual([{ sha: sha(2), pullNumber: 1, kind: 'product', candidateId: null }]);
    expect(before.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    assertReleaseSourcesUnchanged(before, await collect(gh));
    pulls[0]!.title = 'changed';
    expect(() => assertReleaseSourcesUnchanged(before, { bytes: 'changed' })).toThrow('RN_SOURCE_STALE');
    expect(() => assertReleaseSourcesUnchanged(before, { bytes: before.bytes })).not.toThrow();
    const after = await collect(gh); expect(() => assertReleaseSourcesUnchanged(before, after)).toThrow('RN_SOURCE_STALE');
  });
  it('附注标签被解引用；已发布标签缺失失败关闭', async () => {
    const { gh } = fixture(); gh.getGitRef = async () => ({ object: { type: 'tag', sha: sha(55) } });
    expect((await collect(gh)).input.boundary.sha).toBe(sha(1));
    gh.getGitRef = async () => { throw new GitHubRequestError(404, 'GET', '/tag', 'missing'); };
    await expect(collect(gh)).rejects.toThrow('published tag missing');
  });
  it('首发拒绝隐式根；显式采用边界必须绑定仓库、策略且在第一父链', async () => {
    const { gh } = fixture(); gh.listReleases = async () => [];
    await expect(collect(gh)).rejects.toThrow('start-at-adoption');
    const adoption = { mode: 'start-at-adoption' as const, repositoryId: 123, policySha: sha(99), boundarySha: sha(1), reference: 'migration-1' };
    expect((await collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0', { adoption })).input.boundary.kind).toBe('adoption');
    await expect(collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0', { adoption: { ...adoption, repositoryId: 999 } })).rejects.toThrow('binding');
    await expect(collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0', { adoption: { ...adoption, boundarySha: sha(80) } })).rejects.toThrow('start-at-adoption');
  });
  it('同提交多标签必须显式选择，发布时间不能覆盖第一父距离', async () => {
    const { gh, releases } = fixture(); releases.push({ ...releases[0]!, tag_name: 'v1.0.1' });
    await expect(collect(gh)).rejects.toThrow('RN_SOURCE_AMBIGUOUS');
    const policy = { previousStableTag: 'v1.0.0' };
    const a = await collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0', policy); releases.reverse();
    expect((await collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0', policy)).bytes).toBe(a.bytes);
    expect(selectPreviousRelease([{ tag: 'new-time', targetSha: sha(1), publishedAt: '2030', draft: false, prerelease: false }, { tag: 'near', targetSha: sha(2), publishedAt: '2020', draft: false, prerelease: false }], [sha(2), sha(1)])?.tag).toBe('near');
  });
  it.each(['missing', 'multiple', 'foreign', 'wrong-merge', 'wrong-branch', 'unmerged', 'files-truncated', 'commits-truncated', 'duplicate-files'])('拒绝不完整或歧义来源 %s', async mode => {
    const { gh, pulls } = fixture();
    if (mode === 'missing') gh.listPullsForCommit = async () => [];
    if (mode === 'multiple') gh.listPullsForCommit = async () => [pulls[0]!, { ...pulls[0]!, number: 9 }];
    if (mode === 'foreign') pulls[0]!.base.repo.id = 999;
    if (mode === 'wrong-merge') gh.listPullsForCommit = async () => [{ ...pulls[0]!, merge_commit_sha: sha(999) }];
    if (mode === 'wrong-branch') pulls[0]!.base.ref = 'other';
    if (mode === 'unmerged') pulls[0]!.merged = false;
    if (mode === 'files-truncated') pulls[0]!.changed_files = 2;
    if (mode === 'commits-truncated') pulls[0]!.commits = 2;
    if (mode === 'duplicate-files') { pulls[0]!.changed_files = 2; gh.listPullFiles = async () => Array(2).fill({ filename: 'same', status: 'modified', additions: 1, deletions: 0 }); }
    await expect(collect(gh)).rejects.toThrow(/RN_SOURCE_/);
  });
  it('拒绝缺失中间提交、循环和不匹配响应', async () => {
    const { gh } = fixture(); gh.getCommit = async () => ({ sha: sha(2), parents: [{ sha: sha(2) }] });
    await expect(collect(gh)).rejects.toThrow('cycle');
    gh.getCommit = async () => ({ sha: sha(8), parents: [] });
    await expect(collect(gh)).rejects.toThrow('identity');
    expect(() => attributeReleaseSources(identity, { kind: 'stable-release', sha: sha(1), reference: 'v1' }, [{ sha: sha(2), firstParent: sha(8), pulls: [] }])).toThrow('broken');
  });
  it('受管候选必须有中央身份和精确两文件范围，只计入审阅记录', async () => {
    const { gh, pulls } = fixture(); pulls[0]!.changed_files = 2;
    const files = ['candidate.json', 'release-notes.zh-CN.md'].map(name => ({ filename: `.release-notes/candidates/v1.1.0/${name}`, status: 'added', additions: 1, deletions: 0 }));
    gh.listPullFiles = async () => files;
    await expect(collect(gh)).rejects.toThrow('unregistered candidate');
    const record: ManagedReviewRecord = { candidateId: 'central-1', repositoryId: 123, policySha: sha(99), targetTag: 'v1.1.0', pullNumber: 1, headSha: sha(102), mergeSha: sha(2), authorId: 42 };
    const read = () => collectReleaseSources(gh, 'o', 'r', identity, 'v2.0.0', { reviews: [record] });
    expect((await read()).input.commits[0]?.kind).toBe('review-record');
    record.authorId = 43; await expect(read()).rejects.toThrow('candidate identity'); record.authorId = 42;
    files[0]!.filename = 'src/product.ts'; await expect(read()).rejects.toThrow('exact file scope');
  });
  it('真实分页客户端读取 >100 PR 的区间及多页关联，不截断额外关联', async () => {
    const { gh, pulls, releases } = fixture(101); const seen: string[] = [];
    const transport: typeof fetch = async input => {
      const url = new URL(String(input)); seen.push(url.pathname + url.search);
      const commit = /\/commits\/([a-f0-9]{40})\/pulls/.exec(url.pathname);
      if (commit) {
        const n = parseInt(commit[1]!, 16) - 2;
        if (url.searchParams.get('page') === '2') return Response.json([pulls[n]!]);
        return Response.json([], { headers: { link: `<${url.href}&page=2>; rel="next"` } });
      }
      if (url.pathname.endsWith('/releases')) return Response.json(releases);
      throw new Error('unexpected route');
    };
    const client = new GitHubClient('test', 'https://api.github.com', transport);
    const paged = { ...gh, listReleases: client.listReleases.bind(client), listPullsForCommit: client.listPullsForCommit.bind(client) };
    const result = await collectReleaseSources(paged, 'o', 'r', { ...identity, targetSha: sha(102) }, 'v2.0.0');
    expect(result.input.commits).toHaveLength(101); expect(seen.filter(url => url.includes('page=2'))).toHaveLength(101);
    const ambiguous = new GitHubClient('test', 'https://api.github.com', async input => {
      const url = new URL(String(input));
      return url.searchParams.has('page') ? Response.json([{ ...pulls[0], number: 999 }]) : Response.json([pulls[0]], { headers: { link: `<${url.href}&page=2>; rel="next"` } });
    });
    await expect(collect({ ...gh, listPullsForCommit: ambiguous.listPullsForCommit.bind(ambiguous) })).rejects.toThrow('RN_SOURCE_AMBIGUOUS');
  });
  it('标签、文件和 PR 描述变化被输出前复核发现，非法数字不进入摘要', async () => {
    const { gh } = fixture(); const before = await collect(gh);
    gh.listLabels = async () => [{ name: 'security' }];
    expect(() => assertReleaseSourcesUnchanged(before, { bytes: 'different' })).toThrow('STALE');
    const after = await collect(gh); expect(after.inputSha256).not.toBe(before.inputSha256);
    gh.listPullFiles = async () => [{ filename: 'src/a.ts', status: 'modified', additions: NaN, deletions: 0 }];
    await expect(collect(gh)).rejects.toThrow('malformed');
  });
  it('忽略草稿和预发布，但拒绝标签循环及错误类型', async () => {
    const { gh, releases } = fixture(); releases.push({ ...releases[0]!, tag_name: 'draft', draft: true });
    expect((await collect(gh)).input.boundary.reference).toBe('v1.0.0');
    gh.getGitRef = async () => ({ object: { type: 'tag', sha: sha(55) } }); gh.getGitTag = gh.getGitRef;
    await expect(collect(gh)).rejects.toThrow('tag cycle');
    gh.getGitRef = async () => ({ object: { type: 'tree', sha: sha(55) } }); await expect(collect(gh)).rejects.toThrow('tag does not');
  });
});
