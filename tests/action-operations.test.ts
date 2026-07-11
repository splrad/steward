import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { fingerprintForPull, stewardCheckExternalId } from '../packages/core/src/index.js';
import type { LoadedManifest, StewardManifest } from '../packages/manifest/src/index.js';
import type { GitHubPullRequest, GitHubRepositoryClient } from '../packages/github/src/index.js';
import {
  operationDefinitions,
  parseMatrixMode,
  parseMatrixScope,
  parseOperation,
} from '../action/src/contracts.js';
import {
  graphqlApiBase,
  createOperationContext,
  resolveExpectedHead,
  resolvePullNumber,
  trustedWorkflowRunContext,
  validateRepositoryDispatch,
  type GitHubEventPayload,
  type StewardOperationContext,
} from '../action/src/context.js';
import { executeOperation } from '../action/src/operations.js';
import { enabledMatrixConfiguration, stewardMatrixConfiguration } from '../action/src/catalog.js';

function manifest(features: Partial<StewardManifest['features']> = {}): LoadedManifest {
  return {
    manifest: {
      schemaVersion: 1,
      automation: {
        githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
        maintainers: { source: 'users', logins: ['core', 'reviewer'] },
        language: 'zh-CN',
      },
      features: {
        prAutomation: false,
        classification: false,
        dcoAdvisory: false,
        governance: true,
        copilotReview: true,
        release: false,
        webhookRelay: false,
        ...features,
      },
    },
    canonicalJson: '{}',
    configDigest: 'a'.repeat(64),
    source: { path: '.github/steward.json', ref: 'main', blobSha: 'manifest-sha' },
  };
}

function context(overrides: Record<string, unknown> = {}): {
  context: StewardOperationContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
  mutationClient: Record<string, ReturnType<typeof vi.fn>>;
} {
  const pull: GitHubPullRequest = {
    number: 7,
    state: 'open',
    title: 'feat: operation contract',
    body: '',
    user: { login: 'core' },
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { ref: 'feature/action', sha: 'c'.repeat(40) },
    requested_reviewers: [],
  };
  const client = {
    getAuthenticatedUser: vi.fn(async () => ({ login: 'reviewer' })),
    listTeamMembers: vi.fn(async () => []),
    listPullRequestCommits: vi.fn(async () => [{ sha: 'd'.repeat(40), author: { login: 'core' } }]),
    listPullRequestFiles: vi.fn(async () => []),
    listPullRequestReviews: vi.fn(async () => [{
      state: 'APPROVED', commit_id: pull.head.sha, user: { login: 'reviewer' }, body: 'approved',
    }]),
    listCommitCheckRuns: vi.fn(async () => []),
    listIssueComments: vi.fn(async () => []),
    listReviewThreads: vi.fn(async () => []),
    listWorkflowRuns: vi.fn(async () => []),
    listWorkflowJobs: vi.fn(async () => []),
    requestReviewers: vi.fn(async () => undefined),
    createPullRequestReview: vi.fn(async () => undefined),
    createCheckRun: vi.fn(async (_owner, _repository, input) => ({ id: 1, ...input })),
    updateCheckRun: vi.fn(async () => ({ id: 1 })),
    createIssueComment: vi.fn(async () => ({ id: 1 })),
    updateIssueComment: vi.fn(async () => ({ id: 1 })),
    deleteIssueComment: vi.fn(async () => undefined),
    dispatchWorkflow: vi.fn(async () => undefined),
    rerunWorkflowJob: vi.fn(async () => undefined),
  };
  const mutationClient = {
    getAuthenticatedUser: vi.fn(async () => ({ login: 'reviewer' })),
    requestReviewers: vi.fn(async () => undefined),
    createPullRequestReview: vi.fn(async () => undefined),
  };
  return {
    client,
    mutationClient,
    context: {
      owner: 'splrad',
      repository: 'steward',
      repositoryId: 1296724484,
      defaultBranch: 'main',
      eventName: 'pull_request_target',
      event: { repository: { id: 1296724484, full_name: 'splrad/steward' }, pull_request: { number: 7 } },
      pull,
      manifest: manifest(),
      client: client as unknown as GitHubRepositoryClient,
      mutationClient: mutationClient as unknown as GitHubRepositoryClient,
      ...overrides,
    },
  };
}

