import type { Contributor } from './identity.js';

export const summaryStart = '<!-- workflow:managed-pr:start -->';
export const summaryEnd = '<!-- workflow:managed-pr:end -->';
const legacySummaryStart = '<!-- workflow:auto-summary:start -->';
const legacySummaryEnd = '<!-- workflow:auto-summary:end -->';
export const organizationPullRequestTemplate = `${summaryStart}\n等待SPLRAD Steward根据当前提交和代码差异生成标题与正文。\n${summaryEnd}\n`;

export const conventionalTypes = ['feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export type ConventionalType = typeof conventionalTypes[number];

export const aiClassificationConfidences = ['high', 'medium', 'low'] as const;
export type AiClassificationConfidence = typeof aiClassificationConfidences[number];

export interface AiClassificationSuggestion {
  kind: string;
  confidence: AiClassificationConfidence;
  evidence: string[];
}

export interface GeneratedSummary {
  type: ConventionalType;
  scope: string;
  title: string;
  summary: string;
  motivation: string | null;
  changes: string[];
  impact: string[];
  related: string[];
  releaseAndMigration: string[];
  classification?: AiClassificationSuggestion;
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

function requirePlainText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name}必须是字符串`);
  const result = value.trim();
  const characterCount = [...result].length;
  if (characterCount < minimum || characterCount > maximum || /[\r\n]/u.test(result) || result.includes('<') || result.includes('>')) throw new Error(`${name}长度或格式无效`);
  return result;
}

function requirePlainTextArray(value: unknown, name: string, maximumItems: number, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${name}无效`);
  return value.map((item) => requirePlainText(item, `${name}[]`, minimum, maximum));
}

