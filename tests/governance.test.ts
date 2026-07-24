import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  blockingFailuresMarker,
  classifyPullRequestAuthor,
  copilotCommentSeverity,
  copilotCommentTitle,
  copilotFailureModels,
  copilotThreadFindings,
  coreReviewersToRequest,
  evaluateCopilotGate,
  evaluateMainAuthorization,
  mainAuthorizationFailureModel,
  nextBlockingFailuresState,
  orderedBlockingFailures,
  planCopilotReviewRequest,
  sanitizeCopilotCommentTitle,
  selectCurrentHeadReviews,
} from '../packages/core/src/index.js';

const protocol = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/governance.json', import.meta.url),
  'utf8',
)) as {
  blockingComment: { marker: string; legacyMarkers: string[]; sourceOrder: string[] };
  copilot: Record<string, string>;
};

function finding(title: string) {
  return { title, url: `https://example.test/${encodeURIComponent(title)}` };
}

describe('main authorization decisions', () => {
  it.each([
    {
      name: 'unidentified author without manual approval',
      input: { contributors: ['core'], unidentifiedAuthors: ['External'], trustedApprovers: [], trustedManualApprovers: [] },
      status: 'failed_unidentified_commit_authors',
      state: 'failed',
    },
    {
      name: 'unidentified author with manual approval',
      input: { contributors: ['core'], unidentifiedAuthors: ['External'], trustedApprovers: ['core'], trustedManualApprovers: ['core'] },
      status: 'passed_manual_core_approval_for_unidentified_authors',
      state: 'passed',
    },
    {
      name: 'missing real contributors',
      input: { contributors: [], unidentifiedAuthors: [], trustedApprovers: [], trustedManualApprovers: [] },
      status: 'failed_missing_real_contributors',
      state: 'failed',
    },
    {
      name: 'external contributor without manual approval',
      input: { contributors: ['external'], unidentifiedAuthors: [], trustedApprovers: [], trustedManualApprovers: [] },
      status: 'failed_untrusted_contributor_missing_manual_approval',
      state: 'failed',
    },
    {
      name: 'external contributor with manual approval',
      input: { contributors: ['external'], unidentifiedAuthors: [], trustedApprovers: ['core'], trustedManualApprovers: ['core'] },
      status: 'passed_manual_core_approval',
      state: 'passed',
    },
    {
      name: 'trusted contributor with approval',
      input: { contributors: ['core'], unidentifiedAuthors: [], trustedApprovers: ['CORE'], trustedManualApprovers: [] },
      status: 'passed_all_contributors_trusted_with_approval',
      state: 'passed',
    },
    {
      name: 'trusted contributor without approval',
      input: { contributors: ['core'], unidentifiedAuthors: [], trustedApprovers: [], trustedManualApprovers: [] },
      status: 'failed_trusted_contributors_missing_approval',
      state: 'failed',
    },
  ])('$name', ({ input, status, state }) => {
    expect(evaluateMainAuthorization({ ...input, trustedDevelopers: ['core'] })).toMatchObject({ status, state });
  });

  it('plans review requests without the PR author, prior requests, reviews, or bots', () => {
    expect(coreReviewersToRequest({
      trusted: ['author', 'core-one', 'core-two', 'dependabot[bot]'],
      author: 'AUTHOR',
      requested: ['CORE-ONE'],
      reviewed: ['CORE-TWO'],
    })).toEqual({
      eligible: ['core-one', 'core-two'],
      reviewed: ['CORE-TWO'],
      missing: [],
    });
  });

  it('returns a presentation model instead of consumer-facing copy', () => {
    const decision = evaluateMainAuthorization({
      contributors: ['external'],
      unidentifiedAuthors: [],
      trustedDevelopers: ['core'],
      trustedApprovers: [],
      trustedManualApprovers: [],
    });
    expect(mainAuthorizationFailureModel({
      decision,
      coreHandlers: ['core'],
      reviewRequest: { ok: true, eligible: ['core'] },
    })).toEqual({
      source: 'main-authorization',
      presentation: 'main.approval-required',
      handlers: ['core'],
      items: [],
      reviewRequestState: 'confirmed',
    });
  });
});

