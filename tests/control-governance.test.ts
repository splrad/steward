import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalControlJson,
  copilotGateBlockingCommentResourceMarker,
  copilotReviewEvidence,
  finalizeControlPlan,
  inspectGovernanceCopilotGateMutation,
  inspectGovernanceCopilotReviewMutation,
  inspectGovernanceCopilotReviewRecovery,
  planGovernanceCopilotGate,
  planGovernanceCopilotReview,
  recoverGovernanceCopilotGateMutation,
  verifyControlPlan,
  type GovernanceCopilotGateFacts,
  type PullRequestControlContext,
} from '../packages/control/src/index.js';
import type {
  GitHubCheckRun,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubReviewThread,
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
        evidenceProtocol: 'review-request-v1',
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

  it('rejects arbitrary principals, protocols, reviewer fields, and terminal gate claims', async () => {
    const { plan } = await planGovernanceCopilotReview(context(), []);
    const wrongPrincipal = structuredClone(plan) as unknown as Record<string, unknown>;
    (wrongPrincipal.mutations as Array<Record<string, unknown>>)[0]!.principal = 'installation';
    await expect(verifyControlPlan(wrongPrincipal as never)).rejects.toThrow();

    const missingProtocol = structuredClone(plan) as unknown as Record<string, unknown>;
    delete (missingProtocol.mutations as Array<Record<string, unknown>>)[0]!
      .evidenceProtocol;
    await expect(verifyControlPlan(missingProtocol as never)).rejects.toThrow();

    const unsupportedProtocol = structuredClone(plan) as unknown as Record<string, unknown>;
    (unsupportedProtocol.mutations as Array<Record<string, unknown>>)[0]!
      .evidenceProtocol = 'future-protocol';
    await expect(verifyControlPlan(unsupportedProtocol as never)).rejects.toThrow();

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

function gateThread(
  body = 'severity: blocking\nTitle: Fix the unsafe write',
  overrides: Partial<GitHubReviewThread> = {},
): GitHubReviewThread {
  return {
    id: 'PRRT_gate_1',
    isResolved: false,
    isOutdated: false,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        id: 'PRRC_gate_1',
        body,
        url: 'https://github.com/splrad/steward/pull/7#discussion_r1',
        author: { login: 'copilot-pull-request-reviewer[bot]' },
        pullRequestReview: {
          author: { login: 'copilot-pull-request-reviewer[bot]' },
          commit: { oid: headSha },
          state: 'COMMENTED',
        },
      }],
    },
    ...overrides,
  };
}

function gateCheck(
  overrides: Partial<GitHubCheckRun> = {},
): GitHubCheckRun {
  return {
    id: 501,
    head_sha: headSha,
    name: 'Copilot Code Review Gate',
    status: 'in_progress',
    conclusion: null,
    external_id: 'legacy-gate',
    app: { id: 4_243_096, slug: 'splrad-steward' },
    output: { title: 'old', summary: 'old' },
    ...overrides,
  };
}

function gateComment(
  body = '<!-- workflow:copilot-review-gate -->\nlegacy',
  overrides: Partial<GitHubIssueComment> = {},
): GitHubIssueComment {
  return {
    id: 601,
    body,
    user: { id: 77, login: 'splrad-steward[bot]', type: 'Bot' },
    performed_via_github_app: { id: 4_243_096, slug: 'splrad-steward' },
    ...overrides,
  };
}

