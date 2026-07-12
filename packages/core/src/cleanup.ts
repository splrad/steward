import { blockingFailuresMarker } from './blocking-state.js';
import { effectiveAuthorFromBody, normalizeGitHubLogin } from './identity.js';

export const closeStatusMarker = '<!-- workflow:pr-close-status -->';
export const cleanupEphemeralCommentMarkers = [
  blockingFailuresMarker,
  '<!-- workflow:main-authorization-gate -->',
  '<!-- workflow:copilot-review-gate -->',
] as const;

export interface CleanupPullInput {
  number: number;
  merged: boolean;
  mergeCommitSha?: string | null | undefined;
  title?: string | undefined;
  body?: string | null | undefined;
  authorLogin?: string | undefined;
  headRef?: string | undefined;
  baseRef?: string | undefined;
  mergedBy?: string | undefined;
}

export interface CleanupNotification {
  pullNumber: number;
  title: string;
  sourceRef: string;
  targetRef: string;
  author: string;
  mergedBy: string;
  mergeCommitSha: string;
}

export interface CleanupEvaluation {
  merged: boolean;
  notification: CleanupNotification | null;
}

export function evaluatePullRequestCleanup(
  pull: CleanupPullInput,
  options: { botLogins?: readonly unknown[] } = {},
): CleanupEvaluation {
  if (!Number.isSafeInteger(pull.number) || pull.number < 1) {
    throw new Error('Cleanup requires a positive pull request number');
  }
  if (!pull.merged) return { merged: false, notification: null };

  const mergeCommitSha = String(pull.mergeCommitSha ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(mergeCommitSha)) {
    throw new Error('Merged cleanup requires a valid merge commit SHA');
  }
  const title = String(pull.title ?? '').trim();
  const sourceRef = String(pull.headRef ?? '').trim();
  const targetRef = String(pull.baseRef ?? '').trim();
  if (!title || !sourceRef || !targetRef) {
    throw new Error('Merged cleanup requires title, source branch, and target branch evidence');
  }
  const author = effectiveAuthorFromBody({
    body: pull.body,
    ...(pull.authorLogin === undefined ? {} : { prAuthor: pull.authorLogin }),
    botLogins: options.botLogins ?? [],
    fallback: 'unknown',
  });
  return {
    merged: true,
    notification: {
      pullNumber: pull.number,
      title,
      sourceRef,
      targetRef,
      author,
      mergedBy: normalizeGitHubLogin(pull.mergedBy) || 'unknown',
      mergeCommitSha,
    },
  };
}
