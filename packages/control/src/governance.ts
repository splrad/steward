import {
  blockingFailuresMarker,
  classifyPullRequestAuthor,
  copilotFailureModels,
  copilotThreadFindings,
  decodeBlockingState,
  evaluateCopilotGate,
  fingerprintForPull,
  normalizeGitHubLogin,
  planCopilotReviewRequest,
  selectCurrentHeadReviews,
  stewardCheckExternalIdV2,
  writeBlockingState,
  type BlockingFailure,
  type CopilotGateDecision,
  type PullRequestAuthorClassification,
  type PullRequestReviewEvidence,
} from '../../core/src/index.js';
import type {
  CheckRunCreate,
  CheckRunUpdate,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubPullRequestReview,
  GitHubReviewThread,
} from '../../github/src/index.js';
import type {
  ControlMutation,
  ControlMutationIntent,
  ControlDecision,
  ControlPlan,
  CreateBlockingCommentIntent,
  CreateCopilotGateCheckIntent,
  DeleteBlockingCommentIntent,
  PullRequestControlContext,
  RequestCopilotReviewIntent,
  UpdateBlockingCommentIntent,
  UpdateCopilotGateCheckIntent,
} from './contracts.js';
import {
  assertControlPlanSubject,
  controlJsonDigest,
  finalizeControlPlan,
  verifyControlPlan,
} from './plan.js';
import { controlPullRequestInput } from './snapshot.js';

const copilotReviewRequestKey = 'copilot-review:request' as const;
export const copilotGateCheckKey = 'copilot-gate:check' as const;
export const copilotGateBlockingCommentKey = 'copilot-gate:blocking-comment' as const;
export const copilotGateCheckName = 'Copilot Code Review Gate' as const;
export const copilotGateBlockingCommentResourceMarker =
  '<!-- steward:resource:copilot-gate-blocking-comment:v1 -->' as const;

const legacyCopilotGateCommentMarker = '<!-- workflow:copilot-review-gate -->';
const copilotReviewerLogin = 'copilot-pull-request-reviewer';
const maximumGateCollectionSize = 1_000;
const maximumGateThreadComments = 16;
const maximumGateHandlers = 20;
const maximumGateBodyLength = 16_384;
const maximumGateUrlLength = 1_024;
const maximumVisibleDetailLength = 180;

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
  const requests = plan.mutations.filter((candidate): candidate is Extract<
    ControlPlan['mutations'][number],
    { type: 'copilot-review.request' }
  > => candidate.type === 'copilot-review.request');
  const mutation = requests[0];
  if (plan.objective !== 'governance'
    || requests.length !== 1
    || mutation?.type !== 'copilot-review.request'
    || mutation.key !== copilotReviewRequestKey
    || mutation.principal !== 'human'
    || plan.mutations.at(-1) !== mutation) {
    throw new Error('Control plan has no final Copilot review request');
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
        evidenceProtocol: 'review-request-v1',
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
  if (mutation.evidenceProtocol !== 'review-request-v1') {
    return { state: 'stale-plan' };
  }
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

export interface GovernanceCopilotGateActor {
  id: number;
  login: string;
  type: string;
}

export interface GovernanceCopilotGateFacts {
  actor: GovernanceCopilotGateActor;
  commits: readonly GitHubCommit[];
  files: readonly GitHubPullRequestFile[];
  reviews: readonly GitHubPullRequestReview[];
  threads: readonly GitHubReviewThread[];
  checks: readonly GitHubCheckRun[];
  comments: readonly GitHubIssueComment[];
  coreHandlers: readonly unknown[];
  /**
   * Exact read of the prepared comment ID for a delete inspection.
   * Undefined means no authoritative point read was performed; null means
   * GitHub explicitly returned 404.
   */
  targetComment?: GitHubIssueComment | null;
}

interface CanonicalGateReview extends CanonicalReviewEvidence {
  body: string;
}

interface CanonicalGateThreadComment {
  id: string;
  body: string;
  url: string;
  author: { login: string };
  pullRequestReview: {
    author: { login: string };
    commit: { oid: string };
    state: string;
  };
}

interface CanonicalGateThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: CanonicalGateThreadComment[];
}

export interface GovernanceCopilotGateEvidence {
  actor: GovernanceCopilotGateActor;
  author: PullRequestAuthorClassification;
  coreHandlers: string[];
  headSha: string;
  malformed: boolean;
  requestedReviewers: string[];
  reviews: CanonicalGateReview[];
  threads: CanonicalGateThread[];
  pullFingerprint: string;
  contributors: string[];
}

interface CanonicalGateCheck {
  id: number;
  headSha: string;
  name: string;
  status: string;
  conclusion: string;
  externalId: string;
  detailsUrl: string;
  title: string;
  summary: string;
  appId: number;
  appSlug: string;
}

interface CanonicalGateComment {
  id: number;
  body: string;
  ownerId: number;
  ownerLogin: string;
  ownerType: string;
  appId: number | null;
  appSlug: string;
}

export interface CopilotGateResourceInspection<Resource> {
  state: 'none' | 'one' | 'ambiguous' | 'malformed';
  resources: Resource[];
  setDigest: string;
}

export type CopilotGateMutationInspection =
  | { state: 'ready' }
  | { state: 'converged'; resourceId?: number }
  | { state: 'stale-plan' };

export type CopilotGateRecoveryInspection =
  | { state: 'converged'; resourceId?: number }
  | { state: 'unknown' };

export interface GovernanceCopilotGateRecoveryFacts {
  actor: GovernanceCopilotGateActor;
  checks: readonly GitHubCheckRun[];
  comments: readonly GitHubIssueComment[];
  /**
   * Exact read of the prepared comment ID. Collection absence is not proof
   * that a response-lost delete converged.
   */
  targetComment?: GitHubIssueComment | null;
}

function normalizeAppLogin(value: unknown): string {
  return normalizeGitHubLogin(String(value ?? '').trim().replace(/\[bot\]$/i, '')).toLowerCase();
}

