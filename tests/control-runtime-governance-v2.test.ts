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
  installationTokenPermissions: Record<string, string> = {
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
  };
  installationTokenRepositoryId = repositoryId;
  repositoryOwnerId = organizationId;
  liveHeadSha = headSha;
  liveManifestBlobSha = manifestBlobSha;
  pending = false;
  omitRequestedReviewers = false;
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
      return jsonResponse({
        token: installationToken,
        repository_selection: 'selected',
        permissions: this.installationTokenPermissions,
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
        content: encodeBase64Utf8(canonicalManifestJson(manifest)),
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
      return jsonResponse([]);
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
): Promise<string> {
  const input = await buildStewardRuntimeControlApplyNextRequestV2({
    binding: prepared.binding,
    expectedControlRevision,
    resolvedContext: prepared.resolvedContext,
    plan: prepared.plan,
    mutation: prepared.plan.mutations[0]!,
  });
  return await canonicalStewardRuntimeControlApplyNextRequestV2Json(input);
}

async function recoverBody(
  prepared: StewardRuntimeControlPreparedReceiptV2,
  deliveryId: string,
  expectedControlRevision: StewardRuntimeControlRevisionV1 =
    prepared.controlRevision,
): Promise<string> {
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
    mutation: prepared.plan.mutations[0]!,
  });
  return await canonicalStewardRuntimeControlRecoverRequestV2Json(input);
}

describe('Control runtime v2 Governance minimum slice', () => {
  it('prepares one and only one human Copilot intent for a machine-authored PR', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(prepared.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );

    expect(prepared.plan.mutations).toEqual([
      expect.objectContaining({
        ordinal: 0,
        key: 'copilot-review:request',
        mutationType: 'copilot-review.request',
        principal: 'human',
        recoveryPolicy: 'live-evidence-or-action-required',
      }),
    ]);
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]).toMatchObject({
      type: 'copilot-review.request',
      key: 'copilot-review:request',
      principal: 'human',
      observedEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fake.records).toContainEqual({
      method: 'POST',
      pathname: `/app/installations/${installationId}/access_tokens`,
      authorization: 'Bearer test-app-token',
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: {
          contents: 'read',
          metadata: 'read',
          pull_requests: 'read',
        },
      }),
    });
    expect(fake.records).toContainEqual(expect.objectContaining({
      method: 'GET',
      pathname: `/repos/splrad/steward/pulls/${pullRequestNumber}`,
      authorization: `Bearer ${installationToken}`,
    }));
    expect(fake.copilotReviewToken).not.toHaveBeenCalled();
  });

  it('prepares action-required with no mutation when reviewer evidence is incomplete', async () => {
    const fake = new FakeGitHub();
    fake.omitRequestedReviewers = true;

    const prepared = await prepare(fake);
    const plan = await parseCanonicalControlPlanJson(
      Buffer.from(prepared.plan.canonicalPlanBase64, 'base64').toString('utf8'),
    );

    expect(prepared.plan.terminalOutcome).toBe('action-required');
    expect(prepared.plan.mutations).toEqual([]);
    expect(plan.outcome.state).toBe('action_required');
    expect(plan.mutations).toEqual([]);
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

  it('applies the exact snapshot with one human-token POST for the fixed reviewer', async () => {
    const fake = new FakeGitHub();
    const prepared = await prepare(fake);
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