export function validateAiClassificationSuggestion(
  value: unknown,
  allowedKinds?: readonly string[],
): AiClassificationSuggestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('classification必须是对象');
  const object = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'confidence', 'evidence']);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error('classification包含额外字段');
  if (typeof object.kind !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/u.test(object.kind)) throw new Error('classification.kind无效');
  if (allowedKinds && !allowedKinds.includes(object.kind)) throw new Error('classification.kind不属于当前分类配置');
  if (!aiClassificationConfidences.includes(object.confidence as AiClassificationConfidence)) throw new Error('classification.confidence无效');
  if (!Array.isArray(object.evidence) || object.evidence.length < 1 || object.evidence.length > 3) throw new Error('classification.evidence无效');
  const evidence = object.evidence.map((item) => {
    const text = requirePlainText(item, 'classification.evidence[]', 4, 180);
    if (/[<>\[\]`]/u.test(text)) throw new Error('classification.evidence[]必须是无标记纯文本');
    return text;
  });
  return {
    kind: object.kind,
    confidence: object.confidence as AiClassificationConfidence,
    evidence,
  };
}

export function validateGeneratedSummary(value: unknown): GeneratedSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Copilot结果必须是对象');
  const object = value as Record<string, unknown>;
  const allowed = new Set(['type', 'scope', 'title', 'summary', 'motivation', 'changes', 'impact', 'related', 'releaseAndMigration', 'classification']);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error('Copilot结果包含额外字段');
  if (!conventionalTypes.includes(object.type as ConventionalType)) throw new Error('type无效');
  if (typeof object.scope !== 'string' || !/^[a-z0-9-]{1,20}$/.test(object.scope)) throw new Error('scope无效');
  const title = requirePlainText(object.title, 'title', 1, 100);
  if (/[。.]$/u.test(title) || /^(feat|fix|refactor|perf|style|docs|test|build|ci|chore|revert)(\(|:)/u.test(title)) throw new Error('title格式无效');
  const summary = requirePlainText(object.summary, 'summary', 20, 240);
  const motivation = object.motivation === null ? null : requirePlainText(object.motivation, 'motivation', 10, 400);
  if (!Array.isArray(object.changes) || object.changes.length < 1 || object.changes.length > 8) throw new Error('changes无效');
  const changes = object.changes.map((item) => requirePlainText(item, 'changes[]', 10, 200));
  const impact = requirePlainTextArray(object.impact, 'impact', 6, 5, 240);
  if (!Array.isArray(object.related) || object.related.length > 6) throw new Error('related无效');
  const related = object.related.map((item) => requirePlainText(item, 'related[]', 2, 200));
  const releaseAndMigration = requirePlainTextArray(object.releaseAndMigration, 'releaseAndMigration', 6, 5, 240);
  const classification = object.classification === undefined || object.classification === null
    ? undefined
    : validateAiClassificationSuggestion(object.classification);
  return {
    type: object.type as ConventionalType,
    scope: object.scope,
    title,
    summary,
    motivation,
    changes,
    impact,
    related,
    releaseAndMigration,
    ...(classification ? { classification } : {}),
  };
}

function parseConventionalSubject(subject: string): { type: ConventionalType; scope?: string; title: string } | null {
  const separator = subject.indexOf(':');
  if (separator <= 0) return null;
  let prefix = subject.slice(0, separator);
  const title = subject.slice(separator + 1).trim();
  if (!title) return null;
  if (prefix.endsWith('!')) prefix = prefix.slice(0, -1);
  let typeText = prefix;
  let scope: string | undefined;
  const scopeStart = prefix.indexOf('(');
  if (scopeStart >= 0) {
    if (!prefix.endsWith(')') || prefix.indexOf(')', scopeStart) !== prefix.length - 1) return null;
    typeText = prefix.slice(0, scopeStart);
    scope = prefix.slice(scopeStart + 1, -1);
    if (!/^[a-z0-9-]+$/iu.test(scope)) return null;
  }
  const type = typeText.toLowerCase() as ConventionalType;
  if (!conventionalTypes.includes(type)) return null;
  return { type, ...(scope ? { scope } : {}), title };
}

function normalizeScope(value: string): string {
  let normalized = '';
  let separatorPending = false;
  for (const character of value.toLowerCase()) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (isLetter || isDigit) {
      if (separatorPending && normalized.length + 1 < 20) normalized += '-';
      if (normalized.length < 20) normalized += character;
      separatorPending = false;
    } else if (normalized) {
      separatorPending = true;
    }
    if (normalized.length >= 20) break;
  }
  return normalized || 'repo';
}

export function buildDeterministicSummary(facts: AutomationFacts): GeneratedSummary {
  const subjects = facts.commitSubjects.map((item) => item.trim()).filter(Boolean);
  const first = subjects[0] ?? '';
  const parsed = parseConventionalSubject(first);
  const type = parsed?.type ?? (facts.files.every((file) => /^(docs\/|README|SECURITY|CONTRIBUTING)/i.test(file)) ? 'docs' : 'chore');
  const scope = normalizeScope(parsed?.scope ?? (facts.areas.length === 1 ? facts.areas[0]!.replace(/^area:/, '') : 'repo'));
  const candidate = parsed?.title ?? '';
  const title = candidate ? [...candidate.replace(/[。.]$/u, '')].slice(0, 100).join('') : `更新${scope}相关内容`;
  const groups = new Map<string, number>();
  for (const file of facts.files) {
    const group = file.includes('/') ? file.split('/')[0]! : '仓库根目录';
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const changes = [...groups].slice(0, 8).map(([group, count]) => `更新${group}区域中的${count}个文件并保持相关内容一致`);
  return {
    type, scope, title,
    summary: `本次改动更新${facts.areas.length ? facts.areas.join('、') : '仓库'}相关内容，共涉及${facts.files.length}个文件。`,
    motivation: null,
    changes: changes.length ? changes : ['更新仓库相关内容并保持现有行为一致'],
    impact: [],
    related: [],
    releaseAndMigration: [],
  };
}

export function buildPrompt(
  facts: AutomationFacts,
  fallback: GeneratedSummary,
  classificationKinds: readonly string[],
): string {
  const excerpt = [...facts.diffExcerpt].slice(0, 22_000).join('');
  const truncated = excerpt.length < facts.diffExcerpt.length ? '\n差异已截断，禁止推断未显示内容。' : '';
  return [
    '你是SPLRAD拉取请求编辑器。只返回一个JSON对象，不要代码围栏、解释或额外字段。',
    '字段固定为type、scope、title、summary、motivation、changes、impact、related、releaseAndMigration、classification。',
    '标题和正文以简体中文为主；技术术语、代码标识和平台固定字段保留原文，其他内容可按表达需要使用英文。正文写给提交者和维护者，表达自然、简洁、具体，直接说明改了什么、为什么改和会影响什么，不写宣传、评价、聊天式开场或空泛总结。',
    '描述推送来源时，根据上下文写“推送分支后”“提交者推送后”或“首次创建拉取请求时”；除非当前差异必须区分用户与机器人，不使用“人类推送”“真人推送”“普通人类”等内部分类称呼。',
    '避免机械套话和公式结构：少用“此外”“旨在”“确保”“显著”“关键”等泛化词，不使用“不仅……而且……”和为了凑数的三项并列，也不要把多个动作与代码标识符挤进一个长句。',
    '自然不等于口语化；不得加入第一人称、情绪、幽默、主观评价或差异没有提供的事实。',
    'type只能使用feat、fix、refactor、perf、style、docs、test、build、ci、chore、revert；scope只能使用1至20个小写字母、数字或连字符。',
    'title使用1至100个字符简洁说明主要改动，不含类型前缀、编号、换行或句号；summary使用20至240个字符陈述实际改动。',
    'changes包含1至8项，每项10至200个字符；motivation仅在本次提交信息或差异中存在明确的问题、需求或决策依据时使用10至400个字符，否则为null。',
    'impact和releaseAndMigration各为0至6项，每项5至240个字符；related为0至6项，每项2至200个字符。',
    'summary、motivation和changes必须基于本次提交信息和差异事实填写。motivation只说明为什么需要本次修改，不得重复summary或changes；本次提交信息或差异中没有明确问题、需求或决策依据时必须为null。',
    'impact、related、releaseAndMigration没有对应事实时必须返回空数组，不得用“无”“不适用”“未涉及”等占位。',
    `classification是只读影子建议，不直接写入标签；无法基于已显示差异给出建议时必须为null，不为null时kind只能使用${classificationKinds.join('、')}，confidence只能使用high、medium或low，evidence必须包含1至3项基于已显示差异的无Markdown纯文本依据，每项4至180个字符并尽量写明文件路径。`,
    '不得生成验证情况、审查重点、界面与输出变化或人工补充内容。',
    `来源分支：${facts.sourceRef}`, `目标分支：${facts.targetRef}`,
    `最新提交：\n${facts.commitSubjects.slice(0, 20).join('\n')}`,
    `全部文件：\n${facts.files.join('\n')}`, `差异统计：\n${facts.diffStat}`,
    `确定性回退：${JSON.stringify(fallback)}`, `差异：\n${excerpt}${truncated}`,
  ].join('\n\n');
}

function hasUniqueManagedRegion(value: string, startMarker: string, endMarker: string): boolean {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker);
  return start >= 0
    && end > start
    && value.indexOf(startMarker, start + startMarker.length) < 0
    && value.indexOf(endMarker, end + endMarker.length) < 0;
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

export function escapeMarkdownText(value: string, preserveHash = false): string {
  const normalized = value.replace(/[\r\n]+/gu, ' ');
  const markdownControl = preserveHash ? /([\\`*_~\[\]{}()+.!|-])/gu : /([\\`*_~\[\]{}()#+.!|-])/gu;
  return escapeHtml(normalized.replace(markdownControl, '\\$1'));
}

function contributorAvatarUrl(contributor: Contributor): string {
  if (contributor.avatarUrl) {
    try {
      const candidate = new URL(contributor.avatarUrl);
      if (candidate.protocol === 'https:' && ['avatars.githubusercontent.com', 'github.com'].includes(candidate.hostname)) return candidate.href;
    } catch { /* use the GitHub profile avatar fallback */ }
  }
  return `https://github.com/${encodeURIComponent(contributor.login)}.png?size=48`;
}

function renderContributors(contributors: Contributor[]): string {
  const avatars = contributors.map((item, index) => {
    const profile = `https://github.com/${encodeURIComponent(item.login)}`;
    return `<a href="${profile}" aria-label="查看第${index + 1}位贡献者的GitHub资料"><img src="${escapeHtml(contributorAvatarUrl(item))}" alt="" width="48" height="48"></a>`;
  }).join(' ');
  const details = contributors.map((item) => {
    const login = escapeHtml(item.login);
    const profile = `https://github.com/${encodeURIComponent(item.login)}`;
    return `<li><a href="${profile}">@${login}</a></li>`;
  }).join('\n');
  return `## 贡献者\n\n${avatars}\n\n<details>\n<summary>查看贡献者信息</summary>\n\n<ul>\n${details}\n</ul>\n</details>`;
}

export function renderManagedBody(input: { generated: GeneratedSummary; existingBody?: string | null; templateBody: string; actor: string; contributors: Contributor[]; context: string }): string {
  const current = input.existingBody || input.templateBody;
  const validCurrentRegion = hasUniqueManagedRegion(current, summaryStart, summaryEnd);
  const validLegacyRegion = hasUniqueManagedRegion(current, legacySummaryStart, legacySummaryEnd);
  const hasCurrentMarker = current.includes(summaryStart) || current.includes(summaryEnd);
  const hasLegacyMarker = current.includes(legacySummaryStart) || current.includes(legacySummaryEnd);
  if ((hasCurrentMarker && hasLegacyMarker) || (hasCurrentMarker && !validCurrentRegion) || (hasLegacyMarker && !validLegacyRegion) || (!hasCurrentMarker && !hasLegacyMarker)) {
    throw new Error('拉取请求模板受管标记缺失、重复或交叉');
  }
  const sections = [`## 摘要\n\n${escapeMarkdownText(input.generated.summary)}`];
  if (input.generated.motivation) sections.push(`## 变更原因\n\n${escapeMarkdownText(input.generated.motivation)}`);
  sections.push(`## 主要改动\n\n${input.generated.changes.map((item) => `- ${escapeMarkdownText(item)}`).join('\n')}`);
  if (input.generated.impact.length) sections.push(`## 影响分析\n\n${input.generated.impact.map((item) => `- ${escapeMarkdownText(item)}`).join('\n')}`);
  if (input.generated.related.length) sections.push(`## 关联事项\n\n${input.generated.related.map((item) => `- ${escapeMarkdownText(item, true)}`).join('\n')}`);
  if (input.generated.releaseAndMigration.length) sections.push(`## 发布与迁移\n\n${input.generated.releaseAndMigration.map((item) => `- ${escapeMarkdownText(item)}`).join('\n')}`);
  if (input.contributors.length) sections.push(renderContributors(input.contributors));
  const markers = [`<!-- workflow:source-actor:${input.actor} -->`, `<!-- workflow:source-contributors:${input.contributors.map((item) => item.login).join(',')} -->`, `<!-- workflow:auto-context:${input.context} -->`].join('\n');
  return `${summaryStart}\n${sections.join('\n\n')}\n\n${markers}\n${summaryEnd}\n`;
}