function validGateActor(
  subject: ControlPlan['subject'],
  actor: GovernanceCopilotGateActor,
): boolean {
  const canonical = canonicalGateActor(actor);
  return Number.isSafeInteger(canonical.id)
    && canonical.id > 0
    && canonical.type === 'Bot'
    && canonical.login === `${subject.platform.appSlug.toLowerCase()}[bot]`;
}

function canonicalGateActor(
  actor: GovernanceCopilotGateActor,
): GovernanceCopilotGateActor {
  return {
    id: Number(actor?.id),
    login: String(actor?.login ?? '').trim().toLowerCase(),
    type: String(actor?.type ?? '').trim().toLowerCase() === 'bot' ? 'Bot' : '',
  };
}

function isCopilotLogin(value: unknown): boolean {
  return normalizeAppLogin(value) === copilotReviewerLogin;
}

function boundedText(
  value: unknown,
  maximum: number,
): { value: string; malformed: boolean } {
  const text = String(value ?? '');
  return {
    value: text.slice(0, maximum),
    malformed: typeof value !== 'string' || text.length > maximum,
  };
}

function canonicalCoreHandlers(
  values: readonly unknown[],
): { handlers: string[]; malformed: boolean } {
  let malformed = !Array.isArray(values) || values.length > maximumGateHandlers;
  const handlers = new Set<string>();
  for (const value of (Array.isArray(values) ? values : []).slice(0, maximumGateHandlers)) {
    const normalized = normalizeGitHubLogin(value).toLowerCase();
    if (typeof value !== 'string'
      || value !== value.trim()
      || !normalized
      || normalized !== value.toLowerCase()
      || normalized.endsWith('[bot]')) {
      malformed = true;
      continue;
    }
    handlers.add(normalized);
  }
  return { handlers: [...handlers].sort(compareText), malformed };
}

function canonicalGateThreads(
  threads: readonly GitHubReviewThread[],
): { malformed: boolean; threads: CanonicalGateThread[] } {
  let malformed = !Array.isArray(threads) || threads.length > maximumGateCollectionSize;
  const seenThreads = new Set<string>();
  const seenComments = new Set<string>();
  const canonical: CanonicalGateThread[] = [];
  let relevantCommentCount = 0;
  for (const thread of (Array.isArray(threads) ? threads : []).slice(0, maximumGateCollectionSize)) {
    const id = String(thread?.id ?? '').trim();
    if (!id || typeof thread?.isResolved !== 'boolean'
      || typeof thread?.isOutdated !== 'boolean'
      || seenThreads.has(id)
      || !thread.comments
      || !Array.isArray(thread.comments.nodes)
      || thread.comments.pageInfo?.hasNextPage === true) {
      malformed = true;
      continue;
    }
    seenThreads.add(id);
    const comments: CanonicalGateThreadComment[] = [];
    if (!thread.isResolved && !thread.isOutdated) {
      if (thread.comments.nodes.length > maximumGateCollectionSize) malformed = true;
      for (const comment of thread.comments.nodes.slice(0, maximumGateCollectionSize)) {
        const authorLogin = String(comment?.author?.login ?? '').trim().toLowerCase();
        const reviewAuthorLogin = String(
          comment?.pullRequestReview?.author?.login ?? '',
        ).trim().toLowerCase();
        if (!isCopilotLogin(reviewAuthorLogin || authorLogin)
          && !isCopilotLogin(authorLogin)) {
          continue;
        }
        const commentId = String(comment?.id ?? '').trim();
        const body = boundedText(comment?.body, maximumGateBodyLength);
        const url = boundedText(comment?.url, maximumGateUrlLength);
        const commitId = String(
          comment?.pullRequestReview?.commit?.oid ?? '',
        ).trim().toLowerCase();
        const state = String(
          comment?.pullRequestReview?.state ?? '',
        ).trim().toUpperCase();
        if (!commentId
          || seenComments.has(commentId)
          || body.malformed
          || url.malformed
          || !authorLogin
          || !reviewAuthorLogin
          || (isCopilotLogin(authorLogin) !== isCopilotLogin(reviewAuthorLogin))) {
          malformed = true;
          continue;
        }
        relevantCommentCount += 1;
        if (relevantCommentCount > maximumGateThreadComments) {
          malformed = true;
          continue;
        }
        seenComments.add(commentId);
        comments.push({
          id: commentId,
          body: body.value,
          url: url.value,
          author: { login: authorLogin },
          pullRequestReview: {
            author: { login: reviewAuthorLogin },
            commit: { oid: commitId },
            state,
          },
        });
      }
    }
    comments.sort((left, right) => compareText(left.id, right.id));
    canonical.push({
      id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments,
    });
  }
  canonical.sort((left, right) => compareText(left.id, right.id));
  return { malformed, threads: canonical };
}

