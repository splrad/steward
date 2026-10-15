import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assembleReleaseFacts, parseReleaseMigration, type FactPull, type ReleaseFactHistory } from '../src/release-facts.js';
import type { ReleaseSourceInput } from '../src/release-notes-input.js';
import { retainReleaseFragment } from '../../runner/src/release-facts.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const entry = { change: '修复批量读取过程中的遗漏问题', userImpact: '用户可以读取到完整的结果列表', actionRequired: false as const };
const documented = { schemaVersion: 1, status: 'documented', entries: [entry] };
const profile = { fragmentDirectory: '.release-notes/fragments', required: ['src/**'], reviewRequired: [], ignored: ['tests/**'] };
function fixture() {
  const source: ReleaseSourceInput = { schemaVersion: 1, repositoryId: 123, defaultBranch: 'main', targetSha: sha(3), policySha: sha(99),
    boundary: { kind: 'stable-release', sha: sha(1), reference: 'v1.0.0' },
    commits: [{ sha: sha(3), pullNumber: 2, kind: 'product', candidateId: null }, { sha: sha(2), pullNumber: 1, kind: 'product', candidateId: null }] };
  const f = retainReleaseFragment('.release-notes/fragments/fix-first.json', Buffer.from(JSON.stringify(documented, null, 2) + '\r\n'));
  const pulls: FactPull[] = [{ pullNumber: 2, mergeSha: sha(3), changes: [{ path: 'src/a.ts', status: 'modified' }, { path: f.path, status: 'added' }], classification: { primaryKind: 'bug', riskFlags: [] }, fragment: f },
    { pullNumber: 1, mergeSha: sha(2), changes: [{ path: 'tests/a.ts', status: 'added' }], classification: { primaryKind: 'chore', riskFlags: [] }, fragment: null }];
  const history: ReleaseFactHistory = { repositoryId: 123, targetSha: sha(3), policySha: sha(99), complete: true,
    fragments: [{ fragmentId: 'fix-first', pullNumber: 2, mergeSha: sha(3), blobSha: f.blobSha, sha256: f.sha256, consumed: false }], migrations: [] };
  return { source, targetTag: 'v1.1.0', profile, pulls, history };
}
function migrationFixture() {
  const f = fixture();
  const bytes = encode({ schemaVersion: 1, migrationId: 'adopt-2026', repositoryId: 123,
    previousRelease: { tag: 'v1.0.0', sha: sha(1) }, boundarySha: sha(2), expiresAfterTag: 'v1.1.0',
    entries: [{ pullNumber: 1, mergeSha: sha(2), fragment: documented }] });
  const migration = { value: parseReleaseMigration(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), rawBase64: bytes.toString('base64') };
  f.history.migrations = [{ migrationId: migration.value.migrationId, sha256: migration.sha256, consumed: false }];
  return { ...f, migration };
}
function rebind(f: ReturnType<typeof migrationFixture>) {
  const bytes = encode(f.migration.value);
  f.migration.rawBase64 = bytes.toString('base64');
  f.migration.sha256 = createHash('sha256').update(bytes).digest('hex');
  f.history.migrations[0]!.sha256 = f.migration.sha256;
}
describe('R03 发布事实合同', () => {
  it('未消费迁移原文缺失及多个待消费登记均失败关闭', () => {
    const f = migrationFixture(); const { migration, ...without } = f;
    expect(() => assembleReleaseFacts(without)).toThrow('pending migration');
    f.history.migrations = [...f.history.migrations, { migrationId: 'second-id', sha256: 'b'.repeat(64), consumed: false }];
    expect(() => assembleReleaseFacts(f)).toThrow('pending migration');
  });
  it.each(['base64', 'digest', 'value'])('迁移原文绑定拒绝 %s 不一致', kind => {
    const f = migrationFixture();
    if (kind === 'base64') f.migration.rawBase64 += '\n';
    if (kind === 'digest') { f.migration.sha256 = 'b'.repeat(64); f.history.migrations[0]!.sha256 = f.migration.sha256; }
    if (kind === 'value') f.migration.value.entries[0]!.fragment = { schemaVersion: 1, status: 'not-user-facing', reason: '更改原文之外的事实语义内容' };
    expect(() => assembleReleaseFacts(f)).toThrow();
  });
  it.each(['base64', 'digest', 'value', 'blob'])('普通片段原文绑定拒绝 %s 不一致', kind => {
    const f = fixture(), fragment = f.pulls[0]!.fragment!;
    if (kind === 'base64') fragment.rawBase64 += '\n';
    if (kind === 'digest') { fragment.sha256 = 'b'.repeat(64); f.history.fragments[0]!.sha256 = fragment.sha256; }
    if (kind === 'value') fragment.fragment = { schemaVersion: 1, status: 'not-user-facing', reason: '更改原文之外的事实语义内容' };
    if (kind === 'blob') { fragment.blobSha = sha(8); f.history.fragments[0]!.blobSha = fragment.blobSha; }
    expect(() => assembleReleaseFacts(f)).toThrow();
  });
  it.each([
    null, { primaryKind: '', riskFlags: [] }, { primaryKind: '   ', riskFlags: [] }, { primaryKind: 42, riskFlags: [] },
    { primaryKind: 'chore', riskFlags: null }, { primaryKind: 'chore', riskFlags: [''] }, { primaryKind: 'chore', riskFlags: ['  '] },
    { primaryKind: 'chore', riskFlags: [42] }, { primaryKind: 'chore', riskFlags: ['security', 'security'] },
  ])('普通 PR 非法分类 %j 在评估路径前拒绝', classification => {
    const f = fixture(); Object.assign(f.pulls[1]!, { classification });
    expect(() => assembleReleaseFacts(f)).toThrow('fact classification');
  });
  it.each(['', ' ', '\t', '\u00a0', '\u3000'])('root Schema 与解析器均拒绝空白分类 %j', blank => {
    const f = migrationFixture(), data = JSON.parse(Buffer.from(f.migration.rawBase64, 'base64').toString());
    data.previousRelease = null; data.root = { sha: sha(1), fragment: documented, classification: { primaryKind: 'feature', riskFlags: [] } };
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync('schema/release-notes-migration.schema.json', 'utf8')));
    data.root.classification.primaryKind = blank;
    expect(validate(data)).toBe(false); expect(() => parseReleaseMigration(encode(data))).toThrow();
    data.root.classification.primaryKind = 'feature'; data.root.classification.riskFlags = [blank];
    expect(validate(data)).toBe(false); expect(() => parseReleaseMigration(encode(data))).toThrow();
    data.root.classification.riskFlags = ['security'];
    expect(validate(data)).toBe(true); expect(parseReleaseMigration(encode(data)).root?.classification.riskFlags).toEqual(['security']);
  });
  it('固定事实 ID，保留原始 CRLF 字节；ignored 与产品事实完整覆盖', () => {
    const f = fixture(), r = assembleReleaseFacts(f);
    expect(r.facts.map(v => v.factId)).toEqual(['fix-first#0']);
    const kept = r.consumedFragments[0]!;
    expect(Buffer.from(kept.rawBase64, 'base64').toString()).toBe(JSON.stringify(documented, null, 2) + '\r\n');
    expect(kept.sha256).toBe(createHash('sha256').update(Buffer.from(kept.rawBase64, 'base64')).digest('hex'));
    expect(r.coverage).toHaveLength(2); expect(r.excluded[0]?.kind).toBe('ignored');
    expect(r).toEqual(assembleReleaseFacts({ ...f, pulls: [...f.pulls].reverse() }));
  });
  it('多事实保留原始索引，not-user-facing 保留可清理来源与空 factIds', () => {
    const f = fixture(); const fragment = retainReleaseFragment(f.pulls[0]!.fragment!.path, encode({ schemaVersion: 1, status: 'not-user-facing', reason: '仅调整内部测试辅助模块的实现' }));
    f.pulls[0]!.fragment = fragment; Object.assign(f.history.fragments[0]!, { blobSha: fragment.blobSha, sha256: fragment.sha256 });
    const r = assembleReleaseFacts(f); expect(r.facts).toEqual([]); expect(r.consumedFragments[0]?.factIds).toEqual([]); expect(r.excluded[0]?.kind).toBe('not-user-facing');
    expect(retainReleaseFragment(fragment.path, encode({ ...documented, entries: [entry, entry] })).fragment).toMatchObject({ entries: [entry, entry] });
  });
  it.each(['missing', 'incomplete', 'repository', 'target', 'policy'])('缺失或错误历史索引 %s 失败关闭', kind => {
    const f = fixture();
    if (kind === 'missing') Object.assign(f, { history: undefined });
    if (kind === 'incomplete') Object.assign(f.history, { complete: false });
    if (kind === 'repository') f.history.repositoryId++;
    if (kind === 'target') f.history.targetSha = sha(55);
    if (kind === 'policy') f.history.policySha = sha(55);
    expect(() => assembleReleaseFacts(f)).toThrow('history');
  });
  it.each(['missing', 'duplicate', 'consumed', 'origin', 'blob', 'digest'])('历史防复用检查 %s', kind => {
    const f = fixture(), prior = f.history.fragments[0]!;
    if (kind === 'missing') f.history.fragments = [];
    if (kind === 'duplicate') f.history.fragments = [prior, { ...prior, mergeSha: sha(66) }];
    if (kind === 'consumed') prior.consumed = true;
    if (kind === 'origin') prior.mergeSha = sha(66);
    if (kind === 'blob') prior.blobSha = sha(66);
    if (kind === 'digest') prior.sha256 = 'a'.repeat(64);
    expect(() => assembleReleaseFacts(f)).toThrow();
  });
  it.each(['modified', 'removed', 'renamed'])('历史片段 %s 失败', status => {
    const f = fixture(); Object.assign(f.pulls[0]!.changes[1]!, { status, previousPath: '.release-notes/fragments/previous.json' });
    expect(() => assembleReleaseFacts(f)).toThrow('lifecycle');
  });
  it('遗漏、重复、区间外 PR 与 required 无片段失败', () => {
    const f = fixture(); expect(() => assembleReleaseFacts({ ...f, pulls: [f.pulls[0]!] })).toThrow('coverage');
    expect(() => assembleReleaseFacts({ ...f, pulls: [f.pulls[0]!, f.pulls[0]!] })).toThrow('coverage');
    f.pulls[1]!.classification.primaryKind = 'bug'; expect(() => assembleReleaseFacts(f)).toThrow('RN_FRAGMENT_REQUIRED');
  });
  it('迁移命名空间、边界和原文与普通片段互斥', () => {
    const f = migrationFixture(), r = assembleReleaseFacts(f);
    expect(r.facts.map(v => v.factId)).toEqual(['fix-first#0', 'migration:adopt-2026:1#0']);
    expect(r.consumedFragments).toHaveLength(1); expect(r.migration?.rawBase64).toBe(f.migration.rawBase64);
    expect(r.coverage.map(v => v.source)).toEqual(['fragment', 'migration']);
  });
  it('首次根提交来源未确定时失败关闭，不把开区间遗漏当作无事实', () => {
    const f = fixture(); f.source.boundary.kind = 'adoption';
    if (f.history.migrations[0]) f.history.migrations[0].rootSha = sha(1);
    expect(() => assembleReleaseFacts(f)).toThrow('root migration provenance');
    const g = migrationFixture(); g.source.boundary.kind = 'adoption'; g.migration.value.previousRelease = null;
    expect(() => assembleReleaseFacts(g)).toThrow('original semantic mismatch');
  });
  it('首次根事实使用独立 ID 和 rootSha，不伪造 PR、blob 或文件删除项', () => {
    const f = migrationFixture(); f.source.boundary.kind = 'adoption';
    if (f.history.migrations[0]) f.history.migrations[0].rootSha = sha(1);
    f.migration.value.previousRelease = null;
    f.migration.value.root = { sha: sha(1), fragment: { schemaVersion: 1, status: 'documented', entries: [entry] }, classification: { primaryKind: 'feature', riskFlags: [] } };
    rebind(f);
    const r = assembleReleaseFacts({ ...f, verifiedRoot: { sha: sha(1), parents: [] } });
    expect(r.facts.find(v => v.rootSha)).toEqual({ factId: 'migration:adopt-2026:root#0', pullNumber: null, mergeSha: null, rootSha: sha(1), entry, security: false });
    expect(r.rootRecord).toEqual({ sha: sha(1), status: 'documented', factIds: ['migration:adopt-2026:root#0'], reason: null });
    expect(r.consumedFragments).toHaveLength(1);
  });
  it.each(['missing', 'parents', 'identity', 'boundary', 'stable', 'unregistered', 'reassigned', 'consumed'])('根来源 %s 拒绝', kind => {
    const f = migrationFixture(); f.source.boundary.kind = 'adoption';
    if (f.history.migrations[0]) f.history.migrations[0].rootSha = sha(1); f.migration.value.previousRelease = null;
    f.migration.value.root = { sha: sha(1), fragment: { schemaVersion: 1, status: 'documented', entries: [entry] }, classification: { primaryKind: 'feature', riskFlags: [] } };
    const verifiedRoot = { sha: sha(1), parents: [] as string[] };
    if (kind === 'parents') verifiedRoot.parents.push(sha(9));
    if (kind === 'unregistered') delete f.history.migrations[0]!.rootSha;
    if (kind === 'reassigned') f.history.migrations = [...f.history.migrations, { ...f.history.migrations[0]!, migrationId: 'other-root' }];
    if (kind === 'consumed') f.history.migrations[0]!.consumed = true;
    if (kind === 'identity') verifiedRoot.sha = sha(9);
    if (kind === 'boundary') f.source.boundary.sha = sha(9);
    if (kind === 'stable') { f.source.boundary.kind = 'stable-release'; f.migration.value.previousRelease = { tag: 'v1.0.0', sha: sha(1) }; }
    rebind(f);
    expect(() => assembleReleaseFacts({ ...f, ...(kind === 'missing' ? {} : { verifiedRoot }) })).toThrow();
  });
  it('根 not-user-facing 保留排除原因，安全和破坏性约束仍生效', () => {
    const f = migrationFixture(); f.source.boundary.kind = 'adoption';
    if (f.history.migrations[0]) f.history.migrations[0].rootSha = sha(1); f.migration.value.previousRelease = null;
    const root = { sha: sha(1), fragment: { schemaVersion: 1 as const, status: 'not-user-facing' as const, reason: '根提交仅包含内部辅助配置内容' }, classification: { primaryKind: 'chore', riskFlags: [] as string[] } };
    f.migration.value.root = root;
    rebind(f);
    const input = { ...f, verifiedRoot: { sha: sha(1), parents: [] } };
    expect(assembleReleaseFacts(input).rootRecord?.factIds).toEqual([]);
    expect(assembleReleaseFacts(input).rootRecord?.reason).toBe(root.fragment.reason);
    root.classification.riskFlags = ['security']; rebind(f); expect(() => assembleReleaseFacts(input)).toThrow('RN_FACT_CONFLICT');
  });
  it('根迁移严格 schema 与解析器一致，拒绝重复根/伪造 PR 和稳定版本夹带 root', () => {
    const f = migrationFixture(), data = JSON.parse(Buffer.from(f.migration.rawBase64, 'base64').toString());
    data.previousRelease = null; data.root = { sha: sha(1), fragment: documented, classification: { primaryKind: 'feature', riskFlags: [] } };
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync('schema/release-notes-migration.schema.json', 'utf8')));
    expect(validate(data)).toBe(true); expect(parseReleaseMigration(encode(data)).root?.sha).toBe(sha(1));
    data.root.pullNumber = 0; expect(validate(data)).toBe(false); expect(() => parseReleaseMigration(encode(data))).toThrow(); delete data.root.pullNumber;
    data.entries[0].mergeSha = sha(1); expect(() => parseReleaseMigration(encode(data))).toThrow('duplicate migration source'); data.entries[0].mergeSha = sha(2);
    data.previousRelease = { tag: 'v1.0.0', sha: sha(1) }; expect(validate(data)).toBe(false); expect(() => parseReleaseMigration(encode(data))).toThrow('root only');
    data.previousRelease = null; delete data.root; expect(validate(data)).toBe(false); expect(() => parseReleaseMigration(encode(data))).toThrow('requires root');
  });
  it.each(['expired', 'consumed', 'digest', 'repository', 'previous', 'boundary', 'missing', 'extra', 'merge', 'overlap'])('非法迁移 %s 失败关闭', kind => {
    const f = migrationFixture(), m = f.migration.value;
    if (kind === 'expired') f.targetTag = 'v1.1.1';
    if (kind === 'consumed') f.history.migrations[0]!.consumed = true;
    if (kind === 'digest') f.history.migrations[0]!.sha256 = 'a'.repeat(64);
    if (kind === 'repository') m.repositoryId++;
    if (kind === 'previous') m.previousRelease!.sha = sha(55);
    if (kind === 'boundary') m.boundarySha = sha(55);
    if (kind === 'missing') m.entries = [];
    if (kind === 'extra') m.entries.push({ ...m.entries[0]! });
    if (kind === 'merge') m.entries[0]!.mergeSha = sha(55);
    if (kind === 'overlap') { m.boundarySha = sha(3); m.entries.push({ ...m.entries[0]!, pullNumber: 2, mergeSha: sha(3) }); }
    expect(() => assembleReleaseFacts(f)).toThrow();
  });
  it('迁移仍遵守 security/breaking-change 约束', () => {
    const f = migrationFixture(); f.pulls[1]!.classification.riskFlags = ['security'];
    expect(assembleReleaseFacts(f).facts.find(v => v.pullNumber === 1)?.security).toBe(true);
    f.migration.value.entries[0]!.fragment = { schemaVersion: 1, status: 'not-user-facing', reason: '只修改了内部辅助实现细节' };
    rebind(f); expect(() => assembleReleaseFacts(f)).toThrow('RN_FACT_CONFLICT');
    f.migration.value.entries[0]!.fragment = { schemaVersion: 1, status: 'documented', entries: [entry] }; rebind(f);
    f.pulls[1]!.classification.riskFlags = ['breaking-change']; expect(() => assembleReleaseFacts(f)).toThrow('actionRequired');
  });
  it('受管候选只排除审阅记录；不允许附加产品事实', () => {
    const f = fixture(); f.source.commits[1]!.kind = 'review-record'; f.source.commits[1]!.candidateId = 'central-1';
    f.pulls = [f.pulls[0]!]; const r = assembleReleaseFacts(f);
    expect(r.excluded[0]?.kind).toBe('review-record'); expect(r.facts).toHaveLength(1);
    f.source.commits[1]!.candidateId = null; expect(() => assembleReleaseFacts(f)).toThrow('source kind');
  });
  it('迁移 Schema 与解析器接受同一有效清单；未知字段、重复键、非法 UTF8 拒绝', () => {
    const f = migrationFixture(), bytes = Buffer.from(f.migration.rawBase64, 'base64');
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync('schema/release-notes-migration.schema.json', 'utf8')));
    expect(validate(JSON.parse(bytes.toString()))).toBe(true);
    const extra = { ...JSON.parse(bytes.toString()), extra: 1 }; expect(validate(extra)).toBe(false);
    expect(() => parseReleaseMigration(encode(extra))).toThrow();
    expect(() => parseReleaseMigration(Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')))).toThrow('DUPLICATE_KEY');
    expect(() => parseReleaseMigration(new Uint8Array([0xff]))).toThrow('ENCODING');
    expect(() => parseReleaseMigration(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))).toThrow('ENCODING');
  });
});
