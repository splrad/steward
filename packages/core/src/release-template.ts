import {headingFields,optionalNotes,noSourceInformation} from './candidate-note.js';
export {previewUnitNotes} from './candidate-note.js';
import Mustache from 'mustache';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { selectReleaseContributors, type ReleaseContributor, type RepositoryAuthor } from './release-candidate.js';
import { assertDeliveryAssetName, assertDeliveryPath } from './delivery-config.js';
import { assertSelectedReleaseDownloads, assertVersionAcquisitionLinks, isConditionalTemplate, parseConditionalNotes, renderConditionalNotes } from './conditional-release-notes.js';

type NotesField = typeof headingFields[keyof typeof headingFields];
const usesCompactLayout = (template: string) => template.includes('{{{upgradeNotices}}}');
const prompts = [
  '说明此版本给使用者带来的主要变化。',
  '根据源码证据生成此版本给使用者带来的主要变化，供原PR审阅。',
  '按使用者可观察的行为、适用条件和必要操作列出本次变化；',
  '说明本版本真实支持的安装方法及必要操作；',
  '说明受支持系统、架构、运行时和宿主范围，以及已验证和未验证的边界。',
  '说明从上一受验版本升级的准确步骤、备份要求及不可逆变化。',
  '说明如何选择产物及安装；渠道尚未验收时明确标注待分发，并提供GitHub资产安装方式。',
  '列出已确认的问题、受影响范围和可用规避办法，标明未覆盖场景。',
  '说明停止当前版本、取回上一受验版本、恢复配置或数据并验证的方法。',
];
function fail(message: string): never { throw new Error(`RELEASE_TEMPLATE: ${message}`); }
function filled(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || /\{\{|\}\}/.test(value)
    || prompts.some(prompt => value.includes(prompt))) fail('empty or unfilled input');
}

/** Keep the committed Markdown bytes between unique level-two headings. */
export function parseLegacyNotes(markdown: string, template = ''): Record<NotesField, string> {
  const nodes = unified().use(remarkParse).parse(markdown).children;
  const result: Partial<Record<NotesField, string>> = {};
  const headings = nodes.filter(node => node.type === 'heading' && node.depth === 2);
  for (const [index, heading] of headings.entries()) {
    if (heading.type !== 'heading' || heading.children.some(child => child.type !== 'text')) fail('invalid heading');
    const label = heading.children.map(child => child.type === 'text' ? child.value : '').join('');
    const field = headingFields[label as keyof typeof headingFields];
    if (!field || Object.hasOwn(result, field)) fail('unknown or duplicate heading');
    const start = heading.position?.end.offset, end = headings[index + 1]?.position?.start.offset ?? markdown.length;
    if (start === undefined) fail('missing Markdown position');
    const value = markdown.slice(start, end).trim(); filled(value); result[field] = value;
  }
  if (usesCompactLayout(template)) for (const key of optionalNotes) result[key] ??= '';
  if (Object.keys(result).length !== Object.keys(headingFields).length) fail('missing heading');
  return result as Record<NotesField, string>;
}

export function parseSupplementalNotes(markdown: string, template = '') {
  return isConditionalTemplate(template) ? parseConditionalNotes(markdown, template.includes('{{#acquisition}}')) : parseLegacyNotes(markdown, template);
}

export interface ReleaseTemplateData extends Record<NotesField, string> {
  productName: string; version: string; downloads: string;
  sourceSha: string; controllerSha: string; sourceLinkLabel: string; sourceUrl: string; commitUrl: string;
  hasContributors: boolean; contributors: ReleaseContributor[];
  channels: { name: string; status: '待分发'; location: string }[];
}
const plainFields = new Set(['productName', 'version', 'sourceSha', 'controllerSha', 'sourceLinkLabel']);
const markdownFields = new Set(['summary', 'userChanges', 'compatibility', 'upgrade', 'downloads',
  'installation', 'knownIssues', 'recovery', 'sourceUrl', 'commitUrl']);