async function governanceCopilotGateEvidence(
  context: PullRequestControlContext,
  facts: Pick<
    GovernanceCopilotGateFacts,
    'actor' | 'commits' | 'coreHandlers' | 'files' | 'reviews' | 'threads'
  >,
): Promise<GovernanceCopilotGateEvidence> {
  let malformed = !Array.isArray(facts.reviews)
    || facts.reviews.length > maximumGateCollectionSize
    || !Array.isArray(facts.commits)
    || facts.commits.length > maximumGateCollectionSize
    || !Array.isArray(facts.files)
    || facts.files.length > maximumGateCollectionSize;
  const requestedReviewers = context.pull.requested_reviewers;
  if (Array.isArray(requestedReviewers)
    && requestedReviewers.length > maximumGateHandlers) {
    malformed = true;
  }
  const boundedPull: GitHubPullRequest = Array.isArray(requestedReviewers)
    ? {
        ...context.pull,
        requested_reviewers: requestedReviewers.slice(0, maximumGateHandlers),
      }
    : context.pull;
  const reviews = (Array.isArray(facts.reviews) ? facts.reviews : [])
    .slice(0, maximumGateCollectionSize)
    .map((review) => {
      const body = review.body === undefined || review.body === null
        ? { value: '', malformed: false }
        : boundedText(review.body, maximumGateBodyLength);
      if (body.malformed) malformed = true;
      return { ...review, body: body.value };
    });
  const commits = (Array.isArray(facts.commits) ? facts.commits : [])
    .slice(0, maximumGateCollectionSize);
  const files = (Array.isArray(facts.files) ? facts.files : [])
    .slice(0, maximumGateCollectionSize);
  for (const commit of commits) {
    if (!/^[a-f0-9]{40}$/i.test(String(commit?.sha ?? ''))
      || (commit?.author?.login !== undefined
        && typeof commit.author.login !== 'string')) {
      malformed = true;
    }
  }
  for (const file of files) {
    if (typeof file?.filename !== 'string' || !file.filename
      || typeof file?.status !== 'string' || !file.status
      || typeof file?.sha !== 'string'
      || (file.additions !== undefined && !Number.isFinite(file.additions))
      || (file.deletions !== undefined && !Number.isFinite(file.deletions))) {
      malformed = true;
    }
  }
  const requestEvidence = copilotReviewEvidence(boundedPull, reviews);
  const selected = selectCurrentHeadReviews(reviews, context.pull.head.sha);
  const currentReviews = [...selected.pendingReviews, ...selected.reviews]
    .map((review) => ({ ...canonicalReview(review), body: String(review.body ?? '') }))
    .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
  const threads = canonicalGateThreads(facts.threads);
  const coreHandlers = canonicalCoreHandlers(facts.coreHandlers);
  const fingerprint = await fingerprintForPull({
    pull: context.pull,
    commits,
    files,
    botLogins: [
      context.subject.platform.appSlug,
      'copilot-pull-request-reviewer[bot]',
    ],
  });
  if (fingerprint.contributors.length > maximumGateHandlers) malformed = true;
  return {
    actor: canonicalGateActor(facts.actor),
    author: requestEvidence.author,
    coreHandlers: coreHandlers.handlers,
    headSha: requestEvidence.headSha,
    malformed: malformed
      || requestEvidence.malformed
      || threads.malformed
      || coreHandlers.malformed
      || !validGateActor(context.subject, facts.actor),
    requestedReviewers: requestEvidence.requestedReviewers,
    reviews: currentReviews,
    threads: threads.threads,
    pullFingerprint: fingerprint.value,
    contributors: fingerprint.contributors.slice(0, maximumGateHandlers),
  };
}

function canonicalGateCheck(check: GitHubCheckRun): CanonicalGateCheck | null {
  const id = Number(check?.id);
  const headSha = String(check?.head_sha ?? '').trim().toLowerCase();
  const name = String(check?.name ?? '');
  const status = String(check?.status ?? '').trim();
  const conclusion = String(check?.conclusion ?? '').trim();
  const appId = Number(check?.app?.id);
  const appSlug = String(check?.app?.slug ?? '').trim().toLowerCase();
  if (!Number.isSafeInteger(id) || id <= 0
    || !/^[a-f0-9]{40}$/.test(headSha)
    || !name.trim()
    || name.length > 255
    || !status
    || status.length > 64
    || !Number.isSafeInteger(appId)
    || appId <= 0
    || !appSlug
    || appSlug.length > 100
    || String(check.external_id ?? '').length > 1_024
    || String(check.details_url ?? '').length > maximumGateUrlLength
    || String(check.output?.title ?? '').length > 1_024
    || String(check.output?.summary ?? '').length > maximumGateBodyLength) {
    return null;
  }
  return {
    id,
    headSha,
    name,
    status,
    conclusion,
    externalId: String(check.external_id ?? ''),
    detailsUrl: String(check.details_url ?? ''),
    title: String(check.output?.title ?? ''),
    summary: String(check.output?.summary ?? ''),
    appId,
    appSlug,
  };
}

export async function inspectCopilotGateCheckResources(
  subject: ControlPlan['subject'],
  checks: readonly GitHubCheckRun[],
): Promise<CopilotGateResourceInspection<CanonicalGateCheck>> {
  let malformed = !Array.isArray(checks) || checks.length > maximumGateCollectionSize;
  const resources: CanonicalGateCheck[] = [];
  const seen = new Set<number>();
  for (const check of (Array.isArray(checks) ? checks : []).slice(0, maximumGateCollectionSize)) {
    if (String(check?.name ?? '') !== copilotGateCheckName
      || String(check?.head_sha ?? '').trim().toLowerCase() !== subject.pullRequest.headSha) {
      continue;
    }
    const canonical = canonicalGateCheck(check);
    if (!canonical) {
      malformed = true;
      continue;
    }
    const idMatches = canonical.appId === subject.platform.appId;
    const slugMatches = canonical.appSlug === subject.platform.appSlug;
    if (idMatches !== slugMatches) {
      malformed = true;
      continue;
    }
    if (!idMatches) continue;
    if (seen.has(canonical.id)) {
      malformed = true;
      continue;
    }
    seen.add(canonical.id);
    resources.push(canonical);
  }
  resources.sort((left, right) => left.id - right.id);
  const setDigest = await controlJsonDigest(resources);
  return {
    state: malformed ? 'malformed'
      : resources.length === 0 ? 'none'
        : resources.length === 1 ? 'one'
          : 'ambiguous',
    resources,
    setDigest,
  };
}

function hasOwnedBlockingMarker(body: string): boolean {
  return body.includes(copilotGateBlockingCommentResourceMarker)
    || body.includes(blockingFailuresMarker)
    || body.includes(legacyCopilotGateCommentMarker);
}

