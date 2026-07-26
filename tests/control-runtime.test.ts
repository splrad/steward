import { describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeControlApplyNextRequestV2,
  buildStewardRuntimeControlPrepareRequestV2,
  buildStewardRuntimeControlRecoverRequestV2,
  buildStewardRuntimeControlRequest,
  canonicalStewardRuntimeControlApplyNextRequestV2Json,
  canonicalStewardRuntimeControlPrepareRequestV2Json,
  canonicalStewardRuntimeControlRecoverRequestV2Json,
  canonicalStewardRuntimeControlRequestJson,
  type StewardRuntimeControlPlanBindingV2,
} from '../packages/core/src/index.js';
import {
  canonicalControlJson,
  controlJsonDigest,
  type ControlPlan,
} from '../packages/control/src/index.js';
import { encodeBase64Utf8 } from '../packages/manifest/src/encoding.js';
import {
  createControlRuntimeHandler,
  maximumControlRequestBytes,
  type ControlRuntimeEnv,
} from '../packages/control-runtime/src/index.js';

const env: ControlRuntimeEnv = {
  CF_VERSION_METADATA: {
    id: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
    tag: `steward-${'a'.repeat(40)}`,
    timestamp: '2026-07-23T16:00:00.000Z',
  },
};

function controlRequest(operation: 'runtime-probe' | 'pull-request-reconcile' = 'runtime-probe') {
  const internal = operation === 'runtime-probe';
  return buildStewardRuntimeControlRequest({
    generation: 7,
    workItem: {
      schemaVersion: 1,
      operation,
      installationId: 145_952_003,
      subject: {
        repositoryId: 1_298_587_318,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: 6,
      },
      cause: internal
        ? {
            kind: 'internal-probe',
            deliveryId: 'probe:runtime:1',
            receivedAt: '2026-07-23T16:00:00.000Z',
          }
        : {
            kind: 'github-webhook',
            deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
            event: 'pull_request',
            action: 'synchronize',
            receivedAt: '2026-07-23T16:00:00.000Z',
          },
    },
  });
}

