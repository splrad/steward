import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  copilotReviewEvidence,
  inspectGovernanceCopilotReviewMutation,
  inspectGovernanceCopilotReviewRecovery,
  planGovernanceCopilotReview,
  verifyControlPlan,
  type PullRequestControlContext,
} from '../packages/control/src/index.js';
import type {
  GitHubPullRequest,
  GitHubPullRequestReview,
} from '../packages/github/src/index.js';
import {
  canonicalManifestJson,
  type LoadedManifest,
  type StewardManifest,
} from '../packages/manifest/src/index.js';

const headSha = 'c'.repeat(40);

function loadedManifest(copilotReview = true): LoadedManifest {
  const manifest: StewardManifest = {
    schemaVersion: 1,
    automation: {
      githubApp: {
        clientId: 'Iv23liuSr0qd4WLJdZhH',
        slug: 'splrad-steward',
      },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false,
      classification: false,
      dcoAdvisory: false,
      governance: true,
      copilotReview,
      release: false,
      webhookRelay: false,
    },
  };
  const canonicalJson = canonicalManifestJson(manifest);
  return {
    manifest,
    canonicalJson,
    configDigest: createHash('sha256').update(canonicalJson).digest('hex'),
    source: {
      path: '.github/steward.json',
      ref: 'main',
      blobSha: 'b'.repeat(40),
    },
  };
}

function pull(
  author: { login?: string; type?: string } | null = {
    login: 'dependabot[bot]',
    type: 'Bot',
  },
  requestedReviewers: GitHubPullRequest['requested_reviewers'] = [],
): GitHubPullRequest {
  return {
    number: 7,
    state: 'open',
    title: 'chore: update dependency',
    body: '',
    user: author,
    labels: [],
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'dependabot/npm/update', sha: headSha },
    requested_reviewers: requestedReviewers,
  };
}

function context(
  detail = pull(),
  copilotReview = true,
): PullRequestControlContext {
  const manifest = loadedManifest(copilotReview);
  return {
    subject: {
      repository: {
        id: 1_296_724_484,
        owner: 'splrad',
        name: 'steward',
        defaultBranch: 'main',
      },
      pullRequest: { number: detail.number, headSha: detail.head.sha },
      manifest: {
        blobSha: manifest.source.blobSha,
        configDigest: manifest.configDigest,
      },
      platform: {
        appId: 4_243_096,
        clientId: 'Iv23liuSr0qd4WLJdZhH',
        appSlug: 'splrad-steward',
      },
    },
    pull: detail,
    manifest,
  };
}

function copilotReview(
  overrides: Partial<GitHubPullRequestReview> = {},
): GitHubPullRequestReview {
  return {
    id: 100,
    state: 'COMMENTED',
    body: 'Copilot reviewed the pull request.',
    commit_id: headSha,
    submitted_at: '2026-07-26T12:00:00.000Z',
    user: { login: 'copilot-pull-request-reviewer[bot]' },
    ...overrides,
  };
}

