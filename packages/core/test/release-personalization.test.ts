import { describe, expect, it } from 'vitest';
import { freezePersonalization, validatePersonalization, assertPersonalizationConfiguration, refreshPersonalizedSections } from '../src/release-personalization.js';
import { renderGeneratedRelease } from '../src/release-production.js';
import { newReleaseReceipt, candidateProjection, validateCandidateNotes } from '../src/release-note-receipt.js';
import { frozenFixture, sha } from './release-receipt-fixture.js';

const generated = { userNotes: { upgrade: ['请先备份原始数据。'], changes: [{ category: '修复' as const, text: '修复导入失败。' }] }, reviewEvidence: { internalChanges: [], unknowns: [] } };
const identity = { id: 9001, fullName: 'sample/neutral-product' };
const section = { id: 'downloads', type: 'asset-table', slot: 'beforeActions', title: '下载', items: ['package'] };
function profile(enabled = true, sections = [section]) { return { repository: identity, releaseNotes: { personalization: { enabled, sections } } }; }
function frozen(assets = true) {
  const f = frozenFixture();
  if (assets) {
    f.assets = [{ name: 'neutral-1.2.3.zip', size: 42, sha256: 'a'.repeat(64) }];
    f.build = { runId: 1, artifactId: 2, artifactName: 'assets', headSha: sha('c') };
    f.manifests = [{ schemaVersion: 1, repositoryId: f.repositoryId, fullName: f.fullName, buildId: 'release', profile: 'custom-adapter-v1', targetSha: f.productTargetSha, policySha: f.policySha, version: '1.2.3', inputsSha256: 'b'.repeat(64),
      artifacts: [{ id: 'package', kind: 'file', file: f.assets[0]!.name, size: 42, sha256: 'a'.repeat(64), mediaType: 'application/zip' }] }];
  }
  return f;
}
describe('repository personalization freeze and rendering', () => {
  it.each([undefined, profile(false, [])])('unconfigured and disabled produce the same generic notes', config => {
    const f = frozen(false); f.personalization = freezePersonalization(f.repositoryId, f.fullName, config);
    expect(f.personalization.enabled).toBe(false); expect(f.personalization.sections).toEqual([]);
    const notes = renderGeneratedRelease(generated, f);
    expect(notes).toBe(renderGeneratedRelease(generated, frozen(false)));
    expect(notes).toContain('请先备份原始数据。'); expect(notes).not.toContain('releases/download');
  });
  it('renders verified downloads under upgrade advice, with optional product guidance in its configured slot', () => {
    const f = frozen(); f.personalization = freezePersonalization(f.repositoryId, f.fullName, profile(true, [section,
      { id: 'environment', type: 'bullet-list', slot: 'afterChanges', title: '适用环境', items: ['适用于独立命令行环境。'] }]));
    const notes = renderGeneratedRelease(generated, f);
    expect(notes).toContain('| [neutral-1.2.3.zip](https://github.com/sample/neutral-product/releases/download/v1.2.3/neutral-1.2.3.zip) | 42 |');
    expect(notes.indexOf('### 下载')).toBeLessThan(notes.indexOf('## 更新内容'));
    expect(notes.indexOf('### 适用环境')).toBeGreaterThan(notes.indexOf('### 修复'));
    expect(() => validateCandidateNotes(notes.replace('修复导入失败。', '修复特定文件导入失败。'), f)).not.toThrow();
    expect(() => validateCandidateNotes(notes.replace(' | 42 |', ' | 43 |'), f)).toThrow('PERSONALIZATION_BYTES');
  });
  it('requires actual assets; no placeholder links or ambiguous asset IDs', () => {
    const f = frozen(false); f.personalization = freezePersonalization(f.repositoryId, f.fullName, profile());
    expect(() => renderGeneratedRelease(generated, f)).toThrow('PERSONALIZATION');
    const valid = frozen(); valid.personalization = f.personalization;
    valid.manifests[0]!.artifacts.push({ ...valid.manifests[0]!.artifacts[0]! });
    expect(() => renderGeneratedRelease(generated, valid)).toThrow('PERSONALIZATION');
    f.personalization = freezePersonalization(f.repositoryId, f.fullName, profile(true, [{ id: 'usage', type: 'bullet-list', slot: 'beforeActions', title: '使用方式', items: ['通过命令行启动。'] }]));
    expect(renderGeneratedRelease(generated, f)).not.toContain('releases/download');
  });
  it('updates rebuilt asset details while preserving human prose for the new review', () => {
    const before = frozen(); before.personalization = freezePersonalization(before.repositoryId, before.fullName, profile());
    const notes = renderGeneratedRelease(generated, before).replace('修复导入失败。', '修复导入失败；保留现有文件。');
    const after = structuredClone(before); after.assets[0]!.size = 43;
    const asset = after.manifests[0]!.artifacts[0]!; if (asset.kind === 'file') asset.size = 43;
    const refreshed = refreshPersonalizedSections(notes, before, after);
    expect(refreshed).toContain(' | 43 |'); expect(refreshed).toContain('修复导入失败；保留现有文件。');
    expect(notes).toContain(' | 42 |'); expect(() => newReleaseReceipt(after, refreshed, 2)).not.toThrow();
    expect(() => newReleaseReceipt(after, notes, 2)).toThrow('PERSONALIZATION_BYTES');
  });
  it('rejects profile and frozen material from another repository, including disabled profiles', () => {
    for (const config of [profile(), profile(false, [])]) expect(() => freezePersonalization(9002, 'sample/other', config)).toThrow('PERSONALIZATION');
    const p = freezePersonalization(identity.id, identity.fullName, profile());
    expect(() => validatePersonalization(p, 9002, 'sample/other')).toThrow('PERSONALIZATION');
    const f = frozen(); f.personalization = p;
    expect(() => assertPersonalizationConfiguration(f, { delivery: { githubRelease: { profile: 'other' } } }, { other: { ...profile(), repository: { id: 9002, fullName: 'sample/other' } } })).toThrow();
  });
  it('binds enabled state and exact material to approval identity and rejects stale or forged material', () => {
    const f = frozen(); f.personalization = freezePersonalization(f.repositoryId, f.fullName, profile());
    const original = newReleaseReceipt(f, renderGeneratedRelease(generated, f));
    const changed = frozen(); changed.personalization = freezePersonalization(f.repositoryId, f.fullName, profile(true, [{ ...section, title: '安装文件' }]));
    expect(candidateProjection(newReleaseReceipt(changed, renderGeneratedRelease(generated, changed))).frozenDigest).not.toBe(original.frozenDigest);
    expect(() => validatePersonalization({ ...f.personalization!, enabled: false }, f.repositoryId, f.fullName)).toThrow();
    const configuration = { delivery: { githubRelease: { profile: 'neutral' } } };
    expect(() => assertPersonalizationConfiguration(f, configuration, { neutral: profile() })).not.toThrow();
    expect(() => assertPersonalizationConfiguration(f, configuration, { neutral: profile(false, []) })).toThrow();
    expect(() => assertPersonalizationConfiguration(frozen(), configuration, { neutral: profile() })).toThrow();
  });
  it.each([
    profile(false, [section]), profile(true, []), profile(true, [{ ...section, slot: 'afterChanges' }]),
    profile(true, [{ ...section, title: '<script>' }]), profile(true, [{ ...section, items: ['../escape'] }]),
    profile(true, [{ ...section, type: 'bullet-list', items: ['https://foreign.test'] }]), profile(true, [section, section]),
  ])('rejects invalid configuration %#', config => expect(() => freezePersonalization(identity.id, identity.fullName, config)).toThrow());
});