function canonicalGateComment(comment: GitHubIssueComment): CanonicalGateComment | null {
  const id = Number(comment?.id);
  const body = comment?.body;
  const ownerId = Number(comment?.user?.id);
  const ownerLogin = String(comment?.user?.login ?? '').trim().toLowerCase();
  const ownerType = String(comment?.user?.type ?? '').trim();
  const rawAppId = comment?.performed_via_github_app?.id;
  const appId = rawAppId === undefined || rawAppId === null ? null : Number(rawAppId);
  const appSlug = String(comment?.performed_via_github_app?.slug ?? '').trim().toLowerCase();
  if (!Number.isSafeInteger(id) || id <= 0
    || typeof body !== 'string'
    || body.length > maximumGateBodyLength
    || !Number.isSafeInteger(ownerId)
    || ownerId <= 0
    || !ownerLogin
    || !ownerType
    || (appId !== null && (!Number.isSafeInteger(appId) || appId <= 0))
    || ((appId === null) !== (appSlug === ''))) {
    return null;
  }
  return { id, body, ownerId, ownerLogin, ownerType, appId, appSlug };
}

export async function inspectCopilotGateBlockingCommentResources(
  subject: ControlPlan['subject'],
  actor: GovernanceCopilotGateActor,
  comments: readonly GitHubIssueComment[],
): Promise<CopilotGateResourceInspection<CanonicalGateComment>> {
  const expectedActor = canonicalGateActor(actor);
  let malformed = !validGateActor(subject, actor)
    || !Array.isArray(comments)
    || comments.length > maximumGateCollectionSize;
  const resources: CanonicalGateComment[] = [];
  const seen = new Set<number>();
  for (const comment of (Array.isArray(comments) ? comments : []).slice(0, maximumGateCollectionSize)) {
    const body = typeof comment?.body === 'string' ? comment.body : '';
    if (!hasOwnedBlockingMarker(body)) continue;
    const canonical = canonicalGateComment(comment);
    if (!canonical) {
      const candidateOwnerId = Number(comment?.user?.id);
      const candidateOwnerLogin = String(comment?.user?.login ?? '').trim().toLowerCase();
      if (candidateOwnerId === expectedActor.id || candidateOwnerLogin === expectedActor.login) malformed = true;
      continue;
    }
    const ownerIdMatches = canonical.ownerId === expectedActor.id;
    const ownerLoginMatches = canonical.ownerLogin === expectedActor.login;
    const appIdMatches = canonical.appId === null || canonical.appId === subject.platform.appId;
    const appSlugMatches = canonical.appId === null || canonical.appSlug === subject.platform.appSlug;
    const exactAppProvenance = canonical.appId === subject.platform.appId
      && canonical.appSlug === subject.platform.appSlug;
    if (ownerIdMatches !== ownerLoginMatches
      || (exactAppProvenance && !ownerIdMatches)
      || (ownerIdMatches && canonical.ownerType !== 'Bot')
      || (ownerIdMatches && (!appIdMatches || !appSlugMatches))
      || (canonical.appId !== null
        && canonical.appId === subject.platform.appId !== (canonical.appSlug === subject.platform.appSlug))) {
      malformed = true;
      continue;
    }
    if (!ownerIdMatches) continue;
    if (body.includes(blockingFailuresMarker) && decodeBlockingState(body) === null) {
      malformed = true;
      continue;
    }
    if (seen.has(canonical.id)) {
      malformed = true;
      continue;
    }
    seen.add(canonical.id);
    resources.push(canonical);
  }
  resources.sort((left, right) => left.id - right.id);
  const setDigest = await controlJsonDigest(resources);
  return {
    state: malformed ? 'malformed'
      : resources.length === 0 ? 'none'
        : resources.length === 1 ? 'one'
          : 'ambiguous',
    resources,
    setDigest,
  };
}

function compactResourceAudit<Resource extends { id: number }>(
  inspection: CopilotGateResourceInspection<Resource>,
): {
  state: CopilotGateResourceInspection<Resource>['state'];
  setDigest: string;
  resourceIds: number[];
} {
  return {
    state: inspection.state,
    setDigest: inspection.setDigest,
    resourceIds: inspection.resources.map((resource) => resource.id),
  };
}

function compactGateEvidenceAudit(
  evidence: GovernanceCopilotGateEvidence,
  gateEvidenceDigest: string,
): Record<string, unknown> {
  return {
    gateEvidenceDigest,
    malformed: evidence.malformed,
    actor: evidence.actor,
    author: evidence.author,
    headSha: evidence.headSha,
    coreHandlerCount: evidence.coreHandlers.length,
    requestedReviewerCount: evidence.requestedReviewers.length,
    reviewCount: evidence.reviews.length,
    threadCount: evidence.threads.length,
    contributorCount: evidence.contributors.length,
    pullFingerprint: evidence.pullFingerprint,
  };
}

function compactGateDecisionAudit(decision: CopilotGateDecision): Record<string, unknown> {
  return {
    state: decision.state,
    checkStatus: decision.checkStatus,
    checkConclusion: decision.checkConclusion ?? null,
    failureKind: decision.failureKind,
    passingSignal: decision.passingSignal,
    passingConclusionSource: decision.passingConclusionSource,
    blockingCount: decision.blocking.length,
    suggestionCount: decision.suggestions.length,
    unclassifiedCount: decision.unclassified.length,
  };
}

function failureTitle(presentation: string): string {
  const titles: Record<string, string> = {
    'copilot.blocking-comments': '🚫 Copilot 阻断评论',
    'copilot.comment-protocol': '⚠️ Copilot 评论协议异常',
    'copilot.request-failed': '⚠️ Copilot 审查请求失败',
    'copilot.passing-conclusion': '⚠️ Copilot 通过结论无法确认',
  };
  return titles[presentation] ?? '⚠️ Copilot 审查门禁异常';
}

function failureDetails(
  presentation: string,
  items: readonly string[],
): string[] {
  if (presentation === 'copilot.request-failed') {
    return ['Copilot 审查请求未成功完成，请由核心维护者检查请求记录。'];
  }
  if (presentation === 'copilot.passing-conclusion') {
    return ['门禁未识别到 Copilot 的有效通过结论。'];
  }
  return [...items];
}

function safeVisibleDetail(value: unknown): string {
  return String(value ?? '')
    .replace(/@/g, '＠')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumVisibleDetailLength);
}

