import {
  classifyPullRequestAuthor,
  normalizeGitHubLogin,
  planCopilotReviewRequest,
  selectCurrentHeadReviews,
  type PullRequestAuthorClassification,
  type PullRequestReviewEvidence,
} from '../../core/src/index.js';
import type {
  GitHubPullRequest,
  GitHubPullRequestReview,
} from '../../github/src/index.js';
import type {
  ControlDecision,
  ControlPlan,
  PullRequestControlContext,
  RequestCopilotReviewIntent,
} from './contracts.js';
import {
  assertControlPlanSubject,
  controlJsonDigest,
  finalizeControlPlan,
  verifyControlPlan,
} from './plan.js';
import { controlPullRequestInput } from './snapshot.js';

const copilotReviewRequestKey = 'copilot-review:request' as const;

interface CanonicalReviewEvidence {
  id: number;
  state: string;
  commitId: string;
  submittedAt: string;
  reviewer: string;
}

export interface CopilotReviewEvidenceSnapshot {
  author: PullRequestAuthorClassification;
  headSha: string;
  malformed: boolean;
  requestedReviewers: string[];
  reviews: CanonicalReviewEvidence[];
}

export type CopilotReviewMutationInspection =
  | { state: 'ready' }
  | { state: 'converged' }
  | { state: 'stale-plan' };

export type CopilotReviewRecoveryInspection =
  | { state: 'converged' }
  | { state: 'action-required' }
  | { state: 'unknown' };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalReview(
  review: PullRequestReviewEvidence,
): CanonicalReviewEvidence {
  return {
    id: Number(review.id),
    state: String(review.state ?? '').trim().toUpperCase(),
    commitId: String(review.commit_id ?? '').trim().toLowerCase(),
    submittedAt: String(review.submitted_at ?? '').trim(),
    reviewer: String(review.user?.login ?? '').trim().toLowerCase(),
  };
}

function validRequestedReviewer(login: unknown): login is string {
  if (typeof login !== 'string'
    || login.length < 1
    || login.length > 44
    || login !== login.trim()) {
    return false;
  }
  const accountLogin = login.toLowerCase().endsWith('[bot]')
    ? login.slice(0, -5)
    : login;
  const normalized = normalizeGitHubLogin(accountLogin);
  return normalized !== ''
    && normalized.toLowerCase() === accountLogin.toLowerCase();
}

export function copilotReviewEvidence(
  pull: GitHubPullRequest,
  reviews: readonly GitHubPullRequestReview[],
  headShaInput: string = pull.head.sha,
): CopilotReviewEvidenceSnapshot {
  const headSha = String(headShaInput ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    throw new TypeError('Copilot review evidence requires a valid head SHA');
  }
  const requested = pull.requested_reviewers;
  const requestedMalformed = !Array.isArray(requested)
    || requested.some((reviewer) => !validRequestedReviewer(reviewer?.login));
  const requestedReviewers = Array.isArray(requested)
    ? requested
        .map((reviewer) => String(reviewer?.login ?? '').trim().toLowerCase())
        .filter(Boolean)
        .sort(compareText)
    : [];

  const orderedReviews = [...reviews].sort((left, right) => (
    compareText(
      JSON.stringify(canonicalReview(left)),
      JSON.stringify(canonicalReview(right)),
    )
  ));
  const selected = selectCurrentHeadReviews(orderedReviews, headSha);
  const currentReviews = [...selected.pendingReviews, ...selected.reviews]
    .map(canonicalReview)
    .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));

  return {
    author: classifyPullRequestAuthor(pull.user),
    headSha,
    malformed: requestedMalformed || selected.malformed,
    requestedReviewers,
    reviews: currentReviews,
  };
}

function requestDecision(
  evidence: CopilotReviewEvidenceSnapshot,
) {
  return planCopilotReviewRequest({
    author: evidence.author,
    headSha: evidence.headSha,
    requestedReviewers: evidence.requestedReviewers.map((login) => ({ login })),
    reviews: evidence.reviews.map((review) => ({
      id: review.id,
      state: review.state,
      commit_id: review.commitId,
      submitted_at: review.submittedAt,
      user: { login: review.reviewer },
    })),
  });
}

function copilotMutation(plan: ControlPlan): Extract<
  ControlPlan['mutations'][number],
  { type: 'copilot-review.request' }
> {
  const mutation = plan.mutations[0];
  if (plan.objective !== 'governance'
    || plan.mutations.length !== 1
    || mutation?.type !== 'copilot-review.request'
    || mutation.key !== copilotReviewRequestKey
    || mutation.principal !== 'human') {
    throw new Error('Control plan is not a single Copilot review request');
  }
  return mutation;
}

