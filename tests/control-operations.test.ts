import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stewardCheckExternalId } from '../packages/core/src/index.js';
import {
  applyControlPlan,
  canonicalControlJson,
  finalizeControlPlan,
  planClassification,
  planDcoAdvisory,
  verifyControlPlan,
  type ClassificationLease,
  type ControlMutationIntent,
  type ControlPlan,
  type ControlPlanSubject,
  type InstallationMutationPort,
  type PullRequestControlContext,
} from '../packages/control/src/index.js';
import {
  GitHubApiError,
  type GitHubCommit,
  type GitHubIssueComment,
  type GitHubPullRequestFile,
} from '../packages/github/src/index.js';
import {
  canonicalManifestJson,
  type ClassificationConfiguration,
  type LoadedManifest,
  type StewardManifest,
} from '../packages/manifest/src/index.js';

const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function manifest(features: Partial<StewardManifest['features']>): StewardManifest {
  return {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'users', logins: ['core'] },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false,
      classification: false,
      dcoAdvisory: false,
      governance: false,
      copilotReview: false,
      release: false,
      webhookRelay: false,
      ...features,
    },
    ...(features.classification ? { classification } : {}),
  };
}

function loadedManifest(features: Partial<StewardManifest['features']>): LoadedManifest {
  const value = manifest(features);
  const canonicalJson = canonicalManifestJson(value);
  return {
    manifest: value,
    canonicalJson,
    configDigest: createHash('sha256').update(canonicalJson).digest('hex'),
    source: { path: '.github/steward.json', ref: 'main', blobSha: 'manifest-sha' },
  };
}

function classificationContext(labels = ['documentation', 'area:docs', 'external']): PullRequestControlContext {
  const manifest = loadedManifest({ classification: true });
  return {
    subject: {
      repository: { id: 1296724484, owner: 'splrad', name: 'steward', defaultBranch: 'main' },
      pullRequest: { number: 7, headSha: 'c'.repeat(40) },
      manifest: { blobSha: manifest.source.blobSha, configDigest: manifest.configDigest },
      platform: {
        appId: 4243096,
        clientId: 'Iv23liuSr0qd4WLJdZhH',
        appSlug: 'SPLRAD-Steward',
      },
    },
    pull: {
      number: 7,
      state: 'open',
      title: 'feat: deterministic control plan',
      body: '',
      user: { login: 'core', type: 'User' },
      labels: labels.map((name) => ({ name })),
      base: { ref: 'main', sha: 'b'.repeat(40) },
      head: { ref: 'feature/control', sha: 'c'.repeat(40) },
      requested_reviewers: [],
    },
    manifest,
    detailsUrl: 'https://github.com/splrad/steward/actions/runs/123',
  };
}

const classificationCommits: GitHubCommit[] = [
  { sha: 'd'.repeat(40), author: { login: 'core' } },
  { sha: 'e'.repeat(40), author: { login: 'contributor' } },
];

const classificationFiles: GitHubPullRequestFile[] = [
  { filename: 'src/Alpha.cs', status: 'modified', sha: '1'.repeat(40), additions: 2, deletions: 1 },
  { filename: 'src/Beta.cs', status: 'added', sha: '2'.repeat(40), additions: 4, deletions: 0 },
];

function classificationLease(context: PullRequestControlContext): ClassificationLease {
  const attemptDigest = 'a'.repeat(64);
  return {
    contractVersion: 1,
    checkRunId: 42,
    externalId: stewardCheckExternalId({
      repositoryId: context.subject.repository.id,
      prNumber: context.subject.pullRequest.number,
      headSha: context.subject.pullRequest.headSha,
      checkId: 'pr-class-lease',
      configDigest: '0'.repeat(64),
      inputDigest: attemptDigest,
    }),
    attemptDigest,
    repositoryId: context.subject.repository.id,
    pullNumber: context.subject.pullRequest.number,
    headSha: context.subject.pullRequest.headSha,
    appId: context.subject.platform.appId,
    appSlug: context.subject.platform.appSlug,
  };
}

