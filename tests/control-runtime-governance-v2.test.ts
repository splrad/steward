import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeControlApplyNextRequestV2,
  buildStewardRuntimeControlPrepareRequestV2,
  buildStewardRuntimeControlRecoverRequestV2,
  canonicalStewardRuntimeControlApplyNextRequestV2Json,
  canonicalStewardRuntimeControlPrepareRequestV2Json,
  canonicalStewardRuntimeControlRecoverRequestV2Json,
  parseStewardRuntimeControlMutationReceiptV2,
  parseStewardRuntimeControlPreparedReceiptV2,
  parseStewardRuntimeControlRecoveryReceiptV2,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeControlPreparedReceiptV2,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';
import {
  parseCanonicalControlPlanJson,
} from '../packages/control/src/index.js';
import {
  createControlRuntimeHandler,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';
import {
  canonicalManifestJson,
  encodeBase64Utf8,
  type StewardManifest,
} from '../packages/manifest/src/index.js';

const appId = 4_243_096;
const organizationId = 1_001;
const installationId = 145_952_003;
const repositoryId = 1_296_724_484;
const repositoryFullName = 'splrad/steward';
const pullRequestNumber = 7;
const headSha = 'c'.repeat(40);
const manifestBlobSha = 'b'.repeat(40);
const installationToken = 'ghs_installation_token_123456789';
const humanToken = 'github_pat_human_copilot_123456789';

const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    tag: `steward-${'a'.repeat(40)}`,
    timestamp: '2026-07-23T16:00:00.000Z',
  },
  GITHUB_APP_ID: String(appId),
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  STEWARD_ORGANIZATION_ID: String(organizationId),
  STEWARD_ORGANIZATION_LOGIN: 'splrad',
};

const manifest: StewardManifest = {
  schemaVersion: 1,
  automation: {
    githubApp: {
      clientId: 'Iv23liuSr0qd4WLJdZhH',
      slug: 'splrad-steward',
    },
    maintainers: {
      source: 'organization-team',
      teamSlug: 'maintainers',
    },
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
  },
};

interface FetchRecord {
  readonly method: string;
  readonly pathname: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

class FakeGitHub {
  appIdentityValid = true;
  installationState:
    | 'valid'
    | 'wrong-app'
    | 'wrong-organization'
    | 'suspended' = 'valid';
  installationTokenPermissions: Record<string, string> | null = null;
  installationTokenRepositoryId = repositoryId;
  repositoryOwnerId = organizationId;
  liveHeadSha = headSha;
  liveManifestBlobSha = manifestBlobSha;
  copilotReviewEnabled = true;
  pending = false;
  omitRequestedReviewers = false;
  reviews: Record<string, unknown>[] = [];
  threads: Record<string, unknown>[] = [];
  checks: Record<string, unknown>[] = [];
  comments: Record<string, unknown>[] = [];
  commits: Record<string, unknown>[] = [{
    sha: headSha,
    author: { login: 'dependabot[bot]', type: 'Bot' },
  }];
  files: Record<string, unknown>[] = [{
    filename: 'package-lock.json',
    status: 'modified',
    sha: 'f'.repeat(40),
    additions: 1,
    deletions: 1,
  }];
  maintainers = [{ login: 'axiomoth' }];
  nextCheckId = 700;
  nextCommentId = 800;
  uncertainCheckCreate = false;
  uncertainCheckUpdate = false;
  checkCreateRateLimitSeconds: number | null = null;
  malformedCheckResponse = false;
  unexpectedCheckDetailsUrlResponse = false;
  uncertainCommentCreate = false;
  uncertainCommentUpdate = false;
  commentWriteRateLimitSeconds: number | null = null;
  commentDeleteReturns404 = false;
  commentDelete404RemovesComment = true;
  uncertainCommentDelete = false;
  issueCommentReadFailureStatus: number | null = null;
  reviewPostRateLimitSeconds: number | null = null;
  uncertainReviewPost = false;
  readonly records: FetchRecord[] = [];
  readonly appToken = vi.fn(async () => 'test-app-token');
  readonly copilotReviewToken = vi.fn(() => humanToken);