export function committedVersionNotes(markdown: string, version: string, repository: string, sourceSha: string, tag: string, changelogPath?: string): { changelog: string; sourceLinkLabel: string; sourceUrl: string; commitUrl: string } {
  const headings = unified().use(remarkParse).parse(markdown).children.filter(node => node.type === 'heading' && node.depth === 2);
  const plain = (node: any): string => typeof node.value === 'string' ? node.value : (node.children ?? []).map(plain).join('');
  const matches = headings.map((node, index) => ({ node, index })).filter(({ node }) => plain(node).split(/\s/)[0] === version);
  if (matches.length !== 1) fail('version changelog section must be unique');
  const { node, index } = matches[0]!;
  const start = node.position?.end.offset, end = headings[index + 1]?.position?.start.offset ?? markdown.length;
  if (start === undefined) fail('version changelog position');
  const changelog = markdown.slice(start, end).trim(); filled(changelog);
  const links = (node as any).children.filter((child: any) => child.type === 'link');
  const compareUrl = links.length === 1 ? links[0].url : `https://github.com/${repository}/commit/${sourceSha}`;
  const url = new URL(compareUrl);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${repository}/compare/`) && url.pathname !== `/${repository}/commit/${sourceSha}`
    || url.search || url.hash || url.username || url.password) fail('changelog comparison identity');
  if (url.pathname.startsWith(`/${repository}/compare/`)) {
    const range = decodeURIComponent(url.pathname.slice(`/${repository}/compare/`.length)).split('...');
    if (range.length !== 2 || !range[0] || range[1] !== tag) fail('changelog comparison tag');
  }
  const commitUrl = `https://github.com/${repository}/commit/${sourceSha}`;
  const previousTag = url.pathname.startsWith(`/${repository}/compare/`)
    ? decodeURIComponent(url.pathname.slice(`/${repository}/compare/`.length)).split('...')[0] : null;
  if (changelogPath !== undefined) assertDeliveryPath(changelogPath);
  return { changelog, commitUrl, sourceLinkLabel: previousTag ? '查看比较' : changelogPath ? '查看更新记录' : '查看源码',
    sourceUrl: previousTag ? `https://github.com/${repository}/compare/${encodeURIComponent(previousTag)}...${sourceSha}`
      : changelogPath ? `https://github.com/${repository}/blob/${sourceSha}/${changelogPath.split('/').map(encodeURIComponent).join('/')}`
      : `https://github.com/${repository}/tree/${sourceSha}` };
}

export function renderCommittedReleaseNotes(template: string, data: ReleaseTemplateData): string {
  const expected = [...plainFields, ...markdownFields, 'channels', 'hasContributors', 'contributors'];
  if (Object.keys(data).length !== expected.length || Object.keys(data).some(key => !expected.includes(key))) fail('input keys');
  const compact = usesCompactLayout(template);
  for (const key of [...plainFields, ...markdownFields]) {
    const value = data[key as keyof ReleaseTemplateData];
    if (compact && (key === 'downloads' || optionalNotes.some(field => field === key)) && value === '') continue;
    filled(value);
  }
  if (!/^[^\r\n<>\[\]{}*`]+$/.test(data.productName)) fail('product name must be plain text');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version)) fail('invalid version');
  if (![data.sourceSha, data.controllerSha].every(sha => /^[a-f0-9]{40}$/.test(sha))) fail('invalid commit identity');
  validateSourceLink(data);
  if (!Array.isArray(data.channels)) fail('invalid channels');
  for (const channel of data.channels) {
    if (Object.keys(channel).sort().join(',') !== 'location,name,status' || channel.status !== '待分发') fail('invalid channel status');
    filled(channel.name); filled(channel.location);
  }
  if (!Array.isArray(data.contributors) || typeof data.hasContributors !== 'boolean'
    || data.hasContributors !== (data.contributors.length > 0)) fail('invalid contributors');
  for (const person of data.contributors) {
    if (Object.keys(person).sort().join(',') !== 'alt,avatarUrl,id,login,profileUrl' || !Number.isSafeInteger(person.id) || person.id <= 0
      || !/^[A-Za-z0-9-]+$/.test(person.login) || person.alt !== person.login) fail('invalid contributor');
    for (const key of ['profileUrl', 'avatarUrl', 'alt', 'login'] as const) filled(person[key]);
    const profile = new URL(person.profileUrl), avatar = new URL(person.avatarUrl);
    if (profile.href !== `https://github.com/${person.login}` || avatar.protocol !== 'https:' || avatar.hostname !== 'avatars.githubusercontent.com'
      || avatar.username || avatar.password || avatar.port || avatar.hash) fail('invalid contributor URL');
  }
  return renderLegacyTemplate(template, data, compact);
}