function renderBlockingComment(
  headSha: string,
  failures: readonly BlockingFailure[],
): string {
  const sections = failures.map((failure) => {
    const handlers = failure.handlers.map((login) => `@${login}`).join(' ');
    const details = failure.details.map((detail) => `- ${detail}`).join('\n');
    return [
      `### ${failure.title}`,
      handlers ? `处理人：${handlers}` : '处理人：核心维护者',
      details,
    ].filter(Boolean).join('\n');
  });
  return [
    '## 🚧 PR 合并前有待处理事项',
    copilotGateBlockingCommentResourceMarker,
    blockingFailuresMarker,
    '',
    ...sections.flatMap((section) => [section, '']),
    '> 🤖 本评论由 SPLRAD Steward 自动维护，全部阻断解除后将自动删除。',
    '',
    writeBlockingState({ head: headSha, failures: [...failures] }),
  ].join('\n').trim();
}

function checkInput(
  context: PullRequestControlContext,
  decision: CopilotGateDecision,
  gateEvidenceDigest: string,
  mode: 'create' | 'update',
  actionRequired = false,
): CheckRunCreate | CheckRunUpdate {
  const common: CheckRunUpdate = {
    name: copilotGateCheckName,
    status: decision.state === 'pending' ? 'in_progress' : 'completed',
    ...(actionRequired ? { conclusion: 'action_required' as const }
      : decision.state === 'passed' ? { conclusion: 'success' as const }
      : decision.state === 'failed' ? { conclusion: 'failure' as const }
        : decision.state === 'pending' ? {}
          : { conclusion: 'action_required' as const }),
    externalId: stewardCheckExternalIdV2({
      repositoryId: context.subject.repository.id,
      prNumber: context.subject.pullRequest.number,
      headSha: context.subject.pullRequest.headSha,
      checkId: 'copilot-gate',
      configDigest: context.subject.manifest.configDigest,
      inputDigest: gateEvidenceDigest,
    }),
    ...(context.detailsUrl ? { detailsUrl: context.detailsUrl } : {}),
    title: actionRequired ? 'Copilot 审查门禁需要人工处理'
      : decision.state === 'passed' ? 'Copilot 审查门禁已通过'
      : decision.state === 'pending' ? '等待 Copilot 代码审查'
        : decision.state === 'failed' ? 'Copilot 审查门禁未通过'
          : 'Copilot 审查门禁需要人工处理',
    summary: actionRequired
      ? decision.unclassified[0]?.title ?? 'resource-identity-action-required'
      : decision.failureKind || decision.passingSignal || 'waiting-for-review',
  };
  return mode === 'create'
    ? { ...common, headSha: context.subject.pullRequest.headSha }
    : common;
}

function actionRequiredDecision(reason: string): CopilotGateDecision {
  return {
    state: 'failed',
    checkStatus: 'completed',
    checkConclusion: 'failure',
    failureKind: 'comment-protocol',
    passingSignal: '',
    passingConclusionSource: '',
    blocking: [],
    suggestions: [],
    unclassified: [{ title: reason, url: '' }],
  };
}

function checkMatchesInput(
  check: CanonicalGateCheck,
  input: CheckRunCreate | CheckRunUpdate,
  headSha: string,
): boolean {
  return check.headSha === headSha
    && check.name === input.name
    && check.status === input.status
    && check.conclusion === String(input.conclusion ?? '')
    && check.externalId === String(input.externalId ?? '')
    && check.detailsUrl === String(input.detailsUrl ?? '')
    && check.title === String(input.title ?? '')
    && check.summary === String(input.summary ?? '');
}

function governanceGateMutation(
  plan: ControlPlan,
  mutationKey: string,
): Extract<ControlMutation, {
  type:
    | 'copilot-gate-check.upsert'
    | 'blocking-comment.upsert'
    | 'blocking-comment.delete'
    | 'copilot-review.request';
}> {
  const mutation = plan.mutations.find((candidate) => candidate.key === mutationKey);
  if (!mutation || ![
    'copilot-gate-check.upsert',
    'blocking-comment.upsert',
    'blocking-comment.delete',
    'copilot-review.request',
  ].includes(mutation.type)) {
    throw new Error(`Control plan has no Gate mutation ${mutationKey}`);
  }
  return mutation as Extract<ControlMutation, {
    type:
      | 'copilot-gate-check.upsert'
      | 'blocking-comment.upsert'
      | 'blocking-comment.delete'
      | 'copilot-review.request';
  }>;
}