export async function planGovernanceCopilotReview(
  context: PullRequestControlContext,
  reviews: readonly GitHubPullRequestReview[],
): Promise<ControlDecision<'governance'>> {
  if (!context.manifest.manifest.features.copilotReview) {
    const result = {
      operation: 'governance' as const,
      state: 'ignored' as const,
      summary: 'Copilot review is disabled',
    };
    return {
      result,
      plan: await finalizeControlPlan({
        objective: 'governance',
        subject: context.subject,
        pullRequest: context.pull,
        snapshot: { featureEnabled: false },
        outcome: { state: result.state, summary: result.summary },
        mutations: [],
      }),
    };
  }

  const evidence = copilotReviewEvidence(context.pull, reviews);
  if (evidence.malformed || evidence.author.kind === 'unknown') {
    const result = {
      operation: 'governance' as const,
      state: 'action_required' as const,
      summary: evidence.malformed
        ? 'Copilot review evidence is malformed'
        : 'Pull request author identity is unknown',
      details: { evidence },
    };
    return {
      result,
      plan: await finalizeControlPlan({
        objective: 'governance',
        subject: context.subject,
        pullRequest: context.pull,
        snapshot: { featureEnabled: true, evidence },
        outcome: { state: result.state, summary: result.summary },
        mutations: [],
      }),
    };
  }

  const request = requestDecision(evidence);
  const mutations: RequestCopilotReviewIntent[] = request.state === 'request'
    ? [{
        type: 'copilot-review.request',
        key: copilotReviewRequestKey,
        principal: 'human',
        observedEvidenceDigest: await controlJsonDigest(evidence),
      }]
    : [];
  const summary = request.state === 'request'
    ? 'Machine-authored pull request requires an explicit Copilot review request'
    : request.state === 'observe-native'
      ? 'Human-authored pull request is observed through organization-native Copilot review'
      : request.reason === 'copilot-reviewed-current-head'
        ? 'Copilot already reviewed the current pull request head'
        : 'Copilot review is already requested';
  const result = {
    operation: 'governance' as const,
    state: 'pending' as const,
    summary,
    details: { evidence, request },
  };
  return {
    result,
    plan: await finalizeControlPlan({
      objective: 'governance',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: { featureEnabled: true, evidence, request },
      outcome: { state: result.state, summary: result.summary },
      mutations,
    }),
  };
}

export async function inspectGovernanceCopilotReviewMutation(
  plan: ControlPlan,
  context: PullRequestControlContext,
  reviews: readonly GitHubPullRequestReview[],
): Promise<CopilotReviewMutationInspection> {
  await verifyControlPlan(plan);
  const mutation = copilotMutation(plan);
  try {
    assertControlPlanSubject(plan, context.subject);
  } catch {
    return { state: 'stale-plan' };
  }
  if (await controlJsonDigest(controlPullRequestInput(context.pull)) !== plan.pullRequestDigest
    || !context.manifest.manifest.features.copilotReview) {
    return { state: 'stale-plan' };
  }
  const evidence = copilotReviewEvidence(context.pull, reviews);
  if (evidence.malformed || evidence.author.kind !== 'machine') {
    return { state: 'stale-plan' };
  }
  const request = requestDecision(evidence);
  if (request.state === 'not-needed') return { state: 'converged' };
  if (request.state !== 'request'
    || await controlJsonDigest(evidence) !== mutation.observedEvidenceDigest) {
    return { state: 'stale-plan' };
  }
  return { state: 'ready' };
}

export async function inspectGovernanceCopilotReviewRecovery(
  plan: ControlPlan,
  pull: GitHubPullRequest,
  reviews: readonly GitHubPullRequestReview[],
): Promise<CopilotReviewRecoveryInspection> {
  await verifyControlPlan(plan);
  copilotMutation(plan);
  if (pull.number !== plan.subject.pullRequest.number) return { state: 'unknown' };
  // requested_reviewers is PR-level desired-state evidence and may therefore
  // converge after the head advances. Review evidence remains pinned to the
  // prepared head so a review of an unrelated commit cannot prove recovery.
  const evidence = copilotReviewEvidence(
    pull,
    reviews,
    plan.subject.pullRequest.headSha,
  );
  if (evidence.malformed || evidence.author.kind !== 'machine') {
    return { state: 'unknown' };
  }
  const request = requestDecision(evidence);
  if (request.state === 'not-needed') return { state: 'converged' };
  return request.state === 'request'
    ? { state: 'action-required' }
    : { state: 'unknown' };
}
