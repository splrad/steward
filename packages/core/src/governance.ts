import { normalizeGitHubLogin, uniqueHumanLogins } from './identity.js';

export type GovernanceState = 'passed' | 'pending' | 'failed' | 'ignored';

export type MainAuthorizationStatus =
  | 'passed_manual_core_approval_for_unidentified_authors'
  | 'failed_unidentified_commit_authors'
  | 'failed_missing_real_contributors'
  | 'passed_manual_core_approval'
  | 'failed_untrusted_contributor_missing_manual_approval'
  | 'passed_all_contributors_trusted_with_approval'
  | 'failed_trusted_contributors_missing_approval';

export interface MainAuthorizationInput {
  contributors: readonly unknown[];
  unidentifiedAuthors: readonly unknown[];
  trustedDevelopers: readonly unknown[];
  trustedApprovers: readonly unknown[];
  trustedManualApprovers: readonly unknown[];
  botLogins?: readonly unknown[];
}

export interface MainAuthorizationDecision {
  state: 'passed' | 'failed';
  status: MainAuthorizationStatus;
  contributors: string[];
  unidentifiedAuthors: string[];
  untrustedContributors: string[];
  trustedApprovers: string[];
  trustedManualApprovers: string[];
  needsReviewRequest: boolean;
}

export interface ReviewRequestPlan {
  eligible: string[];
  reviewed: string[];
  missing: string[];
}

export interface GovernanceFailureModel {
  source: string;
  presentation:
    | 'main.unidentified-authors'
    | 'main.missing-contributors'
    | 'main.approval-required'
    | 'copilot.blocking-comments'
    | 'copilot.comment-protocol'
    | 'copilot.request-failed'
    | 'copilot.passing-conclusion';
  handlers: string[];
  items: string[];
  reviewRequestState?: 'confirmed' | 'failed' | 'not-requested';
}

function normalizedLoginSet(values: readonly unknown[]): Set<string> {
  return new Set(values.map((value) => normalizeGitHubLogin(value).toLowerCase()).filter(Boolean));
}

export function evaluateMainAuthorization(input: MainAuthorizationInput): MainAuthorizationDecision {
  const botLogins = input.botLogins ?? [];
  const contributors = uniqueHumanLogins(input.contributors, { botLogins });
  const trusted = normalizedLoginSet(input.trustedDevelopers);
  const trustedApprovers = uniqueHumanLogins(input.trustedApprovers, { botLogins })
    .filter((login) => trusted.has(login.toLowerCase()));
  const trustedManualApprovers = uniqueHumanLogins(input.trustedManualApprovers, { botLogins })
    .filter((login) => trusted.has(login.toLowerCase()));
  const unidentifiedAuthors = input.unidentifiedAuthors.map((author) => String(author ?? '').trim()).filter(Boolean);
  const untrustedContributors = contributors.filter((login) => !trusted.has(login.toLowerCase()));

  let status: MainAuthorizationStatus;
  let state: 'passed' | 'failed';
  if (unidentifiedAuthors.length > 0) {
    if (trustedManualApprovers.length > 0) {
      status = 'passed_manual_core_approval_for_unidentified_authors';
      state = 'passed';
    } else {
      status = 'failed_unidentified_commit_authors';
      state = 'failed';
    }
  } else if (contributors.length === 0) {
    status = 'failed_missing_real_contributors';
    state = 'failed';
  } else if (untrustedContributors.length > 0) {
    if (trustedManualApprovers.length > 0) {
      status = 'passed_manual_core_approval';
      state = 'passed';
    } else {
      status = 'failed_untrusted_contributor_missing_manual_approval';
      state = 'failed';
    }
  } else if (trustedApprovers.length > 0) {
    status = 'passed_all_contributors_trusted_with_approval';
    state = 'passed';
  } else {
    status = 'failed_trusted_contributors_missing_approval';
    state = 'failed';
  }

  return {
    state,
    status,
    contributors,
    unidentifiedAuthors,
    untrustedContributors,
    trustedApprovers,
    trustedManualApprovers,
    needsReviewRequest: [
      'failed_unidentified_commit_authors',
      'failed_untrusted_contributor_missing_manual_approval',
      'failed_trusted_contributors_missing_approval',
    ].includes(status),
  };
}