async function classificationPlan(
  context: PullRequestControlContext,
  reverseEvidence = false,
) {
  return await planClassification(context, {
    commits: reverseEvidence ? [...classificationCommits].reverse() : classificationCommits,
    files: reverseEvidence ? [...classificationFiles].reverse() : classificationFiles,
    lease: classificationLease(context),
  });
}

function dcoContext(): PullRequestControlContext {
  const context = classificationContext([]);
  const manifest = loadedManifest({ dcoAdvisory: true });
  return {
    ...context,
    subject: {
      ...context.subject,
      manifest: { blobSha: manifest.source.blobSha, configDigest: manifest.configDigest },
    },
    manifest,
  };
}

function recordingInstallationPort(): { calls: string[]; port: InstallationMutationPort } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async getRepositoryLabel(_owner, _repository, name) {
        calls.push(`get-label:${name}`);
        return { name, color: '000000', description: '' };
      },
      async createRepositoryLabel(_owner, _repository, label) {
        calls.push(`create-label:${label.name}`);
        return label;
      },
      async addIssueLabels(_owner, _repository, _number, labels) {
        calls.push(`add-labels:${labels.join(',')}`);
      },
      async removeIssueLabel(_owner, _repository, _number, label) {
        calls.push(`remove-label:${label}`);
      },
      async createCheckRun(_owner, _repository, input) {
        calls.push('create-check');
        return {
          id: 101,
          head_sha: 'c'.repeat(40),
          name: input.name,
          status: input.status,
          conclusion: input.conclusion ?? null,
          external_id: input.externalId ?? null,
          details_url: input.detailsUrl ?? null,
          app: { id: 4_243_096, slug: 'splrad-steward' },
          output: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
          },
        };
      },
      async updateCheckRun(_owner, _repository, checkRunId, input) {
        calls.push(`update-check:${checkRunId}`);
        return {
          id: checkRunId,
          head_sha: 'c'.repeat(40),
          name: input.name,
          status: input.status,
          conclusion: input.conclusion ?? null,
          external_id: input.externalId ?? null,
          details_url: input.detailsUrl ?? null,
          app: { id: 4_243_096, slug: 'splrad-steward' },
          output: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
          },
        };
      },
      async deleteIssueComment(_owner, _repository, commentId) {
        calls.push(`delete-comment:${commentId}`);
      },
    },
  };
}

const dcoCommit: GitHubCommit = {
  sha: 'd'.repeat(40),
  author: { login: 'core', type: 'User' },
  commit: {
    message: 'feat: signed\n\nSigned-off-by: Core <core@example.com>',
    author: { name: 'Core', email: 'core@example.com' },
  },
};

const dcoLegacyComment: GitHubIssueComment = {
  id: 10,
  user: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' },
  performed_via_github_app: { id: 4_243_096, slug: 'splrad-steward' },
  body: '<!-- workflow:dco-signoff-advisory --> old',
};

function dcoPreconditions(
  context: PullRequestControlContext,
  comments: GitHubIssueComment[],
  trace?: string[],
) {
  return {
    async getRepository() {
      trace?.push('repository:get');
      return { id: 1_296_724_484, fullName: 'splrad/steward', defaultBranch: 'main' };
    },
    async getFile() {
      trace?.push('manifest:get');
      return {
        type: 'file' as const,
        encoding: 'base64',
        content: Buffer.from(context.manifest.canonicalJson).toString('base64'),
        sha: context.manifest.source.blobSha,
      };
    },
    async getPullRequest() {
      trace?.push('pull:get');
      return structuredClone(context.pull);
    },
    async listCommitCheckRuns() { return []; },
    async listIssueComments() {
      trace?.push('comments:list');
      return structuredClone(comments);
    },
  };
}

async function dcoPlan(context = dcoContext()) {
  return {
    context,
    decision: await planDcoAdvisory(context, {
      actor: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' },
      commits: [dcoCommit],
      comments: [dcoLegacyComment],
    }),
  };
}

