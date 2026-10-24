import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { committedVersionNotes, parseSupplementalNotes, renderCommittedReleaseNotes, type ReleaseTemplateData } from '../src/release-template.js';
const template = readFileSync('config/templates/release.md.mustache', 'utf8');
it('extracts only the exact committed version section and tag comparison', () => {
  const input = '# Changes\n\n## [1.2.3](https://github.com/example/product/compare/v1.2.2...v1.2.3)\n\n- Fixed path.\n\n## 1.2.2\n\nOlder.\n';
  expect(committedVersionNotes(input, '1.2.3', 'example/product', 'a'.repeat(40), 'v1.2.3')).toEqual({ changelog: '- Fixed path.', compareUrl: 'https://github.com/example/product/compare/v1.2.2...v1.2.3' });
  for (const broken of [input.replace('...v1.2.3', '...v9.9.9'), input.replace('github.com/example', 'github.com/other'), input + '\n## 1.2.3\nDuplicate.', input.replace('- Fixed path.', '')]) {
    expect(() => committedVersionNotes(broken, '1.2.3', 'example/product', 'a'.repeat(40), 'v1.2.3')).toThrow('RELEASE_TEMPLATE');
  }
  expect(committedVersionNotes('## 1.2.3\n\nFirst release.\n', '1.2.3', 'example/product', 'a'.repeat(40), 'v1.2.3').compareUrl).toBe('https://github.com/example/product/commit/' + 'a'.repeat(40));
});
const notes = '## 概述\n\n修复`字体`路径。\n\n## 兼容性\n\nWindows；宿主未覆盖。\n\n## 升级与迁移\n\n无需配置或数据迁移。\n\n## 安装说明\n\n下载并运行安装包。\n\n## 已知问题\n\n未发现已确认问题；未覆盖场景见兼容性。\n\n## 恢复\n\n停止插件，恢复上一受验安装包及备份配置。\n';
const data: ReleaseTemplateData = { ...parseSupplementalNotes(notes), productName: '示例产品', version: '1.2.3',
  changelog: '- 修复路径。', downloads: '| 文件 | 用途 |\n| --- | --- |\n| archive.zip | 手工安装 |',
  sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), compareUrl: 'https://github.com/example/product/compare/v1.2.2...v1.2.3',
  channels: [{ name: '包渠道', status: '待分发', location: '见后续渠道运行记录。' }] };
it('renders committed Chinese Markdown deterministically', () => {
  const result = renderCommittedReleaseNotes(template, data);
  expect(result).toContain('# 示例产品 1.2.3');
  expect(result).toContain('修复`字体`路径。');
  expect(result).toContain('包渠道：待分发');
  expect(renderCommittedReleaseNotes(template, data)).toBe(result);
});
it('keeps reviewed links, code and HTML bytes in supplemental sections', () => {
  const input = notes.replace('修复`字体`路径。', '[链接](https://example.com)\n\n<details>中文</details>\n\n```text\n## 概述\n```');
  expect(parseSupplementalNotes(input).summary).toContain('<details>中文</details>');
  expect(parseSupplementalNotes(input).summary).toContain('## 概述');
});
it.each([
  notes + '\n## 概述\n重复', notes.replace('## 恢复', '## 其他'), notes.replace('修复`字体`路径。', ''),
  notes.replace('修复`字体`路径。', '说明此版本给使用者带来的主要变化。'), notes.replace('## 概述', '## **概述**'),
])('rejects incomplete or ambiguous notes', input => expect(() => parseSupplementalNotes(input)).toThrow('RELEASE_TEMPLATE'));
it.each(['{{unknown}}', '{{> external}}', '{{#summary}}lambda{{/summary}}', '{{=<% %>=}}<%version%>', '{{{productName}}}'])('rejects unsafe template extension %s', extension => {
  expect(() => renderCommittedReleaseNotes(template + extension, data)).toThrow('RELEASE_TEMPLATE');
});
it.each(['summary', 'version', 'changelog', 'downloads', 'sourceSha', 'channels'])('requires %s', field => {
  const incomplete = { ...data } as any; delete incomplete[field];
  expect(() => renderCommittedReleaseNotes(template, incomplete)).toThrow('RELEASE_TEMPLATE');
});
it('rejects unverified channel status, unsafe identity and omitted template fields', () => {
  expect(() => renderCommittedReleaseNotes(template, { ...data, channels: [{ ...data.channels[0]!, status: '已分发' as any }] })).toThrow();
  expect(() => renderCommittedReleaseNotes(template, { ...data, productName: '<script>' })).toThrow();
  expect(() => renderCommittedReleaseNotes(template, { ...data, compareUrl: 'javascript:alert(1)' })).toThrow();
  expect(() => renderCommittedReleaseNotes(template.replace('{{{recovery}}}', ''), data)).toThrow();
});
