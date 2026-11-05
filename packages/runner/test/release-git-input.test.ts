import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeReleaseGitInput } from '../src/release-git-input.js';
import { collectContentInput, planContentBatches, contentWireInput } from '../src/release-content.js';
import { validateReleaseSource, validateReleaseSourceManifest, validateReleaseEvidence } from '../../core/src/release-bundle.js';
import { frozenFixture } from '../../core/test/release-receipt-fixture.js';
import { receiptDigest } from '../../core/src/release-note-receipt.js';
import { main } from '../src/index.js';

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'steward-git-evidence-')); folders.push(workspace); registerOfflineFixtureRoot(workspace);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  const commit = (name: string, content: string | Buffer, message = 'change') => {
    writeFileSync(join(workspace, name), content); git('add', '--', name); git('commit', '--signoff', '-qm', message); return git('rev-parse', 'HEAD');
  };
  const base = commit('README.md', 'Usage\r\n'); git('tag', 'v1.0.0');
  const options = () => ({ workspace, identity: { repositoryId: 123, defaultBranch: 'main', targetSha: git('rev-parse', 'HEAD'), controllerSha: 'a'.repeat(40) }, unit: { id: 'product', path: '.', version: '1.1.0', tag: 'v1.1.0' }, boundary: { kind: 'tag' as const, sha: base, reference: 'v1.0.0', version: '1.0.0' } });
  return { workspace, git, commit, base, options };
}
describe('完整 Git 发布输入', { timeout: 30_000 }, () => {
  it('draft input retains commit IDs for attribution without duplicating history in model input', async () => {
    const f=fixture(); f.commit('large.txt','未要求逐源码模型覆盖。'.repeat(10000),'feat: new feature');
    const collected=await collectContentInput({directory:join(f.workspace,'collected'),candidateId:'d'.repeat(64),configDigest:'e'.repeat(64),units:[{...f.options(),contextPaths:['README.md']}]});
    expect(collected.sources.some(s=>s.path==='large.txt')).toBe(false);
    expect(collected.sources.some(s=>s.path==='commits'||s.text.includes('feat: new feature'))).toBe(false);
    expect(collected.sources.find(s=>s.path==='README.md')!.text).toContain('Usage');
    expect(collected.manifests[0]!.commits).toHaveLength(1);
    const work=await planContentBatches(collected.input,collected.sources,{manifests:collected.manifests,gaps:[]});
    expect(work.input.batches).toHaveLength(1);expect(work.input.batches[0]!.stage).toBe('DRAFT');
  });
  it.each([
    ['web-sdk', 'packages/web-sdk', 'web-sdk-v1.2.0-beta.1', '1.2.0-beta.1'],
    ['python-sdk', 'packages/python-sdk', 'python-sdk-v2.0.0-rc.2', '2.0.0-rc.2'],
    ['go-module', 'modules/one', 'modules/one/v2.0.0', '2.0.0'],
  ])('保留 RP 已解析的单位、路径、标签和版本：%s', async (id, path, tag, version) => {
    const f = fixture(); f.commit('code.txt', 'product');
    const unit = { id, path, tag, version };
    const snapshot = await freezeReleaseGitInput({ ...f.options(), unit });
    expect(snapshot.input.unit).toEqual(unit);
    expect(snapshot.input.controllerSha).toBe('a'.repeat(40));
    expect(snapshot.input).not.toHaveProperty('policySha');
    await expect(freezeReleaseGitInput({ ...f.options(), unit: { ...unit, version: '1.0.0-rc.1' } })).rejects.toThrow('increase');
  });
  it('跨单字节块保持 UTF-8 判定，空文件和 CRLF 的字节区间完整', async () => {
    const f = fixture(); f.commit('unicode.txt', '中🙂\r\n'); f.commit('empty.txt', '');
    const snapshot = await freezeReleaseGitInput({ ...f.options(), limits: { chunkBytes: 1 } });
    const find = (path: string) => snapshot.input.objects.find(object => object.oid === snapshot.input.changes.find(change => change.path === path)?.after?.oid)!;
    const unicode = find('unicode.txt');
    expect(unicode.encoding).toBe('utf8'); expect(unicode.size).toBe(9); expect(unicode.chunks).toHaveLength(9);
    expect(unicode.sha256).toBe(createHash('sha256').update('中🙂\r\n').digest('hex'));
    expect(find('empty.txt')).toMatchObject({ size: 0, chunks: [], encoding: 'utf8' });
  });
  it.each([false, true])('Git 批量读取隔离父进程秘密并清理临时配置，失败=%s', async failure => {
    const f = fixture(); f.commit('code.txt', 'product');
    const input = f.options();
    vi.stubEnv('GH_TOKEN', 'sentinel-repository-secret'); vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('COPILOT_GITHUB_TOKEN', 'sentinel-model-secret');
    const spawn = vi.spyOn(childProcess, 'spawn');
    const promise = freezeReleaseGitInput({ ...input, ...(failure ? { limits: { objectBytes: 1 } } : {}) });
    if (failure) await expect(promise).rejects.toThrow('coverage budget'); else await promise;
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty('GH_TOKEN'); expect(options.env).not.toHaveProperty('COPILOT_GITHUB_TOKEN'); expect(options.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    expect(existsSync(options.env.HOME!)).toBe(false);
  });
  it('超过旧 32 MiB 整包和 8 MiB 单对象限制后按连续块保存完整摘要', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.commit(`large-${i}.bin`, Buffer.alloc(16 * 1024 * 1024 + 1, i));
    const snapshot = await freezeReleaseGitInput(f.options());
    expect(snapshot.input.coverage.retainedBytes).toBeGreaterThan(48 * 1024 * 1024);
    expect(Buffer.byteLength(snapshot.bytes)).toBeLessThan(32 * 1024);
    expect(snapshot.bytes).not.toContain('rawBase64');
    for (const object of snapshot.input.objects.filter(o => o.type === 'blob' && o.size > 1024 * 1024)) {
      expect(object.chunks).toHaveLength(17);
      expect(object.chunks[0]?.start).toBe(0);
      expect(object.chunks.at(-1)?.end).toBe(object.size);
      expect(object.sha256).toBe(createHash('sha256').update(execFileSync('git', ['cat-file', 'blob', object.oid], { cwd: f.workspace, maxBuffer: 20 * 1024 * 1024 })).digest('hex'));
    }
  });
  it('来源清单拒绝缺块和重复字段；旧 schema 2 字节与收据仍可只读验证', async () => {
    const f = fixture(); f.commit('code.txt', 'product'); const snapshot = await freezeReleaseGitInput(f.options());
    const binding = { ...f.options().identity, unit: snapshot.input.unit, productTree: snapshot.input.productTree, boundary: snapshot.input.boundary, sourceDigest: snapshot.inputSha256 };
    expect(validateReleaseSourceManifest(Buffer.from(snapshot.bytes), binding)).toEqual(snapshot.input);
    const corrupt = JSON.parse(snapshot.bytes); corrupt.objects[0].chunks[0].end++;
    const bad = Buffer.from(JSON.stringify(corrupt) + '\n');
    expect(() => validateReleaseSourceManifest(bad, { ...binding, sourceDigest: receiptDigest(bad) })).toThrow('CHUNK_COVERAGE');
    const duplicate = Buffer.from(snapshot.bytes.replace('"schemaVersion":3', '"schemaVersion":2,"schemaVersion":3'));
    expect(() => validateReleaseSourceManifest(duplicate, { ...binding, sourceDigest: receiptDigest(duplicate) })).toThrow('SOURCE_BINDING');
    const legacy = { ...snapshot.input, schemaVersion: 2, policySha: snapshot.input.controllerSha, targetTag: snapshot.input.unit.tag,
      boundary: { kind: 'tag' as const, sha: f.base, reference: 'v1.0.0' },
      objects: snapshot.input.objects.map(({ chunks, lfsPointer, ...object }) => ({ ...object, rawBase64: execFileSync('git', ['cat-file', object.type, object.oid], { cwd: f.workspace }).toString('base64') })) };
    const legacyBytes = Buffer.from(JSON.stringify(legacy) + '\n');
    const frozen = { ...frozenFixture(), repositoryId: 123, defaultBranch: 'main', productTargetSha: legacy.targetSha, productTree: legacy.productTree,
      policySha: legacy.policySha, targetTag: legacy.targetTag, boundary: legacy.boundary, sourceDigest: receiptDigest(legacyBytes) };
    expect(validateReleaseSource(legacyBytes, frozen)).toEqual(legacy);
    legacy.objects[0]!.rawBase64 = Buffer.from('corrupt').toString('base64');
    const bytes = Buffer.from(JSON.stringify(legacy) + '\n');
    expect(() => validateReleaseSource(bytes, { ...frozen, sourceDigest: receiptDigest(bytes) })).toThrow('SOURCE_OBJECT');
    const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceDigest: binding.sourceDigest, coverage: { commitShas: [], paths: [] }, internalChanges: [], unknowns: [] }));
    expect(() => validateReleaseEvidence(evidence, { sourceDigest: binding.sourceDigest, evidenceDigest: receiptDigest(evidence) }, snapshot.input)).toThrow('EVIDENCE_COVERAGE');
  });
  it('CLI 幂等保存来源，拒绝覆盖异内容和冲突边界', async () => {
    const f = fixture(); f.commit('code.txt', 'product');
    const output = join(f.workspace, 'source.json');
    const args = ['release-freeze', '--workspace', f.workspace, '--repository-id', '123', '--default-branch', 'main',
      '--target-sha', f.options().identity.targetSha, '--controller-sha', 'a'.repeat(40), '--unit', 'product', '--unit-path', '.', '--version', '1.1.0', '--target-tag', 'v1.1.0',
      '--boundary-sha', f.base, '--boundary-tag', 'v1.0.0', '--boundary-version', '1.0.0', '--output', output];
    await main(args); await main(args);
    writeFileSync(output, 'user-edited');
    await expect(main(args)).rejects.toThrow('输出已存在且内容不同');
    await expect(main([...args, '--full-tree', 'true'])).rejects.toThrow('不能混用');
  });
  it('直接提交无需 PR，保留 CRLF 原始字节，忽略工作区未提交修改', async () => {
    const f = fixture(); const head = f.commit('code.txt', 'new\r\n');
    const before = await freezeReleaseGitInput(f.options());
    writeFileSync(join(f.workspace, 'code.txt'), 'uncommitted');
    const after = await freezeReleaseGitInput(f.options());
    expect(after.bytes).toBe(before.bytes);
    expect(before.input.commits.map(c => c.sha)).toEqual([head]);
    expect(before.input.changes).toMatchObject([{ status: 'A', path: 'code.txt' }]);
    const object = before.input.objects.find(o => o.oid === before.input.changes[0]?.after?.oid)!;
    expect(object.sha256).toBe(createHash('sha256').update('new\r\n').digest('hex'));
    expect(object.chunks).toEqual([{ start: 0, end: 5, sha256: object.sha256 }]);
    expect(before.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('完整可达范围包含合并支线，净差异排除被撤销的变化', async () => {
    const f = fixture();
    f.git('checkout', '-qb', 'feature'); const feature = f.commit('feature.txt', 'feature');
    f.git('checkout', '-q', 'main'); f.commit('main.txt', 'main'); f.git('merge', '--no-ff', '-qm', 'merge', 'feature');
    f.commit('temporary.txt', 'temporary'); f.git('rm', '-q', 'temporary.txt'); f.git('commit', '-qm', 'revert temporary');
    const snapshot = await freezeReleaseGitInput(f.options());
    expect(snapshot.input.commits.some(c => c.sha === feature)).toBe(true);
    expect(snapshot.input.commits).toHaveLength(5);
    expect(snapshot.input.changes.map(c => c.path)).toEqual(['feature.txt', 'main.txt']);
  });
  it('保留重命名、二进制及 LFS 指针缺口，不取工作区文件或下载对象', async () => {
    const f = fixture(); f.commit('old.txt', 'rename content');
    const baseline = f.git('rev-parse', 'HEAD');
    renameSync(join(f.workspace, 'old.txt'), join(f.workspace, '新文件.txt')); f.git('add', '-A'); f.git('commit', '-qm', 'rename');
    f.commit('binary.dat', Buffer.from([0, 255, 13, 10]));
    f.commit('large.bin', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n');
    const snapshot = await freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'baseline', sha: baseline, reference: 'explicit boundary' } });
    expect(snapshot.input.changes).toContainEqual(expect.objectContaining({ status: 'R100', path: '新文件.txt', previousPath: 'old.txt' }));
    expect(snapshot.input.gaps).toContainEqual(expect.objectContaining({ path: 'binary.dat', reason: 'binary-semantics-unread' }));
    expect(snapshot.input.gaps).toContainEqual(expect.objectContaining({ path: 'large.bin', reason: 'lfs-pointer-only' }));
  });
  it.each([
    ['binary-semantics-unread', Buffer.from([0, 255, 13, 10])],
    ['lfs-pointer-only', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n'],
  ] as const)('重命名保留前后两个路径的 %s 缺口', async (reason, content) => {
    const f = fixture(); const baseline = f.commit('old.bin', content);
    renameSync(join(f.workspace, 'old.bin'), join(f.workspace, 'new.bin'));
    f.git('add', '-A'); f.git('commit', '-qm', 'rename unreadable file');
    const snapshot = await freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'baseline', sha: baseline, reference: 'explicit boundary' } });
    expect(snapshot.input.changes).toContainEqual(expect.objectContaining({ status: 'R100', previousPath: 'old.bin', path: 'new.bin' }));
    expect(snapshot.input.gaps.filter(g => g.reason === reason).map(g => g.path).sort()).toEqual(['new.bin', 'old.bin']);
  });
  it('首次发布采用完整产品树，不伪造边界 PR', async () => {
    const f = fixture(); f.commit('code.txt', 'product');
    const snapshot = await freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'full-tree' } });
    expect(snapshot.input.boundaryTree).toBeNull();
    expect(snapshot.input.commits).toHaveLength(2);
    expect(snapshot.input.changes.map(c => c.path)).toEqual(['README.md', 'code.txt']);
  });
  it.each(['commits', 'files', 'objectBytes', 'totalBytes'] as const)('超出 %s 限额明确失败，不产出截断快照', async budget => {
    const f = fixture(); f.commit('one.txt', 'one'); f.commit('two.txt', 'two');
    await expect(freezeReleaseGitInput({ ...f.options(), limits: { [budget]: 1 } })).rejects.toThrow('coverage budget');
  });
  it('拒绝漂移标签、非祖先范围及版本倒退', async () => {
    const f = fixture(); f.commit('code.txt', 'product');
    await expect(freezeReleaseGitInput({ ...f.options(), unit: { ...f.options().unit, version: '1.0.0', tag: 'v1.0.0' } })).rejects.toThrow('increase');
    f.git('tag', 'v1.1.0', f.base);
    await expect(freezeReleaseGitInput(f.options())).rejects.toThrow('target tag drift'); f.git('tag', '-d', 'v1.1.0');
    f.git('tag', '-f', 'v1.0.0'); await expect(freezeReleaseGitInput(f.options())).rejects.toThrow('boundary tag drift');
    f.git('checkout', '--orphan', 'unrelated'); f.git('rm', '-rf', '.'); const unrelated = f.commit('other.txt', 'other');
    f.git('checkout', '-q', 'main');
    await expect(freezeReleaseGitInput({ ...f.options(), boundary: { kind: 'baseline', sha: unrelated, reference: 'bad boundary' } })).rejects.toThrow('Git read failed: merge-base');
  });
  it('浅克隆和缺失对象不能被视为完整历史', async () => {
    const f = fixture(); f.commit('code.txt', 'product');
    writeFileSync(join(f.workspace, '.git', 'shallow'), f.git('rev-parse', 'HEAD') + '\n');
    await expect(freezeReleaseGitInput(f.options())).rejects.toThrow('shallow');
    rmSync(join(f.workspace, '.git', 'shallow'));
    await expect(freezeReleaseGitInput({ ...f.options(), identity: { ...f.options().identity, targetSha: 'b'.repeat(40) } })).rejects.toThrow('Git read failed');
  });
});


it.each(['.', 'packages/app'])('selects only the configured HISTORY.md for unit %s', async path => {
  const f=fixture(),notes='## 1.1.0\n\n### Bug Fixes\n\n* current repair\n\n## 1.0.0\n\n* old history\n';
  const prefix=path==='.'?'':path+'/';
  const collected=await collectContentInput({directory:f.workspace,candidateId:'d'.repeat(64),configDigest:'e'.repeat(64),repository:'fixture/product',
    units:[{...f.options(),unit:{...f.options().unit,path},changelogPath:'HISTORY.md'}],
    preparedChanges:[{path:prefix+'HISTORY.md',content:notes},{path:prefix+'CHANGELOG.md',content:notes.replace('current repair','wrong file')},
      {path:prefix+'nested/HISTORY.md',content:notes.replace('current repair','nested file')} ]});
  expect(collected.sources.map(source=>source.path)).toEqual([prefix+'HISTORY.md']);
  expect(collected.sources[0]!.text).toContain('current repair');
  expect(collected.sources[0]!.text).not.toMatch(/old history|wrong file|nested file/);
});
