import {
  formatMentions,
  isBotLogin,
  normalizeGitHubLogin,
  uniqueHumanLogins,
} from './identity.js';

export const automationSummaryStartMarker = '<!-- workflow:auto-summary:start -->';
export const automationSummaryEndMarker = '<!-- workflow:auto-summary:end -->';
export const automationCreatedNoticeMarker = '<!-- workflow:pr-created-notice -->';

export interface AutomationCommitInput {
  sha?: string | undefined;
  message?: string | undefined;
  authorLogin?: string | undefined;
  authorName?: string | undefined;
  authorEmail?: string | undefined;
}

export interface AutomationFileInput {
  filename?: string | undefined;
  status?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface PullRequestAutomationInput {
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  actor: string;
  compareStatus: string;
  aheadBy: number;
  totalCommits: number;
  commits: readonly AutomationCommitInput[];
  files: readonly AutomationFileInput[];
  existingBody?: string | null | undefined;
  templateBody?: string | null | undefined;
  maintainers?: readonly unknown[] | undefined;
  botLogins?: readonly unknown[] | undefined;
}

export interface PullRequestAutomationIgnored {
  state: 'ignored';
  reason: 'default-branch' | 'bot-actor' | 'no-ahead-commits';
}

export interface PullRequestAutomationPlan {
  state: 'planned';
  title: string;
  body: string;
  noticeBody: string;
  contributors: string[];
  changedFiles: number;
  commits: number;
}

export type PullRequestAutomationEvaluation = PullRequestAutomationIgnored | PullRequestAutomationPlan;

function boundedLine(value: unknown, limit: number): string {
  const line = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, Math.max(0, limit - 1))}…`;
}

function safeMarkdownText(value: unknown, limit = 180): string {
  return boundedLine(value, limit)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_\[\]])/g, '\\$1')
    .replace(/@/g, '@\u200b');
}

function safeCodeText(value: unknown, limit = 240): string {
  return boundedLine(value, limit).replace(/`/g, "'").replace(/@/g, '@\u200b');
}

function htmlCommentValue(value: unknown): string {
  return boundedLine(value, 240).replace(/--/g, '- -').replace(/>/g, '&gt;');
}

