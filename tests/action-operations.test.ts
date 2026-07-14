import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fingerprintForPull, stewardCheckExternalId } from '../packages/core/src/index.js';
import {
  canonicalManifestJson,
  type ClassificationConfiguration,
  type LoadedManifest,
  type StewardManifest,
} from '../packages/manifest/src/index.js';
import {
  GitHubApiError,
  type CheckRunCreate,
  type CheckRunUpdate,
  type GitHubCheckRun,
  type GitHubIssueComment,
  type GitHubPullRequestDetail,
  type GitHubPullRequestReview,
  type GitHubRepositoryClient,
  type GitHubReviewThread,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from '../packages/github/src/index.js';
import {
  operationDefinitions,
  parseMatrixMode,
  parseMatrixScope,
  parseOperation,
} from '../action/src/contracts.js';
import {
  graphqlApiBase,
  PullRequestHeadMismatchError,
  PullRequestStateMismatchError,
  createControlOperationContext,
  createOperationContext,
  resolveExpectedHead,
  resolvePullNumber,
  trustedWorkflowRunContext,
  validateRepositoryDispatch,
  type GitHubEventPayload,
  type StewardControlOperationContext,
  type StewardOperationContext,
} from '../action/src/context.js';
import { executeControlOperation, executeOperation } from '../action/src/operations.js';
import { enabledMatrixConfiguration, stewardMatrixConfiguration } from '../action/src/catalog.js';
import { createReleasePreflight } from '../action/src/release-preflight.js';

function manifest(features: Partial<StewardManifest['features']> = {}): LoadedManifest {
  const value: StewardManifest = {
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
    ...(features.classification ? { classification } : {}),
  };
  const canonicalJson = canonicalManifestJson(value);
  return {
    manifest: value,
    canonicalJson,
    configDigest: createHash('sha256').update(canonicalJson).digest('hex'),
    source: { path: '.github/steward.json', ref: 'main', blobSha: 'manifest-sha' },
  };
}

const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function context(overrides: Record<string, unknown> = {}): {
  context: StewardOperationContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
  mutationClient: Record<string, ReturnType<typeof vi.fn>>;
  checkRuns: GitHubCheckRun[];
} {
  const pull: GitHubPullRequestDetail = {
    number: 7,
    state: 'open',
    title: 'feat: operation contract',
    body: '',
    user: { login: 'core' },
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { ref: 'feature/action', sha: 'c'.repeat(40) },
    requested_reviewers: [],
    mergeCommitSha: null,
  };
  let operationContext: StewardOperationContext;
  const checkRuns: GitHubCheckRun[] = [];
  const materializeCheck = (id: number, input: CheckRunCreate | CheckRunUpdate): GitHubCheckRun => ({
    id,
    head_sha: pull.head.sha,
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
  });
  const client = {
    getAuthenticatedUser: vi.fn(async () => ({ id: 99, login: 'splrad-steward[bot]', type: 'Bot' })),
    getUser: vi.fn(async () => ({ id: 99, login: 'splrad-steward[bot]', type: 'Bot' })),
    getRepository: vi.fn(async () => ({ id: 1296724484, fullName: 'splrad/steward', defaultBranch: 'main' })),
    getFile: vi.fn(async () => ({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(operationContext.manifest.canonicalJson).toString('base64'),
      sha: operationContext.manifest.source.blobSha,
    })),
    getPullRequest: vi.fn(async () => structuredClone(pull)),
    listTeamMembers: vi.fn(async () => []),
    listPullRequestCommits: vi.fn(async () => [{ sha: 'd'.repeat(40), author: { login: 'core' } }]),
    listPullRequestFiles: vi.fn(async () => []),
    listPullRequestReviews: vi.fn(async () => [{
      state: 'APPROVED', commit_id: pull.head.sha, user: { login: 'reviewer' }, body: 'approved',
    }]),
    listCommitCheckRuns: vi.fn(async () => structuredClone(checkRuns)),
    listIssueComments: vi.fn(async () => []),
    listReviewThreads: vi.fn(async () => []),
    listWorkflowRuns: vi.fn(async () => []),
    listWorkflowJobs: vi.fn(async () => []),
    getRepositoryLabel: vi.fn(async () => ({ name: 'feature', color: '000000' })),
    createRepositoryLabel: vi.fn(async () => ({ name: 'feature', color: '000000' })),
    addIssueLabels: vi.fn(async (_owner, _repository, _number, labels: readonly string[]) => {
      const current = new Map((pull.labels ?? []).map((label) => [String(label.name ?? '').toLowerCase(), label]));
      for (const label of labels) current.set(label.toLowerCase(), { name: label });
      pull.labels = [...current.values()];
    }),
    removeIssueLabel: vi.fn(async (_owner, _repository, _number, label: string) => {
      pull.labels = (pull.labels ?? []).filter((candidate) => (
        String(candidate.name ?? '').toLowerCase() !== label.toLowerCase()
      ));
    }),
    updatePullRequestBody: vi.fn(async (_owner, _repository, _number, body: string) => { pull.body = body; }),
    requestReviewers: vi.fn(async () => undefined),
    createPullRequestReview: vi.fn(async () => undefined),
    createCheckRun: vi.fn(async (_owner, _repository, input: CheckRunCreate): Promise<GitHubCheckRun> => {
      const check = materializeCheck(Math.max(0, ...checkRuns.map((candidate) => candidate.id)) + 1, input);
      checkRuns.push(check);
      return check;
    }),
    updateCheckRun: vi.fn(async (
      _owner,
      _repository,
      checkRunId: number,
      input: CheckRunUpdate,
    ): Promise<GitHubCheckRun> => {
      const check = materializeCheck(checkRunId, input);
      const index = checkRuns.findIndex((candidate) => candidate.id === checkRunId);
      if (index >= 0) checkRuns[index] = check;
      return check;
    }),
    createIssueComment: vi.fn(async () => ({ id: 1 })),
    updateIssueComment: vi.fn(async () => ({ id: 1 })),
    deleteIssueComment: vi.fn(async () => undefined),
    dispatchWorkflow: vi.fn(async () => ({
      kind: 'identified' as const,
      workflowRunId: 123,
      runUrl: 'https://api.github.com/repos/splrad/steward/actions/runs/123',
      htmlUrl: 'https://github.com/splrad/steward/actions/runs/123',
    })),
    rerunWorkflowJob: vi.fn(async () => undefined),
  };
  const mutationClient = {
    getAuthenticatedUser: vi.fn(async () => ({ login: 'reviewer' })),
    requestReviewers: vi.fn(async () => undefined),
    createPullRequestReview: vi.fn(async () => undefined),
  };
  operationContext = {
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
  };
  return {
    client,
    mutationClient,
    context: operationContext,
    checkRuns,
  };
}

function controlContext(
  fixture: ReturnType<typeof context>,
  attemptId = 'action-test-attempt',
): StewardControlOperationContext {
  return {
    eventName: fixture.context.eventName,
    client: fixture.context.client,
    route: {
      repository: {
        id: fixture.context.repositoryId,
        owner: fixture.context.owner,
        name: fixture.context.repository,
      },
      pullRequest: {
        number: fixture.context.pull.number,
        expectedHeadSha: fixture.context.pull.head.sha,
      },
      attemptId,
      ...(fixture.context.detailsUrl ? { detailsUrl: fixture.context.detailsUrl } : {}),
    },
  };
}

describe('Action operation contract', () => {
  it('keeps Actions-write ownership exclusive to Matrix', () => {
    expect(Object.entries(operationDefinitions).filter(([, definition]) => definition.actionsWrite).map(([name]) => name))
      .toEqual(['matrix']);
    expect(parseOperation('governance-main')).toBe('governance-main');
    expect(parseOperation('governance-preflight')).toBe('governance-preflight');
    expect(parseOperation('automation')).toBe('automation');
    expect(parseOperation('classification')).toBe('classification');
    expect(parseOperation('cleanup')).toBe('cleanup');
    expect(parseOperation('dco-advisory')).toBe('dco-advisory');
    expect(parseOperation('release-preflight')).toBe('release-preflight');
    expect(parseOperation('release-status')).toBe('release-status');
    expect(parseOperation('release-reconcile')).toBe('release-reconcile');
    expect(parseOperation('release-publish')).toBe('release-publish');
    expect(parseOperation('release-finalize')).toBe('release-finalize');
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
    expect(() => validateRepositoryDispatch({
      client_payload: { ...event.client_payload, delivery_id: '   ' },
    }, 1296724484)).toThrow('delivery ID');
    expect(() => validateRepositoryDispatch(event, 1)).toThrow('repository ID');
    expect(() => validateRepositoryDispatch({
      client_payload: { ...event.client_payload, source_event: 'workflow_run' },
    }, 1296724484)).toThrow('supported review signal');
    expect(() => validateRepositoryDispatch({
      client_payload: { ...event.client_payload, action: 'approved' },
    }, 1296724484)).toThrow('supported review signal');
    expect(() => validateRepositoryDispatch({
      client_payload: {
        repository_id: 1296724484,
        pr_number: 7,
        head_sha: 'c'.repeat(40),
        action: 'resolved',
        delivery_id: 'delivery',
      },
    }, 1296724484)).not.toThrow();
  });

  it('derives the distinct GHES GraphQL base without weakening REST confinement', () => {
    expect(graphqlApiBase('https://github.example/api/v3/')).toBe('https://github.example/api/');
    expect(graphqlApiBase('https://api.github.com/')).toBe('https://api.github.com/');
  });

  it('reports pull request state mismatch evidence without raw log control characters', () => {
    const error = new PullRequestStateMismatchError(7, 'open', 'closed\nforged-log-line');
    expect(error).toMatchObject({
      name: 'PullRequestStateMismatchError',
      pullNumber: 7,
      expectedState: 'open',
      actualState: 'closed\nforged-log-line',
    });
    expect(error.message).toBe(
      'Steward operation only accepts an open pull request; '
      + 'pull request #7 has state "closed\\nforged-log-line"',
    );
  });

  it('reports pull request head mismatch evidence with the pull request identity', () => {
    const error = new PullRequestHeadMismatchError(7, 'c'.repeat(40), 'd'.repeat(40));
    expect(error).toMatchObject({
      name: 'PullRequestHeadMismatchError',
      pullNumber: 7,
      expectedHead: 'c'.repeat(40),
      actualHead: 'd'.repeat(40),
    });
    expect(error.message).toContain('Pull request #7 head');
  });

  it('requires an explicit token and validates repository, default branch, and head from live metadata', async () => {
    const eventPath = 'tests/fixtures/action-event.json';
    const encodedManifest = Buffer.from(JSON.stringify(manifest().manifest)).toString('base64');
    const authorizationByPath = new Map<string, string>();
    let liveRepositoryId = 1296724484;
    let livePullState = 'open';
    let liveBaseRef = 'main';
    let liveHeadSha = 'c'.repeat(40);
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      authorizationByPath.set(path, new Headers(init?.headers).get('authorization') ?? '');
      if (path === '/repos/splrad/steward') {
        return new Response(JSON.stringify({ id: liveRepositoryId, full_name: 'splrad/steward', default_branch: 'main' }));
      }
      if (path === '/repos/splrad/steward/contents/.github/steward.json') {
        return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: encodedManifest, sha: 'blob' }));
      }
      if (path === '/repos/splrad/steward/pulls/7') {
        return new Response(JSON.stringify({
          number: 7,
          state: livePullState,
          base: { ref: liveBaseRef, sha: 'b'.repeat(40) },
          head: { sha: liveHeadSha },
        }));
      }
      if (path === '/user') return new Response(JSON.stringify({ login: 'reviewer' }));
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(createOperationContext({
      inputs: { operation: 'governance-main', eventPath },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'pull_request_target' },
      fetch: fetcher,
    })).rejects.toThrow('explicit GitHub token');
    expect(fetchMock).not.toHaveBeenCalled();

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

    await expect(createOperationContext({
      inputs: {
        operation: 'matrix',
        token: 'token',
        eventPath: 'tests/fixtures/action-workflow-run-event.json',
      },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'workflow_run' },
      fetch: fetcher,
    })).resolves.toMatchObject({
      pull: { number: 7, head: { sha: 'c'.repeat(40) } },
      eventName: 'workflow_run',
    });

    await expect(createOperationContext({
      inputs: {
        operation: 'matrix',
        token: 'token',
        eventPath: 'tests/fixtures/action-repository-dispatch-event.json',
      },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'repository_dispatch' },
      fetch: fetcher,
    })).resolves.toMatchObject({
      pull: { number: 7, head: { sha: 'c'.repeat(40) } },
      eventName: 'repository_dispatch',
    });

    const dispatchContext = () => createOperationContext({
      inputs: {
        operation: 'matrix' as const,
        token: 'token',
        eventPath: 'tests/fixtures/action-repository-dispatch-event.json',
      },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'repository_dispatch' },
      fetch: fetcher,
    });
    liveRepositoryId = 1;
    await expect(dispatchContext()).rejects.toThrow('event repository does not match');
    liveRepositoryId = 1296724484;

    liveHeadSha = 'd'.repeat(40);
    await expect(dispatchContext()).rejects.toThrow('Pull request #7 head');
    liveHeadSha = 'c'.repeat(40);

    liveBaseRef = 'develop';
    await expect(dispatchContext()).rejects.toThrow('does not target the current default branch');
    liveBaseRef = 'main';

    livePullState = 'closed';
    await expect(dispatchContext()).rejects.toThrow(
      'only accepts an open pull request; pull request #7 has state "closed"',
    );
  });

  it('builds the Classification/DCO Control route without preloading repository metadata or Manifest', async () => {
    const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const resolved = await createControlOperationContext({
      inputs: {
        operation: 'classification',
        token: 'platform-token',
        eventPath: 'tests/fixtures/action-event.json',
      },
      environment: {
        GITHUB_API_URL: 'https://api.github.com/',
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_RUN_ID: '123456',
        GITHUB_RUN_ATTEMPT: '2',
      },
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolved.route).toEqual({
      repository: { id: 1_296_724_484, owner: 'splrad', name: 'steward' },
      pullRequest: { number: 7, expectedHeadSha: 'c'.repeat(40) },
      attemptId: 'actions-run:123456:attempt:2',
      detailsUrl: 'https://github.com/splrad/steward/actions/runs/123456/attempts/2',
    });
  });

  it('binds reruns to distinct trusted Control attempt identities', async () => {
    const resolveAttempt = async (attempt: string) => (await createControlOperationContext({
      inputs: {
        operation: 'classification',
        token: 'platform-token',
        eventPath: 'tests/fixtures/action-event.json',
      },
      environment: {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_RUN_ID: '123456',
        GITHUB_RUN_ATTEMPT: attempt,
      },
    })).route.attemptId;

    await expect(resolveAttempt('1')).resolves.toBe('actions-run:123456:attempt:1');
    await expect(resolveAttempt('2')).resolves.toBe('actions-run:123456:attempt:2');
  });

  it.each([
    ['missing run attempt', '123456', undefined],
    ['zero run ID', '0', '1'],
    ['non-canonical run attempt', '123456', '01'],
    ['non-numeric run ID', 'run-123456', '1'],
  ])('rejects %s as a Control attempt identity', async (_name, runId, runAttempt) => {
    await expect(createControlOperationContext({
      inputs: {
        operation: 'classification',
        token: 'platform-token',
        eventPath: 'tests/fixtures/action-event.json',
      },
      environment: {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_RUN_ID: runId,
        ...(runAttempt ? { GITHUB_RUN_ATTEMPT: runAttempt } : {}),
      },
    })).rejects.toThrow('trusted positive GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT');
  });

  it('exposes runtime inputs without consumer policy fields', async () => {
    const metadata = await readFile('action/action.yml', 'utf8');
    for (const input of [
      'github-token:', 'mutation-token:', 'event-path:', 'pr-number:', 'head-sha:', 'source-branch:', 'matrix-mode:', 'matrix-scope:',
      'release-adapter-phase:', 'release-plan:',
    ]) {
      expect(metadata).toContain(input);
    }
    for (const output of ['governance-enabled:', 'copilot-review-enabled:']) expect(metadata).toContain(output);
    for (const forbidden of ['trusted-developers:', 'labels:', 'workflow-file:', 'check-name:']) {
      expect(metadata).not.toContain(forbidden);
    }
  });

  it('accepts Cleanup only for a live closed PR matching the trusted close event', async () => {
    const encodedManifest = Buffer.from(JSON.stringify(manifest().manifest)).toString('base64');
    let liveState = 'closed';
    let liveMerged = true;
    let liveMergeSha = 'a'.repeat(40);
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      if (path === '/repos/splrad/steward') {
        return new Response(JSON.stringify({ id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' }));
      }
      if (path === '/repos/splrad/steward/contents/.github/steward.json') {
        return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: encodedManifest, sha: 'blob' }));
      }
      if (path === '/repos/splrad/steward/pulls/7') {
        return new Response(JSON.stringify({
          number: 7,
          state: liveState,
          merged: liveMerged,
          base: { ref: 'main', sha: 'b'.repeat(40) },
          head: { ref: 'feature/cleanup', sha: 'c'.repeat(40) },
        }));
      }
      if (path === '/graphql') {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: {
          state: liveMerged ? 'MERGED' : 'CLOSED',
          merged: liveMerged,
          mergeCommit: liveMerged ? { oid: liveMergeSha } : null,
        } } } }));
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    const cleanupContext = (eventName = 'pull_request_target') => createOperationContext({
      inputs: { operation: 'cleanup', token: 'token', eventPath: 'tests/fixtures/action-cleanup-event.json' },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: eventName },
      fetch: fetchMock as unknown as typeof fetch,
      pullState: 'closed',
    });
    await expect(cleanupContext()).resolves.toMatchObject({ pull: { state: 'closed', merged: true } });

    liveMerged = false;
    await expect(cleanupContext()).rejects.toThrow('merged state does not match');
    liveMerged = true;
    liveMergeSha = 'b'.repeat(40);
    await expect(cleanupContext()).rejects.toThrow('merge commit does not match');
    liveMergeSha = 'a'.repeat(40);
    liveState = 'open';
    await expect(cleanupContext()).rejects.toThrow(
      'only accepts a closed pull request; pull request #7 has state "open"',
    );
    liveState = 'closed';
    await expect(cleanupContext('workflow_dispatch')).rejects.toThrow('require a pull_request_target closed event');
  });

  it('builds Release adapter context only from a live merged default-branch PR and trusted close event', async () => {
    const releaseManifest = manifest({ release: true }).manifest;
    releaseManifest.release = {
      triggerPaths: ['release/version.txt'],
      runner: 'ubuntu-latest',
      adapterCommand: ['node', '.github/steward/release.mjs'],
    };
    const encodedManifest = Buffer.from(JSON.stringify(releaseManifest)).toString('base64');
    let changedFile = 'release/version.txt';
    let liveMergeSha = 'e'.repeat(40);
    let liveMerged = true;
    let liveBaseRef = 'main';
    let eventName: 'pull_request' | 'pull_request_target' = 'pull_request';
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      if (path === '/repos/splrad/steward') {
        return new Response(JSON.stringify({ id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' }));
      }
      if (path === '/repos/splrad/steward/contents/.github/steward.json') {
        return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: encodedManifest, sha: 'blob' }));
      }
      if (path === '/repos/splrad/steward/pulls/7') {
        return new Response(JSON.stringify({
          number: 7,
          state: 'closed',
          merged: liveMerged,
          base: { ref: liveBaseRef, sha: 'b'.repeat(40) },
          head: { sha: 'c'.repeat(40) },
        }));
      }
      if (path === '/graphql') {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: {
          state: liveMerged ? 'MERGED' : 'CLOSED',
          merged: liveMerged,
          mergeCommit: liveMerged ? { oid: liveMergeSha } : null,
        } } } }));
      }
      if (path === '/repos/splrad/steward/pulls/7/files') {
        return new Response(JSON.stringify([{ filename: changedFile }]));
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    const preflight = () => createReleasePreflight({
      inputs: {
        operation: 'release-preflight',
        token: 'platform-token',
        eventPath: 'tests/fixtures/action-release-event.json',
      },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: eventName },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(preflight()).resolves.toMatchObject({
      state: 'passed',
      runner: 'ubuntu-latest',
      adapterCommand: ['node', '.github/steward/release.mjs'],
      context: {
        repository: { id: 1296724484, fullName: 'splrad/steward' },
        pullRequest: { number: 7, mergeSha: 'e'.repeat(40) },
      },
      decision: { state: 'planned', matchedPaths: ['release/version.txt'] },
    });

    eventName = 'pull_request_target';
    await expect(preflight()).resolves.toMatchObject({
      state: 'passed',
      context: { pullRequest: { number: 7, mergeSha: 'e'.repeat(40) } },
      decision: { state: 'planned', matchedPaths: ['release/version.txt'] },
    });
    eventName = 'pull_request';

    changedFile = 'docs/readme.md';
    await expect(preflight()).resolves.toMatchObject({
      state: 'ignored',
      decision: { reason: 'trigger-path-not-matched' },
    });

    liveMergeSha = 'f'.repeat(40);
    await expect(preflight()).rejects.toThrow('does not match trusted event');
    liveMergeSha = 'e'.repeat(40);

    liveBaseRef = 'develop';
    await expect(preflight()).rejects.toThrow('does not target the current default branch');
    liveBaseRef = 'main';

    liveMerged = false;
    await expect(preflight()).rejects.toThrow('requires a merged pull request');
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

  it('does not request Copilot again while the reviewer is pending or after the current head was reviewed', async () => {
    const pending = context();
    pending.context.pull.requested_reviewers = [{ login: 'copilot-pull-request-reviewer[bot]' }];
    await expect(executeOperation(
      'governance-request-copilot', pending.context, { operation: 'governance-request-copilot' },
    )).resolves.toMatchObject({ state: 'ignored', summary: 'Copilot review is already requested' });
    expect(pending.client.listPullRequestReviews).not.toHaveBeenCalled();
    expect(pending.mutationClient.requestReviewers).not.toHaveBeenCalled();

    const reviewed = context();
    reviewed.client.listPullRequestReviews!.mockResolvedValue([{
      state: 'COMMENTED',
      commit_id: reviewed.context.pull.head.sha,
      user: { login: 'copilot-pull-request-reviewer[bot]' },
      submitted_at: '2026-07-12T03:07:44Z',
    }]);
    await expect(executeOperation(
      'governance-request-copilot', reviewed.context, { operation: 'governance-request-copilot' },
    )).resolves.toMatchObject({ state: 'ignored', summary: 'Copilot already reviewed the current head' });
    expect(reviewed.mutationClient.requestReviewers).not.toHaveBeenCalled();
  });

  it('requests Copilot again when the only prior review belongs to an older head', async () => {
    const fixture = context();
    fixture.client.listPullRequestReviews!.mockResolvedValue([{
      state: 'COMMENTED',
      commit_id: 'd'.repeat(40),
      user: { login: 'copilot-pull-request-reviewer[bot]' },
      submitted_at: '2026-07-12T02:15:27Z',
    }]);

    await expect(executeOperation(
      'governance-request-copilot', fixture.context, { operation: 'governance-request-copilot' },
    )).resolves.toMatchObject({ state: 'passed', summary: 'Copilot review requested' });
    expect(fixture.mutationClient.requestReviewers).toHaveBeenCalledOnce();
  });

  it('requests Copilot again when the current-head review was dismissed', async () => {
    const fixture = context();
    fixture.client.listPullRequestReviews!.mockResolvedValue([{
      state: 'DISMISSED',
      commit_id: fixture.context.pull.head.sha,
      user: { login: 'copilot-pull-request-reviewer[bot]' },
      submitted_at: '2026-07-12T03:07:44Z',
    }]);

    await executeOperation('governance-request-copilot', fixture.context, { operation: 'governance-request-copilot' });
    expect(fixture.mutationClient.requestReviewers).toHaveBeenCalledOnce();
  });

  it('converges Classification through Manifest policy, GitHub primitives, metadata, and the App Check', async () => {
    const fixture = context();
    fixture.context.manifest = {
      ...manifest({ classification: true }),
      manifest: { ...manifest({ classification: true }).manifest, classification },
    };
    fixture.context.pull.labels = [{ name: 'documentation' }, { name: 'area:docs' }, { name: 'external' }];
    fixture.client.listPullRequestFiles!.mockResolvedValue([{ filename: 'src/Options.cs' }]);

    const result = await executeControlOperation('classification', controlContext(fixture));

    expect(result).toMatchObject({
      state: 'passed',
      details: { evaluation: { decision: { kind: 'kind:feature', publicLabels: ['feature'] } } },
    });
    expect(fixture.client.getRepositoryLabel).toHaveBeenCalledWith('splrad', 'steward', 'feature');
    expect(fixture.client.removeIssueLabel).toHaveBeenCalledWith('splrad', 'steward', 7, 'documentation');
    expect(fixture.client.removeIssueLabel).toHaveBeenCalledWith('splrad', 'steward', 7, 'area:docs');
    expect(fixture.client.removeIssueLabel).not.toHaveBeenCalledWith('splrad', 'steward', 7, 'external');
    expect(fixture.client.addIssueLabels).toHaveBeenCalledWith('splrad', 'steward', 7, ['feature']);
    expect(fixture.client.updatePullRequestBody).not.toHaveBeenCalled();
    expect(fixture.client.updateCheckRun).toHaveBeenCalledWith('splrad', 'steward', 1, expect.objectContaining({
      name: 'PR Classification Gate', status: 'completed', conclusion: 'success',
    }));
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Classification Gate', status: 'in_progress', headSha: 'c'.repeat(40),
    }));
  });

  it('does not trust stale PR metadata to remove labels when Classification is disabled', async () => {
    const fixture = context();
    fixture.context.pull.body = '<!-- workflow:pr-classification:start\nvisible-labels=security\nworkflow:pr-classification:end -->';
    const result = await executeControlOperation('classification', controlContext(fixture));
    expect(result).toMatchObject({ state: 'ignored' });
    expect(fixture.client.listPullRequestFiles).not.toHaveBeenCalled();
    expect(fixture.client.removeIssueLabel).not.toHaveBeenCalled();
    expect(fixture.client.updatePullRequestBody).not.toHaveBeenCalled();
    expect(fixture.client.createCheckRun).not.toHaveBeenCalled();
  });

  it('reports DCO issues as advisory, skips bots, and removes only App-owned legacy comments', async () => {
    const fixture = context();
    fixture.context.manifest = manifest({ dcoAdvisory: true });
    fixture.client.listPullRequestCommits!.mockResolvedValue([
      {
        sha: 'd'.repeat(40),
        author: { login: 'external', type: 'User' },
        commit: {
          author: { name: 'External', email: 'external@example.com' },
          message: `fix: ping @maintainer with \`markdown\` <tag> &lt;entity&gt; ${'x'.repeat(300)}`,
        },
      },
      {
        sha: 'e'.repeat(40),
        author: { login: 'dependabot[bot]', type: 'Bot' },
        commit: {
          author: { name: 'dependabot[bot]', email: 'dependabot[bot]@users.noreply.github.com' },
          message: 'chore: bump dependency',
        },
      },
      {
        sha: 'f'.repeat(40),
        author: { login: 'core', type: 'User' },
        commit: {
          author: { name: 'Core', email: 'core@example.com' },
          message: 'feat: signed\n\nSigned-off-by: Core <core@example.com>',
        },
      },
    ]);
    fixture.client.listIssueComments!.mockResolvedValue([
      { id: 10, user: { id: 99, login: 'splrad-steward[bot]', type: 'Bot' }, body: '<!-- workflow:dco-signoff-advisory -->' },
      { id: 11, user: { login: 'splrad-steward[bot]' }, body: 'unrelated' },
      { id: 12, user: { login: 'external' }, body: '<!-- workflow:dco-signoff-advisory -->' },
    ]);

    const result = await executeControlOperation('dco-advisory', controlContext(fixture));

    expect(result).toMatchObject({
      operation: 'dco-advisory',
      state: 'passed',
      details: {
        evaluation: { total: 3, passed: 1, skipped: 1, issues: [{ reason: 'missing' }] },
        issuesTruncated: 0,
        legacyCommentsDeleted: 1,
      },
    });
    expect(result.summary).not.toContain('@maintainer');
    expect(result.summary).toContain('@\u200bmaintainer');
    expect(result.summary).not.toContain('`markdown`');
    expect(result.summary).toContain("'markdown'");
    expect(result.summary).toContain('&lt;tag&gt;');
    expect(result.summary).toContain('&amp;lt;entity&amp;gt;');
    expect(result.summary).toContain('external@example.com');
    expect(result.summary).not.toContain('external@\u200bexample.com');
    const details = result.details as { evaluation: { issues: Array<{ subject: string; authorEmail: string }> } };
    expect(details.evaluation.issues[0]?.subject).toContain('@\u200bmaintainer');
    expect(details.evaluation.issues[0]?.subject.length).toBeLessThanOrEqual(240);
    expect(details.evaluation.issues[0]?.authorEmail).toBe('external@example.com');
    expect(fixture.client.deleteIssueComment).toHaveBeenCalledOnce();
    expect(fixture.client.deleteIssueComment).toHaveBeenCalledWith('splrad', 'steward', 10);
    expect(fixture.client.createIssueComment).not.toHaveBeenCalled();
    expect(fixture.client.createCheckRun).not.toHaveBeenCalled();
  });

  it('does not read commits or comments when DCO Advisory is disabled', async () => {
    const fixture = context();
    const result = await executeControlOperation('dco-advisory', controlContext(fixture));
    expect(result).toMatchObject({ state: 'ignored' });
    expect(fixture.client.listPullRequestCommits).not.toHaveBeenCalled();
    expect(fixture.client.listIssueComments).not.toHaveBeenCalled();
  });

  it('bounds DCO workflow output while preserving complete advisory counts', async () => {
    const fixture = context();
    fixture.context.manifest = manifest({ dcoAdvisory: true });
    fixture.client.listPullRequestCommits!.mockResolvedValue(Array.from({ length: 22 }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      author: { login: `external-${index}`, type: 'User' },
      commit: {
        author: { name: `External ${index}`, email: `external-${index}@example.com` },
        message: `fix: unsigned ${index}`,
      },
    })));
    const result = await executeControlOperation('dco-advisory', controlContext(fixture));
    expect(result).toMatchObject({
      state: 'passed',
      details: {
        evaluation: { total: 22, issues: expect.arrayContaining([expect.objectContaining({ reason: 'missing' })]) },
        issuesTruncated: 2,
      },
    });
    const details = result.details as { evaluation: { issues: unknown[] } };
    expect(details.evaluation.issues).toHaveLength(20);
    expect(result.summary).toContain('另有 2 项未展开');
  });

  it('fails on malformed GitHub commit evidence instead of reporting a false advisory result', async () => {
    const fixture = context();
    fixture.context.manifest = manifest({ dcoAdvisory: true });
    fixture.client.listPullRequestCommits!.mockResolvedValue([{ sha: 'short', commit: { message: 'fix: malformed' } }]);
    await expect(executeControlOperation('dco-advisory', controlContext(fixture)))
      .rejects.toThrow('without a valid SHA or message');
    expect(fixture.client.deleteIssueComment).not.toHaveBeenCalled();
  });

  it('does not mistake an empty commit response for a clean DCO advisory', async () => {
    const fixture = context();
    fixture.context.manifest = manifest({ dcoAdvisory: true });
    fixture.client.listPullRequestCommits!.mockResolvedValue([]);
    await expect(executeControlOperation('dco-advisory', controlContext(fixture)))
      .rejects.toThrow('no commits for an open pull request');
  });

  it('removes only App-owned temporary state and updates one durable merged notification', async () => {
    const fixture = context();
    Object.assign(fixture.context.pull, {
      state: 'closed',
      merged: true,
      mergeCommitSha: 'a'.repeat(40),
      merged_by: { login: 'reviewer' },
      title: 'feat: cleanup @maintainer <tag> &lt;entity&gt;',
      body: '<!-- workflow:source-actor:external-dev -->',
      user: { login: 'splrad-steward[bot]', type: 'Bot' },
      head: { ref: 'feature/@cleanup', sha: 'c'.repeat(40) },
    });
    fixture.client.listIssueComments!.mockResolvedValue([
      { id: 10, user: { login: 'splrad-steward[bot]' }, body: '<!-- workflow:pr-blocking-failures -->' },
      { id: 11, user: { login: 'external' }, body: '<!-- workflow:pr-blocking-failures -->' },
      { id: 12, user: { login: 'splrad-steward[bot]' }, body: '<!-- workflow:pr-close-status -->\nold' },
      { id: 13, user: { login: 'splrad-steward[bot]' }, body: '<!-- workflow:pr-close-status -->\nduplicate' },
    ]);

    const result = await executeOperation('cleanup', fixture.context, { operation: 'cleanup' });

    expect(result).toMatchObject({
      state: 'passed',
      details: {
        merged: true,
        removedEphemeralComments: 1,
        removedCloseComments: 1,
        notificationAction: 'update',
      },
    });
    expect(fixture.client.deleteIssueComment!.mock.calls.map((call) => call[2])).toEqual([10, 13]);
    expect(fixture.client.updateIssueComment).toHaveBeenCalledOnce();
    const notification = String(fixture.client.updateIssueComment!.mock.calls[0]?.[3] ?? '');
    expect(notification).toContain('<!-- workflow:pr-close-status -->');
    expect(notification).toContain('@external-dev');
    expect(notification).toContain('@core');
    expect(notification).toContain('@reviewer');
    expect(notification).not.toContain('@maintainer');
    expect(notification).toContain('@\u200bmaintainer');
    expect(notification).toContain('&lt;tag&gt;');
    expect(notification).toContain('&amp;lt;entity&amp;gt;');
    expect(notification).toContain('feature/@\u200bcleanup');
    expect(fixture.client.createIssueComment).not.toHaveBeenCalled();
  });

  it('cleans stale App state without publishing a notification for an unmerged close', async () => {
    const fixture = context();
    Object.assign(fixture.context.pull, { state: 'closed', merged: false });
    fixture.client.listIssueComments!.mockResolvedValue([
      { id: 20, user: { login: 'splrad-steward[bot]' }, body: '<!-- workflow:copilot-review-gate -->' },
      { id: 21, user: { login: 'splrad-steward[bot]' }, body: '<!-- workflow:pr-close-status -->\nstale' },
      { id: 22, user: { login: 'external' }, body: '<!-- workflow:pr-close-status -->\nkeep' },
    ]);
    const result = await executeOperation('cleanup', fixture.context, { operation: 'cleanup' });
    expect(result).toMatchObject({
      state: 'passed',
      details: { merged: false, removedEphemeralComments: 1, removedCloseComments: 1, notificationAction: 'none' },
    });
    expect(fixture.client.deleteIssueComment!.mock.calls.map((call) => call[2])).toEqual([20, 21]);
    expect(fixture.client.createIssueComment).not.toHaveBeenCalled();
    expect(fixture.client.updateIssueComment).not.toHaveBeenCalled();
  });

  it('renders missing merged identities as text without mentioning the placeholder account', async () => {
    const fixture = context();
    Object.assign(fixture.context.pull, {
      state: 'closed',
      merged: true,
      mergeCommitSha: 'a'.repeat(40),
      merged_by: null,
      title: 'feat: cleanup',
      body: null,
      user: null,
      head: { ref: 'feature/cleanup', sha: 'c'.repeat(40) },
    });

    await executeOperation('cleanup', fixture.context, { operation: 'cleanup' });

    expect(fixture.client.createIssueComment).toHaveBeenCalledOnce();
    const notification = String(fixture.client.createIssueComment!.mock.calls[0]?.[3] ?? '');
    expect(notification).toContain('- 提交人：unknown');
    expect(notification).toContain('- 合并人：unknown');
    expect(notification).not.toContain('@unknown');
    expect(notification).toContain('- 通知对象：@core');
  });

  it('creates a missing managed label and tolerates only a confirmed concurrent creation race', async () => {
    const fixture = context();
    fixture.context.manifest = {
      ...manifest({ classification: true }),
      manifest: { ...manifest({ classification: true }).manifest, classification },
    };
    fixture.client.listPullRequestFiles!.mockResolvedValue([{ filename: 'src/Options.cs' }]);
    fixture.client.getRepositoryLabel!
      .mockRejectedValueOnce(new GitHubApiError({ status: 404, method: 'GET', path: '/labels/feature', message: 'missing' }))
      .mockResolvedValueOnce({ name: 'feature', color: '000000' });
    fixture.client.createRepositoryLabel!.mockRejectedValueOnce(new GitHubApiError({
      status: 422, method: 'POST', path: '/labels', message: 'already exists',
    }));

    await executeControlOperation('classification', controlContext(fixture));

    expect(fixture.client.createRepositoryLabel).toHaveBeenCalledOnce();
    expect(fixture.client.getRepositoryLabel).toHaveBeenCalledTimes(2);
    expect(fixture.client.createCheckRun).toHaveBeenCalledOnce();
  });

  it('creates a fresh Check generation without touching already-converged labels or the contributor body', async () => {
    const fixture = context();
    fixture.context.manifest = {
      ...manifest({ classification: true }),
      manifest: { ...manifest({ classification: true }).manifest, classification },
    };
    fixture.context.pull.labels = [{ name: 'FEATURE' }];
    fixture.context.pull.body = [
      '<!-- workflow:pr-classification:start',
      'areas=area:runtime',
      'kind=kind:feature',
      'visible-labels=feature',
      'release-labels=feature',
      'workflow:pr-classification:end -->',
    ].join('\n');
    const files = [{ filename: 'src/Options.cs' }];
    fixture.client.listPullRequestFiles!.mockResolvedValue(files);
    const inputDigest = (await fingerprintForPull({
      pull: fixture.context.pull,
      commits: [{ sha: 'd'.repeat(40), author: { login: 'core' } }],
      files,
      botLogins: ['splrad-steward', 'copilot-pull-request-reviewer[bot]'],
    })).value;
    const externalId = stewardCheckExternalId({
      repositoryId: 1296724484,
      prNumber: 7,
      headSha: 'c'.repeat(40),
      checkId: 'pr-classification',
      configDigest: fixture.context.manifest.configDigest,
      inputDigest,
    });
    fixture.checkRuns.push({
      id: 44,
      head_sha: 'c'.repeat(40),
      name: 'PR Classification Gate',
      status: 'completed',
      conclusion: 'success',
      external_id: externalId,
      app: { id: 4243096, slug: 'splrad-steward' },
      output: {
        title: 'PR 分类已更新',
        summary: '标题、正文、提交、贡献者和文件输入均与当前分类结果一致。',
      },
    });

    await executeControlOperation('classification', controlContext(fixture));

    expect(fixture.client.getRepositoryLabel).not.toHaveBeenCalled();
    expect(fixture.client.removeIssueLabel).not.toHaveBeenCalled();
    expect(fixture.client.addIssueLabels).not.toHaveBeenCalled();
    expect(fixture.client.updatePullRequestBody).not.toHaveBeenCalled();
    expect(fixture.client.createCheckRun).toHaveBeenCalledOnce();
    expect(fixture.client.updateCheckRun).not.toHaveBeenCalledWith('splrad', 'steward', 44, expect.anything());
    expect(fixture.client.updateCheckRun).toHaveBeenCalledWith('splrad', 'steward', 45, expect.objectContaining({
      status: 'completed', conclusion: 'success',
    }));
  });

  it('never writes a passing Classification Check after a label mutation failure', async () => {
    const fixture = context();
    fixture.context.manifest = {
      ...manifest({ classification: true }),
      manifest: { ...manifest({ classification: true }).manifest, classification },
    };
    fixture.context.pull.labels = [{ name: 'documentation' }];
    fixture.client.listPullRequestFiles!.mockResolvedValue([{ filename: 'src/Options.cs' }]);
    fixture.client.removeIssueLabel!.mockRejectedValueOnce(new GitHubApiError({
      status: 500, method: 'DELETE', path: '/labels/documentation', message: 'failed',
    }));

    await expect(executeControlOperation('classification', controlContext(fixture)))
      .rejects.toThrow('failed (500)');
    expect(fixture.client.addIssueLabels).toHaveBeenCalledOnce();
    expect(fixture.client.addIssueLabels!.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.client.removeIssueLabel!.mock.invocationCallOrder[0]!);
    expect(fixture.client.updatePullRequestBody).not.toHaveBeenCalled();
    expect(fixture.client.createCheckRun).toHaveBeenCalledOnce();
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      status: 'in_progress',
    }));
    expect(fixture.client.createCheckRun).not.toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      status: 'completed',
      conclusion: 'success',
    }));
    expect(fixture.client.updateCheckRun).not.toHaveBeenCalledWith('splrad', 'steward', expect.any(Number), expect.objectContaining({
      status: 'completed', conclusion: 'success',
    }));
    expect(fixture.client.updateCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.any(Number), expect.objectContaining({
      status: 'completed', conclusion: 'failure',
    }));
  });

  it.each([
    {
      name: 'commit SHA',
      arrange: (fixture: ReturnType<typeof context>) => fixture.client.listPullRequestCommits!.mockResolvedValue([{ sha: '' }]),
      message: 'valid SHA',
    },
    {
      name: 'file name',
      arrange: (fixture: ReturnType<typeof context>) => fixture.client.listPullRequestFiles!.mockResolvedValue([{ filename: '' }]),
      message: 'valid filename',
    },
    {
      name: 'label name',
      arrange: (fixture: ReturnType<typeof context>) => { fixture.context.pull.labels = [{}]; },
      message: 'valid name',
    },
  ])('fails closed before Classification mutations when GitHub omits a valid $name', async ({ arrange, message }) => {
    const fixture = context();
    fixture.context.manifest = {
      ...manifest({ classification: true }),
      manifest: { ...manifest({ classification: true }).manifest, classification },
    };
    arrange(fixture);

    await expect(executeControlOperation('classification', controlContext(fixture)))
      .rejects.toThrow(message);
    expect(fixture.client.getRepositoryLabel).not.toHaveBeenCalled();
    expect(fixture.client.addIssueLabels).not.toHaveBeenCalled();
    expect(fixture.client.removeIssueLabel).not.toHaveBeenCalled();
    expect(fixture.client.updatePullRequestBody).not.toHaveBeenCalled();
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      status: 'in_progress',
    }));
    expect(fixture.client.updateCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.any(Number), expect.objectContaining({
      status: 'completed', conclusion: 'failure',
    }));
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

  it('converges aggregate Governance failures through review and Resolve events', async () => {
    const fixture = context();
    const comments: GitHubIssueComment[] = [];
    const reviews: GitHubPullRequestReview[] = [{
      id: 20,
      state: 'COMMENTED',
      body: 'Copilot reviewed 1 out of 1 changed files in this pull request and generated 1 comment.',
      commit_id: fixture.context.pull.head.sha,
      user: { login: 'copilot-pull-request-reviewer[bot]' },
    }];
    const threads: GitHubReviewThread[] = [{
      id: 'thread-1',
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [{
          id: 'comment-1',
          body: 'Severity: blocking\nTitle: Fix the unsafe state transition',
          url: 'https://github.example/thread/1',
          author: { login: 'copilot-pull-request-reviewer[bot]' },
        }],
      },
    }];
    let nextCommentId = 30;

    fixture.client.listPullRequestReviews!.mockImplementation(async () => reviews);
    fixture.client.listReviewThreads!.mockImplementation(async () => threads);
    fixture.client.listIssueComments!.mockImplementation(async () => comments);
    fixture.client.createIssueComment!.mockImplementation(async (_owner, _repository, _number, body: string) => {
      const comment = { id: nextCommentId++, body, user: { login: 'splrad-steward[bot]' } };
      comments.push(comment);
      return comment;
    });
    fixture.client.updateIssueComment!.mockImplementation(async (_owner, _repository, commentId: number, body: string) => {
      const comment = comments.find((candidate) => candidate.id === commentId);
      if (!comment) throw new Error(`Unknown in-memory issue comment ${commentId}`);
      comment.body = body;
      return comment;
    });
    fixture.client.deleteIssueComment!.mockImplementation(async (_owner, _repository, commentId: number) => {
      const index = comments.findIndex((candidate) => candidate.id === commentId);
      if (index < 0) throw new Error(`Unknown in-memory issue comment ${commentId}`);
      comments.splice(index, 1);
    });

    const mainBlocked = await executeOperation('governance-main', fixture.context, { operation: 'governance-main' });
    expect(mainBlocked.state).toBe('failed');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('核心开发者审批');

    const copilotBlocked = await executeOperation(
      'governance-copilot', fixture.context, { operation: 'governance-copilot' },
    );
    expect(copilotBlocked).toMatchObject({ state: 'failed', summary: 'blocking-comments' });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('核心开发者审批');
    expect(comments[0]?.body).toContain('Copilot 阻断评论');

    reviews.push({
      id: 21,
      state: 'APPROVED',
      body: 'approved',
      commit_id: fixture.context.pull.head.sha,
      user: { login: 'reviewer' },
    });
    const mainRecovered = await executeOperation('governance-main', fixture.context, { operation: 'governance-main' });
    expect(mainRecovered.state).toBe('passed');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).not.toContain('核心开发者审批');
    expect(comments[0]?.body).toContain('Copilot 阻断评论');

    threads[0]!.isResolved = true;
    fixture.context.eventName = 'repository_dispatch';
    const copilotRecovered = await executeOperation(
      'governance-copilot', fixture.context, { operation: 'governance-copilot' },
    );
    expect(copilotRecovered).toMatchObject({ state: 'passed', summary: 'no-current-comments-with-known-conclusion' });
    expect(comments).toEqual([]);
    expect(fixture.client.createIssueComment).toHaveBeenCalledOnce();
    expect(fixture.client.updateIssueComment).toHaveBeenCalledTimes(2);
    expect(fixture.client.deleteIssueComment).toHaveBeenCalledOnce();
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
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(3);
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'dco-advisory.yml', ref: 'main',
    }));
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'pr-governance.yml', ref: 'main',
    }));
    expect(fixture.client.listWorkflowJobs).toHaveBeenCalledWith('splrad', 'steward', 80);
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Validation Matrix Gate', status: 'in_progress',
    }));
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'DCO Sign-off Advisory',
      detailsUrl: 'https://github.com/splrad/steward/actions/runs/123',
    }));
    expect(fixture.client.createCheckRun).not.toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Validation Matrix Gate', conclusion: 'failure',
    }));
  });

  it('omits dispatcher context details from legacy dispatch proxy Checks', async () => {
    const fixture = context({
      detailsUrl: 'https://github.com/splrad/steward/actions/runs/999',
    });
    fixture.context.manifest = manifest({ classification: true, dcoAdvisory: true });
    fixture.client.dispatchWorkflow!.mockResolvedValue({ kind: 'accepted' });

    await executeOperation('matrix', fixture.context, { operation: 'matrix' });

    const proxyWrites = fixture.client.createCheckRun!.mock.calls
      .map((call) => call[2] as CheckRunCreate)
      .filter((input) => input.title === '等待一次性补跑结果');
    expect(proxyWrites.length).toBeGreaterThan(0);
    for (const input of proxyWrites) expect(input).not.toHaveProperty('detailsUrl');
  });

  it('starts a fresh legacy proxy generation instead of reusing a completed Check with an old run URL', async () => {
    const fixture = context({
      eventName: 'workflow_dispatch',
      detailsUrl: 'https://github.com/splrad/steward/actions/runs/999',
    });
    const inputDigest = (await fingerprintForPull({
      pull: fixture.context.pull,
      commits: [{ sha: 'd'.repeat(40), author: { login: 'core' } }],
      files: [],
      botLogins: ['splrad-steward', 'copilot-pull-request-reviewer[bot]'],
    })).value;
    const identity = (checkId: string) => stewardCheckExternalId({
      repositoryId: 1296724484,
      prNumber: 7,
      headSha: 'c'.repeat(40),
      checkId,
      configDigest: fixture.context.manifest.configDigest,
      inputDigest,
    });
    fixture.client.listCommitCheckRuns!.mockResolvedValue([
      {
        id: 70,
        name: 'Main Authorization Gate',
        status: 'completed',
        conclusion: 'success',
        external_id: identity('main-authorization'),
        app: { slug: 'splrad-steward' },
      },
      {
        id: 71,
        name: 'Copilot Code Review Gate',
        status: 'completed',
        conclusion: 'failure',
        details_url: 'https://github.com/splrad/steward/actions/runs/888',
        external_id: identity('copilot-review-gate'),
        app: { slug: 'splrad-steward' },
      },
    ]);
    fixture.client.dispatchWorkflow!.mockResolvedValue({ kind: 'accepted' });

    await executeOperation('matrix', fixture.context, { operation: 'matrix' });

    expect(fixture.client.updateCheckRun).not.toHaveBeenCalledWith(
      'splrad', 'steward', 71, expect.anything(),
    );
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'Copilot Code Review Gate',
      status: 'in_progress',
      headSha: 'c'.repeat(40),
    }));
    const proxy = fixture.client.createCheckRun!.mock.calls
      .map((call) => call[2] as CheckRunCreate)
      .find((input) => input.name === 'Copilot Code Review Gate');
    expect(proxy).not.toHaveProperty('detailsUrl');
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
    const inputDigest = (await fingerprintForPull({
      pull: fixture.context.pull,
      commits: [{ sha: 'd'.repeat(40), author: { login: 'core' } }],
      files: [],
      botLogins: ['splrad-steward', 'copilot-pull-request-reviewer[bot]'],
    })).value;
    const identity = (checkId: string) => stewardCheckExternalId({
      repositoryId: 1296724484,
      prNumber: 7,
      headSha: 'c'.repeat(40),
      checkId,
      configDigest: fixture.context.manifest.configDigest,
      inputDigest,
    });
    fixture.client.listWorkflowJobs!.mockResolvedValue([{
      id: 81,
      name: 'govern / Main Authorization Gate',
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
        id: 89,
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
    expect(fixture.client.updateCheckRun).toHaveBeenCalledWith('splrad', 'steward', 89, expect.objectContaining({
      status: 'completed', conclusion: 'success',
    }));
    expect(fixture.client.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({
      name: 'PR Validation Matrix Gate', status: 'completed', conclusion: 'success',
    }));
  });

  it('starts one new Matrix Gate generation when a completed same-head gate becomes pending', async () => {
    const fixture = context();
    const inputDigest = (await fingerprintForPull({
      pull: fixture.context.pull,
      commits: [{ sha: 'd'.repeat(40), author: { login: 'core' } }],
      files: [],
      botLogins: ['splrad-steward', 'copilot-pull-request-reviewer[bot]'],
    })).value;
    const identity = (checkId: string) => stewardCheckExternalId({
      repositoryId: 1296724484,
      prNumber: 7,
      headSha: 'c'.repeat(40),
      checkId,
      configDigest: fixture.context.manifest.configDigest,
      inputDigest,
    });
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 90,
        name: 'Main Authorization Gate',
        status: 'in_progress',
        conclusion: null,
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
      {
        id: 92,
        name: 'PR Validation Matrix Gate',
        status: 'completed',
        conclusion: 'failure',
        external_id: identity('validation-matrix'),
        app: { slug: 'splrad-steward' },
      },
    ];
    let nextCheckRunId = 100;
    fixture.client.listCommitCheckRuns!.mockImplementation(async () => checkRuns);
    fixture.client.createCheckRun!.mockImplementation(async (
      _owner,
      _repository,
      input: CheckRunCreate,
    ) => {
      const run: GitHubCheckRun = {
        id: nextCheckRunId++,
        name: input.name,
        status: input.status,
        conclusion: input.conclusion ?? null,
        app: { slug: 'splrad-steward' },
        ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
      };
      checkRuns.push(run);
      return run;
    });
    fixture.client.updateCheckRun!.mockImplementation(async (
      _owner,
      _repository,
      checkRunId: number,
      input: CheckRunUpdate,
    ) => {
      const run = checkRuns.find((candidate) => candidate.id === checkRunId);
      if (!run) throw new Error(`Unknown in-memory Check Run ${checkRunId}`);
      Object.assign(run, {
        name: input.name,
        status: input.status,
        ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
        ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
      });
      return run;
    });

    const first = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(first.state).toBe('pending');
    expect(checkRuns.filter((run) => run.name === 'PR Validation Matrix Gate')).toHaveLength(2);
    expect(checkRuns.find((run) => run.id === 92)).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(checkRuns.find((run) => run.id === 100)).toMatchObject({ status: 'in_progress', conclusion: null });

    const repeated = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(repeated.state).toBe('pending');
    expect(checkRuns.filter((run) => run.name === 'PR Validation Matrix Gate')).toHaveLength(2);

    Object.assign(checkRuns.find((run) => run.id === 90)!, { status: 'completed', conclusion: 'success' });
    const recovered = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(recovered.state).toBe('passed');
    expect(checkRuns.filter((run) => run.name === 'PR Validation Matrix Gate')).toHaveLength(2);
    expect(checkRuns.find((run) => run.id === 100)).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(fixture.client.createCheckRun).toHaveBeenCalledTimes(1);
  });

  it('converges across repeated same-head Matrix events without duplicate repair dispatches', async () => {
    const fixture = context();
    fixture.context.manifest = manifest({ classification: true });
    const checkRuns: GitHubCheckRun[] = [];
    const workflowRuns: GitHubWorkflowRun[] = [];
    const workflowJobs = new Map<number, GitHubWorkflowJob[]>();
    let nextCheckRunId = 100;

    fixture.client.listCommitCheckRuns!.mockImplementation(async () => checkRuns);
    fixture.client.listWorkflowRuns!.mockImplementation(async () => workflowRuns);
    fixture.client.listWorkflowJobs!.mockImplementation(async (_owner, _repository, runId: number) => (
      workflowJobs.get(runId) ?? []
    ));
    fixture.client.createCheckRun!.mockImplementation(async (
      _owner,
      _repository,
      input: CheckRunCreate,
    ) => {
      const run: GitHubCheckRun = {
        id: nextCheckRunId++,
        name: input.name,
        status: input.status,
        conclusion: input.conclusion ?? null,
        app: { slug: 'splrad-steward' },
        ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
      };
      checkRuns.push(run);
      return run;
    });
    fixture.client.updateCheckRun!.mockImplementation(async (
      _owner,
      _repository,
      checkRunId: number,
      input: CheckRunUpdate,
    ) => {
      const run = checkRuns.find((candidate) => candidate.id === checkRunId);
      if (!run) throw new Error(`Unknown in-memory Check Run ${checkRunId}`);
      Object.assign(run, {
        name: input.name,
        status: input.status,
        ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
        ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
      });
      return run;
    });

    const first = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(first.state).toBe('pending');
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(2);

    const repeated = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(repeated.state).toBe('pending');
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(2);

    const classificationRun: GitHubWorkflowRun = {
      id: 80,
      path: '.github/workflows/pr-classification.yml',
      event: 'workflow_dispatch',
      display_title: `PR Validation Target \x237 / ${fixture.context.pull.head.sha}`,
      pull_requests: [],
    };
    workflowRuns.push(classificationRun);
    workflowJobs.set(80, [{
      id: 801,
      name: 'Classify Pull Request',
      status: 'completed',
      conclusion: 'success',
    }]);
    fixture.context.eventName = 'workflow_run';
    fixture.context.event = {
      repository: { id: 1296724484, full_name: 'splrad/steward' },
      workflow_run: classificationRun,
    };

    const partiallyRecovered = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(partiallyRecovered.state).toBe('pending');
    expect(checkRuns.find((run) => run.name === 'PR Classification Gate')).toMatchObject({
      status: 'completed', conclusion: 'success',
    });
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(2);

    const governanceRun: GitHubWorkflowRun = {
      id: 81,
      path: '.github/workflows/pr-governance.yml',
      event: 'workflow_dispatch',
      display_title: `PR Validation Target \x237 / ${fixture.context.pull.head.sha}`,
      pull_requests: [],
    };
    workflowRuns.push(governanceRun);
    workflowJobs.set(81, [
      { id: 811, name: 'Main Authorization Gate', status: 'completed', conclusion: 'success' },
      { id: 812, name: 'Update Copilot Review Check', status: 'completed', conclusion: 'success' },
    ]);
    fixture.context.event = {
      repository: { id: 1296724484, full_name: 'splrad/steward' },
      workflow_run: governanceRun,
    };

    const fullyRecovered = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(fullyRecovered.state).toBe('passed');
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(2);
    expect(checkRuns.find((run) => run.name === 'PR Validation Matrix Gate')).toMatchObject({
      status: 'completed', conclusion: 'success',
    });

    const previousHead = fixture.context.pull.head.sha;
    fixture.context.pull.head.sha = 'e'.repeat(40);
    fixture.context.eventName = 'pull_request_target';
    fixture.context.event = {
      repository: { id: 1296724484, full_name: 'splrad/steward' },
      pull_request: { number: 7 },
    };

    const newHead = await executeOperation('matrix', fixture.context, { operation: 'matrix' });
    expect(newHead.state).toBe('pending');
    expect(fixture.client.dispatchWorkflow).toHaveBeenCalledTimes(4);
    expect(checkRuns.filter((run) => run.name === 'PR Validation Matrix Gate')).toHaveLength(2);
    expect(checkRuns.filter((run) => run.external_id?.includes(`head:${previousHead}`))).toHaveLength(4);
    expect(checkRuns.filter((run) => run.external_id?.includes(`head:${fixture.context.pull.head.sha}`))).toHaveLength(4);
  });

  it('bounds Matrix job queries while retaining priority evidence', async () => {
    const eventRun: GitHubWorkflowRun = {
      id: 1,
      path: '.github/workflows/pr-governance.yml',
      event: 'workflow_dispatch',
      display_title: `PR Validation Target \x237 / ${'c'.repeat(40)} / governance`,
      created_at: '2026-01-01T00:00:00Z',
      pull_requests: [],
    };
    const fixture = context({
      eventName: 'workflow_run',
      event: {
        repository: { id: 1296724484, full_name: 'splrad/steward' },
        workflow_run: eventRun,
      },
    });
    fixture.context.manifest = manifest({ classification: true, dcoAdvisory: true });

    const referencedRun: GitHubWorkflowRun = {
      id: 2,
      path: '.github/workflows/dco-advisory.yml',
      event: 'pull_request_target',
      head_sha: fixture.context.pull.head.sha,
      created_at: '2026-01-02T00:00:00Z',
      pull_requests: [{ number: fixture.context.pull.number }],
    };
    const targetRuns: GitHubWorkflowRun[] = [
      {
        id: 101,
        path: '.github/workflows/pr-classification.yml',
        event: 'pull_request_target',
        head_sha: fixture.context.pull.head.sha,
        created_at: '2026-02-01T00:00:00Z',
        pull_requests: [{ number: fixture.context.pull.number }],
      },
      {
        id: 102,
        path: '.github/workflows/dco-advisory.yml',
        event: 'pull_request_target',
        head_sha: fixture.context.pull.head.sha,
        created_at: '2026-02-02T00:00:00Z',
        pull_requests: [{ number: fixture.context.pull.number }],
      },
      {
        id: 103,
        path: '.github/workflows/pr-governance.yml',
        event: 'pull_request_target',
        head_sha: fixture.context.pull.head.sha,
        created_at: '2026-02-03T00:00:00Z',
        pull_requests: [{ number: fixture.context.pull.number }],
      },
    ];
    const noiseRuns: GitHubWorkflowRun[] = Array.from({ length: 35 }, (_, index) => ({
      id: 200 + index,
      path: '.github/workflows/unrelated.yml',
      event: 'pull_request_target',
      head_sha: fixture.context.pull.head.sha,
      created_at: new Date(Date.UTC(2026, 2, 1, index)).toISOString(),
      pull_requests: [{ number: fixture.context.pull.number }],
    }));
    fixture.client.listWorkflowRuns!.mockResolvedValue([
      eventRun,
      referencedRun,
      ...targetRuns,
      ...noiseRuns,
    ]);
    fixture.client.listCommitCheckRuns!.mockResolvedValue([{
      id: 500,
      name: 'DCO Sign-off Advisory',
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://github.com/splrad/steward/actions/runs/2/job/20',
      created_at: '2026-04-01T00:00:00Z',
      app: { slug: 'github-actions' },
    }]);

    await expect(executeOperation('matrix', fixture.context, {
      operation: 'matrix',
      matrixMode: 'observe',
    })).resolves.toBeDefined();

    const queriedRunIds = fixture.client.listWorkflowJobs!.mock.calls.map((call) => call[2]);
    expect(queriedRunIds).toHaveLength(30);
    expect(new Set(queriedRunIds).size).toBe(30);
    expect(queriedRunIds).toEqual(expect.arrayContaining([1, 2, 101, 102, 103]));
  });
});
