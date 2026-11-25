import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replayReleaseContributors, selectReleaseContributors } from '../src/release-candidate.js';
import { isAdoptedOrganizationReleaseTemplate, reviewedConditionalReleaseTemplate } from '../src/conditional-release-notes.js';
import { validateContentResult } from '../src/release-content.js';
import { renderCandidateNote, renderCandidateProjection } from '../src/candidate-note.js';
import { parseSupplementalNotes, renderFrozenReleaseNotes, type FrozenReleaseNotes } from '../src/release-template.js';

const template = readFileSync('templates/repository/.github/release-template.md.mustache', 'utf8');
const previousTemplate = readFileSync('packages/core/test/fixtures/release-template-conditional-linked-users.mustache', 'utf8');
const originalTemplate = readFileSync('packages/core/test/fixtures/release-template-conditional-v1.mustache', 'utf8');
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
    notes('已知问题与限制', '**离线升级**。需要手动获取安装包。'),
  ].join('\n'), titles: ['本版重点', '本次更新', '📦 交付方式变化', '兼容性与迁移', '已知问题与限制'] },
  { kind: 'library', input: notes('概述', '客户端库现在支持批量读写。') + '\n' +
    notes('✨ 新增功能与内容', '**批量读写**。一次调用可读取多条记录。'), titles: ['本次更新', '✨ 新增功能与内容'] },
  { kind: 'documentation first release', input: notes('概述', '首版公开交付站点运行手册。') + '\n' +
    notes('📚 文档更新', '**站点运行手册**。值班人员可按第 3 章执行首次巡检。'), titles: ['本次更新', '📚 文档更新'] },
  { kind: 'substantive documentation revision', input: notes('📚 文档更新', '**施工规范第 3 章**。检验人员按新版附录记录复验日期。'), titles: ['本次更新', '📚 文档更新'] },
  { kind: 'compatibility only', input: notes('兼容性与迁移', '**系统范围**。旧版运行时需升级至 Node.js 24。'), titles: ['兼容性与迁移'] },
  { kind: 'fix with README upkeep', input: notes('🐛 错误修复', '**导出**。失败时保留已有文件。'), titles: ['本次更新', '🐛 错误修复'] },
];

