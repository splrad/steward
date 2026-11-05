import { describe, expect, it, vi } from 'vitest';
import { budgetReleaseSourceTransport, releaseSourceBudget } from '../src/release-source-budget.js';
import { GitHubClient } from '../../github/src/client.js';
import { collectReleaseSources, assertReleaseSourcesUnchanged } from '../src/release-notes-input.js';
import { attributeReleaseSources } from '../../core/src/release-notes-input.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const identity = { repositoryId: 123, defaultBranch: 'main', targetSha: sha(2), controllerSha: sha(99) };
const source = (count = 1) => ({ ...identity, targetSha: sha(count + 1), boundary: { kind: 'tag' as const, sha: sha(1), reference: 'component-v1.0.0', version: '1.0.0' },
  commits: Array.from({ length: count }, (_, i) => ({ sha: sha(i + 2), parents: [sha(i + 1)] })) });
function fixture(count = 1) {
  const pulls = Array.from({ length: count }, (_, i) => ({ number: i + 1, merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: sha(i + 2), changed_files: 1, commits: 1, title: 'title', body: '', user: { id: 42, login: 'alice', type: 'User' }, head: { sha: sha(i + 102), ref: 'feature', repo: { id: 123 } }, base: { ref: 'main', sha: sha(i + 1), repo: { id: 123 } } }));
  const gh = {
    listPullsForCommit: async (_o: string, _r: string, s: string) => pulls.filter(p => p.merge_commit_sha === s),
    getPullRequest: async (_o: string, _r: string, n: number) => pulls.find(p => p.number === n)!,
    listPullFiles: async () => [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
    listPullCommits: async (_o: string, _r: string, n: number) => [{ sha: sha(n + 101), commit: { message: 'change' } }],
    listLabels: async () => [{ name: 'bug' }],
  };
  return { gh, pulls };
}
const collect = (gh: Parameters<typeof collectReleaseSources>[0]) => collectReleaseSources(gh, 'o', 'r', source());

describe('Git 来源与补充 PR 事实', () => {
  it.each(['User', 'Bot', 'Organization', 'Mannequin'])('作者类型 %s 保留到快照', async type => {
    const { gh, pulls } = fixture(); pulls[0]!.user.type = type;
    expect(JSON.parse((await collect(gh)).bytes).sourceFacts[0].author.type).toBe(type);
  });
  it.each(['Unknown', '', 'bot', null, undefined, 42])('非法作者类型 %s 在读取后续事实前失败', async type => {
    const { gh, pulls } = fixture(); Object.assign(pulls[0]!.user, { type });
    gh.listPullFiles = vi.fn(gh.listPullFiles);
    await expect(collect(gh)).rejects.toMatchObject({ code: 'RN_SOURCE_INCOMPLETE' });
    expect(gh.listPullFiles).not.toHaveBeenCalled();
  });
  it('无 PR、多个 PR 和直接提交均保留；排序不改变摘要', async () => {
    const { gh, pulls } = fixture();
    gh.listPullsForCommit = async () => [];
    expect((await collect(gh)).input.commits[0]?.pullNumbers).toEqual([]);
    pulls.push({ ...pulls[0]!, number: 2 });
    gh.listPullsForCommit = async () => [...pulls];
    const before = await collect(gh); pulls.reverse();
    expect((await collect(gh)).bytes).toBe(before.bytes);
    expect(before.input.commits[0]?.pullNumbers).toEqual([1, 2]);
    expect(before.bytes).toContain('controllerSha'); expect(before.bytes).not.toContain('policySha');
  });
  it('同一 PR 可关联多个提交，保留关联全集并只读取一份 PR 详情', async () => {
    const { gh, pulls } = fixture(); pulls[0]!.merge_commit_sha = sha(3); pulls[0]!.commits = 2;
    gh.listPullsForCommit = async () => pulls;
    gh.listPullCommits = async () => [2, 3].map(n => ({ sha: sha(n), commit: { message: 'non-conventional change' } }));
    gh.getPullRequest = vi.fn(gh.getPullRequest);
    const result = await collectReleaseSources(gh, 'o', 'r', source(2));
    expect(result.input.commits.map(c => c.pullNumbers)).toEqual([[1], [1]]);
    expect(result.facts).toHaveLength(1); expect(gh.getPullRequest).toHaveBeenCalledTimes(1);
  });
  it('120 PR 双轮真实客户端采集共 1200 请求，Git 范围不再从 API 重建', async () => {
    vi.useFakeTimers();
    try {
      const { gh } = fixture(120); let requests = 0; const started = Date.now();
      const transport = budgetReleaseSourceTransport(async input => {
        requests++; const path = new URL(String(input)).pathname;
        const commit = /\/commits\/([a-f0-9]{40})\/pulls$/.exec(path);
        if (commit) return Response.json(await gh.listPullsForCommit('o', 'r', commit[1]!));
        const pull = /\/(pulls|issues)\/(\d+)(?:\/(files|commits|labels))?$/.exec(path);
        if (pull) { const n = Number(pull[2]); return Response.json(pull[3] === 'files' ? await gh.listPullFiles() : pull[3] === 'commits' ? await gh.listPullCommits('o', 'r', n) : pull[3] === 'labels' ? await gh.listLabels() : await gh.getPullRequest('o', 'r', n)); }
        throw new Error(`unexpected ${path}`);
      });
      const client = new GitHubClient('test', 'https://api.github.com', transport);
      const run = async () => assertReleaseSourcesUnchanged(await collectReleaseSources(client, 'o', 'r', source(120)), await collectReleaseSources(client, 'o', 'r', source(120)));
      const done = run(); await vi.runAllTimersAsync(); await done;
      expect(requests).toBe(1200); expect(requests).toBeLessThan(releaseSourceBudget.requests);
      expect(Date.now() - started).toBeLessThan(releaseSourceBudget.timeoutMs);
    } finally { vi.useRealTimers(); }
  });
  it('超过旧 120 提交上限的完整 Git 范围仍可补充 PR', async () => {
    const { gh } = fixture(121);
    expect((await collectReleaseSources(gh, 'o', 'r', source(121))).input.commits).toHaveLength(121);
  });
  it.each(['foreign', 'wrong-merge', 'unmerged', 'files-truncated', 'commits-truncated', 'duplicate-files', 'duplicate-association'])('拒绝不完整或身份不符的补充证据 %s', async mode => {
    const { gh, pulls } = fixture();
    if (mode === 'foreign') pulls[0]!.base.repo.id = 999;
    if (mode === 'wrong-merge') gh.listPullsForCommit = async () => [{ ...pulls[0]!, merge_commit_sha: sha(999) }];
    if (mode === 'unmerged') pulls[0]!.merged = false;
    if (mode === 'files-truncated') pulls[0]!.changed_files = 2;
    if (mode === 'commits-truncated') pulls[0]!.commits = 2;
    if (mode === 'duplicate-files') { pulls[0]!.changed_files = 2; gh.listPullFiles = async () => Array(2).fill({ filename: 'same', status: 'modified', additions: 1, deletions: 0 }); }
    if (mode === 'duplicate-association') gh.listPullsForCommit = async () => [pulls[0]!, pulls[0]!];
    await expect(collect(gh)).rejects.toThrow(/RN_SOURCE_/);
  });
  it('分支合并的 PR 可作为补充证据，候选目录不产生另一套授权', async () => {
    const { gh, pulls } = fixture(); pulls[0]!.base.ref = 'feature';
    gh.listPullFiles = async () => [{ filename: '.release-notes/candidates/v1.1.0/candidate.json', status: 'added', additions: 1, deletions: 0 }];
    expect((await collect(gh)).input.commits[0]?.pullNumbers).toEqual([1]);
  });
  it('缺目标、循环、重复和不可达提交被拒绝，完整树必须覆盖所有父提交', () => {
    const s = source(), call = (rows: any[], boundary: any = s.boundary) => attributeReleaseSources(identity, boundary, rows);
    expect(() => call([{ sha: sha(3), parents: [], pulls: [] }])).toThrow('target missing');
    expect(() => call([{ sha: sha(2), parents: [sha(2)], pulls: [] }])).toThrow('cycle');
    expect(() => call([{ sha: sha(2), parents: [sha(1)], pulls: [] }, { sha: sha(2), parents: [sha(1)], pulls: [] }])).toThrow('duplicate');
    expect(() => call([{ sha: sha(2), parents: [sha(1)], pulls: [] }, { sha: sha(8), parents: [], pulls: [] }])).toThrow('unreachable');
    expect(() => call([{ sha: sha(2), parents: [sha(1)], pulls: [] }], { kind: 'full-tree' })).toThrow('incomplete');
  });
  it('分页客户端保留第二页额外 PR，而非截断或作为歧义失败', async () => {
    const { gh, pulls } = fixture(); pulls.push({ ...pulls[0]!, number: 2 });
    const seen: string[] = [];
    const client = new GitHubClient('test', 'https://api.github.com', async input => {
      const url = new URL(String(input)); seen.push(url.href);
      const response=url.searchParams.has('page') ? Response.json([pulls[1]]) : Response.json([pulls[0]], { headers: { link: `<${url.href}&page=2>; rel="next"` } });
      Object.defineProperty(response,'url',{value:url.href});return response;
    });
    expect((await collect({ ...gh, listPullsForCommit: client.listPullsForCommit.bind(client) })).input.commits[0]?.pullNumbers).toEqual([1, 2]);
    expect(seen).toHaveLength(2);
  });
  it('标签、文件和正文变化在复核时被发现；已有快照独立于可变 API 对象', async () => {
    const { gh, pulls } = fixture(); const before = await collect(gh);
    pulls[0]!.title = 'changed'; expect(before.facts[0]!.pull.title).toBe('title');
    expect(() => assertReleaseSourcesUnchanged(before, { bytes: before.bytes })).not.toThrow();
    const after = await collect(gh); expect(() => assertReleaseSourcesUnchanged(before, after)).toThrow('STALE');
    gh.listLabels = async () => [{ name: 'security' }];
    expect((await collect(gh)).inputSha256).not.toBe(after.inputSha256);
    gh.listPullFiles = async () => [{ filename: 'src/a.ts', status: 'modified', additions: NaN, deletions: 0 }];
    await expect(collect(gh)).rejects.toThrow('malformed');
  });
});