describe('Control operation plans', () => {
  it('produces an identical canonical Classification plan from equivalent unordered evidence', async () => {
    const forward = await classificationPlan(classificationContext(), false);
    const reverse = await classificationPlan(
      classificationContext(['external', 'area:docs', 'documentation']),
      true,
    );

    expect(canonicalControlJson(reverse.plan)).toBe(canonicalControlJson(forward.plan));
    expect(reverse.plan.planId).toBe(forward.plan.planId);
    expect(forward.plan.mutations.map((mutation) => mutation.key)).toEqual([
      'check-run:pr-classification:start',
      'repository-label:feature',
      'issue-labels:classification',
      'issue-label:area:docs',
      'issue-label:documentation',
      'check-run:pr-classification:complete',
    ]);
    expect(forward.plan.mutations.map((mutation) => mutation.type)).toEqual([
      'check-run.upsert',
      'repository-label.ensure',
      'issue-labels.add',
      'issue-label.remove',
      'issue-label.remove',
      'check-run.upsert',
    ]);
    expect(forward.plan.mutations.at(-1)).toMatchObject({
      type: 'check-run.upsert',
      mode: 'update',
      input: { status: 'completed', conclusion: 'success' },
    });
    expect(forward.plan.mutations[0]).toMatchObject({
      type: 'check-run.upsert',
      mode: 'update',
      input: { status: 'in_progress' },
    });
    const start = forward.plan.mutations[0];
    const complete = forward.plan.mutations.at(-1);
    if (start?.type !== 'check-run.upsert' || complete?.type !== 'check-run.upsert') {
      throw new Error('Classification fixture omitted its Check protocol');
    }
    expect(start.input.externalId).toContain(':check:pr-class-lease:');
    expect(start.observedCheckExternalId).toBe(start.input.externalId);
    expect(complete.observedCheckExternalId).toBe(start.input.externalId);
    expect(complete.input.externalId).toContain(':check:pr-classification:');
    expect(complete.input.externalId).not.toBe(start.input.externalId);
  });

  it('ignores every legacy Classification marker and never plans a contributor body write', async () => {
    const clean = classificationContext([]);
    clean.pull.body = 'Human-authored description';
    const legacy = classificationContext([]);
    legacy.pull.body = [
      'Human-authored description',
      '',
      '<!-- workflow:pr-classification:start',
      'areas=area:runtime',
      'kind=kind:feature',
      'visible-labels=feature',
      'release-labels=security',
      'workflow:pr-classification:end -->',
      '',
      '<!-- workflow:pr-classification:start',
      'areas=area:security',
      'kind=kind:fix',
      'visible-labels=security',
      'release-labels=security',
      'workflow:pr-classification:end -->',
    ].join('\n');

    const cleanDecision = await classificationPlan(clean);
    const legacyDecision = await classificationPlan(legacy);

    expect(canonicalControlJson(legacyDecision.plan)).toBe(canonicalControlJson(cleanDecision.plan));
    expect(legacyDecision.plan.mutations.some((mutation) => (
      (mutation as { type: string }).type === 'pull-request.body.update'
    ))).toBe(false);
    const details = legacyDecision.result.details as { evaluation: { presentation: { releaseLabels: string[] } } };
    expect(details.evaluation.presentation.releaseLabels).not.toContain('security');
  });

  it('rejects a Classification lease outside the bound pull request head', async () => {
    const context = classificationContext();
    const lease = classificationLease(context);
    lease.headSha = 'e'.repeat(40);

    await expect(planClassification(context, {
      commits: classificationCommits,
      files: classificationFiles,
      lease,
    })).rejects.toThrow('lease bound to the live Control subject');
  });

  it.each([
    ['check ID', (lease: ClassificationLease) => { lease.externalId = lease.externalId.replace('check:pr-class-lease', 'check:pr-classification'); }],
    ['zero config', (lease: ClassificationLease) => { lease.externalId = lease.externalId.replace(`config:${'0'.repeat(64)}`, `config:${'b'.repeat(64)}`); }],
    ['attempt digest', (lease: ClassificationLease) => { lease.externalId = lease.externalId.replace(`input:${'a'.repeat(64)}`, `input:${'b'.repeat(64)}`); }],
  ])('rejects a Classification lease whose external identity has the wrong %s', async (_name, mutate) => {
    const context = classificationContext();
    const lease = classificationLease(context);
    mutate(lease);
    await expect(planClassification(context, {
      commits: classificationCommits,
      files: classificationFiles,
      lease,
    })).rejects.toThrow('lease bound to the live Control subject');
  });

  it('keeps disabled Classification write-free without a lease and completes an existing lease by exact ID', async () => {
    const context = classificationContext([]);
    const disabled = loadedManifest({ classification: false });
    context.manifest = disabled;
    context.subject.manifest = { blobSha: disabled.source.blobSha, configDigest: disabled.configDigest };

    const withoutLease = await planClassification(context, null);
    expect(withoutLease.result.state).toBe('ignored');
    expect(withoutLease.plan.mutations).toEqual([]);

    const lease = classificationLease(context);
    const withLease = await planClassification(context, { commits: [], files: [], lease });
    expect(withLease.result.state).toBe('ignored');
    expect(withLease.plan.mutations).toEqual([
      expect.objectContaining({
        type: 'check-run.upsert',
        mode: 'update',
        checkRunId: lease.checkRunId,
        input: expect.objectContaining({ status: 'completed', conclusion: 'success' }),
      }),
    ]);
  });

  it('normalizes DCO comment order and deletes only App-owned legacy comments', async () => {
    const commits: GitHubCommit[] = [{
      sha: 'd'.repeat(40),
      author: { login: 'core', type: 'User' },
      commit: {
        message: 'feat: signed\n\nSigned-off-by: Core <core@example.com>',
        author: { name: 'Core', email: 'core@example.com' },
      },
    }];
    const comments = [
      { id: 12, user: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' }, body: '<!-- workflow:dco-signoff-advisory --> old 12' },
      { id: 11, user: { id: 100, login: 'external', type: 'User' }, body: '<!-- workflow:dco-signoff-advisory --> spoofed' },
      { id: 10, user: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' }, body: '<!-- workflow:dco-signoff-advisory --> old 10' },
      { id: 13, user: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' }, body: 'unrelated App comment' },
    ];

    const actor = { id: 99, login: 'splrad-steward[bot]', type: 'Bot' };
    const forward = await planDcoAdvisory(dcoContext(), { actor, commits, comments });
    const reverse = await planDcoAdvisory(dcoContext(), { actor, commits, comments: [...comments].reverse() });

    expect(canonicalControlJson(reverse.plan)).toBe(canonicalControlJson(forward.plan));
    expect(reverse.plan.planId).toBe(forward.plan.planId);
    expect(forward.plan.mutations).toHaveLength(2);
    expect(forward.plan.mutations.map((mutation) => mutation.key)).toEqual([
      'issue-comment:dco-legacy:10',
      'issue-comment:dco-legacy:12',
    ]);
    expect(forward.plan.mutations.map((mutation) => (
      mutation.type === 'issue-comment.delete' ? mutation.commentId : -1
    ))).toEqual([10, 12]);
    expect(forward.plan.mutations.every((mutation) => (
      mutation.type === 'issue-comment.delete'
      && mutation.expectedOwnerId === 99
      && mutation.expectedOwnerLogin === 'splrad-steward[bot]'
    ))).toBe(true);
  });

  it('binds the Manifest once while re-reading mutable state for each DCO deletion', async () => {
    const context = dcoContext();
    const comments = [
      structuredClone(dcoLegacyComment),
      {
        ...structuredClone(dcoLegacyComment),
        id: 12,
        body: '<!-- workflow:dco-signoff-advisory --> old 12',
      },
    ];
    const decision = await planDcoAdvisory(context, {
      actor: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' },
      commits: [dcoCommit],
      comments,
    });
    const trace: string[] = [];
    const recording = recordingInstallationPort();

    const receipts = await applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, comments, trace),
      installation: recording.port,
    });

    expect(receipts).toHaveLength(2);
    expect(trace.filter((entry) => entry === 'repository:get')).toHaveLength(1);
    expect(trace.filter((entry) => entry === 'manifest:get')).toHaveLength(1);
    expect(trace.filter((entry) => entry === 'pull:get')).toHaveLength(3);
    expect(trace.filter((entry) => entry === 'comments:list')).toHaveLength(3);
  });

  it('stops multi-comment DCO cleanup when a later comment drifts between intents', async () => {
    const context = dcoContext();
    const comments = [
      structuredClone(dcoLegacyComment),
      {
        ...structuredClone(dcoLegacyComment),
        id: 12,
        body: '<!-- workflow:dco-signoff-advisory --> old 12',
      },
    ];
    const decision = await planDcoAdvisory(context, {
      actor: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' },
      commits: [dcoCommit],
      comments,
    });
    const recording = recordingInstallationPort();
    const installation: InstallationMutationPort = {
      ...recording.port,
      async deleteIssueComment(_owner, _repository, commentId) {
        recording.calls.push(`delete-comment:${commentId}`);
        const index = comments.findIndex((comment) => comment.id === commentId);
        if (index >= 0) comments.splice(index, 1);
        if (commentId === 10) comments.find((comment) => comment.id === 12)!.body = 'human replacement';
      },
    };

    await expect(applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, comments),
      installation,
    })).rejects.toMatchObject({
      outcome: 'unknown',
      mutationKey: 'issue-comment:dco-legacy:12',
      completed: [expect.objectContaining({
        key: 'issue-comment:dco-legacy:10',
        state: 'applied',
      })],
      cause: expect.objectContaining({ name: 'ControlPreconditionError' }),
    });
    expect(recording.calls).toEqual(['delete-comment:10']);
  });

  it('rejects a self-consistent DCO plan that targets a different App bot', async () => {
    const context = dcoContext();
    await expect(finalizeControlPlan({
      objective: 'dco-advisory',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: { fixture: 'foreign-app-comment' },
      outcome: { state: 'passed', summary: 'invalid foreign cleanup' },
      mutations: [{
        type: 'issue-comment.delete',
        key: 'issue-comment:dco-legacy:99',
        principal: 'installation',
        commentId: 99,
        expectedOwnerId: 100,
        expectedOwnerLogin: 'foreign-app[bot]',
        observedBodyDigest: 'a'.repeat(64),
      }],
    })).rejects.toThrow('invalid issue comment precondition');
  });

  it('treats an already-absent DCO legacy comment as converged', async () => {
    const { context, decision } = await dcoPlan();
    const recording = recordingInstallationPort();

    const receipts = await applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, []),
      installation: recording.port,
    });

    expect(receipts).toEqual([expect.objectContaining({
      key: 'issue-comment:dco-legacy:10',
      state: 'converged',
      resourceId: 10,
    })]);
    expect(recording.calls).not.toContain('delete-comment:10');
  });

  it.each([
    ['body', (comment: GitHubIssueComment) => { comment.body = 'human replacement'; }],
    ['owner', (comment: GitHubIssueComment) => { comment.user = { id: 100, login: 'external', type: 'User' }; }],
    ['App provenance', (comment: GitHubIssueComment) => {
      comment.performed_via_github_app = { id: 1, slug: 'foreign-app' };
    }],
  ])('refuses DCO deletion after %s drift', async (_name, mutate) => {
    const { context, decision } = await dcoPlan();
    const live = structuredClone(dcoLegacyComment);
    mutate(live);
    const recording = recordingInstallationPort();

    await expect(applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, [live]),
      installation: recording.port,
    })).rejects.toThrow('changed issue comment');
    expect(recording.calls).not.toContain('delete-comment:10');
  });

  it('treats a DCO delete-time 404 race as converged', async () => {
    const { context, decision } = await dcoPlan();
    const recording = recordingInstallationPort();
    const comments = [structuredClone(dcoLegacyComment)];
    const installation: InstallationMutationPort = {
      ...recording.port,
      async deleteIssueComment() {
        comments.splice(0, comments.length);
        throw new GitHubApiError({
          status: 404,
          method: 'DELETE',
          path: '/repos/splrad/steward/issues/comments/10',
          message: 'Not Found',
        });
      },
    };

    await expect(applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, comments),
      installation,
    })).resolves.toEqual([expect.objectContaining({ state: 'converged', resourceId: 10 })]);
  });

  it('does not report convergence when a DCO delete returns 404 but the comment still exists', async () => {
    const { context, decision } = await dcoPlan();
    const recording = recordingInstallationPort();
    const installation: InstallationMutationPort = {
      ...recording.port,
      async deleteIssueComment() {
        throw new GitHubApiError({
          status: 404,
          method: 'DELETE',
          path: '/repos/splrad/steward/issues/comments/10',
          message: 'Not Found',
        });
      },
    };

    await expect(applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, [dcoLegacyComment]),
      installation,
    })).rejects.toMatchObject({
      outcome: 'unknown',
      cause: expect.objectContaining({ status: 404 }),
    });
  });

  it('refuses DCO convergence when the comment changes after a delete-time 404', async () => {
    const { context, decision } = await dcoPlan();
    const recording = recordingInstallationPort();
    const comments = [structuredClone(dcoLegacyComment)];
    const installation: InstallationMutationPort = {
      ...recording.port,
      async deleteIssueComment() {
        comments[0]!.body = 'human replacement';
        throw new GitHubApiError({
          status: 404,
          method: 'DELETE',
          path: '/repos/splrad/steward/issues/comments/10',
          message: 'Not Found',
        });
      },
    };

    await expect(applyControlPlan(decision.plan, context.subject, {
      preconditions: dcoPreconditions(context, comments),
      installation,
    })).rejects.toThrow('changed issue comment');
  });

  it('rejects a tampered mutation payload with the old plan ID before invoking any port', async () => {
    const context = classificationContext();
    const decision = await classificationPlan(context);
    const tampered = structuredClone(decision.plan);
    const first = tampered.mutations.find((mutation) => mutation.type === 'repository-label.ensure');
    if (!first) {
      throw new Error('Classification fixture omitted label assurance');
    }
    first.label = { ...first.label, color: 'ffffff' };
    const recording = recordingInstallationPort();

    await expect(applyControlPlan(tampered, context.subject, { installation: recording.port }))
      .rejects.toThrow(/desired digest|identity/i);
    expect(tampered.planId).toBe(decision.plan.planId);
    expect(recording.calls).toEqual([]);
  });

  it('rejects a self-consistent Classification plan that completes its Check before derived state', async () => {
    const context = classificationContext();
    const decision = await classificationPlan(context);
    const intents = decision.plan.mutations.map((mutation) => {
      const { desiredDigest: _desiredDigest, preconditions: _preconditions, ...intent } = mutation;
      return intent as ControlMutationIntent;
    });
    const start = intents[0];
    const complete = intents.at(-1);
    if (!start || !complete) throw new Error('Classification fixture omitted Check protocol intents');

    await expect(finalizeControlPlan({
      objective: 'classification',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: { fixture: 'complete-before-state' },
      outcome: { state: 'passed', summary: 'invalid ordering' },
      mutations: [complete, ...intents.slice(1, -1), start],
    })).rejects.toThrow('start/complete Check protocol');
  });

  it('rejects a self-consistent Classification plan that publishes an unrecognized Check name', async () => {
    const context = classificationContext();
    const decision = await classificationPlan(context);
    const intents = decision.plan.mutations.map((mutation) => {
      const { desiredDigest: _desiredDigest, preconditions: _preconditions, ...intent } = mutation;
      return intent as ControlMutationIntent;
    });
    const checks = intents.filter((mutation): mutation is Extract<ControlMutationIntent, {
      type: 'check-run.upsert';
    }> => mutation.type === 'check-run.upsert');
    for (const check of checks) check.input.name = 'Unexpected Classification Gate';

    await expect(finalizeControlPlan({
      objective: 'classification',
      subject: context.subject,
      pullRequest: context.pull,
      snapshot: { fixture: 'unexpected-check-name' },
      outcome: { state: 'passed', summary: 'invalid Check name' },
      mutations: intents,
    })).rejects.toThrow('start/complete Check protocol');
  });

  it('rejects a Manifest object changed after loading while its canonical evidence stays unchanged', async () => {
    const context = classificationContext();
    if (!context.manifest.manifest.classification) throw new Error('Fixture omitted Classification policy');
    context.manifest.manifest.classification.decisions.kinds.fallback = 'kind:tampered';

    await expect(planClassification(context, {
      commits: classificationCommits,
      files: classificationFiles,
      lease: classificationLease(context),
    })).rejects.toThrow('object does not match its canonical JSON');
  });

  it('rejects head, config, and App subject drift before invoking any port', async () => {
    const context = classificationContext();
    const decision = await classificationPlan(context);
    const drifts: [string, (subject: ControlPlanSubject) => void][] = [
      ['head', (subject) => { subject.pullRequest.headSha = 'e'.repeat(40); }],
      ['config', (subject) => { subject.manifest.configDigest = 'b'.repeat(64); }],
      ['App', (subject) => { subject.platform.appSlug = 'different-steward'; }],
      ['App ID', (subject) => { subject.platform.appId = 1; }],
      ['App client ID', (subject) => { subject.platform.clientId = 'different-client'; }],
    ];

    for (const [name, drift] of drifts) {
      const subject = structuredClone(context.subject);
      drift(subject);
      const recording = recordingInstallationPort();
      await expect(
        applyControlPlan(decision.plan, subject, { installation: recording.port }),
        `${name} drift`,
      ).rejects.toThrow('Control plan subject does not match the current runtime subject');
      expect(recording.calls, `${name} drift`).toEqual([]);
    }
  });

  it('rejects an unsupported principal for the whole plan before invoking any port', async () => {
    const context = classificationContext();
    const plan = structuredClone((await classificationPlan(context)).plan);
    const mutation = plan.mutations.find((candidate) => candidate.type === 'issue-labels.add');
    if (!mutation) throw new Error('Fixture omitted an issue label mutation');
    (mutation as { principal: string }).principal = 'copilot-requester';
    const recording = recordingInstallationPort();

    await expect(applyControlPlan(plan, context.subject, { installation: recording.port }))
      .rejects.toThrow('unsupported principal');
    expect(recording.calls).toEqual([]);
  });

  it.each([
    ['unknown Check mode', (plan: Record<string, unknown>) => {
      const mutations = plan.mutations as Array<Record<string, unknown>>;
      const check = mutations.find((mutation) => mutation.type === 'check-run.upsert');
      if (!check) throw new Error('Fixture omitted a Check mutation');
      check.mode = 'typo';
    }, '/mode is unsupported'],
    ['unknown objective', (plan: Record<string, unknown>) => { plan.objective = 'future-operation'; }, '/objective is unsupported'],
    ['objective/mutation mismatch', (plan: Record<string, unknown>) => { plan.objective = 'dco-advisory'; }, 'does not allow mutation'],
    ['unknown envelope field', (plan: Record<string, unknown>) => { plan.untrusted = true; }, '/untrusted is not allowed'],
    ['removed PR body mutation', (plan: Record<string, unknown>) => {
      const mutations = plan.mutations as Array<Record<string, unknown>>;
      mutations[0] = {
        type: 'pull-request.body.update',
        key: 'forged-body-write',
        principal: 'installation',
        desiredDigest: 'a'.repeat(64),
        preconditions: mutations[0]?.preconditions,
        body: 'overwrite contributor content',
        observedBodyDigest: 'b'.repeat(64),
      };
    }, '/body is not allowed'],
    ['completed Check without conclusion', (plan: Record<string, unknown>) => {
      const mutations = plan.mutations as Array<Record<string, unknown>>;
      const check = mutations.find((mutation) => (
        mutation.type === 'check-run.upsert'
        && (mutation.input as Record<string, unknown> | undefined)?.status === 'completed'
      ));
      const input = check?.input as Record<string, unknown> | undefined;
      if (!input) throw new Error('Fixture omitted a Check mutation');
      delete input.conclusion;
    }, '/conclusion is required'],
    ['in-progress Check with conclusion', (plan: Record<string, unknown>) => {
      const mutations = plan.mutations as Array<Record<string, unknown>>;
      const check = mutations.find((mutation) => (
        mutation.type === 'check-run.upsert'
        && (mutation.input as Record<string, unknown> | undefined)?.status === 'in_progress'
      ));
      const input = check?.input as Record<string, unknown> | undefined;
      if (!input) throw new Error('Fixture omitted a Check mutation');
      input.conclusion = 'success';
    }, '/conclusion is not allowed'],
  ])('strictly rejects an unrecognized serialized plan shape: %s', async (_name, mutate, message) => {
    const decision = await classificationPlan(classificationContext());
    const malformed = structuredClone(decision.plan) as unknown as Record<string, unknown>;
    mutate(malformed);

    await expect(verifyControlPlan(malformed as unknown as ControlPlan)).rejects.toThrow(message);
  });
});
