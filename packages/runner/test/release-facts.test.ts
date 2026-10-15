import { budgetReleaseSourceTransport } from '../src/release-source-budget.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../github/src/index.js';
import { collectReleaseFactSnapshot, retainReleaseFragment, type ReleaseFactContext } from '../src/release-facts.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const path = '.release-notes/fragments/fix-first.json';
const bytes = Buffer.from('{\r\n "schemaVersion": 1, "status": "documented", "entries": [{"change":"修复批量读取过程中的遗漏问题","userImpact":"用户可以读取到完整的结果列表","actionRequired":false}]\r\n}\r\n');
function fixture() {
  const identity = { repositoryId: 123, defaultBranch: 'main', targetSha: sha(3), policySha: sha(99) };
  const retained = retainReleaseFragment(path, bytes);
  const pull = { number: 1, merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: sha(3), changed_files: 2, commits: 1,
    title: 'title', body: '', user: { id: 42, login: 'alice', type: 'User' }, head: { sha: sha(4), ref: 'feature', repo: { id: 123 } }, base: { ref: 'main', sha: sha(1), repo: { id: 123 } } };
  const files = [{ filename: path, status: 'added', additions: 1, deletions: 0 }, { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }];
  const gh = new GitHubClient('test');
  gh.listReleases = vi.fn(async () => [{ tag_name: 'v1.0.0', draft: false, prerelease: false }]);
  gh.getGitRef = vi.fn(async () => ({ object: { type: 'commit', sha: sha(1) } }));
  gh.getCommit = vi.fn(async () => ({ sha: sha(3), parents: [{ sha: sha(1) }] }));
  gh.listPullsForCommit = vi.fn(async () => [pull]); gh.getPullRequest = vi.fn(async () => pull);
  gh.listPullFiles = vi.fn(async () => files); gh.listPullCommits = vi.fn(async () => [{ sha: sha(4), commit: { message: 'fix' } }]); gh.listLabels = vi.fn(async () => []);
  const objects = new Map<string, any>([
    [`/repos/o/r/git/commits/${sha(3)}`, { sha: sha(3), tree: { sha: sha(10) } }],
    [`/repos/o/r/git/trees/${sha(10)}`, { sha: sha(10), truncated: false, tree: [{ path: '.release-notes', mode: '040000', type: 'tree', sha: sha(11) }] }],
    [`/repos/o/r/git/trees/${sha(11)}`, { sha: sha(11), truncated: false, tree: [{ path: 'fragments', mode: '040000', type: 'tree', sha: sha(12) }] }],
    [`/repos/o/r/git/trees/${sha(12)}`, { sha: sha(12), truncated: false, tree: [{ path: 'fix-first.json', mode: '100644', type: 'blob', sha: retained.blobSha }] }],
    [`/repos/o/r/git/blobs/${retained.blobSha}`, { sha: retained.blobSha, encoding: 'base64', content: retained.rawBase64, size: bytes.length }],
  ]);
  gh.request = vi.fn(async (_method, url) => { if (!objects.has(url)) throw Error(`unexpected ${url}`); return structuredClone(objects.get(url)); });
  const context: ReleaseFactContext = { history: { repositoryId: 123, targetSha: sha(3), policySha: sha(99), complete: true,
    fragments: [{ fragmentId: 'fix-first', pullNumber: 1, mergeSha: sha(3), blobSha: retained.blobSha, sha256: retained.sha256, consumed: false }], migrations: [] } };
  return { options: { gh, owner: 'o', repo: 'r', identity, targetTag: 'v1.1.0',
    profile: { fragmentDirectory: '.release-notes/fragments', required: ['src/**'], reviewRequired: [], ignored: [] },
    readContext: vi.fn(async () => structuredClone(context)), classify: () => ({ primaryKind: 'bug', riskFlags: [] as string[] }) }, objects, context, files, pull };
}
describe('R03 固定树事实采集', () => {
  it.each([50, 51])('%s PR 的完整 HTTP 预算边界包含两轮片段读取', async count => {
    vi.useFakeTimers();
    try {
      let calls = 0; const target = sha(count + 1); const retained = retainReleaseFragment(path, bytes);
      const name = (n: number) => 'fix-' + String(n).padStart(4, '0');
      const pull = (n: number) => ({ number: n, merged: true, merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: sha(n + 1), changed_files: 1, commits: 1,
        title: 'title', body: '', user: { id: 42, login: 'alice', type: 'User' }, head: { sha: sha(100 + n), ref: 'feature', repo: { id: 123 } }, base: { ref: 'main', sha: sha(n), repo: { id: 123 } } });
      const transport = budgetReleaseSourceTransport(async input => {
        calls++; const p = new URL(String(input)).pathname;
        if (p.endsWith('/releases')) return Response.json([{ tag_name: 'v1.0.0', draft: false, prerelease: false }]);
        if (p.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: sha(1) } });
        if (p.includes('/git/blobs/')) return Response.json({ sha: retained.blobSha, encoding: 'base64', content: retained.rawBase64, size: bytes.length });
        const git = /\/git\/(commits|trees)\/([a-f0-9]{40})$/.exec(p);
        if (git) {
          const n = parseInt(git[2]!, 16);
          if (git[1] === 'commits') return Response.json({ sha: sha(n), tree: { sha: sha(1000 + n) } });
          const tree = n < 2000 ? [{ path: '.release-notes', mode: '040000', type: 'tree', sha: sha(n + 1000) }]
            : n < 3000 ? [{ path: 'fragments', mode: '040000', type: 'tree', sha: sha(n + 1000) }]
            : Array.from({ length: count }, (_, i) => ({ path: name(i + 1) + '.json', mode: '100644', type: 'blob', sha: retained.blobSha }));
          return Response.json({ sha: sha(n), truncated: false, tree });
        }
        const commit = /\/commits\/([a-f0-9]{40})(\/pulls)?$/.exec(p);
        if (commit) { const n = parseInt(commit[1]!, 16); return Response.json(commit[2] ? [pull(n - 1)] : { sha: sha(n), parents: [{ sha: sha(n - 1) }] }); }
        const pr = /\/(pulls|issues)\/(\d+)(?:\/(files|commits|labels))?$/.exec(p);
        if (pr) { const n = Number(pr[2]); return Response.json(pr[3] === 'files' ? [{ filename: '.release-notes/fragments/' + name(n) + '.json', status: 'added', additions: 1, deletions: 0 }]
          : pr[3] === 'commits' ? [{ sha: sha(100 + n), commit: { message: 'change' } }] : pr[3] === 'labels' ? [] : pull(n)); }
        throw Error(p);
      });
      const gh = new GitHubClient('test', 'https://api.github.com', transport);
      const identity = { repositoryId: 123, defaultBranch: 'main', targetSha: target, policySha: sha(99) };
      const history = { ...identity, complete: true as const, fragments: Array.from({ length: count }, (_, i) => ({ fragmentId: name(i + 1), pullNumber: i + 1, mergeSha: sha(i + 2), blobSha: retained.blobSha, sha256: retained.sha256, consumed: false })), migrations: [] };
      const done = Promise.allSettled([collectReleaseFactSnapshot({ gh, owner: 'o', repo: 'r', identity, targetTag: 'v1.1.0',
        profile: { fragmentDirectory: '.release-notes/fragments', required: [], reviewRequired: [], ignored: [] }, readContext: async () => ({ history }), classify: () => ({ primaryKind: 'bug', riskFlags: [] }) })]);
      await vi.runAllTimersAsync(); const [result] = await done;
      if (count === 50) { expect(result?.status).toBe('fulfilled'); expect(calls).toBe(1604); }
      else { expect(result?.status).toBe('rejected'); expect(calls).toBe(52); }
    } finally { vi.useRealTimers(); }
  });
  it('真实 Git blob 路径读取，两轮来源/历史复核，输出原字节和确定性摘要', async () => {
    const f = fixture(), out = await collectReleaseFactSnapshot(f.options);
    expect(out.facts.facts[0]?.factId).toBe('fix-first#0');
    expect(Buffer.from(out.facts.consumedFragments[0]!.rawBase64, 'base64')).toEqual(bytes);
    expect(out.inputSha256).toBe(createHash('sha256').update(out.bytes).digest('hex'));
    expect(f.options.readContext).toHaveBeenCalledTimes(2);
    expect(f.options.gh.listPullFiles).toHaveBeenCalledTimes(2);
    expect(out).toEqual(await collectReleaseFactSnapshot(f.options));
  });
  it.each(['missing', 'truncated', 'symlink', 'digest', 'encoding'])('远端片段 %s 失败关闭', async kind => {
    const f = fixture(), tree = f.objects.get(`/repos/o/r/git/trees/${sha(12)}`), retained = retainReleaseFragment(path, bytes);
    if (kind === 'missing') tree.tree = [];
    if (kind === 'truncated') tree.truncated = true;
    if (kind === 'symlink') tree.tree[0].mode = '120000';
    if (kind === 'digest') f.objects.get(`/repos/o/r/git/blobs/${retained.blobSha}`).content = Buffer.alloc(bytes.length).toString('base64');
    if (kind === 'encoding') f.objects.get(`/repos/o/r/git/blobs/${retained.blobSha}`).encoding = 'utf8';
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow();
  });
  it('可信历史缺失、未知状态和二次消费均失败', async () => {
    const f = fixture(); Object.assign(f.options, { readContext: undefined });
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow('history unavailable');
    const g = fixture(); g.options.readContext.mockResolvedValueOnce(structuredClone(g.context)); g.context.history.fragments[0]!.consumed = true;
    await expect(collectReleaseFactSnapshot(g.options)).rejects.toThrow('reuse');
  });
  it('二次读取的非消费历史漂移同样阻断', async () => {
    const f = fixture(); f.options.readContext.mockResolvedValueOnce(structuredClone(f.context));
    f.context.history.migrations = [{ migrationId: 'other-id', sha256: 'a'.repeat(64), consumed: true }];
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow('RN_SOURCE_STALE');
  });
  it('R02 来源不变时分类结果漂移仍按 R03 快照阻断', async () => {
    const f = fixture(); let calls = 0;
    f.options.classify = () => ({ primaryKind: 'bug', riskFlags: ++calls === 1 ? [] : ['security'] });
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow('RN_SOURCE_STALE');
  });
  it('源 PR 内容在两次读取间改变时阻断', async () => {
    const f = fixture(); let calls = 0;
    f.options.classify = () => { if (++calls === 1) f.files[1]!.additions++; return { primaryKind: 'bug', riskFlags: [] }; };
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow('RN_SOURCE_STALE');
  });
  it('不从产品树读迁移清单，缺少中央迁移事实不会替代缺片段', async () => {
    const f = fixture(); f.files.splice(0, 1); f.pull.changed_files = 1;
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow('RN_FRAGMENT_REQUIRED');
    expect(f.options.gh.request).not.toHaveBeenCalled();
  });
  it('target 与合并时 blob 字节不同时阻断', async () => {
    const f = fixture(), original = f.options.gh.request; let reads = 0;
    f.options.gh.request = vi.fn(async (method, url, body) => {
      if (url.endsWith(`/git/trees/${sha(12)}`) && ++reads === 2) return { sha: sha(12), truncated: false, tree: [] } as any;
      return original(method, url, body);
    });
    await expect(collectReleaseFactSnapshot(f.options)).rejects.toThrow('fragment missing or changed');
  });
  it('中央迁移正常采集，迁移原字节及独立命名空间进入输出', async () => {
    const f = fixture(); f.files.splice(0, 1); f.pull.changed_files = 1;
    const migrationBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, migrationId: 'adopt-2026', repositoryId: 123,
      previousRelease: { tag: 'v1.0.0', sha: sha(1) }, boundarySha: sha(3), expiresAfterTag: 'v1.1.0',
      entries: [{ pullNumber: 1, mergeSha: sha(3), fragment: JSON.parse(bytes.toString()) }] }));
    f.context.migrationBytes = migrationBytes;
    f.context.history.migrations = [{ migrationId: 'adopt-2026', sha256: createHash('sha256').update(migrationBytes).digest('hex'), consumed: false }];
    const result = await collectReleaseFactSnapshot(f.options);
    expect(result.facts.facts[0]?.factId).toBe('migration:adopt-2026:1#0');
    expect(result.facts.consumedFragments).toEqual([]);
    expect(Buffer.from(result.facts.migration!.rawBase64, 'base64')).toEqual(migrationBytes);
  });
  it.each(['valid', 'parents', 'wrong-sha', 'direct-commit'])('首次根采集与普通来源边界 %s', async mode => {
    const f = fixture(); f.options.gh.listReleases = vi.fn(async () => []);
    f.options.gh.getCommit = vi.fn(async (_o, _r, commit) => commit === sha(1)
      ? { sha: mode === 'wrong-sha' ? sha(8) : sha(1), parents: mode === 'parents' ? [{ sha: sha(8) }] : [] }
      : { sha: sha(3), parents: [{ sha: sha(1) }] });
    if (mode === 'direct-commit') f.options.gh.listPullsForCommit = vi.fn(async () => []);
    const migrationBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, migrationId: 'root-2026', repositoryId: 123, previousRelease: null,
      boundarySha: sha(1), expiresAfterTag: 'v1.1.0', entries: [],
      root: { sha: sha(1), fragment: JSON.parse(bytes.toString()), classification: { primaryKind: 'feature', riskFlags: [] } } }));
    f.context.migrationBytes = migrationBytes;
    f.context.history.migrations = [{ migrationId: 'root-2026', rootSha: sha(1), sha256: createHash('sha256').update(migrationBytes).digest('hex'), consumed: false }];
    const options = { ...f.options, sourcePolicy: { adoption: { mode: 'start-at-adoption' as const, repositoryId: 123, policySha: sha(99), boundarySha: sha(1), reference: 'central-root-adoption' } } };
    if (mode === 'valid') {
      const result = await collectReleaseFactSnapshot(options);
      expect(result.facts.facts.map(f => f.factId)).toEqual(['fix-first#0', 'migration:root-2026:root#0']);
      expect(f.options.gh.getCommit).toHaveBeenCalledWith('o', 'r', sha(1));
    } else await expect(collectReleaseFactSnapshot(options)).rejects.toThrow(mode === 'direct-commit' ? 'associated PRs' : 'root commit');
  });

});
