import type { Contributor } from './identity.js';

export const summaryStart = '<!-- workflow:auto-summary:start -->';
export const summaryEnd = '<!-- workflow:auto-summary:end -->';
export const coauthorMarker = '<!-- workflow:co-authored-by -->';
export const organizationPullRequestTemplate = `${summaryStart}\n等待SPLRAD Steward根据当前提交和代码差异生成标题与正文。\n${summaryEnd}\n\n### 人工补充\n\n<!-- 只填写自动摘要没有覆盖、但审查者必须知道的内容；没有时保留为空。 -->\n`;

export const conventionalTypes = ['feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export type ConventionalType = typeof conventionalTypes[number];

export interface GeneratedSummary {
  type: ConventionalType;
  scope: string;
  title: string;
  summary: string;
  changes: string[];
  reviewNotes: string[];
}

export interface AutomationFacts {
  sourceRef: string;
  targetRef: string;
  headSha: string;
  baseSha: string;
  commitSubjects: string[];
  files: string[];
  diffStat: string;
  diffExcerpt: string;
  areas: string[];
  contributors: Contributor[];
}

function hanCount(value: string): number {
  return (value.match(/[\p{Script=Han}]/gu) ?? []).length;
}

function requireText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name}必须是字符串`);
  const result = value.trim();
  const count = hanCount(result);
  if (count < minimum || count > maximum || /[\r\n]/u.test(result)) throw new Error(`${name}长度或格式无效`);
  return result;
}

export function validateGeneratedSummary(value: unknown): GeneratedSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Copilot结果必须是对象');
  const object = value as Record<string, unknown>;
  const allowed = new Set(['type', 'scope', 'title', 'summary', 'changes', 'reviewNotes']);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error('Copilot结果包含额外字段');
  if (!conventionalTypes.includes(object.type as ConventionalType)) throw new Error('type无效');
  if (typeof object.scope !== 'string' || !/^[a-z0-9-]{1,20}$/.test(object.scope)) throw new Error('scope无效');
  const title = requireText(object.title, 'title', 1, 50);
  if (/[。.]$/u.test(title) || /^(feat|fix|refactor|perf|style|docs|test|build|ci|chore|revert)(\(|:)/u.test(title)) throw new Error('title格式无效');
  const summary = requireText(object.summary, 'summary', 20, 120);
  if (!Array.isArray(object.changes) || object.changes.length < 1 || object.changes.length > 8) throw new Error('changes无效');
  if (!Array.isArray(object.reviewNotes) || object.reviewNotes.length > 5) throw new Error('reviewNotes无效');
  const changes = object.changes.map((item) => requireText(item, 'changes[]', 10, 100));
  const reviewNotes = object.reviewNotes.map((item) => requireText(item, 'reviewNotes[]', 10, 100));
  return { type: object.type as ConventionalType, scope: object.scope, title, summary, changes, reviewNotes };
}

export function buildDeterministicSummary(facts: AutomationFacts): GeneratedSummary {
  const subjects = facts.commitSubjects.map((item) => item.trim()).filter(Boolean);
  const first = subjects[0] ?? '';
  const match = /^(feat|fix|refactor|perf|style|docs|test|build|ci|chore|revert)(?:\(([a-z0-9-]+)\))?!?:\s*(.+)$/iu.exec(first);
  const type = (match?.[1]?.toLowerCase() as ConventionalType | undefined) ?? (facts.files.every((file) => /^(docs\/|README|SECURITY|CONTRIBUTING)/i.test(file)) ? 'docs' : 'chore');
  const scope = match?.[2] ?? (facts.areas.length === 1 ? facts.areas[0]!.replace(/^area:/, '') : 'repo');
  const candidate = match?.[3]?.trim() ?? '';
  const title = hanCount(candidate) > 0 ? candidate.replace(/[。.]$/u, '').slice(0, 50) : `更新${scope}相关内容`;
  const groups = new Map<string, number>();
  for (const file of facts.files) {
    const group = file.includes('/') ? file.split('/')[0]! : '仓库根目录';
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const changes = [...groups].slice(0, 8).map(([group, count]) => `更新${group}区域中的${count}个文件并保持相关内容一致`);
  return {
    type, scope, title,
    summary: `本次改动更新${facts.areas.length ? facts.areas.join('、') : '仓库'}相关内容，共涉及${facts.files.length}个文件。`,
    changes: changes.length ? changes : ['更新仓库相关内容并保持现有行为一致'],
    reviewNotes: [],
  };
}

export function buildPrompt(facts: AutomationFacts, fallback: GeneratedSummary): string {
  const excerpt = [...facts.diffExcerpt].slice(0, 22_000).join('');
  const truncated = excerpt.length < facts.diffExcerpt.length ? '\n差异已截断，禁止推断未显示内容。' : '';
  return [
    '你是SPLRAD拉取请求编辑器。只返回一个JSON对象，不要代码围栏、解释或额外字段。',
    '字段固定为type、scope、title、summary、changes、reviewNotes。主体使用简体中文。',
    `来源分支：${facts.sourceRef}`, `目标分支：${facts.targetRef}`,
    `最新提交：\n${facts.commitSubjects.slice(0, 20).join('\n')}`,
    `全部文件：\n${facts.files.join('\n')}`, `差异统计：\n${facts.diffStat}`,
    `确定性回退：${JSON.stringify(fallback)}`, `差异：\n${excerpt}${truncated}`,
  ].join('\n\n');
}

export function renderManagedBody(input: { generated: GeneratedSummary; existingBody?: string | null; templateBody: string; actor: string; contributors: Contributor[]; context: string }): string {
  const current = input.existingBody || input.templateBody;
  const start = current.indexOf(summaryStart);
  const end = current.indexOf(summaryEnd);
  if (start < 0 || end < start || current.indexOf(summaryStart, start + 1) >= 0 || current.indexOf(summaryEnd, end + 1) >= 0) throw new Error('拉取请求模板受管标记缺失或重复');
  const sections = [`### 摘要\n\n${input.generated.summary}`, `### 改动内容\n\n${input.generated.changes.map((item) => `- ${item}`).join('\n')}`];
  if (input.generated.reviewNotes.length) sections.push(`### 审查提示\n\n${input.generated.reviewNotes.map((item) => `- ${item}`).join('\n')}`);
  if (input.contributors.length) sections.push(`### 贡献者\n\n${input.contributors.map((item) => `[@${item.login}](https://github.com/${item.login})`).join('、')}`);
  const markers = [`<!-- workflow:source-actor:${input.actor} -->`, `<!-- workflow:source-contributors:${input.contributors.map((item) => item.login).join(',')} -->`, `<!-- workflow:auto-context:${input.context} -->`].join('\n');
  let body = `${current.slice(0, start)}${summaryStart}\n${sections.join('\n\n')}\n\n${markers}\n${summaryEnd}${current.slice(end + summaryEnd.length)}`;
  const coauthors = input.contributors.filter((item) => item.name && item.email).map((item) => `Co-authored-by: ${item.name} <${item.email}>`);
  body = body.replace(new RegExp(`\\n?${coauthorMarker}[\\s\\S]*$`, 'u'), '');
  if (coauthors.length) body += `\n\n${coauthorMarker}\n${coauthors.join('\n')}`;
  return body;
}
