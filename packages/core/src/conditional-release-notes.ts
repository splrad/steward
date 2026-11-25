import Mustache from 'mustache';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { isAlias, isScalar, parseAllDocuments, visit } from 'yaml';
import { sha256Hex } from './fingerprint.js';
import type { ReleaseContributor } from './candidate-note.js';

export const changeHeadings = {
  added: '✨ 新增功能与内容',
  improved: '⚡ 改进',
  fixed: '🐛 错误修复',
  security: '🔒 安全修复',
  documentation: '📚 文档更新',
  delivery: '📦 交付方式变化',
} as const;
export const conditionalHeadings = {
  requiredActions: '必须执行的操作',
  summary: '概述',
  highlights: '本版重点',
  ...changeHeadings,
  compatibility: '兼容性与迁移',
  knownLimitations: '已知问题与限制',
} as const;
export type ConditionalSection = keyof typeof conditionalHeadings;
export const reviewedHeadings = { ...conditionalHeadings, acquisition: '获取与使用' } as const;
type ReviewedSection = keyof typeof reviewedHeadings;
type Item = { title: string; description: string; example?: { language: string; content: string } };
type Items = { items: Item[] };
type ConditionalNotes = {
  summary?: string;
  requiredActions?: { items: { affectedUsers: string; instruction: string }[] };
  highlights?: Items;
  changes?: Partial<Record<keyof typeof changeHeadings, Items>>;
  compatibility?: Items;
  acquisition?: Items;
  knownLimitations?: Items;
};

const parser = unified().use(remarkParse);
function fail(reason: string): never { throw new Error(`RELEASE_TEMPLATE: ${reason}`); }
const sectionByHeading = new Map<string, ReviewedSection>(
  Object.entries(reviewedHeadings).map(([key, value]) => [value, key as ReviewedSection]),
);
export const isConditionalTemplate = (template: string): boolean => template.includes('{{#requiredActions}}');
const adoptedConditionalDigests = [
  '104ba109cfd13d3dca3b3ffb51d9d48eadae31fbc3c38c1ba517aceb94245231', // avatars
  '120dc4498c5a8ab55e14caf222f0fce2dd09b366f072798c6d12a2db3945776a', // avatars and numeric IDs
  '5c4b14554ed6ad7729b8c13c7e8daedff23dba36bb83fa0e22319a70aa493763', // linked usernames and numeric IDs
  'e7d54160c3c6811e223ad17b8d2d3284cd9b9e11ddf2d87dae3b8e846b839bb0', // linked usernames
  '3d165e96c046f349596a57099fab0a463cdcc8ae9c8f6d695220882ca1bd5ffa', // project title and version-specific changes
];
const showsReleaseContributorIds = (template: string): boolean => template.includes('{{id}}');

export async function isAdoptedOrganizationReleaseTemplate(template: string): Promise<boolean> {
  const digest = await sha256Hex(template);
  return adoptedConditionalDigests.includes(digest);
}

/** An already reviewed conditional note retains the exact format across template adoption. */
export async function reviewedConditionalReleaseTemplate(current: string, reviewed?: string): Promise<string> {
  if (reviewed && reviewed !== current) {
    const currentDigest = await sha256Hex(current), reviewedDigest = await sha256Hex(reviewed);
    const reviewedVersion = adoptedConditionalDigests.indexOf(reviewedDigest);
    if (reviewedVersion >= 0 && adoptedConditionalDigests.indexOf(currentDigest) > reviewedVersion) return reviewed;
  }
  return current;
}

const legacyOrganizationTemplates = new Set([
  '456bedbae6c57f772630a44153077d0b26fd44c340abb8ea2905d1d813b76711', // Steward 723f1583
  '8b61942fc172cca1ed06886a3fd691835c5dc474624c3b6872449cdf14ed98e5', // Steward 8eae6add
]);
export const isPreviouslyAdoptedReleaseTemplate = async (template: string): Promise<boolean> =>
  legacyOrganizationTemplates.has(await sha256Hex(template));

export function isConditionalItem(markdown: string, allowExample = false): boolean {
  const nodes = parser.parse(markdown).children;
  return nodes[0]?.type === 'paragraph' && (nodes.length === 1 || allowExample && nodes.length === 2 && nodes[1]?.type === 'code');
}