export function coreReviewersToRequest(input: {
  trusted: readonly unknown[];
  author: unknown;
  requested: readonly unknown[];
  reviewed?: readonly unknown[];
  botLogins?: readonly unknown[];
}): ReviewRequestPlan {
  const botLogins = input.botLogins ?? [];
  const author = normalizeGitHubLogin(input.author).toLowerCase();
  const eligible = uniqueHumanLogins(input.trusted, { botLogins })
    .filter((login) => login.toLowerCase() !== author);
  const requested = normalizedLoginSet(input.requested);
  const reviewedSet = normalizedLoginSet(input.reviewed ?? []);
  const reviewed = uniqueHumanLogins(input.reviewed ?? [], { botLogins })
    .filter((login) => eligible.some((candidate) => candidate.toLowerCase() === login.toLowerCase()));
  return {
    eligible,
    reviewed,
    missing: eligible.filter((login) => !requested.has(login.toLowerCase()) && !reviewedSet.has(login.toLowerCase())),
  };
}

export function mainAuthorizationFailureModel(input: {
  decision: MainAuthorizationDecision;
  coreHandlers: readonly unknown[];
  reviewRequest?: { ok: boolean; eligible?: readonly unknown[] } | null;
  botLogins?: readonly unknown[];
}): GovernanceFailureModel | null {
  if (input.decision.state !== 'failed') return null;
  const botLogins = input.botLogins ?? [];
  const coreHandlers = uniqueHumanLogins(input.coreHandlers, { botLogins });
  const eligible = uniqueHumanLogins(input.reviewRequest?.eligible ?? [], { botLogins });
  const handlers = eligible.length ? eligible : coreHandlers;
  const reviewRequestState = input.reviewRequest
    ? input.reviewRequest.ok ? 'confirmed' : 'failed'
    : 'not-requested';
  const presentation = input.decision.status === 'failed_unidentified_commit_authors'
    ? 'main.unidentified-authors'
    : input.decision.status === 'failed_missing_real_contributors'
      ? 'main.missing-contributors'
      : 'main.approval-required';
  return {
    source: 'main-authorization',
    presentation,
    handlers,
    items: presentation === 'main.unidentified-authors' ? input.decision.unidentifiedAuthors : [],
    reviewRequestState,
  };
}

const copilotNoBlockingConclusionPattern = /(?:^|\r?\n)\s*(?:\x23{1,6}\s*)?结论\s*(?::|：)?\s*(?:\r?\n\s*)*未发现需要阻断合并的问题。/;
const copilotNoCommentsPattern = /Copilot reviewed \d+ out of \d+ changed files in this pull request and generated no (?:new )?comments\./i;
const copilotGeneratedCommentsPattern = /Copilot reviewed \d+ out of \d+ changed files in this pull request and generated (\d+) (?:new )?comments\./i;
const copilotBlockingSeverityPattern = /^\s*(severity\s*[:：]\s*blocking|严重程度\s*[:：]\s*阻断)(?:\s|$)/i;
const copilotSuggestionSeverityPattern = /^\s*(severity\s*[:：]\s*suggestion|严重程度\s*[:：]\s*建议)(?:\s|$)/i;
const copilotTitlePattern = /^\s*(?:\x23{1,6}\s*)?(?:标题|title)\s*[:：]\s*(.+?)\s*$/i;

export interface CopilotFinding {
  title: string;
  url: string;
}

export interface CopilotFindings {
  blocking: CopilotFinding[];
  suggestions: CopilotFinding[];
  unclassified: CopilotFinding[];
}

export interface CopilotThreadComment {
  body?: unknown;
  url?: unknown;
  author?: { login?: unknown } | null;
  pullRequestReview?: { author?: { login?: unknown } | null } | null;
}