function request(
  body: string,
  headers: Record<string, string> = {},
  path = '/v1/reconcile',
): Request {
  return new Request(`https://control.internal${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
      ...headers,
    },
    body,
  });
}

async function controlV2RequestBodies(): Promise<Readonly<Record<
  'prepare' | 'apply-next' | 'recover',
  string
>>> {
  const binding = {
    workItem: controlRequest('pull-request-reconcile').workItem,
    generation: 7,
    objective: 'dco-advisory' as const,
  };
  const recoverBinding = {
    ...binding,
    generation: binding.generation + 1,
  };
  const resolvedContext = {
    ...binding.workItem.subject,
    headSha: 'b'.repeat(40),
    defaultBranch: 'main',
    manifestBlobSha: 'e'.repeat(40),
    configDigest: 'f'.repeat(64),
    pullRequestDigest: '0'.repeat(64),
  };
  const mutationIntent = {
    type: 'issue-comment.delete' as const,
    key: 'dco-comment:1234',
    principal: 'installation' as const,
    commentId: 1_234,
    expectedOwnerId: 4_243_096,
    expectedOwnerLogin: 'splrad-steward[bot]',
    observedBodyDigest: '9'.repeat(64),
  };
  const desiredDigest = await controlJsonDigest(mutationIntent);
  const mutation = {
    ordinal: 0,
    key: mutationIntent.key,
    mutationType: mutationIntent.type,
    principal: mutationIntent.principal,
    recoveryPolicy: 'live-evidence' as const,
    desiredDigest,
  };
  const controlPlanWithoutId: Omit<ControlPlan, 'planId'> = {
    contractVersion: 1,
    snapshotDigest: await controlJsonDigest({ fixture: 'control-v2' }),
    pullRequestDigest: resolvedContext.pullRequestDigest,
    objective: binding.objective,
    subject: {
      repository: {
        id: resolvedContext.repositoryId,
        owner: 'splrad',
        name: 'steward-sandbox-install-e2e',
        defaultBranch: resolvedContext.defaultBranch,
      },
      pullRequest: {
        number: resolvedContext.pullRequestNumber,
        headSha: resolvedContext.headSha,
      },
      manifest: {
        blobSha: resolvedContext.manifestBlobSha,
        configDigest: resolvedContext.configDigest,
      },
      platform: {
        appId: 4_243_096,
        clientId: 'Iv23liuSr0qd4WLJdZhH',
        appSlug: 'splrad-steward',
      },
    },
    outcome: {
      state: 'pending',
      summary: 'Control v2 transport fixture',
    },
    mutations: [{
      ...mutationIntent,
      desiredDigest,
      preconditions: {
        configDigest: resolvedContext.configDigest,
        defaultBranch: resolvedContext.defaultBranch,
        headSha: resolvedContext.headSha,
        manifestBlobSha: resolvedContext.manifestBlobSha,
        pullNumber: resolvedContext.pullRequestNumber,
        pullRequestDigest: resolvedContext.pullRequestDigest,
        repositoryId: resolvedContext.repositoryId,
      },
    }],
  };
  const planId = await controlJsonDigest(controlPlanWithoutId);
  const canonicalPlanValue: ControlPlan = {
    ...controlPlanWithoutId,
    planId,
  };
  const canonicalPlan = canonicalControlJson(canonicalPlanValue);
  const planBytes = new TextEncoder().encode(canonicalPlan);
  const plan: StewardRuntimeControlPlanBindingV2 = {
    contractVersion: 1,
    planId,
    planDigest: await controlJsonDigest(canonicalPlanValue),
    preparedGeneration: binding.generation,
    terminalOutcome: 'pending-external',
    canonicalPlanByteLength: planBytes.byteLength,
    canonicalPlanBase64: encodeBase64Utf8(canonicalPlan),
    mutationCount: 1,
    mutations: [mutation],
  };
  const expectedControlRevision = {
    stewardCommit: 'a'.repeat(40),
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag,
    workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
  };

  return {
    prepare: await canonicalStewardRuntimeControlPrepareRequestV2Json(
      await buildStewardRuntimeControlPrepareRequestV2({ binding }),
    ),
    'apply-next': await canonicalStewardRuntimeControlApplyNextRequestV2Json(
      await buildStewardRuntimeControlApplyNextRequestV2({
        binding,
        expectedControlRevision,
        resolvedContext,
        plan,
        mutation,
      }),
    ),
    recover: await canonicalStewardRuntimeControlRecoverRequestV2Json(
      await buildStewardRuntimeControlRecoverRequestV2({
        binding: recoverBinding,
        expectedControlRevision,
        resolvedContext,
        plan,
        mutation,
      }),
    ),
  };
}

describe('private Control runtime foundation', () => {
  it('returns an exact revision-bound receipt for an internal runtime probe', async () => {
    const input = controlRequest();
    const response = await createControlRuntimeHandler().fetch(
      request(canonicalStewardRuntimeControlRequestJson(input)),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      state: 'converged',
      subject: input.workItem.subject,
      deliveryId: input.workItem.cause.deliveryId,
      generation: input.generation,
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: env.CF_VERSION_METADATA.id,
        workerVersionTag: env.CF_VERSION_METADATA.tag,
        workerVersionCreatedAt: env.CF_VERSION_METADATA.timestamp,
      },
    });
  });

  it('fails closed instead of acknowledging a real pull-request operation', async () => {
    const response = await createControlRuntimeHandler().fetch(
      request(canonicalStewardRuntimeControlRequestJson(controlRequest('pull-request-reconcile'))),
      env,
    );
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'control-operation-not-implemented',
    });
  });

  it('accepts strict v2 phases but never acknowledges unimplemented operations', async () => {
    const dependencies = {
      fetch: vi.fn<typeof fetch>(),
      appToken: vi.fn<() => Promise<string>>(),
    };
    const handler = createControlRuntimeHandler(dependencies);
    const bodies = await controlV2RequestBodies();

    for (const phase of ['prepare', 'apply-next', 'recover'] as const) {
      const response = await handler.fetch(
        request(
          bodies[phase],
          { 'x-steward-internal-protocol': '2' },
          '/v2/reconcile',
        ),
        env,
      );
      expect(response.status, phase).toBe(501);
      await expect(response.json()).resolves.toEqual({
        error: 'control-operation-not-implemented',
      });
    }
    const governancePrepare = JSON.parse(bodies.prepare) as {
      binding: { objective: string };
    };
    governancePrepare.binding.objective = 'governance';
    const governanceResponse = await handler.fetch(
      request(
        JSON.stringify(governancePrepare),
        { 'x-steward-internal-protocol': '2' },
        '/v2/reconcile',
      ),
      env,
    );
    expect(governanceResponse.status).toBe(501);
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.appToken).not.toHaveBeenCalled();
  });

  it('rejects a self-consistent canonical plan that violates Control semantics', async () => {
    const bodies = await controlV2RequestBodies();
    const apply = JSON.parse(bodies['apply-next']) as Record<string, unknown>;
    const plan = apply.plan as Record<string, unknown>;
    const binary = atob(String(plan.canonicalPlanBase64));
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    ))) as Record<string, unknown>;
    delete decoded.planId;
    decoded.objective = 'classification';
    const existingMutations = decoded.mutations as Array<Record<string, unknown>>;
    const preconditions = existingMutations[0]!.preconditions;
    const intent = {
      type: 'repository-label.ensure',
      key: 'repository-label:kind:feature',
      principal: 'installation',
      label: {
        name: 'kind:feature',
        color: '1f883d',
        description: 'Feature change',
      },
    };
    const desiredDigest = await controlJsonDigest(intent);
    decoded.mutations = [{
      ...intent,
      desiredDigest,
      preconditions,
    }];
    const planId = await controlJsonDigest(decoded);
    const canonicalPlan = canonicalControlJson({ ...decoded, planId });
    const planBytes = new TextEncoder().encode(canonicalPlan);
    (apply.binding as Record<string, unknown>).objective = 'classification';
    plan.planId = planId;
    plan.planDigest = await controlJsonDigest({ ...decoded, planId });
    plan.canonicalPlanByteLength = planBytes.byteLength;
    plan.canonicalPlanBase64 = encodeBase64Utf8(canonicalPlan);
    const mutation = {
      ordinal: 0,
      key: intent.key,
      mutationType: intent.type,
      principal: intent.principal,
      recoveryPolicy: 'live-evidence',
      desiredDigest,
    };
    plan.mutations = [mutation];
    apply.mutation = mutation;

    const dependencies = {
      fetch: vi.fn<typeof fetch>(),
      appToken: vi.fn<() => Promise<string>>(),
    };
    const response = await createControlRuntimeHandler(dependencies).fetch(
      request(
        JSON.stringify(apply),
        { 'x-steward-internal-protocol': '2' },
        '/v2/reconcile',
      ),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid-control-request',
    });
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.appToken).not.toHaveBeenCalled();
  });

  it('keeps v1 and v2 paths protocol-separated without fallback', async () => {
    const v1Body = canonicalStewardRuntimeControlRequestJson(controlRequest());
    const v2Body = (await controlV2RequestBodies()).prepare;
    const handler = createControlRuntimeHandler();

    expect((await handler.fetch(
      request(v2Body, {}, '/v2/reconcile'),
      env,
    )).status).toBe(403);
    expect((await handler.fetch(
      request(v1Body, { 'x-steward-internal-protocol': '2' }),
      env,
    )).status).toBe(403);
    expect((await handler.fetch(
      request(v1Body, { 'x-steward-internal-protocol': '2' }, '/v2/reconcile'),
      env,
    )).status).toBe(400);
    expect((await handler.fetch(
      request(v2Body),
      env,
    )).status).toBe(400);
    expect((await handler.fetch(
      request(
        '{"schemaVersion":2,"phase":"unsupported"}',
        { 'x-steward-internal-protocol': '2' },
        '/v2/reconcile',
      ),
      env,
    )).status).toBe(400);
  });

  it('requires the private protocol marker and exact JSON transport', async () => {
    const body = canonicalStewardRuntimeControlRequestJson(controlRequest());
    expect((await createControlRuntimeHandler().fetch(
      request(body, { 'x-steward-internal-protocol': '0' }),
      env,
    )).status).toBe(403);
    expect((await createControlRuntimeHandler().fetch(
      request(body, { 'content-type': 'text/plain' }),
      env,
    )).status).toBe(415);
  });

  it('rejects malformed requests without exposing validation details', async () => {
    const response = await createControlRuntimeHandler().fetch(
      request('{"schemaVersion":1}'),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid-control-request' });
  });

  it('streams and rejects an oversized request body before parsing it', async () => {
    const oversized = `"${'x'.repeat(maximumControlRequestBytes)}"`;
    const response = await createControlRuntimeHandler().fetch(
      request(oversized),
      env,
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'request-too-large',
    });
  });

  it('fails closed when immutable revision bindings are absent or invalid', async () => {
    const response = await createControlRuntimeHandler().fetch(
      request(canonicalStewardRuntimeControlRequestJson(controlRequest())),
      {
        ...env,
        CF_VERSION_METADATA: {
          ...env.CF_VERSION_METADATA,
          tag: 'unbound',
        },
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'control-revision-unavailable',
    });
  });

  it('has no public health, diagnostics, or catch-all route', async () => {
    const response = await createControlRuntimeHandler().fetch(
      new Request('https://control.internal/health'),
      env,
    );
    expect(response.status).toBe(404);
  });
});