function httpsLink(value: string): void {
  if (!/^https:\/\//i.test(value) || /[\s<>\\]/u.test(value)) fail('public HTTPS link required');
  const url = new URL(value);
  if (url.username || url.password) fail('public HTTPS link required');
}

/** One reviewed item is a Markdown paragraph headed by bold text, with an optional fenced usage example. */
export function parseConditionalNotes(markdown: string, allowAcquisition = false): ConditionalNotes {
  const sections: Partial<Record<ReviewedSection, Item[]>> = {};
  let summary: string | undefined;
  let current: ReviewedSection | undefined;
  let last: Item | undefined;
  let count = 0;
  const inspected = new Set<ReviewedSection>();
  const slice = (node: ReturnType<typeof parser.parse>['children'][number]) =>
    markdown.slice(node.position?.start.offset, node.position?.end.offset);
  for (const node of parser.parse(markdown).children) {
    if (node.type === 'heading' && node.depth === 2 && node.children.length === 1 && node.children[0]?.type === 'text') {
      if (current && !count) fail('empty heading');
      current = sectionByHeading.get(node.children[0].value);
      if (!current || current === 'acquisition' && !allowAcquisition || inspected.has(current)) fail('unknown or duplicate heading');
      inspected.add(current);
      last = undefined;
      count = 0;
      continue;
    }
    if (!current) return fail('content outside a release heading');
    if (node.type === 'code' && current === 'acquisition' && last && !last.example) {
      if (!/^(?:`{3,}|~{3,})/.test(slice(node)) || !/^[a-zA-Z0-9_+-]*$/.test(node.lang ?? '') || node.meta
        || !node.value.trim() || /^ {0,3}~{3,}/m.test(node.value)) fail('invalid fenced usage example');
      last.example = { language: node.lang ?? '', content: node.value };
      continue;
    }
    if (node.type !== 'paragraph') return fail('invalid release item');
    const verify = (child: (typeof node)['children'][number]): void => {
      if (['html', 'linkReference', 'image', 'imageReference'].includes(child.type)) fail('unsupported release markup');
      if (child.type === 'link') httpsLink(child.url);
      if ('children' in child) child.children.forEach(verify);
    };
    node.children.forEach(verify);
    const text = slice(node);
    if (/\{\{|\}\}|当前发布资料未提供此项变化的确认信息。/.test(text)) fail('unfilled release item');
    count++;
    if (current === 'summary') {
      if (summary || /\r?\n/.test(text)) fail('summary must be one paragraph on one line');
      summary = text;
      continue;
    }
    const leading = node.children[0];
    if (leading?.type !== 'strong' || leading.children.length !== 1 || leading.children[0]?.type !== 'text')
      return fail('release item needs a short title');
    const title = leading.children[0].value.trim();
    const body = markdown.slice(leading.position!.end.offset, node.position!.end.offset);
    const description = body.slice(1).trim();
    if (!body.startsWith('。') || !title || /[\r\n*_[\]`\\]/.test(title) || !description || /\r?\n/.test(description))
      fail('release item needs a one-line description after its title');
    last = { title, description };
    (sections[current] ??= []).push(last);
  }
  if (current && !count) fail('empty heading');
  if (summary && sections.highlights) fail('summary and highlights are mutually exclusive');
  const changes: ConditionalNotes['changes'] = {};
  for (const key of Object.keys(changeHeadings) as (keyof typeof changeHeadings)[]) {
    const items = sections[key];
    if (items) changes[key] = { items };
  }
  if (!summary && !Object.keys(sections).length) fail('substantive release content required');
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(sections.requiredActions ? { requiredActions: { items: sections.requiredActions.map(({ title, description }) => ({
      affectedUsers: title, instruction: description,
    })) } } : {}),
    ...(sections.highlights ? { highlights: { items: sections.highlights } } : {}),
    ...(Object.keys(changes).length ? { changes } : {}),
    ...(sections.compatibility ? { compatibility: { items: sections.compatibility } } : {}),
    ...(sections.acquisition ? { acquisition: { items: sections.acquisition } } : {}),
    ...(sections.knownLimitations ? { knownLimitations: { items: sections.knownLimitations } } : {}),
  };
}

function githubRepositoryPath(url: URL, repository: string) {
  if (url.hostname !== 'github.com') return;
  const prefix = `/${repository.toLowerCase()}/`;
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { fail('invalid GitHub link encoding'); }
  if (!decoded.toLowerCase().startsWith(prefix)) return;
  return {
    path: decoded.slice(prefix.length),
    rawPath: url.pathname.toLowerCase().startsWith(prefix) ? url.pathname.slice(prefix.length) : '',
  };
}

/** Product-local acquisition references must point to the actual release or its reviewed source. */
export function assertVersionAcquisitionLinks(notes: ConditionalNotes, repository: string, tag: string, sourceSha?: string,
  assetNames?: readonly string[]) {
  const refs = sourceSha ? [tag, sourceSha] : [tag];
  const archives = sourceSha ? [`refs/tags/${tag}`, sourceSha] : [`refs/tags/${tag}`];
  const versioned = (url: URL): boolean => {
    const local = githubRepositoryPath(url, repository);
    if (!local) return true;
    if (url.origin !== 'https://github.com' || url.username || url.password) return false;
    const { path, rawPath } = local, route = path.toLowerCase();
    if (rawPath.startsWith('releases/tag/')) return path.slice('releases/tag/'.length) === tag;
    if (rawPath.startsWith('releases/download/')) {
      const download = path.slice('releases/download/'.length);
      return assetNames ? assetNames.some(name => download === `${tag}/${name}`) : download.startsWith(tag + '/');
    }
    if (route === 'releases' || route.startsWith('releases/')) return false;
    if (/^(?:blob|tree)\//.test(route)) {
      if (!/^(?:blob|tree)\//.test(rawPath)) return false;
      const ref = path.slice(path.indexOf('/') + 1);
      return refs.some(version => ref === version || ref.startsWith(version + '/'));
    }
    if (route.startsWith('archive/')) {
      if (!rawPath.startsWith('archive/')) return false;
      const archive = path.slice('archive/'.length);
      return archives.some(version => archive === `${version}.zip` || archive === `${version}.tar.gz`);
    }
    return true;
  };
  for (const item of notes.acquisition?.items ?? []) {
    const paragraph = parser.parse(item.description).children[0];
    if (paragraph?.type !== 'paragraph') fail('invalid acquisition description');
    const verify = (child: (typeof paragraph)['children'][number]): void => {
      if (child.type === 'link' && !versioned(new URL(child.url))) fail('acquisition link is outside the release version');
      if (child.type === 'text' || child.type === 'inlineCode') for (const link of githubUrls(child.value)) {
        if (!versioned(new URL(link))) fail('acquisition link is outside the release version');
      }
      if ('children' in child) child.children.forEach(verify);
    };
    paragraph.children.forEach(verify);
    for (const link of githubUrls(item.example?.content ?? '')) {
      if (!versioned(new URL(link))) fail('acquisition example link is outside the release version');
    }
    if (/^ya?ml$/i.test(item.example?.language ?? '')) {
      for (const document of parseAllDocuments(item.example!.content, { uniqueKeys: true })) {
        if (document.errors.length) fail('invalid YAML acquisition example');
        visit(document, {
          Pair(_key, pair) {
            const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
            if (!isScalar(key) || key.value !== 'uses') return;
            const reference = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
            if (!isScalar(reference) || typeof reference.value !== 'string') fail('invalid YAML workflow reference');
            const value = reference.value.trim(), at = value.indexOf('@');
            const action = (at === -1 ? value : value.slice(0, at)).toLowerCase();
            if ((action === repository.toLowerCase() || action.startsWith(repository.toLowerCase() + '/'))
              && (at === -1 || !refs.includes(value.slice(at + 1)))) fail('workflow example is outside the release version');
          },
        });
      }
    }
  }
}

function githubUrls(text: string) {
  const urls = new Set<string>();
  for (const [link] of text.matchAll(/https?:\/\/(?:[^\s<>()[\]"'`/?#\\]*@)?github\.com(?::\d+)?\/[^\s<>()[\]"'`]+/gi)) {
    let end = link.length;
    while (end > 0 && '.,!?;:'.includes(link.charAt(end - 1))) end--;
    urls.add(link.slice(0, end));
  }
  return urls;
}

export function assertSelectedReleaseDownloads(markdown: string, repository: string, tag: string, selected?: ReadonlySet<string>) {
  const prefix = 'releases/download/';
  for (const link of githubUrls(markdown)) {
    const url = new URL(link);
    const local = githubRepositoryPath(url, repository);
    if (!local) continue;
    const { path, rawPath } = local, route = path.toLowerCase();
    if (route === 'releases/latest/download' || route.startsWith('releases/latest/download/'))
      fail('conditional release links to a file outside GitHub delivery');
    if (!route.startsWith(prefix)) continue;
    const download = path.slice(prefix.length);
    const tagPrefix = tag + '/';
    if (!rawPath.startsWith(prefix) || url.origin !== 'https://github.com' || url.username || url.password || !download.startsWith(tagPrefix) || download === tagPrefix
      || (selected && !selected.has(download.slice(tagPrefix.length))))
      fail('conditional release links to a file outside GitHub delivery');
  }
}

const categories = Object.keys(changeHeadings);
const sectionChildren: Record<string, readonly string[]> = {
  root: ['requiredActions', 'summary', 'highlights', 'changes', 'compatibility', 'acquisition', 'knownLimitations', 'hasContributors'],
  changes: categories,
  requiredActions: ['items'],
  highlights: ['items'],
  compatibility: ['items'],
  acquisition: ['items'],
  knownLimitations: ['items'],
  ...Object.fromEntries(categories.map(key => [key, ['items']])),
  items: ['links', 'example'],
  'hasContributors': ['contributors'],
};
const escapedFields: Record<string, readonly string[]> = {
  root: ['sourceLink.label'],
  items: ['title', 'affectedUsers'],
  links: ['label'],
  example: ['language'],
  contributors: ['profileUrl', 'avatarUrl', 'alt', 'login', 'id'],
};
const rawFields: Record<string, readonly string[]> = {
  root: ['sourceLink.url'],
  summary: ['summary'],
  items: ['description', 'instruction'],
  links: ['url'],
  example: ['content'],
};

export function renderConditionalNotes(template: string, notes: ConditionalNotes, sourceLink: { label: string; url: string },
  contributors: readonly ReleaseContributor[]): string {
  const used = new Set<string>();
  function inspect(tokens: ReturnType<typeof Mustache.parse>, scope: string[] = []) {
    const context = scope.at(-1) ?? 'root';
    for (const [kind, name, , , body] of tokens) {
      if (kind === 'text' || kind === '!') continue;
      used.add([...scope, name].join('.'));
      if (kind === '#' && sectionChildren[context]?.includes(name)
        && (name !== 'example' || scope[0] === 'acquisition')) {
        inspect(body as ReturnType<typeof Mustache.parse>, [...scope, name]);
      } else if (!(kind === 'name' && escapedFields[context]?.includes(name) || kind === '&' && rawFields[context]?.includes(name))) {
        fail('unsupported conditional template token');
      }
    }
  }
  inspect(Mustache.parse(template));
  const required = [
    'summary.summary', 'requiredActions.items.affectedUsers', 'requiredActions.items.instruction',
    ...['highlights', ...categories.map(key => 'changes.' + key), 'compatibility', 'knownLimitations']
      .flatMap(key => [key + '.items.title', key + '.items.description']),
    ...['profileUrl', 'avatarUrl', 'alt'].map(key => 'hasContributors.contributors.' + key),
    'sourceLink.label', 'sourceLink.url',
  ];
  if (used.has('acquisition')) {
    required.push('acquisition.items.title', 'acquisition.items.description',
      'acquisition.items.example.language', 'acquisition.items.example.content');
  }
  if (showsReleaseContributorIds(template)) required.push('hasContributors.contributors.id', 'hasContributors.contributors.login');
  if (required.some(key => !used.has(key))) fail('conditional template omits a required field');
  httpsLink(sourceLink.url);
  const output = Mustache.render(template, {
    ...notes, sourceLink, hasContributors: contributors.length > 0, contributors,
  }).trimEnd() + '\n';
  const headings = parser.parse(output).children.flatMap(node =>
    node.type === 'heading' && node.depth === 2 ? [node.children.map(child => child.type === 'text' ? child.value : '').join('')] : []);
  const expected = [notes.highlights && '本版重点', notes.changes && '本次更新', notes.compatibility && '兼容性与迁移',
    notes.acquisition && '获取与使用', notes.knownLimitations && '已知问题与限制', contributors.length && '贡献者', '版本记录'].filter(Boolean);
  if (JSON.stringify(headings) !== JSON.stringify(expected)) fail('conditional template layout');
  return output;
}