describe('Action operation contract', () => {
  it('keeps Actions-write ownership exclusive to Matrix', () => {
    expect(Object.entries(operationDefinitions).filter(([, definition]) => definition.actionsWrite).map(([name]) => name))
      .toEqual(['matrix']);
    expect(parseOperation('governance-main')).toBe('governance-main');
    expect(parseOperation('governance-preflight')).toBe('governance-preflight');
    expect(() => parseOperation('release')).toThrow('Unsupported Steward operation');
    expect(Object.entries(operationDefinitions).filter(([, definition]) => definition.mutationToken).map(([name]) => name))
      .toEqual(['governance-request-copilot', 'governance-auto-approve']);
    expect(stewardMatrixConfiguration.targets.find((target) => target.id === 'dco-signoff')).toMatchObject({
      workflowFile: 'dco-advisory.yml', legacyWorkflowFiles: ['dco-check.yml'],
    });
    expect(enabledMatrixConfiguration(manifest({ classification: false, dcoAdvisory: false }).manifest.features)
      .targets.map((target) => target.id)).toEqual(['main-authorization', 'copilot-review-gate']);
  });

  it('resolves only stable event facts and validates manual Matrix parameters', () => {
    const event: GitHubEventPayload = {
      workflow_run: { head_sha: 'A'.repeat(40), pull_requests: [{ number: 9 }] },
    };
    expect(resolvePullNumber(event, '10')).toBe(9);
    expect(resolveExpectedHead(event, undefined)).toBe('');
    expect(resolveExpectedHead({}, 'A'.repeat(40))).toBe('a'.repeat(40));
    expect(parseMatrixMode(undefined)).toBe('enforce');
    expect(parseMatrixScope('auto', 'repository_dispatch')).toBe('gate-only');
    expect(parseMatrixScope('auto', 'workflow_run', true)).toBe('gate-only');
    expect(() => parseMatrixMode('apply-everything')).toThrow('Unsupported Matrix mode');
  });

  it('accepts only fixed trusted workflow-run titles and review signals', () => {
    expect(trustedWorkflowRunContext({
      path: '.github/workflows/pr-governance.yml@refs/heads/main',
      event: 'workflow_dispatch',
      display_title: `PR Validation Target \x237 / ${'c'.repeat(40)} / all`,
    })).toEqual({ prNumber: 7, headSha: 'c'.repeat(40) });
    expect(trustedWorkflowRunContext({
      path: '.github/workflows/untrusted.yml',
      event: 'workflow_dispatch',
      display_title: `PR Validation Target \x237 / ${'c'.repeat(40)}`,
    })).toBeNull();
    expect(trustedWorkflowRunContext({
      path: '.github/workflows/pr-review-signal.yml',
      event: 'pull_request',
      display_title: `PR Review Signal \x237 / ${'c'.repeat(40)} / pull_request / review_requested`,
    })).toEqual({ prNumber: 7, headSha: 'c'.repeat(40) });
  });

  it('fails closed for untrusted repository dispatch payloads', () => {
    const event: GitHubEventPayload = {
      client_payload: {
        repository_id: 1296724484,
        pr_number: 7,
        head_sha: 'c'.repeat(40),
        source_event: 'pull_request_review_thread',
        action: 'resolved',
        delivery_id: 'delivery',
      },
    };
    expect(() => validateRepositoryDispatch(event, 1296724484)).not.toThrow();
    expect(() => validateRepositoryDispatch({
      client_payload: { ...event.client_payload, delivery_id: '' },
    }, 1296724484)).toThrow('delivery ID');
    expect(() => validateRepositoryDispatch(event, 1)).toThrow('repository ID');
  });

  it('derives the distinct GHES GraphQL base without weakening REST confinement', () => {
    expect(graphqlApiBase('https://github.example/api/v3/')).toBe('https://github.example/api/');
    expect(graphqlApiBase('https://api.github.com/')).toBe('https://api.github.com/');
  });

  it('requires an explicit token and validates repository, default branch, and head from live metadata', async () => {
    const eventPath = 'tests/fixtures/action-event.json';
    const encodedManifest = Buffer.from(JSON.stringify(manifest().manifest)).toString('base64');
    const authorizationByPath = new Map<string, string>();
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      authorizationByPath.set(path, new Headers(init?.headers).get('authorization') ?? '');
      if (path === '/repos/splrad/steward') {
        return new Response(JSON.stringify({ id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' }));
      }
      if (path === '/repos/splrad/steward/contents/.github/steward.json') {
        return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: encodedManifest, sha: 'blob' }));
      }
      if (path === '/repos/splrad/steward/pulls/7') {
        return new Response(JSON.stringify({
          number: 7,
          state: 'open',
          base: { ref: 'main', sha: 'b'.repeat(40) },
          head: { sha: 'c'.repeat(40) },
        }));
      }
      if (path === '/user') return new Response(JSON.stringify({ login: 'reviewer' }));
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as unknown as typeof fetch;

    await expect(createOperationContext({
      inputs: { operation: 'governance-main', eventPath },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'pull_request_target' },
      fetch: fetcher,
    })).rejects.toThrow('explicit GitHub token');
    expect(fetcher).not.toHaveBeenCalled();

    const resolved = await createOperationContext({
      inputs: { operation: 'governance-main', token: 'platform-token', mutationToken: 'human-token', eventPath },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'pull_request_target' },
      fetch: fetcher,
    });
    expect(resolved).toMatchObject({ owner: 'splrad', repository: 'steward', repositoryId: 1296724484 });
    await resolved.mutationClient?.getAuthenticatedUser();
    expect(authorizationByPath.get('/repos/splrad/steward')).toBe('Bearer platform-token');
    expect(authorizationByPath.get('/user')).toBe('Bearer human-token');

    await expect(createOperationContext({
      inputs: { operation: 'governance-main', token: 'token', eventPath, headSha: 'd'.repeat(40) },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'workflow_dispatch' },
      fetch: fetcher,
    })).resolves.toMatchObject({ repositoryId: 1296724484 });
  });

  it('exposes runtime inputs without consumer policy fields', async () => {
    const metadata = await readFile('action/action.yml', 'utf8');
    for (const input of ['github-token:', 'mutation-token:', 'event-path:', 'pr-number:', 'head-sha:', 'matrix-mode:', 'matrix-scope:']) {
      expect(metadata).toContain(input);
    }
    for (const output of ['governance-enabled:', 'copilot-review-enabled:']) expect(metadata).toContain(output);
    for (const forbidden of ['trusted-developers:', 'labels:', 'workflow-file:', 'check-name:']) {
      expect(metadata).not.toContain(forbidden);
    }
  });

  it('loads feature switches without mutation and confines human review writes to the mutation client', async () => {
    const fixture = context();
    const preflight = await executeOperation('governance-preflight', fixture.context, { operation: 'governance-preflight' });
    expect(preflight).toMatchObject({
      state: 'passed', details: { governance: true, copilotReview: true },
    });
    expect(fixture.client.requestReviewers).not.toHaveBeenCalled();
    expect(fixture.mutationClient.requestReviewers).not.toHaveBeenCalled();

    await executeOperation('governance-request-copilot', fixture.context, { operation: 'governance-request-copilot' });
    expect(fixture.mutationClient.requestReviewers).toHaveBeenCalledOnce();
    expect(fixture.client.requestReviewers).not.toHaveBeenCalled();

    fixture.client.listPullRequestReviews!.mockResolvedValue([]);
    await executeOperation('governance-auto-approve', fixture.context, { operation: 'governance-auto-approve' });
    expect(fixture.mutationClient.getAuthenticatedUser).toHaveBeenCalledOnce();
    expect(fixture.mutationClient.createPullRequestReview).toHaveBeenCalledOnce();
    expect(fixture.client.createPullRequestReview).not.toHaveBeenCalled();
  });

  it('fails closed when a human review operation has no mutation client', async () => {
    const fixture = context({ mutationClient: undefined });
    await expect(executeOperation(
      'governance-request-copilot', fixture.context, { operation: 'governance-request-copilot' },
    )).rejects.toThrow('separate mutation token');
  });

  it('connects main governance facts to core decisions and Check mutation', async () => {
    const fixture = context();
    const result = await executeOperation('governance-main', fixture.context, { operation: 'governance-main' });
    expect(result).toMatchObject({ state: 'passed', summary: 'passed_all_contributors_trusted_with_approval' });
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'Main Authorization Gate', status: 'completed', conclusion: 'success', headSha: 'c'.repeat(40),
    }));
    expect(fixture.client.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('does not treat GitHub App commits without an author login as unidentified humans', async () => {
    const fixture = context();
    fixture.client.listPullRequestCommits!.mockResolvedValue([{
      sha: 'd'.repeat(40),
      author: null,
      committer: { login: 'splrad-steward[bot]', type: 'Bot' },
      commit: { author: { name: 'splrad-steward[bot]', email: '1+splrad-steward[bot]@users.noreply.github.com' } },
    }]);
    const result = await executeOperation('governance-main', fixture.context, { operation: 'governance-main' });
    expect(result).toMatchObject({ state: 'passed' });
  });

  it('uses only the latest current-head review per reviewer', async () => {
    const fixture = context();
    fixture.client.listPullRequestReviews!.mockResolvedValue([
      {
        id: 1, state: 'APPROVED', commit_id: 'c'.repeat(40), submitted_at: '2026-07-11T00:00:00Z',
        user: { login: 'reviewer' }, body: 'approved',
      },
      {
        id: 2, state: 'DISMISSED', commit_id: 'c'.repeat(40), submitted_at: '2026-07-11T00:01:00Z',
        user: { login: 'reviewer' }, body: 'dismissed',
      },
    ]);
    const result = await executeOperation('governance-main', fixture.context, { operation: 'governance-main' });
    expect(result).toMatchObject({ state: 'failed', summary: 'failed_trusted_contributors_missing_approval' });
  });

  it('converges only the current source legacy comment into aggregate state', async () => {
    const fixture = context();
    fixture.client.listIssueComments!.mockResolvedValue([
      {
        id: 10,
        user: { login: 'splrad-steward[bot]' },
        body: '<!-- workflow:main-authorization-gate -->\nlegacy main block',
      },
      {
        id: 11,
        user: { login: 'splrad-steward[bot]' },
        body: '<!-- workflow:copilot-review-gate -->\nlegacy copilot block',
      },
    ]);
    await executeOperation('governance-main', fixture.context, { operation: 'governance-main' });
    expect(fixture.client.deleteIssueComment).toHaveBeenCalledWith('splrad', 'steward', 10);
    expect(fixture.client.deleteIssueComment).not.toHaveBeenCalledWith('splrad', 'steward', 11);
  });

  it('fails closed instead of overwriting an aggregate comment with invalid hidden state', async () => {
    const fixture = context();
    fixture.client.listIssueComments!.mockResolvedValue([{
      id: 12,
      user: { login: 'splrad-steward[bot]' },
      body: '<!-- workflow:pr-blocking-failures -->\n<!-- workflow:pr-blocking-failures-state:not-json -->',
    }]);
    await expect(executeOperation('governance-main', fixture.context, { operation: 'governance-main' }))
      .rejects.toThrow('invalid hidden state');
    expect(fixture.client.deleteIssueComment).not.toHaveBeenCalled();
    expect(fixture.client.createCheckRun).not.toHaveBeenCalled();
  });

  it('maps Matrix repair plans to dispatches while other operations cannot write Actions', async () => {
    const fixture = context();
    fixture.context.manifest = manifest({ classification: true, dcoAdvisory: true });
    fixture.client.listWorkflowRuns!.mockResolvedValue([{
      id: 80,
      path: '.github/workflows/pr-classification.yml',
      event: 'workflow_dispatch',
      display_title: `PR Validation Target \x237 / ${'c'.repeat(40)} / classification`,
      head_sha: 'b'.repeat(40),
      pull_requests: [],
    }]);
    const result = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(result.state).toBe('pending');
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(2);
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'pr-governance.yml', ref: 'main',
    }));
    expect(fixture.client.listWorkflowJobs).toHaveBeenCalledWith('splrad', 'steward', 80);
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Validation Matrix Gate', status: 'in_progress',
    }));
    expect(fixture.client.createCheckRun).not.toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Validation Matrix Gate', conclusion: 'failure',
    }));
  });

  it('completes a trusted current-event proxy before converging the Matrix Gate', async () => {
    const fixture = context({
      eventName: 'workflow_run',
      event: {
        repository: { id: 1296724484, full_name: 'splrad/steward' },
        workflow_run: {
          id: 80,
          path: '.github/workflows/pr-governance.yml',
          event: 'workflow_dispatch',
          display_title: `PR Validation Target \x237 / ${'c'.repeat(40)} / main-authorization`,
          pull_requests: [],
        },
      },
    });
    const inputDigest = fingerprintForPull({
      pull: fixture.context.pull,
      commits: [{ sha: 'd'.repeat(40), author: { login: 'core' } }],
      files: [],
      botLogins: ['splrad-steward', 'copilot-pull-request-reviewer[bot]'],
    }).value;
    const identity = (checkId: string) => stewardCheckExternalId({
      repositoryId: 1296724484,
      prNumber: 7,
      headSha: 'c'.repeat(40),
      checkId,
      configDigest: 'a'.repeat(64),
      inputDigest,
    });
    fixture.client.listWorkflowJobs!.mockResolvedValue([{
      id: 81,
      name: 'Main Authorization Gate',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.example/job/81',
    }]);
    fixture.client.listCommitCheckRuns!.mockResolvedValue([
      {
        id: 90,
        name: 'Main Authorization Gate',
        status: 'in_progress',
        external_id: identity('main-authorization'),
        app: { slug: 'splrad-steward' },
      },
      {
        id: 91,
        name: 'Copilot Code Review Gate',
        status: 'completed',
        conclusion: 'success',
        external_id: identity('copilot-review-gate'),
        app: { slug: 'splrad-steward' },
      },
    ]);

    const result = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(result.state).toBe('passed');
    expect(fixture.client.updateCheckRun).toHaveBeenCalledWith('splrad', 'steward', 90, expect.objectContaining({
      status: 'completed', conclusion: 'success',
    }));
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Validation Matrix Gate', status: 'completed', conclusion: 'success',
    }));
  });
});