export async function planGovernanceCopilotGate(
  context: PullRequestControlContext,
  facts: GovernanceCopilotGateFacts | null,
): Promise<ControlDecision<'governance'>> {
  if (!facts) {
    throw new TypeError('Copilot Gate planning requires live resource facts');
  }
  if (!context.manifest.manifest.features.copilotReview) {
    const actor = canonicalGateActor(facts.actor);
    const gateEvidenceDigest = await controlJsonDigest({
      featureEnabled: false,
      actor,
    });
    const [checks, comments] = await Promise.all([
      inspectCopilotGateCheckResources(context.subject, facts.checks),
      inspectCopilotGateBlockingCommentResources(context.subject, actor, facts.comments),
    ]);
    const resourceProblem = !validGateActor(context.subject, actor)
      ? 'Authenticated GitHub App actor identity is malformed'
      : checks.state === 'ambiguous' || checks.state === 'malformed'
        ? 'Copilot Gate Check resources require manual repair'
        : comments.state === 'ambiguous' || comments.state === 'malformed'
          ? 'Blocking comment resources require manual repair'
          : '';
    const disabledDecision: CopilotGateDecision = {
      state: 'passed',
      checkStatus: 'completed',
      checkConclusion: 'success',
      failureKind: '',
      passingSignal: 'no-current-comments-with-known-conclusion',
      passingConclusionSource: '',
      blocking: [],
      suggestions: [],
      unclassified: [],
    };
    const mutations: ControlMutationIntent[] = [];
    const check = checks.resources[0];
    if (checks.state === 'none' || checks.state === 'one') {
      const mode = check ? 'update' : 'create';
      const input = checkInput(
        context,
        resourceProblem ? actionRequiredDecision(resourceProblem) : disabledDecision,
        gateEvidenceDigest,
        mode,
        Boolean(resourceProblem),
      );
      if (!check || !checkMatchesInput(check, input, context.subject.pullRequest.headSha)) {
        mutations.push(check
          ? {
              type: 'copilot-gate-check.upsert',
              key: copilotGateCheckKey,
              principal: 'installation',
              mode: 'update',
              checkRunId: check.id,
              input: input as CheckRunUpdate,
              observedGateEvidenceDigest: gateEvidenceDigest,
              observedCheckSetDigest: checks.setDigest,
              observedCheckDigest: await controlJsonDigest(check),
            } satisfies UpdateCopilotGateCheckIntent
          : {
              type: 'copilot-gate-check.upsert',
              key: copilotGateCheckKey,
              principal: 'installation',
              mode: 'create',
              input: input as CheckRunCreate,
              observedGateEvidenceDigest: gateEvidenceDigest,
              observedCheckSetDigest: checks.setDigest,
            } satisfies CreateCopilotGateCheckIntent);
      }
    }
    const existingComment = comments.state === 'one' ? comments.resources[0] : undefined;
    if (existingComment) {
      mutations.push({
        type: 'blocking-comment.delete',
        key: copilotGateBlockingCommentKey,
        principal: 'installation',
        commentId: existingComment.id,
        actorId: actor.id,
        actorLogin: actor.login,
        resourceMarker: copilotGateBlockingCommentResourceMarker,
        observedGateEvidenceDigest: gateEvidenceDigest,
        observedCommentSetDigest: comments.setDigest,
        observedBodyDigest: await controlJsonDigest(existingComment.body),
      } satisfies DeleteBlockingCommentIntent);
    }
    const result = {
      operation: 'governance' as const,
      // Runtime v2 deliberately forbids ignored plans with mutations. A
      // disabled feature is ignored only after its managed Check/comment
      // resources have already converged; cleanup itself is a settled pass.
      state: resourceProblem
        ? 'action_required' as const
        : mutations.length
          ? 'passed' as const
          : 'ignored' as const,
      summary: resourceProblem || 'Copilot review is disabled',
    };
    return {
      result,
      plan: await finalizeControlPlan({
        objective: 'governance',
        subject: context.subject,
        pullRequest: context.pull,
        snapshot: {
          featureEnabled: false,
          actor,
          gateEvidenceDigest,
          checkResources: compactResourceAudit(checks),
          commentResources: compactResourceAudit(comments),
          resourceProblem,
        },
        outcome: { state: result.state, summary: result.summary },
        mutations,
      }),
    };
  }

  const evidence = await governanceCopilotGateEvidence(context, facts);
  const gateEvidenceDigest = await controlJsonDigest(evidence);
  const [checks, comments] = await Promise.all([
    inspectCopilotGateCheckResources(context.subject, facts.checks),
    inspectCopilotGateBlockingCommentResources(context.subject, evidence.actor, facts.comments),
  ]);
  const copilotReviews = evidence.reviews.filter((review) => (
    review.state !== 'PENDING' && isCopilotLogin(review.reviewer)
  ));
  const findings = copilotThreadFindings(evidence.threads, {
    fallbackTitle: 'Copilot review comment',
    headSha: context.subject.pullRequest.headSha,
  });
  const hasCurrentHeadCopilotThread = evidence.threads.some((thread) => (
    !thread.isResolved
    && !thread.isOutdated
    && thread.comments.some((comment) => (
      comment.pullRequestReview.commit.oid === context.subject.pullRequest.headSha
      && !['DISMISSED', 'PENDING'].includes(comment.pullRequestReview.state)
    ))
  ));
  const threadReviewMismatch = hasCurrentHeadCopilotThread && copilotReviews.length === 0;
  if (threadReviewMismatch) {
    findings.unclassified.push({
      title: 'Current-head Copilot thread has no matching submitted review',
      url: '',
    });
  }
  if (evidence.malformed) {
    findings.unclassified.push({
      title: 'Current-head Copilot review evidence is malformed',
      url: '',
    });
  }
  let decision = evaluateCopilotGate({ reviews: copilotReviews, findings });
  const resourceProblem = !validGateActor(context.subject, facts.actor)
    ? 'Authenticated GitHub App actor identity is malformed'
    : checks.state === 'ambiguous'
      ? 'Multiple App-owned Copilot Gate Checks exist for the current head'
      : checks.state === 'malformed'
        ? 'Copilot Gate Check resources are malformed'
        : comments.state === 'ambiguous'
          ? 'Multiple App-owned blocking comments exist'
          : comments.state === 'malformed'
            ? 'Blocking comment resources are malformed'
            : '';
  if (resourceProblem) decision = actionRequiredDecision(resourceProblem);

  const mutations: ControlMutationIntent[] = [];
  const check = checks.resources[0];
  if (checks.state === 'none' || checks.state === 'one') {
    const mode = check ? 'update' : 'create';
    const input = checkInput(
      context,
      decision,
      gateEvidenceDigest,
      mode,
      Boolean(resourceProblem),
    );
    if (!check || !checkMatchesInput(check, input, context.subject.pullRequest.headSha)) {
      mutations.push(check
        ? {
            type: 'copilot-gate-check.upsert',
            key: copilotGateCheckKey,
            principal: 'installation',
            mode: 'update',
            checkRunId: check.id,
            input: input as CheckRunUpdate,
            observedGateEvidenceDigest: gateEvidenceDigest,
            observedCheckSetDigest: checks.setDigest,
            observedCheckDigest: await controlJsonDigest(check),
          } satisfies UpdateCopilotGateCheckIntent
        : {
            type: 'copilot-gate-check.upsert',
            key: copilotGateCheckKey,
            principal: 'installation',
            mode: 'create',
            input: input as CheckRunCreate,
            observedGateEvidenceDigest: gateEvidenceDigest,
            observedCheckSetDigest: checks.setDigest,
          } satisfies CreateCopilotGateCheckIntent);
    }
  }

  if (!resourceProblem) {
    const models = copilotFailureModels({
      decision,
      coreHandlers: evidence.coreHandlers,
      contributorHandlers: evidence.contributors,
      botLogins: [
        context.subject.platform.appSlug,
        'copilot-pull-request-reviewer[bot]',
      ],
    });
    const failures: BlockingFailure[] = models.map((model) => {
      const sourceFindings = model.source === 'copilot-review:blocking-comments'
        ? decision.blocking
        : model.source === 'copilot-review:comment-protocol'
          ? decision.unclassified
          : [];
      const items = sourceFindings.length
        ? sourceFindings.map((finding) => (
            safeVisibleDetail(
              finding.url ? `${finding.title} — ${finding.url}` : finding.title,
            )
          ))
        : model.items.map(safeVisibleDetail);
      return {
        source: model.source,
        title: failureTitle(model.presentation),
        handlers: model.handlers,
        details: failureDetails(model.presentation, items),
      };
    });
    const existing = comments.resources[0];
    if (failures.length) {
      const body = renderBlockingComment(context.subject.pullRequest.headSha, failures);
      if (!existing || existing.body !== body) {
        mutations.push(existing
          ? {
              type: 'blocking-comment.upsert',
              key: copilotGateBlockingCommentKey,
              principal: 'installation',
              mode: 'update',
              commentId: existing.id,
              actorId: evidence.actor.id,
              actorLogin: evidence.actor.login,
              resourceMarker: copilotGateBlockingCommentResourceMarker,
              body,
              observedGateEvidenceDigest: gateEvidenceDigest,
              observedCommentSetDigest: comments.setDigest,
              observedBodyDigest: await controlJsonDigest(existing.body),
            } satisfies UpdateBlockingCommentIntent
          : {
              type: 'blocking-comment.upsert',
              key: copilotGateBlockingCommentKey,
              principal: 'installation',
              mode: 'create',
              actorId: evidence.actor.id,
              actorLogin: evidence.actor.login,
              resourceMarker: copilotGateBlockingCommentResourceMarker,
              body,
              observedGateEvidenceDigest: gateEvidenceDigest,
              observedCommentSetDigest: comments.setDigest,
            } satisfies CreateBlockingCommentIntent);
      }
    } else if (existing) {
      mutations.push({
        type: 'blocking-comment.delete',
        key: copilotGateBlockingCommentKey,
        principal: 'installation',
        commentId: existing.id,
        actorId: evidence.actor.id,
        actorLogin: evidence.actor.login,
        resourceMarker: copilotGateBlockingCommentResourceMarker,
        observedGateEvidenceDigest: gateEvidenceDigest,
        observedCommentSetDigest: comments.setDigest,
        observedBodyDigest: await controlJsonDigest(existing.body),
      } satisfies DeleteBlockingCommentIntent);
    }
  }

  const request = requestDecision({
    author: evidence.author,
    headSha: evidence.headSha,
    malformed: evidence.malformed,
    requestedReviewers: evidence.requestedReviewers,
    reviews: evidence.reviews,
  });
  if (!resourceProblem
    && !evidence.malformed
    && !threadReviewMismatch
    && request.state === 'request') {
    mutations.push({
      type: 'copilot-review.request',
      key: copilotReviewRequestKey,
      principal: 'human',
      evidenceProtocol: 'copilot-gate-v1',
      observedEvidenceDigest: gateEvidenceDigest,
    });
  }

  const outcomeState = resourceProblem ? 'action_required' as const : decision.state;
  const summary = resourceProblem
    || decision.failureKind
    || decision.passingSignal
    || 'waiting-for-review';
  const result = {
    operation: 'governance' as const,
    state: outcomeState,
    summary,
    details: {
      evidence: compactGateEvidenceAudit(evidence, gateEvidenceDigest),
      decision: compactGateDecisionAudit(decision),
      resourceProblem,
    },
  };
  return {
    result,
    plan: await finalizeControlPlan({
      objective: 'governance',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: {
        featureEnabled: true,
        evidence: compactGateEvidenceAudit(evidence, gateEvidenceDigest),
        checkResources: compactResourceAudit(checks),
        commentResources: compactResourceAudit(comments),
        decision: compactGateDecisionAudit(decision),
        resourceProblem,
      },
      outcome: { state: result.state, summary: result.summary },
      mutations,
    }),
  };
}

