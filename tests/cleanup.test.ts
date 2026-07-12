import { describe, expect, it } from 'vitest';
import {
  blockingFailuresMarker,
  cleanupEphemeralCommentMarkers,
  closeStatusMarker,
  evaluatePullRequestCleanup,
} from '../packages/core/src/index.js';

describe('PR Cleanup policy', () => {
  it('keeps canonical and legacy temporary markers distinct from the durable close marker', () => {
    expect(cleanupEphemeralCommentMarkers).toEqual([
      blockingFailuresMarker,
      '<!-- workflow:main-authorization-gate -->',
      '<!-- workflow:copilot-review-gate -->',
    ]);
    expect(cleanupEphemeralCommentMarkers).not.toContain(closeStatusMarker);
  });

  it('returns no notification for a pull request closed without merge', () => {
    expect(evaluatePullRequestCleanup({ number: 7, merged: false })).toEqual({
      merged: false,
      notification: null,
    });
  });

  it('derives a merged notification from trusted pull facts and contributor metadata', () => {
    const result = evaluatePullRequestCleanup({
      number: 7,
      merged: true,
      mergeCommitSha: 'A'.repeat(40),
      title: 'feat: cleanup',
      body: '<!-- workflow:source-actor:external-dev -->',
      authorLogin: 'splrad-steward[bot]',
      headRef: 'feature/cleanup',
      baseRef: 'main',
      mergedBy: 'reviewer',
    }, { botLogins: ['splrad-steward'] });
    expect(result).toEqual({
      merged: true,
      notification: {
        pullNumber: 7,
        title: 'feat: cleanup',
        sourceRef: 'feature/cleanup',
        targetRef: 'main',
        author: 'external-dev',
        mergedBy: 'reviewer',
        mergeCommitSha: 'a'.repeat(40),
      },
    });
  });

  it('fails closed when a merged notification lacks authoritative presentation evidence', () => {
    const valid = {
      number: 7,
      merged: true,
      mergeCommitSha: 'a'.repeat(40),
      title: 'feat: cleanup',
      headRef: 'feature/cleanup',
      baseRef: 'main',
    };
    expect(() => evaluatePullRequestCleanup({ ...valid, mergeCommitSha: 'short' }))
      .toThrow('valid merge commit SHA');
    expect(() => evaluatePullRequestCleanup({ ...valid, title: '' }))
      .toThrow('title, source branch, and target branch');
    expect(() => evaluatePullRequestCleanup({ ...valid, number: 0 }))
      .toThrow('positive pull request number');
  });
});