function gateFacts(
  overrides: Partial<GovernanceCopilotGateFacts> = {},
): GovernanceCopilotGateFacts {
  return {
    actor: { id: 77, login: 'splrad-steward[bot]', type: 'Bot' },
    commits: [{
      sha: headSha,
      author: { login: 'dependabot[bot]', type: 'Bot' },
      commit: {
        message: 'chore: update dependency',
        author: { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' },
      },
    }],
    files: [{
      filename: 'package-lock.json',
      status: 'modified',
      sha: 'd'.repeat(40),
      additions: 1,
      deletions: 1,
    }],
    reviews: [],
    threads: [],
    checks: [],
    comments: [],
    coreHandlers: ['maintainer'],
    ...overrides,
  };
}

describe('Control Governance Copilot Gate planning', () => {
  it('publishes disabled success and deletes one stale blocking comment', async () => {
    const disabled = await planGovernanceCopilotGate(
      context(pull(), false),
      gateFacts({ comments: [gateComment()] }),
    );
    expect(disabled).toMatchObject({
      result: { state: 'passed' },
      plan: {
        mutations: [
          {
            type: 'copilot-gate-check.upsert',
            input: { status: 'completed', conclusion: 'success' },
          },
          {
            type: 'blocking-comment.delete',
            commentId: 601,
          },
        ],
      },
    });
    await expect(inspectGovernanceCopilotGateMutation(
      disabled.plan,
      'copilot-gate:check',
      context(pull(), false),
      gateFacts({ comments: [gateComment()] }),
    )).resolves.toEqual({ state: 'ready' });
    const checkMutation = disabled.plan.mutations[0];
    if (checkMutation?.type !== 'copilot-gate-check.upsert') {
      throw new Error('missing disabled Check intent');
    }
    const converged = await planGovernanceCopilotGate(
      context(pull(), false),
      gateFacts({
        comments: [],
        checks: [gateCheck({
          name: checkMutation.input.name,
          status: checkMutation.input.status,
          conclusion: checkMutation.input.conclusion ?? null,
          external_id: String(checkMutation.input.externalId ?? ''),
          details_url: checkMutation.input.detailsUrl ?? null,
          output: {
            title: String(checkMutation.input.title ?? ''),
            summary: String(checkMutation.input.summary ?? ''),
          },
        })],
      }),
    );
    expect(converged).toMatchObject({
      result: { state: 'ignored' },
      plan: { mutations: [] },
    });
    await expect(planGovernanceCopilotGate(context(), null))
      .rejects.toThrow('requires live resource facts');
  });

  it('orders a pending Gate Check before the final human request', async () => {
    const decision = await planGovernanceCopilotGate(context(), gateFacts());

    expect(decision.result.state).toBe('pending');
    expect(decision.plan.mutations.map(({ type, key, principal }) => ({
      type, key, principal,
    }))).toEqual([
      {
        type: 'copilot-gate-check.upsert',
        key: 'copilot-gate:check',
        principal: 'installation',
      },
      {
        type: 'copilot-review.request',
        key: 'copilot-review:request',
        principal: 'human',
      },
    ]);
    expect(decision.plan.mutations[1]).toMatchObject({
      type: 'copilot-review.request',
      evidenceProtocol: 'copilot-gate-v1',
    });
    expect(decision.plan.mutations[0]).toMatchObject({
      mode: 'create',
      input: {
        name: 'Copilot Code Review Gate',
        status: 'in_progress',
        headSha,
      },
    });
    const checkMutation = decision.plan.mutations[0];
    if (checkMutation?.type !== 'copilot-gate-check.upsert') {
      throw new Error('missing pending Check intent');
    }
    const alreadyCurrent = await planGovernanceCopilotGate(context(), gateFacts({
      checks: [gateCheck({
        name: checkMutation.input.name,
        status: checkMutation.input.status,
        conclusion: checkMutation.input.conclusion ?? null,
        external_id: String(checkMutation.input.externalId ?? ''),
        details_url: checkMutation.input.detailsUrl ?? null,
        output: {
          title: String(checkMutation.input.title ?? ''),
          summary: String(checkMutation.input.summary ?? ''),
        },
      })],
    }));
    expect(alreadyCurrent.plan.mutations.map((mutation) => mutation.key))
      .toEqual(['copilot-review:request']);
    await expect(verifyControlPlan(decision.plan)).resolves.toBeUndefined();
  });

  it('fails malformed review evidence before pending and writes Check then comment', async () => {
    const decision = await planGovernanceCopilotGate(context(), gateFacts({
      reviews: [copilotReview({ commit_id: null })],
    }));

    expect(decision.result.state).toBe('failed');
    expect(decision.plan.mutations.map((mutation) => mutation.type)).toEqual([
      'copilot-gate-check.upsert',
      'blocking-comment.upsert',
    ]);
    expect(decision.plan.mutations[0]).toMatchObject({
      input: { status: 'completed', conclusion: 'failure' },
    });
    const comment = decision.plan.mutations[1];
    expect(comment).toMatchObject({
      type: 'blocking-comment.upsert',
      mode: 'create',
      body: expect.stringContaining(copilotGateBlockingCommentResourceMarker),
    });
    if (comment?.type !== 'blocking-comment.upsert') throw new Error('missing comment intent');
    expect(comment.body).toContain('## 🚧 PR 合并前有待处理事项');
    expect(comment.body).toContain('<!-- workflow:pr-blocking-failures -->');
    expect(comment.body).toContain('SPLRAD Steward');
  });

  it('uses current-head Copilot findings and adopts one App-owned legacy comment', async () => {
    const decision = await planGovernanceCopilotGate(context(), gateFacts({
      reviews: [copilotReview()],
      threads: [gateThread()],
      comments: [gateComment()],
    }));

    expect(decision.result.state).toBe('failed');
    expect(decision.plan.mutations).toEqual([
      expect.objectContaining({
        type: 'copilot-gate-check.upsert',
        mode: 'create',
        input: expect.objectContaining({ conclusion: 'failure' }),
      }),
      expect.objectContaining({
        type: 'blocking-comment.upsert',
        mode: 'update',
        commentId: 601,
        observedBodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('does not request again when a current-head Copilot thread lacks its submitted review', async () => {
    const decision = await planGovernanceCopilotGate(context(), gateFacts({
      threads: [gateThread()],
    }));

    expect(decision.result.state).toBe('failed');
    expect(decision.plan.mutations.map((mutation) => mutation.type)).toEqual([
      'copilot-gate-check.upsert',
      'blocking-comment.upsert',
    ]);
  });

  it('keeps an over-limit evidence failure plan below the v2 64 KiB envelope', async () => {
    const oversizedThreads = Array.from({ length: 17 }, (_, index) => gateThread(
      `severity: blocking\nTitle: @everyone finding ${index}`,
      {
        id: `PRRT_gate_${index}`,
        comments: {
          pageInfo: { hasNextPage: false },
          nodes: [{
            id: `PRRC_gate_${index}`,
            body: `severity: blocking\nTitle: @everyone finding ${index}`,
            url: `https://github.com/splrad/steward/pull/7#discussion_r${index}?q=${'x'.repeat(900)}`,
            author: { login: 'copilot-pull-request-reviewer[bot]' },
            pullRequestReview: {
              author: { login: 'copilot-pull-request-reviewer[bot]' },
              commit: { oid: headSha },
              state: 'COMMENTED',
            },
          }],
        },
      },
    ));
    const decision = await planGovernanceCopilotGate(context(), gateFacts({
      reviews: [copilotReview()],
      threads: oversizedThreads,
      coreHandlers: Array.from({ length: 21 }, (_, index) => `maintainer-${index}`),
    }));
    const canonical = canonicalControlJson(decision.plan);

    expect(decision.result.state).toBe('failed');
    expect(new TextEncoder().encode(canonical).byteLength).toBeLessThan(65_536);
    const comment = decision.plan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.upsert'
    ));
    expect(comment).toMatchObject({ type: 'blocking-comment.upsert' });
    if (!comment || comment.type !== 'blocking-comment.upsert') throw new Error('missing bounded comment');
    expect(comment.body).not.toContain('@everyone');
  });

  it('does not choose among duplicate Checks and publishes action-required only when a Check is unique', async () => {
    const duplicate = await planGovernanceCopilotGate(context(), gateFacts({
      checks: [gateCheck({ id: 501 }), gateCheck({ id: 502 })],
    }));
    expect(duplicate.result.state).toBe('action_required');
    expect(duplicate.plan.mutations).toEqual([]);

    const badComment = await planGovernanceCopilotGate(context(), gateFacts({
      comments: [gateComment(undefined, {
        performed_via_github_app: { id: 4_243_096, slug: 'foreign-app' },
      })],
    }));
    expect(badComment.result.state).toBe('action_required');
    expect(badComment.plan.mutations).toEqual([
      expect.objectContaining({
        type: 'copilot-gate-check.upsert',
        input: expect.objectContaining({
          status: 'completed',
          conclusion: 'action_required',
        }),
      }),
    ]);
  });

  it('deletes the unique blocking comment after a passing Gate', async () => {
    const decision = await planGovernanceCopilotGate(context(), gateFacts({
      reviews: [copilotReview({
        body: 'Copilot reviewed 1 out of 1 changed files in this pull request and generated no new comments.',
      })],
      comments: [gateComment()],
    }));

    expect(decision.result.state).toBe('passed');
    expect(decision.plan.mutations.map((mutation) => mutation.type)).toEqual([
      'copilot-gate-check.upsert',
      'blocking-comment.delete',
    ]);
  });

  it('rejects a self-consistent Gate plan whose human request precedes installation writes', async () => {
    const decision = await planGovernanceCopilotGate(context(), gateFacts());
    const intents = decision.plan.mutations.map((mutation) => {
      const { desiredDigest: _desiredDigest, preconditions: _preconditions, ...intent } = mutation;
      return intent;
    });

    await expect(finalizeControlPlan({
      objective: 'governance',
      subject: decision.plan.subject,
      pullRequest: context().pull,
      snapshot: { fixture: 'wrong-gate-order' },
      outcome: decision.plan.outcome,
      mutations: [...intents].reverse(),
    })).rejects.toThrow('Check, comment, then human request');
  });
});

describe('Control Governance Copilot Gate execution facts', () => {
  it('requires exact evidence and resource-set observations before a Check write', async () => {
    const preparedContext = context();
    const preparedFacts = gateFacts();
    const { plan } = await planGovernanceCopilotGate(preparedContext, preparedFacts);

    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-gate:check',
      preparedContext,
      preparedFacts,
    )).resolves.toEqual({ state: 'ready' });
    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-review:request',
      preparedContext,
      preparedFacts,
    )).resolves.toEqual({ state: 'ready' });
    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-review:request',
      context(pull(undefined, [{ login: 'copilot-pull-request-reviewer[bot]' }])),
      gateFacts(),
    )).resolves.toEqual({ state: 'converged' });

    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-gate:check',
      preparedContext,
      gateFacts({ checks: [gateCheck()] }),
    )).resolves.toEqual({ state: 'stale-plan' });

    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-gate:check',
      preparedContext,
      gateFacts({ reviews: [copilotReview()] }),
    )).resolves.toEqual({ state: 'stale-plan' });
    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-review:request',
      preparedContext,
      gateFacts({
        actor: { id: 77, login: 'other-steward[bot]', type: 'Bot' },
      }),
    )).resolves.toEqual({ state: 'stale-plan' });
    await expect(inspectGovernanceCopilotGateMutation(
      plan,
      'copilot-review:request',
      preparedContext,
      gateFacts({ coreHandlers: ['different-maintainer'] }),
    )).resolves.toEqual({ state: 'stale-plan' });
  });

  it('recovers a response-lost Check write only from one exact desired resource', async () => {
    const preparedContext = context();
    const { plan } = await planGovernanceCopilotGate(preparedContext, gateFacts());
    const mutation = plan.mutations[0];
    if (mutation?.type !== 'copilot-gate-check.upsert') throw new Error('missing Check intent');
    const desired = gateCheck({
      id: 777,
      name: mutation.input.name,
      status: mutation.input.status,
      conclusion: mutation.input.conclusion ?? null,
      external_id: String(mutation.input.externalId ?? ''),
      details_url: mutation.input.detailsUrl ?? null,
      output: {
        title: String(mutation.input.title ?? ''),
        summary: String(mutation.input.summary ?? ''),
      },
    });

    await expect(recoverGovernanceCopilotGateMutation(
      plan,
      mutation.key,
      { actor: gateFacts().actor, checks: [desired], comments: [] },
    )).resolves.toEqual({ state: 'converged', resourceId: 777 });
    await expect(recoverGovernanceCopilotGateMutation(
      plan,
      mutation.key,
      { actor: gateFacts().actor, checks: [], comments: [] },
    )).resolves.toEqual({ state: 'unknown' });
    await expect(recoverGovernanceCopilotGateMutation(
      plan,
      mutation.key,
      {
        actor: gateFacts().actor,
        checks: [desired, { ...desired, id: 778 }],
        comments: [],
      },
    )).resolves.toEqual({ state: 'unknown' });
  });

  it('recovers comment create/delete only from exact desired live state', async () => {
    const blocked = await planGovernanceCopilotGate(context(), gateFacts({
      reviews: [copilotReview()],
      threads: [gateThread()],
    }));
    const create = blocked.plan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.upsert'
    ));
    if (!create || create.type !== 'blocking-comment.upsert') throw new Error('missing comment create');
    const desired = gateComment(create.body, { id: 701 });

    await expect(recoverGovernanceCopilotGateMutation(
      blocked.plan,
      create.key,
      { actor: gateFacts().actor, checks: [], comments: [desired] },
    )).resolves.toEqual({ state: 'converged', resourceId: 701 });
    await expect(recoverGovernanceCopilotGateMutation(
      blocked.plan,
      create.key,
      { actor: gateFacts().actor, checks: [], comments: [] },
    )).resolves.toEqual({ state: 'unknown' });

    const passingReview = copilotReview({
      body: 'Copilot reviewed 1 out of 1 changed files in this pull request and generated no new comments.',
    });
    const passing = await planGovernanceCopilotGate(context(), gateFacts({
      reviews: [passingReview],
      comments: [gateComment()],
    }));
    const deletion = passing.plan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.delete'
    ));
    if (!deletion) throw new Error('missing comment delete');
    await expect(inspectGovernanceCopilotGateMutation(
      passing.plan,
      deletion.key,
      context(),
      gateFacts({
        reviews: [passingReview],
        comments: [gateComment()],
        targetComment: gateComment(),
      }),
    )).resolves.toEqual({ state: 'ready' });
    await expect(inspectGovernanceCopilotGateMutation(
      passing.plan,
      deletion.key,
      context(),
      gateFacts({
        reviews: [passingReview],
        comments: [gateComment()],
      }),
    )).resolves.toEqual({ state: 'stale-plan' });
    await expect(inspectGovernanceCopilotGateMutation(
      passing.plan,
      deletion.key,
      context(),
      gateFacts({
        reviews: [passingReview],
        comments: [],
        targetComment: null,
      }),
    )).resolves.toEqual({ state: 'converged', resourceId: 601 });
    await expect(recoverGovernanceCopilotGateMutation(
      passing.plan,
      deletion.key,
      { actor: gateFacts().actor, checks: [], comments: [], targetComment: null },
    )).resolves.toEqual({ state: 'converged', resourceId: 601 });
    await expect(recoverGovernanceCopilotGateMutation(
      passing.plan,
      deletion.key,
      { actor: gateFacts().actor, checks: [], comments: [] },
    )).resolves.toEqual({ state: 'unknown' });
    await expect(recoverGovernanceCopilotGateMutation(
      passing.plan,
      deletion.key,
      {
        actor: gateFacts().actor,
        checks: [],
        comments: [],
        targetComment: gateComment(),
      },
    )).resolves.toEqual({ state: 'unknown' });
  });
});