function validateSourceLink(data: Pick<ReleaseTemplateData, 'commitUrl' | 'sourceUrl' | 'sourceLinkLabel' | 'sourceSha'>) {
  const commit = new URL(data.commitUrl), source = new URL(data.sourceUrl);
  const prefix = commit.pathname.replace(/\/commit\/[a-f0-9]{40}$/, '');
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(prefix) || prefix.split('/').some(part => part === '.' || part === '..')
    || commit.href !== `https://github.com${prefix}/commit/${data.sourceSha}`
    || source.origin !== 'https://github.com' || source.username || source.password || source.search || source.hash) fail('source identity');
  if (data.sourceLinkLabel === '查看源码') {
    if (source.href !== `https://github.com${prefix}/tree/${data.sourceSha}`) fail('first release source');
  } else if (data.sourceLinkLabel === '查看更新记录') {
    const root = `${prefix}/blob/${data.sourceSha}/`;
    if (!source.pathname.startsWith(root)) fail('changelog source');
    assertDeliveryPath(decodeURIComponent(source.pathname.slice(root.length)));
  } else if (data.sourceLinkLabel === '查看比较') {
    if (!source.pathname.startsWith(`${prefix}/compare/`)) fail('comparison source');
    const range = decodeURIComponent(source.pathname.slice(`${prefix}/compare/`.length)).split('...');
    if (range.length !== 2 || !range[0] || /[\s\0?#]/.test(range[0]) || range[1] !== data.sourceSha) fail('comparison boundary');
  } else fail('source link label');
}

function renderLegacyTemplate(template: string, data: ReleaseTemplateData, compact: boolean) {
  const used = new Set<string>();
  function inspect(tokens: ReturnType<typeof Mustache.parse>, context = 'root') {
    for (const token of tokens) {
      const [kind, name] = token;
      if (kind === 'text' || kind === '!') continue;
      if (kind === '#' && (context === 'root' && ['channels', 'hasContributors'].includes(name)
        || context === 'hasContributors' && name === 'contributors')) {
        used.add(name); inspect(token[4] as ReturnType<typeof Mustache.parse>, name); continue;
      }
      const allowed = context === 'channels' ? new Set(['name', 'status', 'location'])
        : context === 'contributors' ? new Set(['profileUrl', 'avatarUrl', 'alt'])
        : context === 'root' ? new Set([...plainFields, ...markdownFields, 'upgradeNotices']) : new Set<string>();
      if (!['name', '&'].includes(kind) || !allowed.has(name)) fail('unsupported template token');
      if (kind === '&' && (context === 'channels' ? name !== 'location' : context !== 'root' || (!markdownFields.has(name) && name !== 'upgradeNotices'))) fail('unsafe unescaped field');
      used.add(context === 'root' ? name : `${context}.${name}`);
    }
  }
  inspect(Mustache.parse(template));
  const noticeFields = ['compatibility','upgrade','knownIssues','recovery'];
  const requiredMarkdown = [...markdownFields].filter(key => key !== 'commitUrl' && !(compact && noticeFields.includes(key)));
  if (['productName','version','sourceLinkLabel', ...requiredMarkdown, 'hasContributors','contributors', 'contributors.profileUrl', 'contributors.avatarUrl', 'contributors.alt']
    .some(key => !used.has(key))) fail('template omits required field');
  const notices = Object.entries(headingFields)
    .filter(([, key]) => noticeFields.includes(key) && data[key] && data[key] !== noSourceInformation)
    .map(([heading, key]) => `### ${heading}\n\n${data[key]}`);
  const upgradeNotices = notices.length ? `## 升级须知\n\n${notices.join('\n\n')}` : '';
  const categories = unified().use(remarkParse).parse(data.userChanges).children.some(node => node.type === 'heading');
  const output = Mustache.render(template, compact ? { ...data, productName: data.productName.replaceAll('_', '\\_'), upgradeNotices,
    installation: data.installation === noSourceInformation ? '' : data.installation,
    userChanges: categories ? data.userChanges : '### 使用变化\n\n' + data.userChanges } : data);
  if (/\{\{|\}\}/.test(output) || !output.includes(data.version)) fail('unresolved template');
  const headings = unified().use(remarkParse).parse(output).children.filter(node => node.type === 'heading' && node.depth === 2)
    .map(node => (node as any).children.map((child: any) => child.value).join(''));
  if (JSON.stringify(headings) !== JSON.stringify([...(compact && !upgradeNotices ? [] : ['升级须知']), '更新内容', ...(data.hasContributors ? ['贡献者'] : []), '完整变更'])) fail('four section layout');
  return output;
}

/** Adjust only headings in the rendered copy; code fences and original source bytes remain intact. */
export function nestReleaseMarkdown(markdown: string, minimumDepth = 4): string {
  const headings: { start: number; end: number; depth: number; text: string }[] = [];
  const visit = (node: any) => {
    if (node.type === 'heading' && node.position?.start.offset !== undefined && node.position?.end.offset !== undefined) {
      const original = markdown.slice(node.position.start.offset, node.position.end.offset);
      const text = original.replace(/^ {0,3}#{1,6}\s+/, '').replace(/\n {0,3}(?:=+|-+)\s*$/, '');
      headings.push({ start: node.position.start.offset, end: node.position.end.offset, depth: node.depth, text });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(unified().use(remarkParse).parse(markdown));
  const shallowest = Math.min(...headings.map(item => item.depth), minimumDepth);
  for (const item of headings.sort((a, b) => b.start - a.start)) {
    const depth = Math.min(6, item.depth + minimumDepth - shallowest);
    markdown = markdown.slice(0, item.start) + '#'.repeat(depth) + ' ' + item.text + markdown.slice(item.end);
  }
  return markdown.trim();
}
export interface FrozenReleaseNotes {
  repository: string; unitId: string; displayName?: string | undefined; version: string; tag: string; sourceSha: string; controllerSha: string;
  notes: string; sourceLinkLabel: string; sourceUrl: string; commitUrl: string; contributors: ReleaseContributor[]; repositoryAuthors: RepositoryAuthor[];
  contributorMode?: 'github-authors';
  selectedDownloads?: ReadonlySet<string>;
  githubDisabled?: boolean;
  assets: { id: string; name: string; build: string; description?: string | undefined }[];
  channels: { id: string; location: string }[];
}

type ReleaseDownloadInput = Pick<FrozenReleaseNotes,'assets'|'repository'|'tag'>;
function releaseDownloadMarkdown(template: string, data: ReleaseDownloadInput): string {
  const legacy = template.includes('{{controllerSha}}');
  return [ ...(legacy ? ['| 用途（产物 ID，详见安装说明） | 系统/架构（构建目标） | 文件 |', '| --- | --- | --- |'] : []), ...data.assets.map(asset => {
    if (asset.description !== undefined && (!asset.description.trim() || /[\p{C}\p{Zl}\p{Zp}]/u.test(asset.description))) fail('asset description');
    assertDeliveryAssetName(asset.name);
    if (![asset.id, asset.build].every(value => /^[a-z][a-z0-9-]*$/.test(value))) fail('download source');
    const link = `[${asset.name}](https://github.com/${data.repository}/releases/download/${encodeURIComponent(data.tag)}/${encodeURIComponent(asset.name)})`;
    const description = asset.description?.replace(/[\\`*_{}\[\]()<>#!|~&]/g, char => `&#${char.codePointAt(0)};`);
    return legacy ? `| ${asset.id} | ${asset.build} | ${link} |` : `- ${link}${description ? ' — ' + description : ''}`;
  })].join('\n');
}

/** Preserve the reviewed prose and change only the original renderer's download block. */
export function projectFrozenReleaseDownloads(template: string, notes: string, native: ReleaseDownloadInput, selected: ReadonlySet<string>): string {
  if (isConditionalTemplate(template)) {
    assertSelectedReleaseDownloads(notes, native.repository, native.tag, selected);
    return notes;
  }
  const assets=native.assets.filter(asset=>selected.has(asset.name));
  if(assets.length===native.assets.length)return notes;
  if(!assets.length)fail('empty public download set');
  const original='\n'+releaseDownloadMarkdown(template,native)+'\n';
  const framed='\n'+notes+'\n', start=framed.indexOf(original);
  if(start<0 || framed.indexOf(original,start+1)>=0)fail('frozen download block');
  const replacement='\n'+releaseDownloadMarkdown(template,{...native,assets})+'\n';
  return (framed.slice(0,start)+replacement+framed.slice(start+original.length)).slice(1,-1);
}

/** Render only from reviewed source and frozen native identities. */
export function renderFrozenReleaseNotes(template: string, data: FrozenReleaseNotes): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.repository) || data.repository.split('/').some(part => part === '.' || part === '..')
    || ![data.sourceSha, data.controllerSha].every(sha => /^[a-f0-9]{40}$/.test(sha)) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version)) fail('frozen identity');
  if (!/^[a-z][a-z0-9-]*$/.test(data.unitId) || !data.tag || /[\s\0]/.test(data.tag)) fail('unit or tag');
  const conditional = isConditionalTemplate(template);
  const contributors = selectReleaseContributors(data.contributors.map(person => ({ ...person, type: 'User' })),
    data.repositoryAuthors, data.contributorMode === 'github-authors' ? 'github-authors'
      : conditional ? data.contributors : undefined).contributors;
  if (JSON.stringify(contributors) !== JSON.stringify(data.contributors)) fail('frozen contributors');
  if (data.commitUrl !== `https://github.com/${data.repository}/commit/${data.sourceSha}`) fail('commit URL');
  if (conditional) {
    validateSourceLink(data);
    const notes = parseConditionalNotes(data.notes, template.includes('{{#acquisition}}'));
    const selected = data.selectedDownloads ?? new Set(data.assets.map(asset => asset.name));
    assertVersionAcquisitionLinks(notes, data.repository, data.tag, data.sourceSha, [...selected]);
    const body = renderConditionalNotes(template, notes, { label: data.sourceLinkLabel, url: data.sourceUrl }, contributors);
    assertSelectedReleaseDownloads(body, data.repository, data.tag, selected);
    return body;
  }
  const sections = parseLegacyNotes(data.notes, template);
  const channels = data.channels.map(channel => {
    if (!/^[a-z][a-z0-9-]*$/.test(channel.id) || !channel.location.trim() || /[\r\n\0]/.test(channel.location)) fail('channel facts');
    return { name: channel.id, status: '待分发' as const, location: `目标 <code>${Mustache.escape(channel.location)}</code>。` };
  });
  if ((!data.assets.length && !data.githubDisabled) || new Set(data.assets.map(asset => asset.id)).size !== data.assets.length
    || new Set(data.assets.map(asset => asset.name.toLowerCase())).size !== data.assets.length) fail('download set');
  const legacy = template.includes('{{controllerSha}}');
  const downloads = !data.assets.length ? (usesCompactLayout(template) ? '' : '本次构建未配置 GitHub 下载项。') : releaseDownloadMarkdown(template,data);
  const values = { ...Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, nestReleaseMarkdown(value, key === 'userChanges' ? 3 : 4)])),
    productName: data.displayName ?? (legacy ? data.unitId : data.repository.split('/')[1]!), version: data.version, downloads, sourceLinkLabel: data.sourceLinkLabel, sourceUrl: data.sourceUrl, commitUrl: data.commitUrl,
    sourceSha: data.sourceSha, controllerSha: data.controllerSha, channels, hasContributors: contributors.length > 0, contributors } as ReleaseTemplateData;
  return renderCommittedReleaseNotes(template, values);
}
export const productReleaseTemplatePath = '.github/release-template.md.mustache';
export const sharedReleaseTemplatePath = 'templates/repository/' + productReleaseTemplatePath;