  readonly fetch = vi.fn(async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = requestUrl(input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = typeof init?.body === 'string' ? init.body : null;
    this.records.push({
      method,
      pathname: url.pathname,
      authorization: headers.get('authorization'),
      body,
    });

    if (method === 'GET' && url.pathname === '/app') {
      return jsonResponse({
        id: this.appIdentityValid ? appId : appId + 1,
        client_id: manifest.automation.githubApp.clientId,
        slug: manifest.automation.githubApp.slug,
      });
    }
    if (
      method === 'GET'
      && url.pathname === `/app/installations/${installationId}`
    ) {
      return jsonResponse({
        id: installationId,
        app_id: this.installationState === 'wrong-app' ? appId + 1 : appId,
        account: {
          id: this.installationState === 'wrong-organization'
            ? organizationId + 1
            : organizationId,
          login: 'splrad',
          type: 'Organization',
        },
        target_type: 'Organization',
        suspended_at: this.installationState === 'suspended'
          ? '2026-07-26T12:00:00.000Z'
          : null,
      });
    }
    if (
      method === 'POST'
      && url.pathname === `/app/installations/${installationId}/access_tokens`
    ) {
      const requested = JSON.parse(body ?? '{}') as {
        permissions?: Record<string, string>;
      };
      return jsonResponse({
        token: installationToken,
        repository_selection: 'selected',
        permissions:
          this.installationTokenPermissions ?? requested.permissions ?? {},
        repositories: [{ id: this.installationTokenRepositoryId }],
      }, 201);
    }
    if (method === 'GET' && url.pathname === `/repositories/${repositoryId}`) {
      return jsonResponse({
        id: repositoryId,
        full_name: repositoryFullName,
        owner: {
          id: this.repositoryOwnerId,
          login: 'splrad',
          type: 'Organization',
        },
      });
    }
    if (method === 'GET' && url.pathname === '/repos/splrad/steward') {
      return jsonResponse({
        id: repositoryId,
        full_name: repositoryFullName,
        default_branch: 'main',
      });
    }
    if (
      method === 'GET'
      && url.pathname === '/repos/splrad/steward/contents/.github/steward.json'
    ) {
      return jsonResponse({
        type: 'file',
        encoding: 'base64',
        content: encodeBase64Utf8(canonicalManifestJson({
          ...manifest,
          features: {
            ...manifest.features,
            copilotReview: this.copilotReviewEnabled,
          },
        })),
        sha: this.liveManifestBlobSha,
      });
    }
    if (
      method === 'GET'
      && url.pathname === `/repos/splrad/steward/pulls/${pullRequestNumber}`
    ) {
      return jsonResponse({
        number: pullRequestNumber,
        state: 'open',
        title: 'chore: update dependency',
        body: '',
        user: { login: 'dependabot[bot]', type: 'Bot' },
        labels: [],
        base: { ref: 'main', sha: 'd'.repeat(40) },
        head: { ref: 'dependabot/npm/update', sha: this.liveHeadSha },
        ...(this.omitRequestedReviewers
          ? {}
          : {
              requested_reviewers: this.pending
                ? [{ login: 'copilot-pull-request-reviewer[bot]' }]
                : [],
            }),
      });
    }
    if (
      method === 'GET'
      && url.pathname === `/repos/splrad/steward/pulls/${pullRequestNumber}/reviews`
    ) {
      return jsonResponse(this.reviews);
    }
    if (
      method === 'POST'
      && url.pathname === '/graphql'
    ) {
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: this.threads,
              },
            },
          },
        },
      });
    }
    if (
      method === 'GET'
      && url.pathname
        === `/repos/splrad/steward/commits/${this.liveHeadSha}/check-runs`
    ) {
      return jsonResponse({ total_count: this.checks.length, check_runs: this.checks });
    }
    if (
      method === 'GET'
      && url.pathname
        === `/repos/splrad/steward/issues/${pullRequestNumber}/comments`
    ) {
      return jsonResponse(this.comments);
    }
    if (
      method === 'GET'
      && url.pathname
        === `/repos/splrad/steward/pulls/${pullRequestNumber}/commits`
    ) {
      return jsonResponse(this.commits);
    }
    if (
      method === 'GET'
      && url.pathname
        === `/repos/splrad/steward/pulls/${pullRequestNumber}/files`
    ) {
      return jsonResponse(this.files);
    }
    if (
      method === 'GET'
      && url.pathname === '/orgs/splrad/teams/maintainers/members'
    ) {
      return jsonResponse(this.maintainers);
    }
    if (
      method === 'GET'
      && url.pathname === '/users/splrad-steward%5Bbot%5D'
    ) {
      return jsonResponse({
        id: 9_001,
        login: 'splrad-steward[bot]',
        type: 'Bot',
      });
    }
    if (
      method === 'POST'
      && url.pathname === '/repos/splrad/steward/check-runs'
    ) {
      if (this.checkCreateRateLimitSeconds !== null) {
        return jsonResponse(
          { message: 'API rate limit exceeded' },
          429,
          { 'retry-after': String(this.checkCreateRateLimitSeconds) },
        );
      }
      const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
      const check = {
        id: this.nextCheckId++,
        head_sha: input.head_sha,
        name: input.name,
        status: input.status,
        conclusion: input.conclusion ?? null,
        external_id: input.external_id ?? null,
        details_url: input.details_url ?? null,
        app: { id: appId, slug: manifest.automation.githubApp.slug },
        output: input.output,
      };
      this.checks = [...this.checks, check];
      if (this.uncertainCheckCreate) {
        throw new Error('simulated response loss after Check creation');
      }
      return jsonResponse(this.malformedCheckResponse
        ? { ...check, external_id: 'wrong-external-id' }
        : this.unexpectedCheckDetailsUrlResponse
          ? { ...check, details_url: 'https://unexpected.example/check' }
          : check, 201);
    }
    const checkUpdate = new RegExp(
      '^/repos/splrad/steward/check-runs/(\\d+)$',
    ).exec(url.pathname);
    if (method === 'PATCH' && checkUpdate) {
      const id = Number(checkUpdate[1]);
      const input = JSON.parse(body ?? '{}') as Record<string, unknown>;
      const existing = this.checks.find((check) => check.id === id);
      const check = {
        ...existing,
        id,
        head_sha: existing?.head_sha,
        name: input.name,
        status: input.status,
        conclusion: input.conclusion ?? null,
        external_id: input.external_id ?? null,
        details_url: input.details_url ?? null,
        app: { id: appId, slug: manifest.automation.githubApp.slug },
        output: input.output,
      };
      this.checks = this.checks.map((candidate) => (
        candidate.id === id ? check : candidate
      ));
      if (this.uncertainCheckUpdate) {
        throw new Error('simulated response loss after Check update');
      }
      return jsonResponse(check);
    }
    if (
      method === 'POST'
      && url.pathname
        === `/repos/splrad/steward/issues/${pullRequestNumber}/comments`
    ) {
      if (this.commentWriteRateLimitSeconds !== null) {
        return jsonResponse(
          { message: 'API rate limit exceeded' },
          429,
          { 'retry-after': String(this.commentWriteRateLimitSeconds) },
        );
      }
      const input = JSON.parse(body ?? '{}') as { body?: string };
      const comment = {
        id: this.nextCommentId++,
        body: input.body,
        user: { id: 9_001, login: 'splrad-steward[bot]', type: 'Bot' },
        performed_via_github_app: {
          id: appId,
          slug: manifest.automation.githubApp.slug,
        },
      };
      this.comments = [...this.comments, comment];
      if (this.uncertainCommentCreate) {
        throw new Error('simulated response loss after comment creation');
      }
      return jsonResponse(comment, 201);
    }
    const commentResource = new RegExp(
      '^/repos/splrad/steward/issues/comments/(\\d+)$',
    ).exec(url.pathname);
    if (method === 'GET' && commentResource) {
      if (this.issueCommentReadFailureStatus !== null) {
        return jsonResponse(
          { message: 'simulated exact comment read failure' },
          this.issueCommentReadFailureStatus,
        );
      }
      const id = Number(commentResource[1]);
      const comment = this.comments.find((candidate) => candidate.id === id);
      return comment
        ? jsonResponse(comment)
        : jsonResponse({ message: 'Not Found' }, 404);
    }
    if (method === 'PATCH' && commentResource) {
      if (this.commentWriteRateLimitSeconds !== null) {
        return jsonResponse(
          { message: 'API rate limit exceeded' },
          429,
          { 'retry-after': String(this.commentWriteRateLimitSeconds) },
        );
      }
      const id = Number(commentResource[1]);
      const input = JSON.parse(body ?? '{}') as { body?: string };
      const existing = this.comments.find((comment) => comment.id === id);
      const comment = { ...existing, id, body: input.body };
      this.comments = this.comments.map((candidate) => (
        candidate.id === id ? comment : candidate
      ));
      if (this.uncertainCommentUpdate) {
        throw new Error('simulated response loss after comment update');
      }
      return jsonResponse(comment);
    }
    if (method === 'DELETE' && commentResource) {
      const id = Number(commentResource[1]);
      if (this.commentDeleteReturns404) {
        if (this.commentDelete404RemovesComment) {
          this.comments = this.comments.filter((comment) => comment.id !== id);
        }
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      this.comments = this.comments.filter((comment) => comment.id !== id);
      if (this.uncertainCommentDelete) {
        throw new Error('simulated response loss after comment deletion');
      }
      return new Response(null, { status: 204 });
    }
    if (
      method === 'POST'
      && url.pathname
        === `/repos/splrad/steward/pulls/${pullRequestNumber}/requested_reviewers`
    ) {
      if (this.reviewPostRateLimitSeconds !== null) {
        return jsonResponse(
          { message: 'API rate limit exceeded' },
          429,
          { 'retry-after': String(this.reviewPostRateLimitSeconds) },
        );
      }
      if (this.uncertainReviewPost) {
        throw new Error('simulated response loss after dispatch');
      }
      this.pending = true;
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${url.href}`);
  });

  clearObservations(): void {
    this.records.length = 0;
    this.fetch.mockClear();
    this.appToken.mockClear();
    this.copilotReviewToken.mockClear();
  }

  repositoryMutationRecords(): FetchRecord[] {
    return this.records.filter((record) => (
      record.method !== 'GET'
      && !record.pathname.endsWith('/access_tokens')
      && record.pathname !== '/graphql'
    ));
  }
}

function v2Request(body: string): Request {
  return new Request('https://control.internal/v2/reconcile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '2',
    },
    body,
  });
}

function binding() {
  return {
    workItem: {
      schemaVersion: 1 as const,
      operation: 'pull-request-reconcile' as const,
      installationId,
      subject: {
        repositoryId,
        repositoryFullName,
        pullRequestNumber,
      },
      cause: {
        kind: 'github-webhook' as const,
        deliveryId: 'governance-v2-prepare',
        event: 'pull_request' as const,
        action: 'opened' as const,
        receivedAt: '2026-07-26T12:00:00.000Z',
      },
    },
    generation: 7,
    objective: 'governance' as const,
  };
}

function handler(fake: FakeGitHub) {
  return createControlRuntimeHandler({
    fetch: fake.fetch,
    appToken: fake.appToken,
    copilotReviewToken: fake.copilotReviewToken,
  });
}

async function prepare(
  fake: FakeGitHub,
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const input = await buildStewardRuntimeControlPrepareRequestV2({
    binding: binding(),
  });
  const response = await handler(fake).fetch(
    v2Request(await canonicalStewardRuntimeControlPrepareRequestV2Json(input)),
    env,
  );
  expect(response.status).toBe(200);
  return await parseStewardRuntimeControlPreparedReceiptV2(
    await response.json(),
  );
}

async function applyBody(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  expectedControlRevision: StewardRuntimeControlRevisionV1 =
    prepared.controlRevision,
  mutationKey = 'copilot-review:request',
): Promise<string> {
  const mutation = prepared.plan.mutations.find(
    (candidate) => candidate.key === mutationKey,
  );
  if (!mutation) throw new Error(`Prepared plan has no mutation ${mutationKey}`);
  const input = await buildStewardRuntimeControlApplyNextRequestV2({
    binding: prepared.binding,
    expectedControlRevision,
    resolvedContext: prepared.resolvedContext,
    plan: prepared.plan,
    mutation,
  });
  return await canonicalStewardRuntimeControlApplyNextRequestV2Json(input);
}

async function recoverBody(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  deliveryId: string,
  expectedControlRevision: StewardRuntimeControlRevisionV1 =
    prepared.controlRevision,
  mutationKey = 'copilot-review:request',
): Promise<string> {
  const mutation = prepared.plan.mutations.find(
    (candidate) => candidate.key === mutationKey,
  );
  if (!mutation) throw new Error(`Prepared plan has no mutation ${mutationKey}`);
  const input = await buildStewardRuntimeControlRecoverRequestV2({
    binding: {
      ...prepared.binding,
      generation: prepared.binding.generation + 1,
      workItem: parseStewardRuntimeWorkItem({
        ...prepared.binding.workItem,
        cause: {
          ...prepared.binding.workItem.cause,
          deliveryId,
        },
      }),
    },
    expectedControlRevision,
    resolvedContext: prepared.resolvedContext,
    plan: prepared.plan,
    mutation,
  });
  return await canonicalStewardRuntimeControlRecoverRequestV2Json(input);
}

describe('Control runtime v2 Governance minimum slice', () => {
  it('prepares disabled resource cleanup as a settled plan instead of an invalid ignored mutation plan', async () => {
    const fake = new FakeGitHub();
    fake.copilotReviewEnabled = false;
    fake.comments = [{
      id: 601,
      body: '<!-- steward:resource:copilot-gate-blocking-comment:v1 -->',
      user: { id: 9_001, login: 'splrad-steward[bot]', type: 'Bot' },
      performed_via_github_app: {
        id: appId,
        slug: manifest.automation.githubApp.slug,
      },
    }];

    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(prepared.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );

    expect(prepared.plan.terminalOutcome).toBe('settled');
    expect(plan.outcome.state).toBe('passed');
    expect(prepared.plan.mutations.map((mutation) => mutation.key)).toEqual([
      'copilot-gate:check',
      'copilot-gate:blocking-comment',
    ]);
  });

  it('prepares Gate Check before the final human intent with exact read permissions', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(prepared.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );

    expect(prepared.plan.mutations).toEqual([
      expect.objectContaining({
        ordinal: 0,
        key: 'copilot-gate:check',
        mutationType: 'copilot-gate-check.upsert',
        principal: 'installation',
        recoveryPolicy: 'live-evidence',
      }),
      expect.objectContaining({
        ordinal: 1,
        key: 'copilot-review:request',
        mutationType: 'copilot-review.request',
        principal: 'human',
        recoveryPolicy: 'live-evidence-or-action-required',
      }),
    ]);
    expect(plan.mutations).toHaveLength(2);
    expect(plan.mutations[1]).toMatchObject({
      type: 'copilot-review.request',
      key: 'copilot-review:request',
      principal: 'human',
      evidenceProtocol: 'copilot-gate-v1',
      observedEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fake.records.filter((record) => (
      record.method === 'POST'
      && record.pathname
        === `/app/installations/${installationId}/access_tokens`
    )).map((record) => record.body)).toEqual([
      JSON.stringify({
        repository_ids: [repositoryId],
        permissions: {
          contents: 'read',
          metadata: 'read',
          pull_requests: 'read',
        },
      }),
      JSON.stringify({
        repository_ids: [repositoryId],
        permissions: {
          checks: 'read',
          issues: 'read',
          members: 'read',
          metadata: 'read',
          pull_requests: 'read',
        },
      }),
    ]);
    expect(fake.records).toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: `/repos/splrad/steward/pulls/${pullRequestNumber}`,
      authorization: `Bearer ${installationToken}`,
    }));
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('invalidates the Gate and writes the aggregate before any request when review evidence is incomplete', async () => {
    const fake = new FakeGitHub();
    fake.omitRequestedReviewers = true;

    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(prepared.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );

    expect(prepared.plan.terminalOutcome).toBe('settled');
    expect(prepared.plan.mutations.map((mutation) => mutation.key)).toEqual([
      'copilot-gate:check',
      'copilot-gate:blocking-comment',
    ]);
    expect(plan.outcome.state).toBe('failed');
    expect(plan.mutations.map((mutation) => mutation.type)).toEqual([
      'copilot-gate-check.upsert',
      'blocking-comment.upsert',
    ]);
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('fails closed across App, installation, token, and repository scope mismatches', async () => {
    const cases: Array<{
      readonly name: string;
      readonly arrange: (fake: FakeGitHub) => void;
      readonly status: number;
    }> = [
      {
        name: 'App identity',
        arrange: (fake) => {
          fake.appIdentityValid = false;
        },
        status: 503,
      },
      {
        name: 'installation App',
        arrange: (fake) => {
          fake.installationState = 'wrong-app';
        },
        status: 403,
      },
      {
        name: 'installation organization',
        arrange: (fake) => {
          fake.installationState = 'wrong-organization';
        },
        status: 403,
      },
      {
        name: 'suspended installation',
        arrange: (fake) => {
          fake.installationState = 'suspended';
        },
        status: 403,
      },
      {
        name: 'expanded token permissions',
        arrange: (fake) => {
          fake.installationTokenPermissions = {
            contents: 'read',
            metadata: 'read',
            pull_requests: 'read',
            issues: 'write',
          };
        },
        status: 503,
      },
      {
        name: 'wrong token repository',
        arrange: (fake) => {
          fake.installationTokenRepositoryId = repositoryId + 1;
        },
        status: 503,
      },
      {
        name: 'wrong repository owner',
        arrange: (fake) => {
          fake.repositoryOwnerId = organizationId + 1;
        },
        status: 403,
      },
    ];

    for (const testCase of cases) {
      const fake = new FakeGitHub();
      testCase.arrange(fake);
      const input = await buildStewardRuntimeControlPrepareRequestV2({
        binding: binding(),
      });
      const response = await handler(fake).fetch(
        v2Request(
          await canonicalStewardRuntimeControlPrepareRequestV2Json(input),
        ),
        env,
      );

      expect(response.status, testCase.name).toBe(testCase.status);
      expect(fake.copilotReviewToken, testCase.name).not.toHaveBeenCalled();
      expect(fake.repositoryMutationRecords(), testCase.name).toEqual([]);
    }
  });

  it('applies one Gate Check intent with Checks write and validates the exact App response', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.clearObservations();

    const response = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    const receipt = await parseStewardRuntimeControlMutationReceiptV2(
      await response.json(),
    );

    expect(receipt.result).toEqual({
      state: 'applied',
      resourceId: 700,
      retryAfterSeconds: null,
    });
    expect(fake.repositoryMutationRecords()).toEqual([
      expect.objectContaining({
        method: 'POST',
        pathname: '/repos/splrad/steward/check-runs',
        authorization: `Bearer ${installationToken}`,
      }),
    ]);
    expect(fake.records.filter((record) => (
      record.pathname
        === `/app/installations/${installationId}/access_tokens`
    )).at(-1)?.body).toBe(JSON.stringify({
      repository_ids: [repositoryId],
      permissions: {
        checks: 'write',
        members: 'read',
        metadata: 'read',
        pull_requests: 'read',
      },
    }));
    expect(fake.records).not.toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: `/repos/splrad/steward/issues/${pullRequestNumber}/comments`,
    }));
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('keeps an uncertain or non-exact Check response unknown and recovers only one exact desired resource', async () => {
    for (const mode of [
      'response-loss',
      'malformed-response',
      'unexpected-details-url',
    ] as const) {
      const fake = new FakeGitHub();
      const prepared = await prepare(fake);
      fake.uncertainCheckCreate = mode === 'response-loss';
      fake.malformedCheckResponse = mode === 'malformed-response';
      fake.unexpectedCheckDetailsUrlResponse =
        mode === 'unexpected-details-url';
      fake.clearObservations();

      const applied = await handler(fake).fetch(
        v2Request(await applyBody(
          prepared,
          prepared.controlRevision,
          'copilot-gate:check',
        )),
        env,
      );
      const mutationReceipt = await parseStewardRuntimeControlMutationReceiptV2(
        await applied.json(),
      );
      expect(mutationReceipt.result.state, mode).toBe('unknown');
      expect(fake.checks).toHaveLength(1);

      fake.uncertainCheckCreate = false;
      fake.malformedCheckResponse = false;
      fake.unexpectedCheckDetailsUrlResponse = false;
      fake.clearObservations();
      const recovered = await handler(fake).fetch(
        v2Request(await recoverBody(
          prepared,
          `governance-v2-check-recover-${mode}`,
          prepared.controlRevision,
          'copilot-gate:check',
        )),
        env,
      );
      const recoveryReceipt = await parseStewardRuntimeControlRecoveryReceiptV2(
        await recovered.json(),
      );
      expect(recoveryReceipt.result, mode).toEqual({
        state: 'converged',
        resourceId: 700,
      });
      expect(fake.repositoryMutationRecords(), mode).toEqual([]);

      fake.checks.push({ ...fake.checks[0], id: 701 });
      const ambiguous = await handler(fake).fetch(
        v2Request(await recoverBody(
          prepared,
          `governance-v2-check-ambiguous-${mode}`,
          prepared.controlRevision,
          'copilot-gate:check',
        )),
        env,
      );
      const ambiguousReceipt =
        await parseStewardRuntimeControlRecoveryReceiptV2(
          await ambiguous.json(),
        );
      expect(ambiguousReceipt.result, mode).toEqual({
        state: 'unknown',
        resourceId: null,
      });
    }
  });

  it('keeps an absent Check recovery unknown and performs no repository write or human-token read', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.clearObservations();

    const recovered = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-check-recover-absent',
        prepared.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    const receipt = await parseStewardRuntimeControlRecoveryReceiptV2(
      await recovered.json(),
    );

    expect(receipt.result).toEqual({
      state: 'unknown',
      resourceId: null,
    });
    expect(fake.repositoryMutationRecords()).toEqual([]);
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('marks a lost Check update response unknown and recovers only the exact prepared ID', async () => {
    const fake = new FakeGitHub();
    const initial = await prepare(fake);
    await handler(fake).fetch(
      v2Request(await applyBody(
        initial,
        initial.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    fake.pending = true;
    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(prepared.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );
    const mutation = plan.mutations.find((candidate) => (
      candidate.type === 'copilot-gate-check.upsert'
    ));
    expect(mutation).toMatchObject({ mode: 'update', checkRunId: 700 });
    if (!mutation || mutation.type !== 'copilot-gate-check.upsert') {
      throw new Error('Expected a Copilot Gate Check update');
    }
    fake.uncertainCheckUpdate = true;
    fake.clearObservations();

    const applied = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await applied.json(),
    )).result).toEqual({
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    });

    fake.uncertainCheckUpdate = false;
    fake.clearObservations();
    const exactId = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-check-update-exact-id',
        prepared.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await exactId.json(),
    )).result).toEqual({ state: 'converged', resourceId: 700 });

    fake.checks[0] = { ...fake.checks[0], id: 701 };
    const wrongId = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-check-update-wrong-id',
        prepared.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await wrongId.json(),
    )).result).toEqual({ state: 'unknown', resourceId: null });
    expect(fake.repositoryMutationRecords()).toEqual([]);
  });

  it('classifies an explicit Check write rate limit as not-attempted without creating a resource', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.checkCreateRateLimitSeconds = 1_200;
    fake.clearObservations();

    const response = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    const receipt = await parseStewardRuntimeControlMutationReceiptV2(
      await response.json(),
    );

    expect(receipt.result).toEqual({
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: 900,
    });
    expect(fake.checks).toEqual([]);
  });

  it('writes and read-only recovers the stable aggregate comment with Issues write only', async () => {
    const fake = new FakeGitHub();
    fake.omitRequestedReviewers = true;
    const prepared = await prepare(fake);
    fake.uncertainCommentCreate = true;
    fake.clearObservations();

    const applied = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    const mutationReceipt = await parseStewardRuntimeControlMutationReceiptV2(
      await applied.json(),
    );
    expect(mutationReceipt.result.state).toBe('unknown');
    expect(fake.comments).toHaveLength(1);
    expect(fake.records.filter((record) => (
      record.pathname
        === `/app/installations/${installationId}/access_tokens`
    )).at(-1)?.body).toBe(JSON.stringify({
      repository_ids: [repositoryId],
      permissions: {
        issues: 'write',
        members: 'read',
        metadata: 'read',
        pull_requests: 'read',
      },
    }));
    expect(fake.records).not.toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: `/repos/splrad/steward/commits/${headSha}/check-runs`,
    }));

    fake.uncertainCommentCreate = false;
    fake.clearObservations();
    const recovered = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-recover',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    const recoveryReceipt = await parseStewardRuntimeControlRecoveryReceiptV2(
      await recovered.json(),
    );
    expect(recoveryReceipt.result).toEqual({
      state: 'converged',
      resourceId: 800,
    });
    expect(fake.repositoryMutationRecords()).toEqual([]);
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();

    fake.comments.push({ ...fake.comments[0], id: 801 });
    const ambiguous = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-recover-ambiguous',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    const ambiguousReceipt = await parseStewardRuntimeControlRecoveryReceiptV2(
      await ambiguous.json(),
    );
    expect(ambiguousReceipt.result).toEqual({
      state: 'unknown',
      resourceId: null,
    });
  });

  it('bounds a comment update rate limit and recovers a lost update response', async () => {
    const fake = new FakeGitHub();
    fake.omitRequestedReviewers = true;
    const initial = await prepare(fake);
    const initialPlan = await parseCanonicalControlPlanJson(
      Buffer.from(
        initial.plan.canonicalPlanBase64,
        'base64',
      ).toString('utf8'),
    );
    const create = initialPlan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.upsert'
    ));
    if (!create || create.type !== 'blocking-comment.upsert') {
      throw new Error('Expected a blocking comment creation');
    }
    fake.comments = [{
      id: 800,
      body: `${create.body}\nlocal drift`,
      user: { id: 9_001, login: 'splrad-steward[bot]', type: 'Bot' },
      performed_via_github_app: {
        id: appId,
        slug: manifest.automation.githubApp.slug,
      },
    }];
    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(
        prepared.plan.canonicalPlanBase64,
        'base64',
      ).toString('utf8'),
    );
    expect(plan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.upsert'
    ))).toMatchObject({ mode: 'update', commentId: 800 });

    fake.commentWriteRateLimitSeconds = 1_200;
    fake.clearObservations();
    const limited = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await limited.json(),
    )).result).toEqual({
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: 900,
    });
    expect(fake.comments[0]?.body).toBe(`${create.body}\nlocal drift`);

    fake.commentWriteRateLimitSeconds = null;
    fake.uncertainCommentUpdate = true;
    fake.clearObservations();
    const uncertain = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await uncertain.json(),
    )).result).toEqual({
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    });
    expect(fake.comments[0]?.body).toBe(create.body);

    fake.uncertainCommentUpdate = false;
    fake.clearObservations();
    const recovered = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-update-recover',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await recovered.json(),
    )).result).toEqual({ state: 'converged', resourceId: 800 });
    expect(fake.repositoryMutationRecords()).toEqual([]);
  });

  it('converges a raced delete only after exact absence and recovers response loss read-only', async () => {
    const fake = new FakeGitHub();
    fake.omitRequestedReviewers = true;
    const failed = await prepare(fake);
    const failedPlan = await parseCanonicalControlPlanJson(
      Buffer.from(failed.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );
    const create = failedPlan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.upsert'
    ));
    if (!create || create.type !== 'blocking-comment.upsert') {
      throw new Error('Expected a blocking comment creation');
    }
    const comment = {
      id: 900,
      body: create.body,
      user: { id: 9_001, login: 'splrad-steward[bot]', type: 'Bot' },
      performed_via_github_app: {
        id: appId,
        slug: manifest.automation.githubApp.slug,
      },
    };
    fake.comments = [comment];
    fake.omitRequestedReviewers = false;
    const prepared = await prepare(fake);
    fake.commentDeleteReturns404 = true;

    fake.clearObservations();
    const converged = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await converged.json(),
    )).result).toEqual({
      state: 'converged',
      resourceId: 900,
      retryAfterSeconds: null,
    });
    expect(fake.records.filter((record) => (
      record.pathname === '/repos/splrad/steward/issues/comments/900'
    )).map((record) => record.method)).toEqual(['GET', 'DELETE', 'GET']);

    fake.comments = [comment];
    fake.commentDelete404RemovesComment = false;
    fake.clearObservations();
    const stillPresent = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await stillPresent.json(),
    )).result).toEqual({
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    });
    expect(fake.records.filter((record) => (
      record.pathname === '/repos/splrad/steward/issues/comments/900'
    )).map((record) => record.method)).toEqual(['GET', 'DELETE', 'GET']);

    fake.comments = [comment];
    fake.commentDeleteReturns404 = false;
    fake.commentDelete404RemovesComment = true;
    fake.uncertainCommentDelete = true;
    fake.clearObservations();
    const uncertain = await handler(fake).fetch(
      v2Request(await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await uncertain.json(),
    )).result).toEqual({
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    });
    expect(fake.records.filter((record) => (
      record.pathname === '/repos/splrad/steward/issues/comments/900'
    )).map((record) => record.method)).toEqual(['GET', 'DELETE']);

    fake.uncertainCommentDelete = false;
    fake.clearObservations();
    const recovered = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-delete-response-loss',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await recovered.json(),
    )).result).toEqual({ state: 'converged', resourceId: 900 });
    expect(fake.records.filter((record) => (
      record.pathname === '/repos/splrad/steward/issues/comments/900'
    )).map((record) => record.method)).toEqual(['GET']);
    expect(fake.repositoryMutationRecords()).toEqual([]);
  });

  it('recovers a delete only from an exact 404 for the original comment ID', async () => {
    const fake = new FakeGitHub();
    fake.omitRequestedReviewers = true;
    const failed = await prepare(fake);
    const failedPlan = await parseCanonicalControlPlanJson(
      Buffer.from(failed.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );
    const create = failedPlan.mutations.find((mutation) => (
      mutation.type === 'blocking-comment.upsert'
    ));
    if (!create || create.type !== 'blocking-comment.upsert') {
      throw new Error('Expected a blocking comment creation');
    }
    const comment = {
      id: 900,
      body: create.body,
      user: { id: 9_001, login: 'splrad-steward[bot]', type: 'Bot' },
      performed_via_github_app: {
        id: appId,
        slug: manifest.automation.githubApp.slug,
      },
    };
    fake.comments = [comment];
    fake.omitRequestedReviewers = false;
    const prepared = await prepare(fake);
    const deleteMutation = (
      await parseCanonicalControlPlanJson(
        Buffer.from(
          prepared.plan.canonicalPlanBase64,
          'base64',
        ).toString('utf8'),
      )
    ).mutations.find((mutation) => mutation.type === 'blocking-comment.delete');
    expect(deleteMutation).toMatchObject({ commentId: 900 });

    fake.clearObservations();
    const present = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-delete-present',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await present.json(),
    )).result).toEqual({ state: 'unknown', resourceId: null });
    expect(fake.records).toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: '/repos/splrad/steward/issues/comments/900',
    }));
    expect(fake.records).not.toContainEqual(expect.objectContaining({
      pathname: `/repos/splrad/steward/issues/${pullRequestNumber}/comments`,
    }));

    fake.comments = [{ ...comment, id: 901 }];
    fake.clearObservations();
    const absent = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-delete-absent',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await absent.json(),
    )).result).toEqual({ state: 'converged', resourceId: 900 });
    expect(fake.records).toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: '/repos/splrad/steward/issues/comments/900',
    }));

    fake.issueCommentReadFailureStatus = 403;
    fake.clearObservations();
    const unreadable = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-comment-delete-read-failure',
        prepared.controlRevision,
        'copilot-gate:blocking-comment',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlRecoveryReceiptV2(
      await unreadable.json(),
    )).result).toEqual({ state: 'unknown', resourceId: null });
    expect(fake.repositoryMutationRecords()).toEqual([]);
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('applies a single Gate request after the Gate Check has converged', async () => {
    const fake = new FakeGitHub();
    const initial = await prepare(fake);
    const checkResponse = await handler(fake).fetch(
      v2Request(await applyBody(
        initial,
        initial.controlRevision,
        'copilot-gate:check',
      )),
      env,
    );
    expect((await parseStewardRuntimeControlMutationReceiptV2(
      await checkResponse.json(),
    )).result.state).toBe('applied');

    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(
        prepared.plan.canonicalPlanBase64,
        'base64',
      ).toString('utf8'),
    );
    expect(plan.mutations).toEqual([
      expect.objectContaining({
        type: 'copilot-review.request',
        evidenceProtocol: 'copilot-gate-v1',
      }),
    ]);
    fake.clearObservations();

    const response = await handler(fake).fetch(
      v2Request(await applyBody(prepared)),
      env,
    );
    expect(response.status).toBe(200);
    const receipt = await parseStewardRuntimeControlMutationReceiptV2(
      await response.json(),
    );
    expect(receipt.result.state).toBe('applied');
    expect(fake.copilotReviewToken).toHaveBeenCalledTimes(1);
    expect(fake.records.filter((record) => (
      record.pathname
        === `/app/installations/${installationId}/access_tokens`
    )).at(-1)?.body).toBe(JSON.stringify({
      repository_ids: [repositoryId],
      permissions: {
        members: 'read',
        metadata: 'read',
        pull_requests: 'read',
      },
    }));
    expect(fake.records).not.toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: `/repos/splrad/steward/commits/${headSha}/check-runs`,
    }));
    expect(fake.records).not.toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: `/repos/splrad/steward/issues/${pullRequestNumber}/comments`,
    }));

    const humanRequests = fake.records.filter(
      (record) => record.authorization === `Bearer ${humanToken}`,
    );
    expect(humanRequests).toEqual([{
      method: 'POST',
      pathname:
        `/repos/splrad/steward/pulls/${pullRequestNumber}/requested_reviewers`,
      authorization: `Bearer ${humanToken}`,
      body: JSON.stringify({
        reviewers: ['copilot-pull-request-reviewer[bot]'],
      }),
    }]);
  });

  it('converges from live pending evidence without reading the human token', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.pending = true;
    fake.clearObservations();

    const response = await handler(fake).fetch(
      v2Request(await applyBody(prepared)),
      env,
    );
    const receipt = await parseStewardRuntimeControlMutationReceiptV2(
      await response.json(),
    );

    expect(receipt.result.state).toBe('converged');
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
    expect(fake.records).not.toContainEqual(expect.objectContaining({
      pathname:
        `/repos/splrad/steward/pulls/${pullRequestNumber}/requested_reviewers`,
    }));
  });

  it('returns stale-plan on head or Manifest drift without reading the human token', async () => {
    for (const drift of ['head', 'manifest'] as const) {
      const fake = new FakeGitHub();
      const prepared = await prepare(fake);
      if (drift === 'head') {
        fake.liveHeadSha = 'e'.repeat(40);
      } else {
        fake.liveManifestBlobSha = 'f'.repeat(40);
      }
      fake.clearObservations();

      const response = await handler(fake).fetch(
        v2Request(await applyBody(prepared)),
        env,
      );
      const receipt = await parseStewardRuntimeControlMutationReceiptV2(
        await response.json(),
      );

      expect(receipt.result.state, drift).toBe('stale-plan');
      expect(fake.copilotReviewToken, drift).not.toHaveBeenCalled();
      expect(fake.repositoryMutationRecords(), drift).toEqual([]);
    }
  });

  it('rejects a Control revision mismatch before any network or token access', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.clearObservations();
    const mismatchedRevision = {
      ...prepared.controlRevision,
      workerVersionId: '00000000-0000-4000-8000-000000000000',
    };

    const response = await handler(fake).fetch(
      v2Request(await applyBody(prepared, mismatchedRevision)),
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'control-revision-mismatch',
    });
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(fake.appToken).not.toHaveBeenCalled();
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('rejects apply and recovery mutation ordinal, key, or type drift before network access', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    const validBodies = {
      apply: await applyBody(
        prepared,
        prepared.controlRevision,
        'copilot-gate:check',
      ),
      recover: await recoverBody(
        prepared,
        'governance-v2-recover-binding-drift',
        prepared.controlRevision,
        'copilot-gate:check',
      ),
    };

    for (const [phase, body] of Object.entries(validBodies)) {
      for (const drift of ['ordinal', 'key', 'mutationType'] as const) {
        const payload = JSON.parse(body) as {
          mutation: {
            ordinal: number;
            key: string;
            mutationType: string;
          };
        };
        if (drift === 'ordinal') payload.mutation.ordinal += 1;
        if (drift === 'key') payload.mutation.key = 'copilot-review:request';
        if (drift === 'mutationType') {
          payload.mutation.mutationType = 'copilot-review.request';
        }
        fake.clearObservations();
        const response = await handler(fake).fetch(
          v2Request(JSON.stringify(payload)),
          env,
        );
        expect(response.status, `${phase}:${drift}`).toBe(400);
        expect(fake.fetch, `${phase}:${drift}`).not.toHaveBeenCalled();
        expect(fake.appToken, `${phase}:${drift}`).not.toHaveBeenCalled();
        expect(fake.copilotReviewToken, `${phase}:${drift}`)
          .not.toHaveBeenCalled();
      }
    }
  });

  it('records an uncertain reviewer POST as unknown instead of replayable failure', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.uncertainReviewPost = true;
    fake.clearObservations();

    const response = await handler(fake).fetch(
      v2Request(await applyBody(prepared)),
      env,
    );
    const receipt = await parseStewardRuntimeControlMutationReceiptV2(
      await response.json(),
    );

    expect(receipt.result).toEqual({
      state: 'unknown',
      resourceId: null,
      retryAfterSeconds: null,
    });
    expect(fake.copilotReviewToken).toHaveBeenCalledTimes(1);
  });

  it('classifies an explicit rate limit as bounded not-attempted', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.reviewPostRateLimitSeconds = 1_200;
    fake.clearObservations();

    const response = await handler(fake).fetch(
      v2Request(await applyBody(prepared)),
      env,
    );
    const receipt = await parseStewardRuntimeControlMutationReceiptV2(
      await response.json(),
    );

    expect(receipt.result).toEqual({
      state: 'not-attempted',
      resourceId: null,
      retryAfterSeconds: 900,
    });
    expect(fake.copilotReviewToken).toHaveBeenCalledTimes(1);
  });

  it('rejects a recovery revision mismatch before any network or token access', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.clearObservations();
    const mismatchedRevision = {
      ...prepared.controlRevision,
      workerVersionId: '00000000-0000-4000-8000-000000000000',
    };

    const response = await handler(fake).fetch(
      v2Request(await recoverBody(
        prepared,
        'governance-v2-recover-revision-mismatch',
        mismatchedRevision,
      )),
      env,
    );

    expect(response.status).toBe(409);
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(fake.appToken).not.toHaveBeenCalled();
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('recovers read-only: missing proof requires action and pending proof converges', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    fake.clearObservations();

    const missingResponse = await handler(fake).fetch(
      v2Request(await recoverBody(prepared, 'governance-v2-recover-missing')),
      env,
    );
    const missing = await parseStewardRuntimeControlRecoveryReceiptV2(
      await missingResponse.json(),
    );
    expect(missing.result.state).toBe('action-required');
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
    expect(fake.repositoryMutationRecords()).toEqual([]);

    fake.pending = true;
    fake.clearObservations();
    const pendingResponse = await handler(fake).fetch(
      v2Request(await recoverBody(prepared, 'governance-v2-recover-pending')),
      env,
    );
    const pending = await parseStewardRuntimeControlRecoveryReceiptV2(
      await pendingResponse.json(),
    );
    expect(pending.result.state).toBe('converged');
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
    expect(fake.repositoryMutationRecords()).toEqual([]);
  });
});
