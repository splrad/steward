import Mustache from 'mustache';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import { assertSelectedReleaseDownloads, assertVersionAcquisitionLinks, isConditionalTemplate, parseConditionalNotes, renderConditionalNotes } from './conditional-release-notes.js';

export const headingFields = {
  '概述': 'summary', '更新内容': 'userChanges', '兼容性': 'compatibility', '升级与迁移': 'upgrade',
  '安装说明': 'installation', '已知问题': 'knownIssues', '恢复': 'recovery',
} as const;
export const optionalNotes = ['compatibility', 'upgrade', 'installation', 'knownIssues', 'recovery'] as const;
export const noSourceInformation = '当前发布资料未提供此项变化的确认信息。';

export interface ReleaseContributor { id: number; login: string; profileUrl: string; avatarUrl: string; alt: string }

/** Remove generated empty optional sections from the preview while preserving source Markdown. */
export function previewUnitNotes(markdown: string): string {
  if (!markdown.includes(noSourceInformation)) return markdown;
  const nodes = unified().use(remarkParse).parse(markdown).children;
  const headings = nodes.flatMap((node, index) => node.type === 'heading' && node.depth === 2 ? [index] : []);
  let preview = markdown;
  for (let index = headings.length - 1; index >= 0; index--) {
    const position = headings[index]!;
    const heading = nodes[position]!;
    if (heading.type !== 'heading') continue;
    const label = heading.children.length === 1 && heading.children[0]?.type === 'text' ? heading.children[0].value : '';
    const field = headingFields[label as keyof typeof headingFields];
    const start = heading.position?.start.offset, content = heading.position?.end.offset;
    const next = headings[index + 1] ?? nodes.length;
    if (next !== position + 2 || nodes[position + 1]?.type !== 'paragraph') continue;
    const end = nodes[next]?.position?.start.offset ?? markdown.length;
    if (start !== undefined && content !== undefined && optionalNotes.some(key => key === field)
      && markdown.slice(content, end).trim() === noSourceInformation) preview = preview.slice(0, start) + preview.slice(end);
  }
  return preview;
}

export function renderReleaseContributors(contributors: readonly ReleaseContributor[]): string {
  return Mustache.render('{{#hasContributors}}\n## 贡献者\n\n{{#contributors}}<a href="{{profileUrl}}"><img src="{{avatarUrl}}" alt="{{alt}}" width="32" height="32" /></a> {{/contributors}}\n{{/hasContributors}}',
    { hasContributors: contributors.length > 0, contributors });
}

export interface CandidateNoteFormat { template: string; repository: string; sourceSha: string; tag?: string }
export function renderCandidateNote(path:string,markdown:string,contributors:Parameters<typeof renderReleaseContributors>[0], format?: CandidateNoteFormat):string {
  if (format && isConditionalTemplate(format.template)) {
    const url = `https://github.com/${format.repository}/tree/${format.sourceSha}`;
    const notes = parseConditionalNotes(markdown, format.template.includes('{{#acquisition}}'));
    if (format.tag) assertVersionAcquisitionLinks(notes, format.repository, format.tag);
    const body = renderConditionalNotes(format.template, notes, { label: '查看候选源码', url }, contributors);
    if (format.tag) assertSelectedReleaseDownloads(body, format.repository, format.tag);
    return `# ${path}\n\n` + body;
  }
  return `# ${path}\n\n${previewUnitNotes(markdown)}`+renderReleaseContributors(contributors);
}

export function renderCandidateProjection(
  generated: { files: { path: string; content: string | null }[]; baseSha?: string; units?: {id: string; tag: string}[] },
  identity: { noteTemplate?: string; units: { id: string; notesPath?: string; contributors: { contributors: ReleaseContributor[] } }[] },
  repository: string,
): string {
  const notePath = (unit: (typeof identity.units)[number]) => unit.notesPath ?? `.release-notes/${unit.id}.md`;
  const paths = identity.noteTemplate || identity.units.some(unit => unit.notesPath !== undefined)
    ? new Set(identity.units.map(notePath)) : null;
  const notes = generated.files.filter(file => file.content !== null && (paths ? paths.has(file.path) : file.path.startsWith('.release-notes/')));
  if (!notes.length) throw Error('CANDIDATE_PROJECTION_NOTES');
  if (paths && (paths.size !== identity.units.length || notes.length !== paths.size)) throw Error('CANDIDATE_PROJECTION_NOTES');
  return notes.map(file => {
    const unit = identity.units.find(item => notePath(item) === file.path)
      ?? (!paths && identity.units.length === 1 ? identity.units[0] : undefined);
    if (!unit || typeof file.content !== 'string' || !Array.isArray(unit.contributors?.contributors))
      throw Error('CANDIDATE_PROJECTION_UNIT');
    const tag = generated.units?.find(item => item.id === unit.id)?.tag;
    if (identity.noteTemplate && (!tag || !generated.baseSha || !isConditionalTemplate(identity.noteTemplate)))
      throw Error('CANDIDATE_PROJECTION_TEMPLATE');
    return renderCandidateNote(file.path, file.content, unit.contributors.contributors, identity.noteTemplate
      ? {template: identity.noteTemplate, repository, sourceSha: generated.baseSha!, tag: tag!} : undefined);
  }).join('\n').replace(/\r\n?/g, '\n');
}