export interface CopilotGateDecision extends CopilotFindings {
  state: 'passed' | 'pending' | 'failed';
  checkStatus: 'completed' | 'in_progress';
  checkConclusion?: 'success' | 'failure';
  failureKind: '' | 'request-failed' | 'blocking-comments' | 'comment-protocol' | 'passing-conclusion';
  passingSignal: '' | 'suggestion-only-comments' | 'no-current-comments-with-known-conclusion';
  passingConclusionSource: '' | 'fixed-conclusion' | 'no-new-comments' | 'resolved-review-comments';
}

function normalizeReviewAuthor(login: unknown): string {
  const raw = String(login ?? '').trim().replace(/^@+/, '').toLowerCase();
  return normalizeGitHubLogin(raw.replace(/\[bot\]$/, '')).toLowerCase();
}

function isCopilotComment(comment: {
  author?: { login?: unknown } | null;
  pullRequestReview?: { author?: { login?: unknown } | null } | null;
}): boolean {
  const reviewAuthor = normalizeReviewAuthor(comment.pullRequestReview?.author?.login);
  if (reviewAuthor) return reviewAuthor === 'copilot-pull-request-reviewer';
  return normalizeReviewAuthor(comment.author?.login) === 'copilot-pull-request-reviewer';
}

export function copilotCommentSeverity(body: unknown): '' | 'blocking' | 'suggestion' {
  const firstLine = String(body ?? '').split(/\r?\n/, 1)[0] ?? '';
  if (copilotBlockingSeverityPattern.test(firstLine)) return 'blocking';
  if (copilotSuggestionSeverityPattern.test(firstLine)) return 'suggestion';
  return '';
}

export function sanitizeCopilotCommentTitle(value: unknown, maxLength = 60): string {
  const normalized = String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:\x23{1,6}|[-+*>]|\d+[.)])\s*/, '')
    .replace(/[`*~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[。！？；;，,：:]\s*$/, '')
    .trim();
  if (!normalized) return '';
  const characters = Array.from(normalized);
  return characters.length <= maxLength ? normalized : `${characters.slice(0, maxLength - 1).join('')}…`;
}

export function copilotCommentTitle(body: unknown): string {
  const lines = String(body ?? '').split(/\r?\n/);
  const explicit = lines[1]?.match(copilotTitlePattern)?.[1] ?? '';
  const explicitTitle = sanitizeCopilotCommentTitle(explicit);
  if (explicitTitle) return explicitTitle;
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate || /^```/.test(candidate)) continue;
    if (copilotBlockingSeverityPattern.test(candidate)
      || copilotSuggestionSeverityPattern.test(candidate)
      || copilotTitlePattern.test(candidate)) continue;
    const fallback = sanitizeCopilotCommentTitle(candidate.split(/[。！？；;]/, 1)[0]);
    if (fallback) return fallback;
  }
  return 'Copilot 评论';
}

export function copilotThreadFindings(threads: readonly {
  isResolved?: unknown;
  isOutdated?: unknown;
  comments?: readonly CopilotThreadComment[] | { nodes?: readonly CopilotThreadComment[] };
}[]): CopilotFindings {
  const findings: CopilotFindings = { blocking: [], suggestions: [], unclassified: [] };
  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) continue;
    const comments = Array.isArray(thread.comments)
      ? thread.comments as readonly CopilotThreadComment[]
      : (thread.comments as { nodes?: readonly CopilotThreadComment[] } | undefined)?.nodes ?? [];
    for (const comment of comments.filter(isCopilotComment)) {
      const body = String(comment.body ?? '');
      const finding = { title: copilotCommentTitle(body), url: String(comment.url ?? '') };
      const severity = copilotCommentSeverity(body);
      if (severity === 'blocking') findings.blocking.push(finding);
      else if (severity === 'suggestion') findings.suggestions.push(finding);
      else findings.unclassified.push(finding);
    }
  }
  return findings;
}

