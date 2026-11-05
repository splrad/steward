import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { renderFrozenReleaseNotes, nestReleaseMarkdown, type FrozenReleaseNotes } from '../src/release-template.js';
import { renderReleaseContributors } from '../src/release-candidate.js';
const template = readFileSync('templates/repository/.github/release-template.md.mustache', 'utf8');
const data: FrozenReleaseNotes = {
  repository: 'splrad/LayerScape', unitId: 'layerscape', version: '9.2.2', tag: 'v9.2.2', sourceSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40),
  notes: ['概述', '更新内容', '兼容性', '升级与迁移', '安装说明', '已知问题', '恢复'].map((label, i) => `## ${label}\n\n保留事实 ${i}。\n\n### 子标题 ${i}\n\n细节。\n\n#### 更深 ${i}\n\n更多细节。`).join('\n\n'),
  sourceLinkLabel: '查看比较', commitUrl: 'https://github.com/splrad/LayerScape/commit/'+'a'.repeat(40), sourceUrl: 'https://github.com/splrad/LayerScape/compare/v9.2.1...'+'a'.repeat(40),
  contributors: [{ id: 123, login: 'contributor', profileUrl: 'https://github.com/contributor', avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4', alt: 'contributor' }],
  repositoryAuthors: [{ id: 44151430, evidence: 'User confirmed axiomoth and verified native GitHub ID.' }], assets: [{ id: 'plugins', name: 'AFR-DLL_v9.2.2.zip', build: 'windows-x64' }],
  channels: [{ id: 'ghcr-assets', location: 'ghcr.io/splrad/layerscape-assets' }],
};
it.each([true, false])('RN01/RN03 preserves all reviewed facts with contributor section present=%s', present => {
  const input = structuredClone(data); if (!present) input.contributors = [];
  const before = JSON.stringify(input), body = renderFrozenReleaseNotes(template, input);
  expect([...body.matchAll(/^## (.+)$/gm)].map(match => match[1])).toEqual(['升级须知', '更新内容', ...(present ? ['贡献者'] : []), '完整变更']);
  for (let i = 0; i < 7; i++) expect(body).toContain(`保留事实 ${i}。`);
  expect(body).toContain('#### 子标题 0'); expect(body).toContain('##### 更深 0');
  expect(body).toContain('### 子标题 1'); expect(body).toContain(data.sourceUrl);
  expect(body).toContain('# layerscape 9.2.2'); expect(body).toContain('| plugins | windows-x64 |');
  expect(body).toContain('源码提交：[' + data.sourceSha + '](' + data.commitUrl + ')'); expect(body).toContain('执行器提交：' + data.controllerSha);
  if (present) expect(body).toContain('width="48" height="48"');
  expect(body).toContain('/releases/download/v9.2.2/AFR-DLL_v9.2.2.zip');
  expect(body).toContain('ghcr-assets：待分发'); expect(body).toContain('layerscape-assets');
  expect(body).not.toContain('axiomoth'); expect(JSON.stringify(input)).toBe(before);
  expect(renderFrozenReleaseNotes(template, input)).toBe(body);
});
it('RN03 adjusts only display headings and retains code fences and setext content', () => {
  const source = 'Title\n=====\n\n### Detail\n\n```md\n## Literal code\n```\n';
  expect(nestReleaseMarkdown(source)).toBe('#### Title\n\n###### Detail\n\n```md\n## Literal code\n```');
  expect(source).toContain('Title\n=====');
});
it.each(['avatar', 'profile', 'author', 'version', 'comparison', 'missing-section', 'template'])('RN05 rejects %s drift', kind => {
  const input = structuredClone(data); let selected = template;
  if (kind === 'avatar') input.contributors[0]!.avatarUrl = 'http://evil.invalid/avatar';
  if (kind === 'profile') input.contributors[0]!.profileUrl = 'https://github.com/other';
  if (kind === 'author') input.contributors[0]!.id = 44151430;
  if (kind === 'version') input.version += '\n## Injected';
  if (kind === 'comparison') input.sourceUrl = 'https://github.com/other/repo/compare/a...v9.2.2';
  if (kind === 'missing-section') input.notes = input.notes.replace('## 恢复', '## Unknown');
  if (kind === 'template') selected += '{{{unknown}}}';
  expect(() => renderFrozenReleaseNotes(selected, input)).toThrow();
});
it('RN05 HTML attribute escaping is retained by the reused contributor renderer', () => {
  const body = renderReleaseContributors([{ ...data.contributors[0]!, alt: '\"<&\'', avatarUrl: 'https://avatars.githubusercontent.com/u/123?x="<&' }]);
  expect(body).toContain('&quot;'); expect(body).toContain('&lt;'); expect(body).toContain('&amp;');
  expect(body).not.toContain('alt=""<');
});
it.each(['filename', 'asset-id', 'target', 'duplicate', 'empty', 'tag', 'unit'])('RN05 rejects invalid download identity: %s', kind => {
  const input = structuredClone(data);
  if (kind === 'filename') input.assets[0]!.name = '../other.zip';
  if (kind === 'asset-id') input.assets[0]!.id = 'x | malicious';
  if (kind === 'target') input.assets[0]!.build = '<script>';
  if (kind === 'duplicate') input.assets.push(input.assets[0]!);
  if (kind === 'empty') input.assets = [];
  if (kind === 'tag') input.tag = 'v9.2.2\ninjected';
  if (kind === 'unit') input.unitId = 'other\n## Title';
  expect(() => renderFrozenReleaseNotes(template, input)).toThrow();
});
it('labels first release and binds a multi-unit asset URL to the encoded exact tag', () => {
  const input = { ...structuredClone(data), unitId: 'other', tag: 'other/v9.2.2', sourceLinkLabel: '查看源码', sourceUrl: `https://github.com/${data.repository}/tree/${data.sourceSha}` };
  const body = renderFrozenReleaseNotes(template, input);
  expect(body).toContain('# other 9.2.2'); expect(body).toContain('[查看源码](https://github.com/'+data.repository+'/tree/'+data.sourceSha+')');
  expect(body).toContain('/download/other%2Fv9.2.2/AFR-DLL_v9.2.2.zip');
  expect(body).not.toContain('/download/v9.2.2/');
});
