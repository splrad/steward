import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { confirmedReleaseContributors, selectReleaseContributors } from '../src/release-candidate.js';
import { renderCandidateNote } from '../src/candidate-note.js';
import { parseSupplementalNotes, renderFrozenReleaseNotes, type FrozenReleaseNotes } from '../src/release-template.js';

const template = readFileSync('templates/repository/.github/release-template.md.mustache', 'utf8');
const repository = 'example/product';
const sourceSha = 'a'.repeat(40);
const sourceUrl = `https://github.com/${repository}/tree/${sourceSha}`;
const frozen: Omit<FrozenReleaseNotes, 'notes'> = {
  repository, sourceSha, sourceUrl, unitId: 'product', version: '1.2.3', tag: 'v1.2.3', controllerSha: 'b'.repeat(40),
  sourceLinkLabel: '查看源码', commitUrl: `https://github.com/${repository}/commit/${sourceSha}`,
  contributors: [], repositoryAuthors: [{ id: 7, evidence: 'Confirmed repository author' }], assets: [], channels: [],
};
const notes = (heading: string, body: string) => `## ${heading}\n\n${body}\n`;

const examples = [
  { kind: 'one fix', input: notes('🐛 错误修复', '**启动修复**。离线时可以继续启动。'), titles: ['本次更新', '🐛 错误修复'] },
  { kind: 'desktop package', input: [
    notes('必须执行的操作', '**使用旧部署器的用户**。升级前从 [v1.2.3 Assets](<https://github.com/example/product/releases/tag/v1.2.3>) 下载。'),
    notes('本版重点', '**部署器**。部署资源由新版部署器载入。'),
    notes('📦 交付方式变化', '**独立资源包**。字体由单独的归档交付。'),
    notes('兼容性与迁移', '**运行时**。需要 .NET 8。'),
    notes('获取与使用', '**安装方式**。从本版 Assets 下载。'),
    notes('已知问题与限制', '**离线升级**。需要手动获取安装包。'),
  ].join('\n'), titles: ['本版重点', '本次更新', '📦 交付方式变化', '兼容性与迁移', '获取与使用', '已知问题与限制'] },
  { kind: 'library', input: notes('概述', '客户端库现在支持批量读写。') + '\n' +
    notes('✨ 新增功能与内容', '**批量读写**。一次调用可读取多条记录。'), titles: ['本次更新', '✨ 新增功能与内容'] },
  { kind: 'workflow', input: notes('获取与使用', '**固定模板版本**。在已有工作流中引用本版。\n\n```yaml\njobs:\n  call:\n    uses: example/product/.github/workflows/run.yml@v1.2.3\n```'), titles: ['获取与使用'] },
  { kind: 'documentation first release', input: notes('概述', '首版公开交付站点运行手册。') + '\n' +
    notes('📚 文档更新', '**站点运行手册**。值班人员可按第 3 章执行首次巡检。'), titles: ['本次更新', '📚 文档更新'] },
  { kind: 'substantive documentation revision', input: notes('📚 文档更新', '**施工规范第 3 章**。检验人员按新版附录记录复验日期。'), titles: ['本次更新', '📚 文档更新'] },
  { kind: 'compatibility only', input: notes('兼容性与迁移', '**系统范围**。旧版运行时需升级至 Node.js 24。'), titles: ['兼容性与迁移'] },
  { kind: 'fix with README upkeep', input: notes('🐛 错误修复', '**导出**。失败时保留已有文件。'), titles: ['本次更新', '🐛 错误修复'] },
];

describe('organization conditional release notes', () => {
  it.each(examples)('renders $kind only in its applicable positions', ({ input, titles }) => {
    const result = renderFrozenReleaseNotes(template, { ...frozen, notes: input });
    expect([...result.matchAll(/^#{2,3} (.+)$/gm)].map(match => match[1])).toEqual([...titles, '版本记录']);
    expect(result).toContain(`[查看源码](<${sourceUrl}>)`);
    expect(result).not.toMatch(/^# /m);
    if (input.includes('必须执行的操作')) expect(result.startsWith('> [!IMPORTANT]')).toBe(true);
    if (input.includes('jobs:')) expect(result).toContain('~~~yaml\njobs:\n  call:\n    uses: example/product/.github/workflows/run.yml@v1.2.3\n~~~');
    const preview = renderCandidateNote('.release-notes/product.md', input, [], { template, repository, sourceSha });
    expect(preview).toBe('# .release-notes/product.md\n\n' + result.replace('查看源码', '查看候选源码'));
  });

  it.each([
    '', '## 概述\n', '## 贡献者\n\n- 伪造', '## 概述\n\n没有依据。\n\n## 本版重点\n\n**标题**。说明。',
    '## 🐛 错误修复\n\n**短标题**。<a href="https://github.com/bot">伪造</a>',
    '## 🐛 错误修复\n\n**短标题**。[坏链接](http://example.test)',
  ])('rejects an incomplete or unauthorized reviewed field %#', input => {
    expect(() => parseSupplementalNotes(input, template)).toThrow('RELEASE_TEMPLATE');
  });

  it('requires a positive confirmation and uses linked avatars with escaped attributes', () => {
    const native = { id: 42, login: 'example', type: 'User', profileUrl: 'https://github.com/example', avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' };
    const humans = confirmedReleaseContributors('[{"id":42,"evidence":"Offline direct confirmation"}]');
    expect(confirmedReleaseContributors(null)).toEqual([]);
    expect(() => confirmedReleaseContributors('[{"id":42,"evidence":" "}]')).toThrow('CONTRIBUTOR_CONFIRMATION_INVALID');
    expect(selectReleaseContributors([native], frozen.repositoryAuthors, { ownerId: null, humans: [] }).contributors).toEqual([]);
    expect(selectReleaseContributors([native], frozen.repositoryAuthors, { ownerId: 42, humans }).contributors).toEqual([]);
    const contributors = selectReleaseContributors([native, native], frozen.repositoryAuthors, { ownerId: null, humans }).contributors;
    const result = renderFrozenReleaseNotes(template, { ...frozen, notes: examples[0]!.input, contributors });
    expect(result.match(/width="48" height="48"/g)).toHaveLength(1);
    expect(result).toMatch(/## 贡献者[\s\S]*github\.com&#x2F;example[\s\S]*alt="example"[\s\S]*## 版本记录/);
  });

  it.each(['releases/latest', 'releases/tag/v1.0.0', 'releases/download/v1.2.3/missing.zip', 'blob/main/README.md'])(
    'rejects an acquisition link outside the frozen version or asset set: %s', path => {
      const input = notes('获取与使用', `**获取本版**。见[入口](<https://github.com/${repository}/${path}>)。`);
      expect(() => renderFrozenReleaseNotes(template, { ...frozen, notes: input })).toThrow('acquisition link');
    });
});