describe('Copilot governance protocol', () => {
  it('classifies authors only from trusted live GitHub identity fields', () => {
    expect(classifyPullRequestAuthor({ login: 'contributor', type: 'User' }))
      .toEqual({ kind: 'human', login: 'contributor' });
    expect(classifyPullRequestAuthor({ login: 'dependabot[bot]', type: 'Bot' }))
      .toEqual({ kind: 'machine', login: 'dependabot[bot]' });
    expect(classifyPullRequestAuthor({ login: 'automation', type: 'App' }))
      .toEqual({ kind: 'machine', login: 'automation' });
    expect(classifyPullRequestAuthor({ login: 'dependabot[bot]', type: 'User' }).kind)
      .toBe('unknown');
    expect(classifyPullRequestAuthor({ login: '', type: 'Bot' }).kind).toBe('unknown');
    expect(classifyPullRequestAuthor({ login: 'contributor' }).kind).toBe('unknown');
  });

  it('selects only the latest non-dismissed review for the current head', () => {
    const head = 'c'.repeat(40);
    const selected = selectCurrentHeadReviews([
      {
        id: 1,
        state: 'COMMENTED',
        commit_id: head,
        submitted_at: '2026-07-24T00:00:00Z',
        user: { login: protocol.copilot.reviewer },
        body: protocol.copilot.noNewComments,
      },
      {
        id: 2,
        state: 'DISMISSED',
        commit_id: head,
        submitted_at: '2026-07-24T00:01:00Z',
        user: { login: protocol.copilot.reviewer },
        body: protocol.copilot.noNewComments,
      },
      {
        id: 3,
        state: 'COMMENTED',
        commit_id: 'd'.repeat(40),
        submitted_at: '2026-07-24T00:02:00Z',
        user: { login: protocol.copilot.reviewer },
        body: protocol.copilot.noNewComments,
      },
    ], head);
    expect(selected).toEqual({ malformed: false, pendingReviews: [], reviews: [] });
  });

  it('plans explicit Copilot requests only for machine-authored current heads', () => {
    const headSha = 'c'.repeat(40);
    const machine = classifyPullRequestAuthor({ login: 'dependabot[bot]', type: 'Bot' });
    const human = classifyPullRequestAuthor({ login: 'contributor', type: 'User' });
    const unknown = classifyPullRequestAuthor({ login: 'contributor' });
    expect(planCopilotReviewRequest({ author: human, headSha })).toMatchObject({
      state: 'observe-native',
      reason: 'human-native',
    });
    expect(planCopilotReviewRequest({ author: unknown, headSha })).toMatchObject({
      state: 'action-required',
      reason: 'author-unknown',
    });
    expect(planCopilotReviewRequest({
      author: unknown,
      headSha,
      requestedReviewers: [{ login: protocol.copilot.reviewer }],
    })).toMatchObject({
      state: 'action-required',
      reason: 'author-unknown',
    });
    expect(planCopilotReviewRequest({ author: machine, headSha })).toMatchObject({
      state: 'request',
      reason: 'machine-request',
    });
    expect(planCopilotReviewRequest({
      author: machine,
      headSha,
      requestedReviewers: [{ login: protocol.copilot.reviewer }],
    })).toMatchObject({
      state: 'not-needed',
      reason: 'copilot-pending',
    });
    expect(planCopilotReviewRequest({
      author: machine,
      headSha,
      reviews: [{
        id: 1,
        state: 'COMMENTED',
        commit_id: headSha,
        submitted_at: '2026-07-24T00:00:00Z',
        user: { login: protocol.copilot.reviewer },
      }],
    })).toMatchObject({
      state: 'not-needed',
      reason: 'copilot-reviewed-current-head',
    });
    expect(planCopilotReviewRequest({
      author: machine,
      headSha,
      reviews: [{
        id: 3,
        state: 'DISMISSED',
        commit_id: headSha,
        submitted_at: '2026-07-24T00:01:00Z',
        user: { login: protocol.copilot.reviewer },
      }, {
        id: 4,
        state: 'PENDING',
        commit_id: headSha,
        user: { login: protocol.copilot.reviewer },
      }],
    })).toMatchObject({
      state: 'not-needed',
      reason: 'copilot-pending',
    });
    expect(planCopilotReviewRequest({
      author: machine,
      headSha,
      reviews: [{
        id: 2,
        state: 'PENDING',
        commit_id: headSha,
        user: { login: protocol.copilot.reviewer },
      }],
    })).toMatchObject({
      state: 'not-needed',
      reason: 'copilot-pending',
    });
    expect(planCopilotReviewRequest({
      author: machine,
      headSha,
      reviews: [{
        state: 'COMMENTED',
        user: { login: protocol.copilot.reviewer },
      }],
    })).toMatchObject({
      state: 'action-required',
      reason: 'review-evidence-malformed',
    });
  });

  it('preserves severity and concise title parsing', () => {
    expect(copilotCommentSeverity(protocol.copilot.blocking)).toBe('blocking');
    expect(copilotCommentSeverity(protocol.copilot.suggestion)).toBe('suggestion');
    expect(copilotCommentSeverity('前言\n严重程度：阻断')).toBe('');
    expect(copilotCommentTitle(protocol.copilot.blocking)).toBe('必须修复');
    expect(copilotCommentTitle('')).toBe('');
    expect(copilotCommentTitle('', 'Copilot comment')).toBe('Copilot comment');
    expect(sanitizeCopilotCommentTitle('A'.repeat(80))).toHaveLength(60);
  });

  it('classifies only active Copilot review-thread comments', () => {
    const findings = copilotThreadFindings([
      {
        comments: [
          { author: { login: protocol.copilot.reviewer }, body: protocol.copilot.blocking, url: 'blocking' },
          { author: { login: 'human' }, body: '严重程度：阻断', url: 'human' },
        ],
      },
      {
        isResolved: true,
        comments: [{ author: { login: protocol.copilot.reviewer }, body: protocol.copilot.blocking }],
      },
      {
        comments: { nodes: [{ pullRequestReview: { author: { login: protocol.copilot.reviewer } }, body: 'missing protocol' }] },
      },
    ]);
    expect(findings.blocking.map((item) => item.title)).toEqual(['必须修复']);
    expect(findings.unclassified.map((item) => item.title)).toEqual(['missing protocol']);
  });

  it('binds Copilot review-thread evidence to the current head and review state', () => {
    const head = 'c'.repeat(40);
    const comment = (reviewHead: string, state = 'COMMENTED') => ({
      author: { login: protocol.copilot.reviewer },
      body: protocol.copilot.blocking,
      url: `https://example.test/${reviewHead.slice(0, 1)}`,
      pullRequestReview: {
        author: { login: protocol.copilot.reviewer },
        commit: { oid: reviewHead },
        state,
      },
    });
    const findings = copilotThreadFindings([
      { comments: [comment(head)] },
      { comments: [comment('d'.repeat(40))] },
      { comments: [comment(head, 'DISMISSED')] },
      { comments: [comment(head, 'PENDING')] },
      {
        comments: [{
          author: { login: protocol.copilot.reviewer },
          body: protocol.copilot.blocking,
          url: 'https://example.test/unbound',
          pullRequestReview: {
            author: { login: protocol.copilot.reviewer },
            state: 'COMMENTED',
          },
        }],
      },
    ], { headSha: head });
    expect(findings.blocking).toHaveLength(1);
    expect(findings.unclassified).toEqual([{
      title: '必须修复',
      url: 'https://example.test/unbound',
    }]);
  });

  it.each([
    { name: 'waiting', reviews: [], findings: {}, state: 'pending', conclusion: undefined, failure: '' },
    { name: 'request failed', reviews: [], findings: {}, requestFailed: true, state: 'failed', conclusion: 'failure', failure: 'request-failed' },
    { name: 'blocking', reviews: [{}], findings: { blocking: [finding('block')] }, state: 'failed', conclusion: 'failure', failure: 'blocking-comments' },
    { name: 'unclassified', reviews: [{}], findings: { unclassified: [finding('format')] }, state: 'failed', conclusion: 'failure', failure: 'comment-protocol' },
    { name: 'suggestion only', reviews: [{}], findings: { suggestions: [finding('suggest')] }, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'fixed conclusion', reviews: [{ body: protocol.copilot.fixedConclusion }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'official no comments', reviews: [{ body: protocol.copilot.noNewComments }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'official pull request overview', reviews: [{ body: '## Pull request overview\n\nSummarizes the current changes.' }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'resolved comments', reviews: [{ body: protocol.copilot.resolvedComments }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'resolved singular comment', reviews: [{ body: 'Copilot reviewed 1 out of 1 changed files in this pull request and generated 1 comment.' }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'unknown conclusion', reviews: [{ body: 'Review complete.' }], findings: {}, state: 'failed', conclusion: 'failure', failure: 'passing-conclusion' },
  ])('$name', ({ reviews, findings, requestFailed, state, conclusion, failure }) => {
    const decision = evaluateCopilotGate({
      reviews,
      findings,
      ...(requestFailed === undefined ? {} : { requestFailed }),
    });
    expect(decision.state).toBe(state);
    expect(decision.checkConclusion).toBe(conclusion);
    expect(decision.failureKind).toBe(failure);
  });

  it('creates separate contributor and maintainer failure models', () => {
    const decision = evaluateCopilotGate({
      reviews: [{}],
      findings: { blocking: [finding('block')], unclassified: [finding('format')] },
    });
    expect(copilotFailureModels({
      decision,
      coreHandlers: ['core'],
      contributorHandlers: ['contributor'],
    })).toEqual([
      {
        source: 'copilot-review:blocking-comments',
        presentation: 'copilot.blocking-comments',
        handlers: ['contributor'],
        items: ['block'],
      },
      {
        source: 'copilot-review:comment-protocol',
        presentation: 'copilot.comment-protocol',
        handlers: ['core'],
        items: ['format'],
      },
    ]);
  });
});

describe('aggregate comment compatibility', () => {
  it('keeps the established marker and source-family replacement order', () => {
    expect(blockingFailuresMarker).toBe(protocol.blockingComment.marker);
    const state = nextBlockingFailuresState({
      head: 'head-a',
      failures: [{ source: 'main-authorization', title: 'main' }, { source: 'copilot-review', title: 'legacy' }],
    }, 'head-a', {
      sourcePrefix: 'copilot-review',
      failures: [
        { source: 'copilot-review:blocking-comments', title: 'block' },
        { source: 'copilot-review:comment-protocol', title: 'protocol' },
      ],
    });
    expect(state.failures.map((failure) => String(failure.source))).toEqual(protocol.blockingComment.sourceOrder.slice(0, 3));
  });

  it('renders source families in a stable order regardless of event arrival', () => {
    expect(orderedBlockingFailures([
      { source: 'copilot-review:passing-conclusion' },
      { source: 'main-authorization' },
      { source: 'copilot-review:blocking-comments' },
    ]).map((failure) => failure.source)).toEqual([
      'main-authorization',
      'copilot-review:blocking-comments',
      'copilot-review:passing-conclusion',
    ]);
  });
});
