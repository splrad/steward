import { classificationInputBody } from '../../core/src/index.js';
import type { GitHubPullRequest } from '../../github/src/index.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function controlPullRequestInput(pull: GitHubPullRequest): Record<string, unknown> {
  return {
    number: pull.number,
    title: String(pull.title ?? ''),
    body: classificationInputBody(pull.body),
    authorLogin: String(pull.user?.login ?? '').trim().toLowerCase(),
    authorType: String(pull.user?.type ?? '').trim().toLowerCase(),
    baseRef: pull.base.ref,
    baseSha: pull.base.sha ?? null,
    headRef: pull.head.ref ?? null,
    headSha: pull.head.sha.toLowerCase(),
  };
}

export function controlLabelNames(pull: GitHubPullRequest): string[] {
  const labels = (pull.labels ?? []).map((label) => String(label.name ?? '').trim().toLowerCase());
  if (labels.some((label) => !label)) throw new Error('GitHub returned a pull request label without a valid name');
  return [...new Set(labels)].sort(compareText);
}