export function copilotPassingConclusionSource(reviews: readonly { body?: unknown }[]): CopilotGateDecision['passingConclusionSource'] {
  if (reviews.some((review) => copilotNoBlockingConclusionPattern.test(String(review.body ?? '')))) {
    return 'fixed-conclusion';
  }
  if (reviews.some((review) => copilotNoCommentsPattern.test(String(review.body ?? '')))) {
    return 'no-new-comments';
  }
  if (reviews.some((review) => Number(String(review.body ?? '').match(copilotGeneratedCommentsPattern)?.[1] ?? '0') > 0)) {
    return 'resolved-review-comments';
  }
  return '';
}

export function evaluateCopilotGate(input: {
  reviews: readonly { body?: unknown }[];
  findings?: Partial<CopilotFindings>;
  requestFailed?: boolean;
}): CopilotGateDecision {
  const blocking = [...(input.findings?.blocking ?? [])];
  const suggestions = [...(input.findings?.suggestions ?? [])];
  const unclassified = [...(input.findings?.unclassified ?? [])];
  const result: CopilotGateDecision = {
    state: 'passed',
    checkStatus: 'completed',
    checkConclusion: 'success',
    failureKind: '',
    passingSignal: '',
    passingConclusionSource: '',
    blocking,
    suggestions,
    unclassified,
  };
  if (!input.reviews.length) {
    if (input.requestFailed) {
      result.state = 'failed';
      result.checkConclusion = 'failure';
      result.failureKind = 'request-failed';
    } else {
      result.state = 'pending';
      result.checkStatus = 'in_progress';
      delete result.checkConclusion;
    }
    return result;
  }
  if (blocking.length) {
    result.state = 'failed';
    result.checkConclusion = 'failure';
    result.failureKind = 'blocking-comments';
    return result;
  }
  if (unclassified.length) {
    result.state = 'failed';
    result.checkConclusion = 'failure';
    result.failureKind = 'comment-protocol';
    return result;
  }
  if (suggestions.length) {
    result.passingSignal = 'suggestion-only-comments';
    return result;
  }
  result.passingConclusionSource = copilotPassingConclusionSource(input.reviews);
  if (!result.passingConclusionSource) {
    result.state = 'failed';
    result.checkConclusion = 'failure';
    result.failureKind = 'passing-conclusion';
    return result;
  }
  result.passingSignal = 'no-current-comments-with-known-conclusion';
  return result;
}

export function copilotFailureModels(input: {
  decision: CopilotGateDecision;
  coreHandlers: readonly unknown[];
  contributorHandlers: readonly unknown[];
  botLogins?: readonly unknown[];
}): GovernanceFailureModel[] {
  const botLogins = input.botLogins ?? [];
  const coreHandlers = uniqueHumanLogins(input.coreHandlers, { botLogins });
  const contributors = uniqueHumanLogins(input.contributorHandlers, { botLogins });
  const failures: GovernanceFailureModel[] = [];
  if (input.decision.blocking.length) {
    failures.push({
      source: 'copilot-review:blocking-comments',
      presentation: 'copilot.blocking-comments',
      handlers: contributors.length ? contributors : coreHandlers,
      items: input.decision.blocking.map((finding) => finding.title),
    });
  }
  if (input.decision.unclassified.length) {
    failures.push({
      source: 'copilot-review:comment-protocol',
      presentation: 'copilot.comment-protocol',
      handlers: coreHandlers,
      items: input.decision.unclassified.map((finding) => finding.title),
    });
  }
  if (failures.length) return failures;
  if (input.decision.failureKind === 'request-failed') {
    return [{
      source: 'copilot-review:request-failed',
      presentation: 'copilot.request-failed',
      handlers: coreHandlers,
      items: [],
    }];
  }
  if (input.decision.failureKind === 'passing-conclusion') {
    return [{
      source: 'copilot-review:passing-conclusion',
      presentation: 'copilot.passing-conclusion',
      handlers: coreHandlers,
      items: [],
    }];
  }
  return [];
}
