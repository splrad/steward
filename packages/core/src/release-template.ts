import Mustache from 'mustache';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const headingFields = {
  '概述': 'summary', '兼容性': 'compatibility', '升级与迁移': 'upgrade',
  '安装说明': 'installation', '已知问题': 'knownIssues', '恢复': 'recovery',
} as const;
type NotesField = typeof headingFields[keyof typeof headingFields];
const prompts = [
  '说明此版本给使用者带来的主要变化。',
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
export function parseSupplementalNotes(markdown: string): Record<NotesField, string> {
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
  if (Object.keys(result).length !== Object.keys(headingFields).length) fail('missing heading');
  return result as Record<NotesField, string>;
}

export interface ReleaseTemplateData extends Record<NotesField, string> {
  productName: string; version: string; changelog: string; downloads: string;
  sourceSha: string; policySha: string; compareUrl: string;
  channels: { name: string; status: '待分发'; location: string }[];
}
const plainFields = new Set(['productName', 'version', 'sourceSha', 'policySha']);
const markdownFields = new Set(['summary', 'changelog', 'compatibility', 'upgrade', 'downloads',
  'installation', 'knownIssues', 'recovery', 'compareUrl']);

export function committedVersionNotes(markdown: string, version: string, repository: string, sourceSha: string, tag: string): { changelog: string; compareUrl: string } {
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
  return { changelog, compareUrl };
}

export function renderCommittedReleaseNotes(template: string, data: ReleaseTemplateData): string {
  const expected = [...plainFields, ...markdownFields, 'channels'];
  if (Object.keys(data).length !== expected.length || Object.keys(data).some(key => !expected.includes(key))) fail('input keys');
  for (const key of [...plainFields, ...markdownFields]) filled(data[key as keyof ReleaseTemplateData]);
  if (!/^[^\r\n<>\[\]{}*_`]+$/.test(data.productName)) fail('product name must be plain text');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version)) fail('invalid version');
  if (![data.sourceSha, data.policySha].every(sha => /^[a-f0-9]{40}$/.test(sha))) fail('invalid commit identity');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:compare|commit)\/[A-Za-z0-9._%~-]+$/.test(data.compareUrl)) fail('invalid comparison URL');
  if (!Array.isArray(data.channels)) fail('invalid channels');
  for (const channel of data.channels) {
    if (Object.keys(channel).sort().join(',') !== 'location,name,status' || channel.status !== '待分发') fail('invalid channel status');
    filled(channel.name); filled(channel.location);
  }
  const used = new Set<string>();
  function inspect(tokens: ReturnType<typeof Mustache.parse>, inChannels = false) {
    for (const token of tokens) {
      const [kind, name] = token;
      if (kind === 'text' || kind === '!') continue;
      if (kind === '#' && name === 'channels' && !inChannels) {
        used.add(name); inspect(token[4] as ReturnType<typeof Mustache.parse>, true); continue;
      }
      const allowed = inChannels ? new Set(['name', 'status', 'location']) : new Set([...plainFields, ...markdownFields]);
      if (!['name', '&'].includes(kind) || !allowed.has(name)) fail('unsupported template token');
      if (kind === '&' && (inChannels ? name !== 'location' : !markdownFields.has(name))) fail('unsafe unescaped field');
      if (!inChannels) used.add(name);
    }
  }
  inspect(Mustache.parse(template));
  if (expected.some(key => !used.has(key))) fail('template omits required field');
  const output = Mustache.render(template, data);
  if (/\{\{|\}\}/.test(output) || !output.includes(data.version)) fail('unresolved template');
  return output;
}