function validCount(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Automation requires a valid ${label}`);
  return number;
}

function conventionalTitle(commits: readonly AutomationCommitInput[]): string {
  const subject = boundedLine(commits.at(-1)?.message?.split(/\r?\n/, 1)[0], 100);
  return !/[@<>]/.test(subject) && /^(feat|fix|refactor|perf|style|docs|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?:\s*\S.{0,80}$/u
    .test(subject) ? subject : '';
}

function fallbackTitle(files: readonly { filename: string }[]): string {
  const paths = files.map((file) => file.filename.toLowerCase());
  if (paths.every((path) => path.startsWith('docs/') || /(^|\/)readme(?:\.|$)/i.test(path))) {
    return 'docs: 更新项目文档';
  }
  if (paths.every((path) => /(^|\/)(tests?|__tests__)(\/|$)/i.test(path) || /\.(test|spec)\.[^.]+$/i.test(path))) {
    return 'test: 更新测试覆盖';
  }
  if (paths.every((path) => path.startsWith('.github/'))) return 'ci: 更新仓库自动化';
  if (paths.every((path) => /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|.*\.(?:csproj|slnx?|props|targets))$/i.test(path))) {
    return 'build: 更新构建配置';
  }
  return `chore: 更新 ${files.length} 个文件`;
}

function statusLabel(status: string): string {
  if (status === 'added') return '新增';
  if (status === 'removed') return '删除';
  if (status === 'renamed') return '重命名';
  return '更新';
}

function sanitizedTrailer(commit: AutomationCommitInput, botLogins: readonly unknown[]): string {
  if (commit.authorLogin && isBotLogin(commit.authorLogin, botLogins)) return '';
  const name = boundedLine(commit.authorName, 120).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const email = String(commit.authorEmail ?? '').trim();
  if (!name || /\[bot\]/i.test(name) || !/^[^<>\s@]+@[^<>\s@]+$/.test(email)
    || /\[bot\]@users\.noreply\.github\.com$/i.test(email)) return '';
  return `Co-authored-by: ${name} <${email}>`;
}

function stripManagedCoAuthors(body: string): string {
  return body.replace(/\n*\s*<!-- workflow:co-authored-by -->[\s\S]*$/i, '').trimEnd();
}

function stripEditableIdentityMetadata(body: string): string {
  return body.replace(/<!--\s*workflow:(?:source-actor|source-contributors|auto-context):[^>]*-->/gi, '');
}

function appendManagedCoAuthors(body: string, commits: readonly AutomationCommitInput[], botLogins: readonly unknown[]): string {
  const seen = new Set<string>();
  const trailers: string[] = [];
  for (const commit of commits) {
    const trailer = sanitizedTrailer(commit, botLogins);
    const key = String(commit.authorEmail ?? '').trim().toLowerCase();
    if (!trailer || !key || seen.has(key)) continue;
    seen.add(key);
    trailers.push(trailer);
  }
  if (!trailers.length) return body;
  return [
    body.trimEnd(),
    '',
    '<!-- workflow:co-authored-by -->',
    '<details>',
    '<summary>Co-authored-by</summary>',
    '',
    ...trailers,
    '',
    '</details>',
    '',
  ].join('\n');
}

function replaceOrAppendSummary(body: string, autoBlock: string): string {
  const markerPattern = /<!-- workflow:auto-summary:start -->[\s\S]*?<!-- workflow:auto-summary:end -->/;
  if (markerPattern.test(body)) return body.replace(markerPattern, autoBlock);
  if (!body.trim()) return `${autoBlock}\n`;
  return `${body.trim()}\n\n---\n\n${autoBlock}\n`;
}

export function evaluatePullRequestAutomation(input: PullRequestAutomationInput): PullRequestAutomationEvaluation {
  const sourceBranch = boundedLine(input.sourceBranch, 240);
  const targetBranch = boundedLine(input.targetBranch, 240);
  const headSha = String(input.headSha ?? '').trim().toLowerCase();
  const botLogins = input.botLogins ?? [];
  const actor = normalizeGitHubLogin(input.actor);
  if (!sourceBranch || !targetBranch || sourceBranch === targetBranch) return { state: 'ignored', reason: 'default-branch' };
  if (!actor || isBotLogin(actor, botLogins)) return { state: 'ignored', reason: 'bot-actor' };
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('Automation requires a valid head SHA');

  const aheadBy = validCount(input.aheadBy, 'ahead commit count');
  const totalCommits = validCount(input.totalCommits, 'total commit count');
  if (aheadBy === 0) return { state: 'ignored', reason: 'no-ahead-commits' };
  if (!['ahead', 'diverged'].includes(input.compareStatus) || totalCommits !== aheadBy
    || input.commits.length !== totalCommits || totalCommits > 100) {
    throw new Error('Automation compare commit evidence is incomplete or inconsistent');
  }
  if (String(input.commits.at(-1)?.sha ?? '').toLowerCase() !== headSha) {
    throw new Error('Automation compare evidence does not end at the trusted head SHA');
  }
  if (!input.files.length || input.files.length >= 300) {
    throw new Error('Automation compare file evidence is empty or may be truncated');
  }
  const files = input.files.map((file) => {
    const filename = boundedLine(file.filename, 500);
    if (!filename) throw new Error('Automation compare returned a file without a path');
    return {
      filename,
      status: boundedLine(file.status, 40).toLowerCase(),
      additions: validCount(file.additions ?? 0, 'file additions'),
      deletions: validCount(file.deletions ?? 0, 'file deletions'),
    };
  });

  const contributors = uniqueHumanLogins([
    actor,
    ...input.commits.map((commit) => commit.authorLogin),
  ], { botLogins });
  const title = conventionalTitle(input.commits) || fallbackTitle(files);
  const latestSubject = boundedLine(input.commits.at(-1)?.message?.split(/\r?\n/, 1)[0], 160);
  const summary = latestSubject
    ? `${safeMarkdownText(latestSubject)}，共涉及 ${files.length} 个文件。`
    : `当前分支共有 ${totalCommits} 个提交，涉及 ${files.length} 个文件。`;
  const shownFiles = files.slice(0, 20).map((file) => (
    `- ${statusLabel(file.status)} \`${safeCodeText(file.filename, 500)}\`（+${file.additions}/-${file.deletions}）`
  ));
  if (files.length > shownFiles.length) shownFiles.push(`- 另有 ${files.length - shownFiles.length} 个文件未在摘要中展开。`);
  const autoBlock = [
    automationSummaryStartMarker,
    `<!-- workflow:source-actor:${actor} -->`,
    `<!-- workflow:source-contributors:${contributors.join(',')} -->`,
    `<!-- workflow:auto-context:source=${htmlCommentValue(sourceBranch)};target=${htmlCommentValue(targetBranch)};generation=deterministic-api;changed-files=${files.length} -->`,
    '### 摘要',
    '',
    summary,
    '',
    '### 改动内容',
    ...shownFiles,
    '',
    automationSummaryEndMarker,
  ].join('\n');
  const startingBody = stripEditableIdentityMetadata(stripManagedCoAuthors(String(input.existingBody ?? '').trim()
    || stripManagedCoAuthors(String(input.templateBody ?? ''))));
  const body = appendManagedCoAuthors(replaceOrAppendSummary(startingBody, autoBlock), input.commits, botLogins);
  if (body.length > 60_000) throw new Error('Automation pull request body exceeds the supported size');

  const authorMention = formatMentions([actor], { botLogins, emptyText: actor });
  const recipients = formatMentions([...(input.maintainers ?? []), actor], {
    botLogins,
    emptyText: '核心维护者',
  });
  const noticeBody = [
    automationCreatedNoticeMarker,
    '## PR 创建成功',
    '',
    '- PR 链接：__PR_NUMBER__',
    `- 标题：${safeMarkdownText(title, 240)}`,
    `- 分支流向：${safeMarkdownText(sourceBranch, 240)} -> ${safeMarkdownText(targetBranch, 240)}`,
    `- 提交人：${authorMention}`,
    '- 摘要生成：确定性 GitHub API 证据',
    `- 通知对象：${recipients}`,
    '',
    '> 本通知由 SPLRAD Steward 自动维护。',
  ].join('\n');

  return {
    state: 'planned',
    title,
    body,
    noticeBody,
    contributors,
    changedFiles: files.length,
    commits: totalCommits,
  };
}