async function gatePlanStillCurrent(
  plan: ControlPlan,
  context: PullRequestControlContext,
  facts: GovernanceCopilotGateFacts,
  observedGateEvidenceDigest: string,
): Promise<boolean> {
  try {
    assertControlPlanSubject(plan, context.subject);
  } catch {
    return false;
  }
  if (await controlJsonDigest(controlPullRequestInput(context.pull)) !== plan.pullRequestDigest) {
    return false;
  }
  if (!context.manifest.manifest.features.copilotReview) {
    return await controlJsonDigest({
      featureEnabled: false,
      actor: canonicalGateActor(facts.actor),
    }) === observedGateEvidenceDigest;
  }
  return await controlJsonDigest(
    await governanceCopilotGateEvidence(context, facts),
  ) === observedGateEvidenceDigest;
}

export async function inspectGovernanceCopilotGateMutation(
  plan: ControlPlan,
  mutationKey: string,
  context: PullRequestControlContext,
  facts: GovernanceCopilotGateFacts,
): Promise<CopilotGateMutationInspection> {
  await verifyControlPlan(plan);
  const mutation = governanceGateMutation(plan, mutationKey);
  if (mutation.type === 'copilot-review.request') {
    if (mutation.evidenceProtocol !== 'copilot-gate-v1') {
      return { state: 'stale-plan' };
    }
    try {
      assertControlPlanSubject(plan, context.subject);
    } catch {
      return { state: 'stale-plan' };
    }
    if (await controlJsonDigest(controlPullRequestInput(context.pull)) !== plan.pullRequestDigest
      || !context.manifest.manifest.features.copilotReview) {
      return { state: 'stale-plan' };
    }
    const evidence = await governanceCopilotGateEvidence(context, facts);
    if (evidence.malformed || evidence.author.kind !== 'machine') {
      return { state: 'stale-plan' };
    }
    const submittedCopilotReviews = evidence.reviews.filter((review) => (
      review.state !== 'PENDING' && isCopilotLogin(review.reviewer)
    ));
    const hasUnboundCurrentThread = evidence.threads.some((thread) => (
      !thread.isResolved
      && !thread.isOutdated
      && thread.comments.some((comment) => (
        comment.pullRequestReview.commit.oid === context.subject.pullRequest.headSha
        && !['DISMISSED', 'PENDING'].includes(comment.pullRequestReview.state)
      ))
    )) && submittedCopilotReviews.length === 0;
    if (hasUnboundCurrentThread) return { state: 'stale-plan' };
    const request = requestDecision({
      author: evidence.author,
      headSha: evidence.headSha,
      malformed: evidence.malformed,
      requestedReviewers: evidence.requestedReviewers,
      reviews: evidence.reviews,
    });
    if (request.state === 'not-needed') return { state: 'converged' };
    if (request.state !== 'request'
      || await controlJsonDigest(evidence) !== mutation.observedEvidenceDigest) {
      return { state: 'stale-plan' };
    }
    return { state: 'ready' };
  }
  if (!await gatePlanStillCurrent(
    plan,
    context,
    facts,
    mutation.observedGateEvidenceDigest,
  )) {
    return { state: 'stale-plan' };
  }
  if (mutation.type === 'copilot-gate-check.upsert') {
    const inspection = await inspectCopilotGateCheckResources(plan.subject, facts.checks);
    if (inspection.state === 'ambiguous' || inspection.state === 'malformed') {
      return { state: 'stale-plan' };
    }
    const resource = inspection.resources[0];
    if (resource && checkMatchesInput(
      resource,
      mutation.input,
      plan.subject.pullRequest.headSha,
    )) {
      return { state: 'converged', resourceId: resource.id };
    }
    if (inspection.setDigest !== mutation.observedCheckSetDigest) {
      return { state: 'stale-plan' };
    }
    if (mutation.mode === 'create') return resource ? { state: 'stale-plan' } : { state: 'ready' };
    if (!resource
      || resource.id !== mutation.checkRunId
      || await controlJsonDigest(resource) !== mutation.observedCheckDigest) {
      return { state: 'stale-plan' };
    }
    return { state: 'ready' };
  }

  const inspection = await inspectCopilotGateBlockingCommentResources(
    plan.subject,
    facts.actor,
    facts.comments,
  );
  if (inspection.state === 'ambiguous' || inspection.state === 'malformed') {
    return { state: 'stale-plan' };
  }
  const resource = inspection.resources[0];
  if (mutation.type === 'blocking-comment.delete') {
    if (facts.targetComment === null) {
      return resource
        ? { state: 'stale-plan' }
        : { state: 'converged', resourceId: mutation.commentId };
    }
    if (facts.targetComment === undefined) return { state: 'stale-plan' };
    const exact = canonicalGateComment(facts.targetComment);
    if (!exact
      || exact.id !== mutation.commentId
      || !resource
      || await controlJsonDigest(exact) !== await controlJsonDigest(resource)) {
      return { state: 'stale-plan' };
    }
  } else if (resource?.body === mutation.body) {
    return { state: 'converged', resourceId: resource.id };
  }
  if (inspection.setDigest !== mutation.observedCommentSetDigest) {
    return { state: 'stale-plan' };
  }
  if (mutation.type === 'blocking-comment.upsert' && mutation.mode === 'create') {
    return resource ? { state: 'stale-plan' } : { state: 'ready' };
  }
  if (!resource
    || resource.id !== mutation.commentId
    || await controlJsonDigest(resource.body) !== mutation.observedBodyDigest) {
    return { state: 'stale-plan' };
  }
  return { state: 'ready' };
}

