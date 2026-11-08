import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '../../github/src/client.js';
import { evaluateLegacyRuntimeMaintenance, legacyRuntimeMaintenanceBranch } from '../src/legacy-runtime-maintenance.js';

const base = 'e990eda24ef7099264dada118b3e7ddfad883cea', head = 'a'.repeat(40), policy = 'b'.repeat(40);
const contract = readFileSync(new URL('../../../.github/workflow-contract.json', import.meta.url));
const authority = { repositoryId: 1296724484, baseline: JSON.parse(contract.toString()), approverIds: [44151430] };
function fixture() {
  const pull = { number: 307, state: 'open', user: { id: 44151430 }, changed_files: 1,
    base: { repo: { id: 1296724484 }, ref: legacyRuntimeMaintenanceBranch, sha: base },
    head: { repo: { id: 1296724484 }, ref: 'codex/legacy-runtime-retirement-20261108', sha: head } };
  const gh = {
    getRepositoryById: vi.fn(async () => ({ id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' })),
    getPullRequest: vi.fn(async () => structuredClone(pull)),
    getRef: vi.fn(async (_o: string, _r: string, ref: string) => ({ object: { sha: ref === 'pull/307/merge' ? policy : ref.endsWith(legacyRuntimeMaintenanceBranch) ? base : head } })),
    getCommit: vi.fn(async (_o: string, _r: string, sha: string) => ({ sha, commit: { verification: { verified: true, reason: 'valid' } }, parents: sha === policy ? [{ sha: base }, { sha: head }] : [{ sha: base }] })),
    listPullFiles: vi.fn(async () => [{ filename: 'packages/runtime/src/index.ts', status: 'modified' }]),
    getContent: vi.fn(async () => ({ type: 'file', encoding: 'base64', content: contract.toString('base64'), size: contract.length })),
  };
  return { gh, pull, run: () => evaluateLegacyRuntimeMaintenance(gh as unknown as GitHubClient, authority, 307, policy) };
}
describe('exact historical runtime maintenance source', () => {
  it('binds the signed same-repository head and exact original contract', async () => {
    const f = fixture(), result = await f.run();
    expect(result.binding).toMatchObject({ repositoryId: 1296724484, pullNumber: 307, headSha: head, baseSha: base, policySha: policy });
    expect(f.gh.getPullRequest).toHaveBeenCalledTimes(2); expect(f.gh.getRef).toHaveBeenCalledTimes(6);
  });
  it.each(['number', 'state', 'author', 'baseRepo', 'baseRef', 'baseSha', 'headRepo', 'headRef', 'headSha'])('rejects wrong %s', async field => {
    const f = fixture();
    if (field === 'number') f.pull.number = 308;
    if (field === 'state') f.pull.state = 'closed';
    if (field === 'author') f.pull.user.id = 123;
    if (field === 'baseRepo') f.pull.base.repo.id = 123;
    if (field === 'baseRef') f.pull.base.ref = 'main';
    if (field === 'baseSha') f.pull.base.sha = head;
    if (field === 'headRepo') f.pull.head.repo.id = 123;
    if (field === 'headRef') f.pull.head.ref = 'other';
    if (field === 'headSha') f.pull.head.sha = 'invalid';
    await expect(f.run()).rejects.toThrow('pull identity');
  });
  it('rejects an incorrect native merge ref without relying on a legacy PR field', async () => {
    const f = fixture(), original = f.gh.getRef.getMockImplementation()!;
    f.gh.getRef.mockImplementation(async (...args) => args[2] === 'pull/307/merge' ? { object: { sha: head } } : original(...args));
    await expect(f.run()).rejects.toThrow('merge ref');
  });
  it('rejects other repository or PR before network', async () => {
    const f = fixture();
    await expect(evaluateLegacyRuntimeMaintenance(f.gh as unknown as GitHubClient, authority, 308, policy)).rejects.toThrow('repository/pull');
    await expect(evaluateLegacyRuntimeMaintenance(f.gh as unknown as GitHubClient, { ...authority, repositoryId: 123 }, 307, policy)).rejects.toThrow('repository/pull');
    expect(f.gh.getRepositoryById).not.toHaveBeenCalled();
  });
  it('rejects unverified signature and unexpected merge parents', async () => {
    for (const mode of ['signature', 'parents']) {
      const f = fixture(); f.gh.getCommit.mockImplementation(async (_o, _r, sha) => ({ sha, commit: { verification: { verified: mode !== 'signature', reason: 'valid' } }, parents: [{ sha: head }, { sha: base }] }));
      await expect(f.run()).rejects.toThrow(mode === 'signature' ? 'unsigned head' : 'merge parents');
    }
  });
  it.each(['.github/workflows/pr-validation.yml', 'package-lock.json', 'config/repositories.json', 'packages/github/src/workflow-contract.ts'])('rejects out-of-scope %s', async filename => {
    const f = fixture(); f.gh.listPullFiles.mockResolvedValue([{ filename, status: 'modified' }]);
    await expect(f.run()).rejects.toThrow('path outside maintenance scope');
  });
  it.each(['missing', 'duplicate', 'renamed', 'removed'])('rejects incomplete/unsafe file evidence: %s', async mode => {
    const f = fixture();
    if (mode === 'missing') f.pull.changed_files = 2;
    if (mode === 'duplicate') { f.pull.changed_files = 2; f.gh.listPullFiles.mockResolvedValue([{ filename: 'packages/runtime/src/index.ts', status: 'modified' }, { filename: 'packages/runtime/src/index.ts', status: 'modified' }]); }
    if (mode === 'renamed' || mode === 'removed') f.gh.listPullFiles.mockResolvedValue([{ filename: 'packages/runtime/src/index.ts', status: mode }]);
    await expect(f.run()).rejects.toThrow('LEGACY_MAINTENANCE_SOURCE');
  });
  it('rejects changed contract bytes and unknown file metadata', async () => {
    const f = fixture(); f.gh.getContent.mockResolvedValue({ type: 'file', encoding: 'base64', content: Buffer.from('{}').toString('base64'), size: 2 });
    await expect(f.run()).rejects.toThrow();
    f.gh.getContent.mockResolvedValue({ type: 'file', encoding: 'base64', content: contract.toString('base64'), size: contract.length + 1 });
    await expect(f.run()).rejects.toThrow('contract bytes');
  });
  it.each(['pull', 'base', 'head', 'merge'])('rejects %s moving during evaluation', async mode => {
    const f = fixture();
    if (mode === 'pull') f.gh.getPullRequest.mockResolvedValueOnce(structuredClone(f.pull)).mockResolvedValue({ ...f.pull, state: 'closed' });
    else { const original = f.gh.getRef.getMockImplementation()!; let count = 0;
      f.gh.getRef.mockImplementation(async (...args) => { count++; return count > 3 && args[2].includes(mode === 'base' ? 'maintenance/' : mode === 'merge' ? 'pull/307/merge' : 'codex/') ? { object: { sha: 'c'.repeat(40) } } : original(...args); }); }
    await expect(f.run()).rejects.toThrow('source changed during evaluation');
  });
});