describe('Control Governance Copilot request planning', () => {
  it('creates one fixed human intent for a machine-authored pull request', async () => {
    const decision = await planGovernanceCopilotReview(context(), []);

    expect(decision.result).toMatchObject({
      operation: 'governance',
      state: 'pending',
    });
    expect(decision.plan.mutations).toEqual([
      expect.objectContaining({
        type: 'copilot-review.request',
        key: 'copilot-review:request',
        principal: 'human',
        observedEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    await expect(verifyControlPlan(decision.plan)).resolves.toBeUndefined();
  });

  it('keeps human-authored, already-requested, and current-head-reviewed paths mutation-free', async () => {
    const human = await planGovernanceCopilotReview(
      context(pull({ login: 'maintainer', type: 'User' })),
      [],
    );
    const requested = await planGovernanceCopilotReview(
      context(pull(undefined, [{ login: 'copilot-pull-request-reviewer[bot]' }])),
      [],
    );
    const reviewed = await planGovernanceCopilotReview(
      context(),
      [copilotReview()],
    );

    for (const decision of [human, requested, reviewed]) {
      expect(decision.result.state).toBe('pending');
      expect(decision.plan.mutations).toEqual([]);
      await expect(verifyControlPlan(decision.plan)).resolves.toBeUndefined();
    }
  });

  it('fails closed for disabled features and malformed live evidence', async () => {
    const disabled = await planGovernanceCopilotReview(context(pull(), false), []);
    const missingRequestedReviewers = pull();
    delete missingRequestedReviewers.requested_reviewers;
    const malformed = await planGovernanceCopilotReview(
      context(missingRequestedReviewers),
      [],
    );
    const badReview = await planGovernanceCopilotReview(
      context(),
      [copilotReview({ commit_id: null })],
    );
    const badReviewerLogin = await planGovernanceCopilotReview(
      context(pull(undefined, [{ login: 'bad/login' }])),
      [],
    );
    const mentionedReviewerLogin = await planGovernanceCopilotReview(
      context(pull(undefined, [{ login: '@maintainer' }])),
      [],
    );

    expect(disabled.result.state).toBe('ignored');
    expect(disabled.plan.mutations).toEqual([]);
    expect(malformed.result.state).toBe('action_required');
    expect(badReview.result.state).toBe('action_required');
    expect(badReviewerLogin.result.state).toBe('action_required');
    expect(mentionedReviewerLogin.result.state).toBe('action_required');
  });

  it('canonicalizes reviewer and review ordering before binding the plan', async () => {
    const reviews = [
      copilotReview({
        id: 102,
        state: 'DISMISSED',
        submitted_at: '2026-07-26T12:02:00.000Z',
      }),
      copilotReview({
        id: 101,
        user: { login: 'maintainer' },
        submitted_at: '2026-07-26T12:01:00.000Z',
      }),
    ];
    const detail = pull(undefined, [
      { login: 'zeta' },
      { login: 'alpha' },
    ]);
    const forward = await planGovernanceCopilotReview(context(detail), reviews);
    const reverse = await planGovernanceCopilotReview(
      context({
        ...detail,
        requested_reviewers: [...detail.requested_reviewers!].reverse(),
      }),
      [...reviews].reverse(),
    );

    expect(reverse.plan).toEqual(forward.plan);
    expect(copilotReviewEvidence(detail, reviews)).toEqual(
      copilotReviewEvidence(
        { ...detail, requested_reviewers: [...detail.requested_reviewers!].reverse() },
        [...reviews].reverse(),
      ),
    );
  });

  it('rejects arbitrary principals, reviewer fields, and terminal gate claims', async () => {
    const { plan } = await planGovernanceCopilotReview(context(), []);
    const wrongPrincipal = structuredClone(plan) as unknown as Record<string, unknown>;
    (wrongPrincipal.mutations as Array<Record<string, unknown>>)[0]!.principal = 'installation';
    await expect(verifyControlPlan(wrongPrincipal as never)).rejects.toThrow();

    const arbitraryReviewer = structuredClone(plan) as unknown as Record<string, unknown>;
    (arbitraryReviewer.mutations as Array<Record<string, unknown>>)[0]!.reviewer = 'someone';
    await expect(verifyControlPlan(arbitraryReviewer as never)).rejects.toThrow();

    const terminal = structuredClone(plan) as unknown as Record<string, unknown>;
    (terminal.outcome as Record<string, unknown>).state = 'passed';
    await expect(verifyControlPlan(terminal as never)).rejects.toThrow();
  });
});

describe('Control Governance Copilot request execution facts', () => {
  it('requires an exact prepared evidence snapshot before human dispatch', async () => {
    const preparedContext = context();
    const { plan } = await planGovernanceCopilotReview(preparedContext, []);

    await expect(inspectGovernanceCopilotReviewMutation(
      plan,
      preparedContext,
      [],
    )).resolves.toEqual({ state: 'ready' });

    const changed = context({
      ...preparedContext.pull,
      requested_reviewers: [{ login: 'maintainer' }],
    });
    await expect(inspectGovernanceCopilotReviewMutation(
      plan,
      changed,
      [],
    )).resolves.toEqual({ state: 'stale-plan' });
  });

  it('converges without a write when pending or current-head review evidence appears', async () => {
    const preparedContext = context();
    const { plan } = await planGovernanceCopilotReview(preparedContext, []);
    const pending = context({
      ...preparedContext.pull,
      requested_reviewers: [{ login: 'copilot-pull-request-reviewer[bot]' }],
    });

    await expect(inspectGovernanceCopilotReviewMutation(
      plan,
      pending,
      [],
    )).resolves.toEqual({ state: 'converged' });
    await expect(inspectGovernanceCopilotReviewMutation(
      plan,
      preparedContext,
      [copilotReview()],
    )).resolves.toEqual({ state: 'converged' });
  });

  it('recovers only from live proof and never treats missing proof as success', async () => {
    const preparedContext = context();
    const { plan } = await planGovernanceCopilotReview(preparedContext, []);

    await expect(inspectGovernanceCopilotReviewRecovery(
      plan,
      preparedContext.pull,
      [],
    )).resolves.toEqual({ state: 'action-required' });
    await expect(inspectGovernanceCopilotReviewRecovery(
      plan,
      {
        ...preparedContext.pull,
        requested_reviewers: [{ login: 'copilot-pull-request-reviewer[bot]' }],
      },
      [],
    )).resolves.toEqual({ state: 'converged' });
    await expect(inspectGovernanceCopilotReviewRecovery(
      plan,
      (({ requested_reviewers: _requestedReviewers, ...pull }) => pull)(
        preparedContext.pull,
      ),
      [],
    )).resolves.toEqual({ state: 'unknown' });
  });

  it('accepts a review on the prepared head after the live head changes', async () => {
    const preparedContext = context();
    const { plan } = await planGovernanceCopilotReview(preparedContext, []);
    const advanced = {
      ...preparedContext.pull,
      head: { ...preparedContext.pull.head, sha: 'd'.repeat(40) },
    };

    await expect(inspectGovernanceCopilotReviewRecovery(
      plan,
      advanced,
      [copilotReview()],
    )).resolves.toEqual({ state: 'converged' });
  });

  it('accepts PR-level pending desired-state evidence after the head changes', async () => {
    const preparedContext = context();
    const { plan } = await planGovernanceCopilotReview(preparedContext, []);
    const advanced = {
      ...preparedContext.pull,
      head: { ...preparedContext.pull.head, sha: 'd'.repeat(40) },
      requested_reviewers: [{ login: 'copilot-pull-request-reviewer[bot]' }],
    };

    await expect(inspectGovernanceCopilotReviewRecovery(
      plan,
      advanced,
      [],
    )).resolves.toEqual({ state: 'converged' });
  });
});
