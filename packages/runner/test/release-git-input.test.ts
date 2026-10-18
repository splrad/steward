import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeReleaseGitInput } from '../src/release-git-input.js';
import { validateReleaseSource, validateReleaseEvidence } from '../../core/src/release-bundle.js';
import { frozenFixture } from '../../core/test/release-receipt-fixture.js';
import { receiptDigest } from '../../core/src/release-note-receipt.js';
import { main } from '../src/index.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'steward-git-evidence-')); folders.push(workspace);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  const commit = (name: string, content: string | Buffer, message = 'change') => {
    writeFileSync(join(workspace, name), content); git('add', '--', name); git('commit', '-qm', message); return git('rev-parse', 'HEAD');
  };
  const base = commit('README.md', 'Usage\r\n'); git('tag', 'v1.0.0');
  const options = () => ({ workspace, identity: { repositoryId: 123, defaultBranch: 'main', targetSha: git('rev-parse', 'HEAD'), policySha: 'a'.repeat(40) }, targetTag: 'v1.1.0', boundary: { kind: 'tag' as const, sha: base, reference: 'v1.0.0' } });
  return { workspace, git, commit, base, options };
}
describe('完整 Git 发布输入', { timeout: 30_000 }, () => {
  it('冻结输入可供持久收据验证，缺块、重复字段和不完整审阅覆盖被拒绝', () => {
    const f = fixture(); f.commit('code.txt', 'product'); const snapshot = freezeReleaseGitInput(f.options());
    const frozen = { ...frozenFixture(), repositoryId: 123, defaultBranch: 'main', productTargetSha: snapshot.input.targetSha, productTree: snapshot.input.productTree,
      policySha: snapshot.input.policySha, targetTag: snapshot.input.targetTag, boundary: f.options().boundary, sourceDigest: snapshot.inputSha256 };
    expect(validateReleaseSource(Buffer.from(snapshot.bytes), frozen)).toEqual(snapshot.input);
    const corrupt = JSON.parse(snapshot.bytes); corrupt.objects[0].rawBase64 = Buffer.from('corrupt').toString('base64');
    const bytes = Buffer.from(JSON.stringify(corrupt) + '\n');
    expect(() => validateReleaseSource(bytes, { ...frozen, sourceDigest: receiptDigest(bytes) })).toThrow('SOURCE_OBJECT');
    const duplicate = Buffer.from(snapshot.bytes.replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2'));
    expect(() => validateReleaseSource(duplicate, { ...frozen, sourceDigest: receiptDigest(duplicate) })).toThrow('SOURCE_BINDING');
    const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceDigest: frozen.sourceDigest, coverage: { commitShas: [], paths: [] }, internalChanges: [], unknowns: [] }));
    expect(() => validateReleaseEvidence(evidence, { ...frozen, evidenceDigest: receiptDigest(evidence) }, snapshot.input)).toThrow('EVIDENCE_COVERAGE');
  });
  it('CLI 幂等保存来源，拒绝覆盖异内容和冲突边界', async () => {
    const f = fixture(); f.commit('code.txt', 'product');
    const output = join(f.workspace, 'source.json');
    const args = ['release-freeze', '--workspace', f.workspace, '--repository-id', '123', '--default-branch', 'main',
      '--target-sha', f.options().identity.targetSha, '--policy-sha', 'a'.repeat(40), '--target-tag', 'v1.1.0',
      '--boundary-sha', f.base, '--boundary-tag', 'v1.0.0', '--output', output];
    await main(args); await main(args);
    writeFileSync(output, 'user-edited');
    await expect(main(args)).rejects.toThrow('输出已存在且内容不同');
    await expect(main([...args, '--full-tree', 'true'])).rejects.toThrow('不能混用');
  });
  it('直接提交无需 PR，保留 CRLF 原始字节，忽略工作区未提交修改', () => {
    const f = fixture(); const head = f.commit('code.txt', 'new\r\n');
    const before = freezeReleaseGitInput(f.options());
    writeFileSync(join(f.workspace, 'code.txt'), 'uncommitted');
    const after = freezeReleaseGitInput(f.options());
    expect(after.bytes).toBe(before.bytes);
    expect(before.input.commits.map(c => c.sha)).toEqual([head]);
    expect(before.input.changes).toMatchObject([{ status: 'A', path: 'code.txt' }]);
    const object = before.input.objects.find(o => o.oid === before.input.changes[0]?.after?.oid)!;
    expect(Buffer.from(object.rawBase64, 'base64').toString()).toBe('new\r\n');
    expect(before.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('完整可达范围包含合并支线，净差异排除被撤销的变化', () => {
    const f = fixture();
    f.git('checkout', '-qb', 'feature'); const feature = f.commit('feature.txt', 'feature');
    f.git('checkout', '-q', 'main'); f.commit('main.txt', 'main'); f.git('merge', '--no-ff', '-qm', 'merge', 'feature');
    f.commit('temporary.txt', 'temporary'); f.git('rm', '-q', 'temporary.txt'); f.git('commit', '-qm', 'revert temporary');
    const snapshot = freezeReleaseGitInput(f.options());
    expect(snapshot.input.commits.some(c => c.sha === feature)).toBe(true);
    expect(snapshot.input.commits).toHaveLength(5);
    expect(snapshot.input.changes.map(c => c.path)).toEqual(['feature.txt', 'main.txt']);
  });
  it('保留重命名、二进制及 LFS 指针缺口，不取工作区文件或下载对象', () => {
    const f = fixture(); f.commit('old.txt', 'rename content');
    const baseline = f.git('rev-parse', 'HEAD');
    renameSync(join(f.workspace, 'old.txt'), join(f.workspace, '新文件.txt')); f.git('add', '-A'); f.git('commit', '-qm', 'rename');
    f.commit('binary.dat', Buffer.from([0, 255, 13, 10]));
    f.commit('large.bin', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n');
    const snapshot = freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'baseline', sha: baseline, reference: 'explicit boundary' } });
    expect(snapshot.input.changes).toContainEqual(expect.objectContaining({ status: 'R100', path: '新文件.txt', previousPath: 'old.txt' }));
    expect(snapshot.input.gaps).toContainEqual(expect.objectContaining({ path: 'binary.dat', reason: 'binary-semantics-unread' }));
    expect(snapshot.input.gaps).toContainEqual(expect.objectContaining({ path: 'large.bin', reason: 'lfs-pointer-only' }));
  });
  it.each([
    ['binary-semantics-unread', Buffer.from([0, 255, 13, 10])],
    ['lfs-pointer-only', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n'],
  ] as const)('重命名保留前后两个路径的 %s 缺口', (reason, content) => {
    const f = fixture(); const baseline = f.commit('old.bin', content);
    renameSync(join(f.workspace, 'old.bin'), join(f.workspace, 'new.bin'));
    f.git('add', '-A'); f.git('commit', '-qm', 'rename unreadable file');
    const snapshot = freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'baseline', sha: baseline, reference: 'explicit boundary' } });
    expect(snapshot.input.changes).toContainEqual(expect.objectContaining({ status: 'R100', previousPath: 'old.bin', path: 'new.bin' }));
    expect(snapshot.input.gaps.filter(g => g.reason === reason).map(g => g.path).sort()).toEqual(['new.bin', 'old.bin']);
  });
  it('首次发布采用完整产品树，不伪造边界 PR', () => {
    const f = fixture(); f.commit('code.txt', 'product');
    const snapshot = freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'full-tree' } });
    expect(snapshot.input.boundaryTree).toBeNull();
    expect(snapshot.input.commits).toHaveLength(2);
    expect(snapshot.input.changes.map(c => c.path)).toEqual(['README.md', 'code.txt']);
  });
  it.each(['commits', 'files', 'objectBytes', 'totalBytes'] as const)('超出 %s 限额明确失败，不产出截断快照', budget => {
    const f = fixture(); f.commit('one.txt', 'one'); f.commit('two.txt', 'two');
    expect(() => freezeReleaseGitInput({ ...f.options(), limits: { [budget]: 1 } })).toThrow('coverage budget');
  });
  it('拒绝漂移标签、非祖先范围及版本倒退', () => {
    const f = fixture(); f.commit('code.txt', 'product');
    expect(() => freezeReleaseGitInput({ ...f.options(), targetTag: 'v1.0.0' })).toThrow('increase');
    f.git('tag', 'v1.1.0', f.base);
    expect(() => freezeReleaseGitInput(f.options())).toThrow('target tag drift'); f.git('tag', '-d', 'v1.1.0');
    f.git('tag', '-f', 'v1.0.0'); expect(() => freezeReleaseGitInput(f.options())).toThrow('boundary tag drift');
    f.git('checkout', '--orphan', 'unrelated'); f.git('rm', '-rf', '.'); const unrelated = f.commit('other.txt', 'other');
    f.git('checkout', '-q', 'main');
    expect(() => freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'baseline', sha: unrelated, reference: 'bad boundary' } })).toThrow('Git read failed: merge-base');
  });
  it('浅克隆和缺失对象不能被视为完整历史', () => {
    const f = fixture(); f.commit('code.txt', 'product');
    writeFileSync(join(f.workspace, '.git', 'shallow'), f.git('rev-parse', 'HEAD') + '\n');
    expect(() => freezeReleaseGitInput(f.options())).toThrow('shallow');
    rmSync(join(f.workspace, '.git', 'shallow'));
    expect(() => freezeReleaseGitInput({ ...f.options(), identity: { ...f.options().identity, targetSha: 'b'.repeat(40) } })).toThrow('Git read failed');
  });
});
