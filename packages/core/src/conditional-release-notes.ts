import Mustache from 'mustache';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { isAlias, isScalar, parseAllDocuments, visit } from 'yaml';
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
  acquisition: '获取与使用',
  knownLimitations: '已知问题与限制',
} as const;
export type ConditionalSection = keyof typeof conditionalHeadings;
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
const sectionByHeading = new Map<string, ConditionalSection>(
  Object.entries(conditionalHeadings).map(([key, value]) => [value, key as ConditionalSection]),
);
export const isConditionalTemplate = (template: string): boolean => template.includes('{{#requiredActions}}');

export function isConditionalItem(markdown: string, section: ConditionalSection): boolean {
  const nodes = parser.parse(markdown).children;
  return nodes[0]?.type === 'paragraph'
    && (nodes.length === 1 || section === 'acquisition' && nodes.length === 2 && nodes[1]?.type === 'code');
}

function httpsLink(value: string): void {
  if (!/^https:\/\//i.test(value) || /[\s<>\\]/u.test(value)) fail('public HTTPS link required');
  const url = new URL(value);
  if (url.username || url.password) fail('public HTTPS link required');
}

/** One reviewed item is a Markdown paragraph headed by bold text, with an optional fenced usage example. */
export function parseConditionalNotes(markdown: string): ConditionalNotes {
  const sections: Partial<Record<ConditionalSection, Item[]>> = {};
  let summary: string | undefined;
  let current: ConditionalSection | undefined;
  let last: Item | undefined;
  let count = 0;
  const inspected = new Set<ConditionalSection>();
  const slice = (node: ReturnType<typeof parser.parse>['children'][number]) =>
    markdown.slice(node.position?.start.offset, node.position?.end.offset);
  for (const node of parser.parse(markdown).children) {
    if (node.type === 'heading' && node.depth === 2 && node.children.length === 1 && node.children[0]?.type === 'text') {
      if (current && !count) fail('empty heading');
      current = sectionByHeading.get(node.children[0].value);
      if (!current || inspected.has(current)) fail('unknown or duplicate heading');
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

/** Product-local acquisition references must point to the actual release or its reviewed source. */
export function assertVersionAcquisitionLinks(notes: ConditionalNotes, repository: string, tag: string, sourceSha: string,
  assetNames?: readonly string[]) {
  const prefix = `/${repository.toLowerCase()}/`;
  const versioned = (url: URL): boolean => {
    if (url.origin !== 'https://github.com' || !url.pathname.toLowerCase().startsWith(prefix)) return true;
    const path = url.pathname.slice(prefix.length);
    if (path.startsWith('releases/tag/')) return decodeURIComponent(path.slice('releases/tag/'.length)) === tag;
    if (path.startsWith('releases/download/')) {
      const download = decodeURIComponent(path.slice('releases/download/'.length));
      return assetNames ? assetNames.some(name => download === `${tag}/${name}`) : download.startsWith(tag + '/');
    }
    if (path === 'releases' || path.startsWith('releases/')) return false;
    if (/^(?:blob|tree)\//.test(path)) {
      const ref = decodeURIComponent(path.slice(path.indexOf('/') + 1));
      return [tag, sourceSha].some(version => ref === version || ref.startsWith(version + '/'));
    }
    if (path.startsWith('archive/')) {
      const archive = decodeURIComponent(path.slice('archive/'.length));
      return [sourceSha, `refs/tags/${tag}`].some(version => archive === `${version}.zip` || archive === `${version}.tar.gz`);
    }
    return true;
  };
  for (const item of notes.acquisition?.items ?? []) {
    const paragraph = parser.parse(item.description).children[0];
    if (paragraph?.type !== 'paragraph') fail('invalid acquisition description');
    const verify = (child: (typeof paragraph)['children'][number]): void => {
      if (child.type === 'link' && !versioned(new URL(child.url))) fail('acquisition link is outside the release version');
      if ('children' in child) child.children.forEach(verify);
    };
    paragraph.children.forEach(verify);
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
              && (at === -1 || ![tag, sourceSha].includes(value.slice(at + 1)))) fail('workflow example is outside the release version');
          },
        });
      }
    }
  }
}

export function assertSelectedReleaseDownloads(markdown: string, repository: string, tag: string, selected: ReadonlySet<string>) {
  const prefix = `/${repository.toLowerCase()}/releases/download/`;
  const links = new Set([...markdown.matchAll(/https:\/\/github\.com\/[^\s<>()[\]"'`]+/gi)]
    .map(match => match[0]!.replace(/[.,!?;:]+$/, '')));
  for (const link of links) {
    const url = new URL(link);
    if (!url.pathname.toLowerCase().startsWith(prefix)) continue;
    const download = decodeURIComponent(url.pathname.slice(prefix.length));
    const tagPrefix = tag + '/';
    if (!download.startsWith(tagPrefix) || !selected.has(download.slice(tagPrefix.length)))
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
  contributors: ['profileUrl', 'avatarUrl', 'alt'],
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
    ...['highlights', ...categories.map(key => 'changes.' + key), 'compatibility', 'acquisition', 'knownLimitations']
      .flatMap(key => [key + '.items.title', key + '.items.description']),
    'acquisition.items.example.language', 'acquisition.items.example.content',
    ...['profileUrl', 'avatarUrl', 'alt'].map(key => 'hasContributors.contributors.' + key),
    'sourceLink.label', 'sourceLink.url',
  ];
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
