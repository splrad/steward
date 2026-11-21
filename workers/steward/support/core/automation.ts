import type { Contributor } from './identity.js';
import { contributorBlockAnchor, extractIssueLinksBlock } from './issues.js';


export const summaryStart = '<!-- workflow:managed-pr:start -->';
export const summaryEnd = '<!-- workflow:managed-pr:end -->';
const legacySummaryStart = '<!-- workflow:auto-summary:start -->';
const legacySummaryEnd = '<!-- workflow:auto-summary:end -->';
export const organizationPullRequestTemplate = `${summaryStart}\nSPLRAD Steward 专用接管与指令同步变更。\n${summaryEnd}\n`;

export const conventionalTypes = ['feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export type ConventionalType = typeof conventionalTypes[number];


export interface GeneratedSummary {
  type: ConventionalType;
  scope: string;
  title: string;
  summary: string;
  motivation: string | null;
  changes: string[];
  impact: string[];
  releaseAndMigration: string[];
}

function hasUniqueManagedRegion(value: string, startMarker: string, endMarker: string): boolean {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker);
  return start >= 0
    && end > start
    && value.indexOf(startMarker, start + startMarker.length) < 0
    && value.indexOf(endMarker, end + endMarker.length) < 0;
}

export interface ManagedPullRequestRegion {
  start: number;
  end: number;
  block: string;
}

export function extractManagedPullRequestBlock(body: string): ManagedPullRequestRegion {
  const current = hasUniqueManagedRegion(body, summaryStart, summaryEnd);
  const legacy = hasUniqueManagedRegion(body, legacySummaryStart, legacySummaryEnd);
  const hasCurrent = body.includes(summaryStart) || body.includes(summaryEnd);
  const hasLegacy = body.includes(legacySummaryStart) || body.includes(legacySummaryEnd);
  if ((hasCurrent && hasLegacy) || (hasCurrent && !current) || (hasLegacy && !legacy) || (!hasCurrent && !hasLegacy)) {
    throw new Error('拉取请求模板受管标记缺失、重复或交叉');
  }
  const startMarker = current ? summaryStart : legacySummaryStart;
  const endMarker = current ? summaryEnd : legacySummaryEnd;
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker, start) + endMarker.length;
  if (start < 0 || end <= start) throw new Error('拉取请求模板受管标记缺失、重复或交叉');
  return { start, end, block: body.slice(start, end) };
}

export function replaceManagedPullRequestBlock(body: string, block: string): string {
  const current = extractManagedPullRequestBlock(body);
  const replacement = extractManagedPullRequestBlock(block);
  if (replacement.start !== 0 || replacement.end !== block.length || !block.startsWith(summaryStart) || !block.endsWith(summaryEnd)) {
    throw new Error('替换拉取请求受管块无效');
  }
  return `${body.slice(0, current.start)}${block}${body.slice(current.end)}`;
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
  const profiles = contributors.map((item) => {
    const profile = `https://github.com/${encodeURIComponent(item.login)}`;
    return `<a href="${profile}">@${escapeHtml(item.login)}</a>`;
  }).join(' · ');
  if (contributors.length === 1) return `贡献者：${profiles}`;
  const avatars = contributors.map((item, index) => {
    const profile = `https://github.com/${encodeURIComponent(item.login)}`;
    return `<a href="${profile}" aria-label="查看第${index + 1}位贡献者的GitHub资料"><img src="${escapeHtml(contributorAvatarUrl(item))}" alt="" width="48" height="48"></a>`;
  }).join(' ');
  return `## 贡献者\n\n${avatars}\n\n${profiles}`;
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
  const issueLinks = extractIssueLinksBlock(current);
  if (issueLinks) {
    const outerStart = current.indexOf(hasCurrentMarker ? summaryStart : legacySummaryStart);
    const outerEnd = current.indexOf(hasCurrentMarker ? summaryEnd : legacySummaryEnd, outerStart);
    if (issueLinks.start <= outerStart || issueLinks.end > outerEnd) throw new Error('议题子块不在唯一外层受管区域内');
  }
  const sections = [`## 摘要\n\n${escapeMarkdownText(input.generated.summary)}`];
  if (input.generated.motivation) sections.push(`## 变更原因\n\n${escapeMarkdownText(input.generated.motivation)}`);
  sections.push(`## 主要改动\n\n${input.generated.changes.map((item) => `- ${escapeMarkdownText(item)}`).join('\n')}`);
  if (input.generated.impact.length) sections.push(`## 影响分析\n\n${input.generated.impact.map((item) => `- ${escapeMarkdownText(item)}`).join('\n')}`);
  if (issueLinks) sections.push(issueLinks.block);
  if (input.generated.releaseAndMigration.length) sections.push(`## 发布与迁移\n\n${input.generated.releaseAndMigration.map((item) => `- ${escapeMarkdownText(item)}`).join('\n')}`);
  if (input.contributors.length) sections.push(`${contributorBlockAnchor}\n\n${renderContributors(input.contributors)}`);
  const markers = [`<!-- workflow:source-actor:${input.actor} -->`, `<!-- workflow:source-contributors:${input.contributors.map((item) => item.login).join(',')} -->`, `<!-- workflow:auto-context:${input.context} -->`].join('\n');
  return `${summaryStart}\n${sections.join('\n\n')}\n\n${markers}\n${summaryEnd}\n`;
}