describe('organization conditional release notes', () => {
  it('replays an archived acquisition paragraph and rejects it for a new draft', () => {
    const sourceId = 'a'.repeat(64);
    const response = JSON.stringify({ paragraphs: [{ section: 'acquisition', sourceIds: [sourceId],
      textZh: '**安装**。使用本版安装包。\n\n~~~sh\ninstall\n~~~', qualification: 'SOURCE_CONFIRMED' }] });
    expect(() => validateContentResult('DRAFT', response, [sourceId], [], undefined, true)).toThrow('CONTENT_OUTPUT_SCHEMA');
    expect(validateContentResult('DRAFT', response, [sourceId], [], undefined, 'reviewed')).toEqual(JSON.parse(response));
  });

  it.each(examples)('renders $kind only in its applicable positions', ({ input, titles }) => {
    const result = renderFrozenReleaseNotes(template, { ...frozen, notes: input });
    expect([...result.matchAll(/^#{2,3} (.+)$/gm)].map(match => match[1])).toEqual([...titles, '版本记录']);
    expect(result).toContain(`[查看源码](<${sourceUrl}>)`);
    expect(result).not.toMatch(/^# /m);
    if (input.includes('必须执行的操作')) expect(result.startsWith('> [!IMPORTANT]')).toBe(true);
    const preview = renderCandidateNote('.release-notes/product.md', input, [], { template, repository, sourceSha });
    expect(preview).toBe('# .release-notes/product.md\n\n' + result.replace('查看源码', '查看候选源码'));
  });

  it.each([
    notes('获取与使用', '**下载**。下载本版。'), '', '## 概述\n', '## 贡献者\n\n- 伪造', '## 概述\n\n没有依据。\n\n## 本版重点\n\n**标题**。说明。',
    '## 🐛 错误修复\n\n**短标题**。<a href="https://github.com/bot">伪造</a>',
    '## 🐛 错误修复\n\n**短标题**。[坏链接](http://example.test)',
  ])('rejects an incomplete or unauthorized reviewed field %#', input => {
    expect(() => parseSupplementalNotes(input, template)).toThrow('RELEASE_TEMPLATE');
  });

  it('replays the reviewed historical contributors without promoting unselected actors', () => {
    const native = { id: 42, login: 'example', type: 'User', profileUrl: 'https://github.com/example', avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' };
    const other = { ...native, id:43, login:'other', profileUrl:'https://github.com/other' };
    const reviewed = { id:native.id, login:native.login, profileUrl:native.profileUrl, avatarUrl:native.avatarUrl, alt:native.login };
    const record = { actors:[native,native,other], contributors:{contributors:[reviewed],unresolved:1} };
    expect(replayReleaseContributors(record, frozen.repositoryAuthors, 'recorded')).toEqual(record.contributors);
    expect(replayReleaseContributors(record, frozen.repositoryAuthors, 'github-authors').contributors.map(person=>person.id)).toEqual([42,43]);
    const input = { ...frozen, notes: examples[0]!.input, contributors:[reviewed] };
    const result = renderFrozenReleaseNotes(originalTemplate, input);
    expect(result.match(/width="48" height="48"/g)).toHaveLength(1);
    expect(result).toMatch(/## 贡献者[\s\S]*github\.com&#x2F;example[\s\S]*alt="example"[\s\S]*## 版本记录/);
    expect(result).not.toContain('贡献者 GitHub ID');
    expect(() => renderFrozenReleaseNotes(originalTemplate, { ...input, contributors:[reviewed, reviewed] })).toThrow('frozen contributors');
  });

  it('renders only linked usernames in the closed contributor list in both notes', async () => {
    const actor = (id: number, login: string, type = 'User') => ({ id, login, type,
      profileUrl: 'https://github.com/' + login, avatarUrl: 'https://avatars.githubusercontent.com/u/' + id });
    const human = actor(42, 'actual-author');
    const selected = selectReleaseContributors([human, human, actor(43, 'release-automation'),
      actor(44, 'robot[bot]', 'Bot'), actor(19864447, 'web-flow'), null], [], 'github-authors');
    expect(selected.contributors.map(person => person.id)).toEqual([42]);
    const input = examples[0]!.input;
    const result = renderFrozenReleaseNotes(template, { ...frozen, notes: input, contributors: selected.contributors });
    const preview = renderCandidateNote('release.md', input, selected.contributors, {template,repository,sourceSha});
    for (const body of [result, preview]) {
      expect(body).toContain('width="48" height="48"');
      expect(body).toContain('<details>\n<summary>查看贡献者名单</summary>\n\n- <a href="https:&#x2F;&#x2F;github.com&#x2F;actual-author">actual-author</a>\n\n</details>');
    }
    expect(renderFrozenReleaseNotes(template, { ...frozen, notes: input })).not.toContain('<details>');
    expect(await isAdoptedOrganizationReleaseTemplate(template)).toBe(true);
    expect(await reviewedConditionalReleaseTemplate(template, previousTemplate)).toBe(previousTemplate);
    const previous = previousTemplate.replace('查看贡献者名单', '贡献者 GitHub ID')
      .replace('{{login}}</a>', '{{login}}</a> · `{{id}}`');
    expect(await reviewedConditionalReleaseTemplate(template, previous)).toBe(previous);
    expect(renderFrozenReleaseNotes(previous, { ...frozen, notes: input, contributors: selected.contributors })).toContain(' · `42`');
    expect(await reviewedConditionalReleaseTemplate(template, originalTemplate)).toBe(originalTemplate);
    expect(await reviewedConditionalReleaseTemplate(template, originalTemplate + '\n')).toBe(template);
    expect(await reviewedConditionalReleaseTemplate(originalTemplate, template)).toBe(originalTemplate);
  });

  it.each(['releases/latest', 'releases/tag/v1.0.0', 'releases/download/v1.2.3/missing.zip', 'blob/main/README.md'])(
    'rejects an acquisition link outside the frozen version or asset set: %s', path => {
      const input = notes('获取与使用', `**获取本版**。见[入口](<https://github.com/${repository}/${path}>)。`);
      expect(() => renderFrozenReleaseNotes(previousTemplate, { ...frozen, notes: input })).toThrow('acquisition link');
    });

  it.each(['SHA256SUMS','sbom.spdx.json'])('accepts selected metadata %s and rejects the same link outside GitHub delivery', name => {
    const url=`https://github.com/${repository}/releases/download/${frozen.tag}/${name}`;
    for (const section of ['获取与使用','必须执行的操作','本版重点']) {
      const input = notes(section,`**获取校验资料**。见[入口](<${url}>)。`);
      expect(renderFrozenReleaseNotes(previousTemplate,{...frozen,notes:input,selectedDownloads:new Set([name])})).toContain(url);
      expect(() => renderFrozenReleaseNotes(previousTemplate,{...frozen,notes:input,selectedDownloads:new Set()})).toThrow();
    }
  });

  it('projects two notes at the exact configured paths using their own tags', () => {
    const first='units/cli/release.md', second='handbook/latest.adoc';
    const use=(tag:string)=>notes('获取与使用',`**引用**。使用此版本。\n\n~~~yaml\n- uses: example/product@${tag}\n~~~`);
    const generated={baseSha:sourceSha,units:[{id:'cli',tag:'cli-v1.2.3'},{id:'doc',tag:'doc-v1.2.3'}],
      files:[{path:second,content:use('doc-v1.2.3')},{path:'.release-notes/internal.md',content:'internal'},{path:first,content:use('cli-v1.2.3')}]};
    const identity={noteTemplate:previousTemplate,units:[{id:'cli',notesPath:first,contributors:{contributors:[]}},
      {id:'doc',notesPath:second,contributors:{contributors:[]}}]};
    const preview=renderCandidateProjection(generated,identity,repository);
    expect(preview).toContain('# '+first);
    expect(preview).toContain('# '+second);
    expect(preview).not.toContain('internal');
    expect(()=>renderCandidateProjection({...generated,files:generated.files.slice(0,2)},identity,repository)).toThrow('CANDIDATE_PROJECTION_NOTES');
  });

  it.each(['steps:\n  - uses: example/product/action@main', 'steps: [{uses: "example/product@main"}]',
    "ref: &floating example/product@main\nsteps:\n  - 'uses': *floating"])('pins YAML reference in both preview and freeze: %s', example => {
    const input=notes('获取与使用',`**引用本版**。将示例加入工作流。\n\n~~~yaml\n${example}\n~~~`);
    const preview=(text:string)=>renderCandidateNote('.release-notes/product.md',text,[],{template:previousTemplate,repository,sourceSha,tag:frozen.tag});
    const render=(text:string)=>renderFrozenReleaseNotes(previousTemplate,{...frozen,notes:text});
    for (const project of [preview,render]) {
      expect(() => project(input)).toThrow('workflow example is outside the release version');
      expect(project(input.replace('@main','@'+frozen.tag))).toContain('@'+frozen.tag);
    }
  });

  it.each(['releases/latest/download/file.zip','releases/download/v1.0.0/file.zip','blob/main/README.md'])(
    'rejects floating or stale GitHub URLs in shell examples: %s', path => {
      const shell=(ref:string)=>notes('获取与使用',`**准备附件**。下载本版。\n\n~~~sh\ncurl -O "https://github.com/${repository}/${ref}"\n~~~`);
      const preview=(text:string)=>renderCandidateNote('.release-notes/product.md',text,[],{template:previousTemplate,repository,sourceSha,tag:frozen.tag});
      const render=(text:string)=>renderFrozenReleaseNotes(previousTemplate,{...frozen,notes:text,selectedDownloads:new Set(['file.zip'])});
      for (const project of [preview,render]) {
        expect(()=>project(shell(path))).toThrow('acquisition example link');
        expect(project(shell(`releases/download/${frozen.tag}/file.zip`))).toContain('curl -O');
      }
      expect(()=>render(shell(`releases/download/${frozen.tag}/internal.zip`))).toThrow('acquisition example link');
    });

  it('uses a release tag in candidate acquisition so it remains valid after the merge SHA changes', () => {
    const example=(ref:string)=>notes('获取与使用',`**引用工作流**。见[本版源码](<https://github.com/${repository}/tree/${ref}>)。\n\n~~~yaml\n- uses: example/product@${ref}\n~~~`);
    const preview=(text:string)=>renderCandidateNote('.release-notes/product.md',text,[],{template:previousTemplate,repository,sourceSha,tag:frozen.tag});
    const mergedSha='c'.repeat(40);
    const render=(text:string)=>renderFrozenReleaseNotes(previousTemplate,{...frozen,notes:text,sourceSha:mergedSha,
      sourceUrl:`https://github.com/${repository}/tree/${mergedSha}`,commitUrl:`https://github.com/${repository}/commit/${mergedSha}`});
    expect(()=>preview(example(sourceSha))).toThrow('acquisition link');
    expect(()=>preview(example(frozen.tag).replace('@'+frozen.tag,'@'+sourceSha))).toThrow('workflow example');
    expect(preview(example(frozen.tag))).toContain('/tree/'+sourceSha);
    expect(render(example(frozen.tag))).toContain('@'+frozen.tag);
    expect(render(example(mergedSha))).toContain('@'+mergedSha);
  });

  it.each(['releases/latest', 'tree/main', 'blob/v1.0.0/README.md', 'Releases/latest', 'TREE/main',
    'archive%2Frefs%2Fheads%2Fmain.zip'])('checks a bare acquisition URL: %s', path => {
    const input=notes('获取与使用',`**本版入口**。见 https://github.com/${repository}/${path} 。`);
    expect(()=>renderCandidateNote('.release-notes/product.md',input,[],{template:previousTemplate,repository,sourceSha,tag:frozen.tag})).toThrow('acquisition link');
    expect(()=>renderFrozenReleaseNotes(previousTemplate,{...frozen,notes:input})).toThrow('acquisition link');
  });

  it.each(['必须执行的操作','本版重点','兼容性与迁移'])('checks floating links outside acquisition: %s', heading => {
    const location=(ref:string)=>notes(heading,`**下载**。见[附件](<https://github.com/${repository}/releases/${ref}/file.zip>)。`);
    const preview=(input:string)=>renderCandidateNote('.release-notes/product.md',input,[],{template,repository,sourceSha,tag:frozen.tag});
    const render=(input:string)=>renderFrozenReleaseNotes(template,{...frozen,notes:input,selectedDownloads:new Set(['file.zip'])});
    for (const project of [preview,render]) {
      expect(()=>project(location('latest/download'))).toThrow('outside GitHub delivery');
      expect(()=>project(location('download/v1.0.0'))).toThrow('outside GitHub delivery');
      expect(project(location('download/'+frozen.tag))).toContain('/download/'+frozen.tag);
    }
  });

  it.each([
    'releases%2Fdownload%2Fv1.0.0%2Ffile.zip',
    'releases%2Fdownload%2Fv1.2.3%2Ffile.zip',
    'releases/latest%2Fdownload/file.zip',
    'Releases/Download/v1.2.3/file.zip',
    'releases/download/v1.2.3/broken%zz.zip',
  ])('rejects invalid download routes or encoding outside acquisition: %s', path => {
    const input = notes('本版重点', `**下载**。见 https://github.com/${repository}/${path} 。`);
    const preview = () => renderCandidateNote('.release-notes/product.md', input, [], {
      template, repository, sourceSha, tag: frozen.tag,
    });
    const render = () => renderFrozenReleaseNotes(template, { ...frozen, notes: input, selectedDownloads: new Set(['file.zip']) });
    for (const project of [preview, render]) expect(project).toThrow(/outside GitHub delivery|invalid GitHub link encoding/);
  });

  it('preserves the selected filename case and percent encoding', () => {
    const input = notes('获取与使用', `**下载**。见[附件](<https://github.com/${repository}/releases/download/${frozen.tag}/Setup%20x64.zip>)。`);
    expect(renderFrozenReleaseNotes(previousTemplate, { ...frozen, notes: input, selectedDownloads: new Set(['Setup x64.zip']) })).toContain('Setup%20x64.zip');
    expect(() => renderFrozenReleaseNotes(previousTemplate, { ...frozen, notes: input, selectedDownloads: new Set(['setup x64.zip']) })).toThrow('acquisition link');
  });

  it('trims punctuation following a bare download without changing punctuation inside its filename', () => {
    const url = `https://github.com/${repository}/releases/download/${frozen.tag}/Tool!x64.zip`;
    const input = notes('本版重点', `**下载**。如下 ${url}!`);
    expect(renderFrozenReleaseNotes(template, { ...frozen, notes: input, selectedDownloads: new Set(['Tool!x64.zip']) })).toContain(url);
  });

  it.each([
    'https://example:placeholder@github.com/',
    'https://:placeholder@github.com/',
    'http://github.com/',
  ])('requires a public HTTPS URL for bare downloads outside acquisition: %s', authority => {
    const download = `${repository}/releases/download/${frozen.tag}/file.zip`;
    const input = notes('本版重点', `**下载**。见 ${authority}${download} 。`);
    const preview = () => renderCandidateNote('.release-notes/product.md', input, [], {
      template, repository, sourceSha, tag: frozen.tag,
    });
    const render = () => renderFrozenReleaseNotes(template, { ...frozen, notes: input, selectedDownloads: new Set(['file.zip']) });
    for (const project of [preview, render]) expect(project).toThrow('outside GitHub delivery');
  });
});
