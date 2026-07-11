import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  blockingFailuresMarker,
  copilotCommentSeverity,
  copilotCommentTitle,
  copilotFailureModels,
  copilotThreadFindings,
  coreReviewersToRequest,
  evaluateCopilotGate,
  evaluateMainAuthorization,
  mainAuthorizationFailureModel,
  nextBlockingFailuresState,
  sanitizeCopilotCommentTitle,
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

  it.each([
    { name: 'waiting', reviews: [], findings: {}, state: 'pending', conclusion: undefined, failure: '' },
    { name: 'request failed', reviews: [], findings: {}, requestFailed: true, state: 'failed', conclusion: 'failure', failure: 'request-failed' },
    { name: 'blocking', reviews: [{}], findings: { blocking: [finding('block')] }, state: 'failed', conclusion: 'failure', failure: 'blocking-comments' },
    { name: 'unclassified', reviews: [{}], findings: { unclassified: [finding('format')] }, state: 'failed', conclusion: 'failure', failure: 'comment-protocol' },
    { name: 'suggestion only', reviews: [{}], findings: { suggestions: [finding('suggest')] }, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'fixed conclusion', reviews: [{ body: protocol.copilot.fixedConclusion }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'official no comments', reviews: [{ body: protocol.copilot.noNewComments }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
    { name: 'resolved comments', reviews: [{ body: protocol.copilot.resolvedComments }], findings: {}, state: 'passed', conclusion: 'success', failure: '' },
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
});