export async function recoverGovernanceCopilotGateMutation(
  plan: ControlPlan,
  mutationKey: string,
  facts: GovernanceCopilotGateRecoveryFacts,
): Promise<CopilotGateRecoveryInspection> {
  await verifyControlPlan(plan);
  const mutation = governanceGateMutation(plan, mutationKey);
  if (mutation.type === 'copilot-review.request') {
    throw new Error('Human Copilot requests use the dedicated read-only recovery inspector');
  }
  if (mutation.type === 'copilot-gate-check.upsert') {
    const inspection = await inspectCopilotGateCheckResources(plan.subject, facts.checks);
    if (inspection.state === 'ambiguous' || inspection.state === 'malformed') {
      return { state: 'unknown' };
    }
    const resource = inspection.resources[0];
    return resource
      && (mutation.mode === 'create' || resource.id === mutation.checkRunId)
      && checkMatchesInput(
      resource,
      mutation.input,
      plan.subject.pullRequest.headSha,
    )
      ? { state: 'converged', resourceId: resource.id }
      : { state: 'unknown' };
  }
  if (mutation.type === 'blocking-comment.delete') {
    return facts.targetComment === null
      ? { state: 'converged', resourceId: mutation.commentId }
      : { state: 'unknown' };
  }
  const inspection = await inspectCopilotGateBlockingCommentResources(
    plan.subject,
    facts.actor,
    facts.comments,
  );
  if (inspection.state === 'ambiguous' || inspection.state === 'malformed') {
    return { state: 'unknown' };
  }
  const resource = inspection.resources[0];
  return resource
    && (mutation.mode === 'create' || resource.id === mutation.commentId)
    && resource.body === mutation.body
    ? { state: 'converged', resourceId: resource.id }
    : { state: 'unknown' };
}
