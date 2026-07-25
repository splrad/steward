import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeControlApplyNextRequestV2,
  buildStewardRuntimeControlPrepareRequestV2,
  buildStewardRuntimeDiagnosticsControlProbe,
  buildStewardRuntimeControlRequest,
  buildStewardRuntimeWorkItem,
  canonicalControlJson,
  canonicalStewardRuntimeControlApplyNextRequestV2Json,
  canonicalStewardRuntimeControlPrepareRequestV2Json,
  canonicalStewardRuntimeDiagnosticsControlProbeJson,
  canonicalStewardRuntimeControlRequestJson,
  controlJsonDigest,
  parseStewardRuntimeDiagnosticsControlReceipt,
  parseStewardRuntimeControlReceipt,
  type StewardRuntimeControlPlanBindingV2,
} from '../packages/core/src/index.js';
import {
  controlRuntimeCanonicalRepositoryFullName,
  controlRuntimeDiagnosticsSubject,
  controlRuntimeVersionMetadata,
} from './control-runtime-fixture.js';

interface ControlRuntimeExport {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

const controlRuntime = (
  exports as unknown as { default: ControlRuntimeExport }
).default;

function controlRequest(
  operation: 'runtime-probe' | 'pull-request-reconcile',
): Request {
  const workItem = operation === 'runtime-probe'
    ? buildStewardRuntimeWorkItem({
        operation,
        installationId: 145_952_003,
        subject: {
          repositoryId: 1_298_587_318,
          repositoryFullName: 'splrad/steward-sandbox-install-e2e',
          pullRequestNumber: 6,
        },
        cause: {
          kind: 'internal-probe',
          deliveryId: 'control-workerd-runtime-probe',
          receivedAt: '2026-07-23T18:00:00.000Z',
        },
      })
    : buildStewardRuntimeWorkItem({
        operation,
        installationId: 145_952_003,
        subject: {
          repositoryId: 1_298_587_318,
          repositoryFullName: 'splrad/steward-sandbox-install-e2e',
          pullRequestNumber: 6,
        },
        cause: {
          kind: 'github-webhook',
          deliveryId: 'control-workerd-pull-request',
          event: 'pull_request',
          action: 'opened',
          receivedAt: '2026-07-23T18:00:01.000Z',
        },
      });

  return new Request('https://control.internal/v1/reconcile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
    },
    body: canonicalStewardRuntimeControlRequestJson(
      buildStewardRuntimeControlRequest({
        workItem,
        generation: 7,
      }),
    ),
  });
}

async function controlPrepareRequestV2(): Promise<Request> {
  const workItem = buildStewardRuntimeWorkItem({
    operation: 'pull-request-reconcile',
    installationId: 145_952_003,
    subject: {
      repositoryId: 1_298_587_318,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber: 6,
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: 'control-workerd-v2-prepare',
      event: 'pull_request',
      action: 'synchronize',
      receivedAt: '2026-07-23T18:00:02.000Z',
    },
  });

  return new Request('https://control.internal/v2/reconcile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '2',
    },
    body: await canonicalStewardRuntimeControlPrepareRequestV2Json(
      await buildStewardRuntimeControlPrepareRequestV2({
        binding: {
          workItem,
          generation: 7,
          objective: 'classification',
        },
      }),
    ),
  });
}

async function controlApplyRequestV2(): Promise<Request> {
  const workItem = buildStewardRuntimeWorkItem({
    operation: 'pull-request-reconcile',
    installationId: 145_952_003,
    subject: {
      repositoryId: 1_298_587_318,
      repositoryFullName: 'splrad/steward-sandbox-install-e2e',
      pullRequestNumber: 6,
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: 'control-workerd-v2-apply',
      event: 'pull_request',
      action: 'synchronize',
      receivedAt: '2026-07-23T18:00:03.000Z',
    },
  });
  const binding = {
    workItem,
    generation: 7,
    objective: 'dco-advisory' as const,
  };
  const resolvedContext = {
    ...workItem.subject,
    headSha: 'b'.repeat(40),
    defaultBranch: 'main',
    manifestBlobSha: 'c'.repeat(40),
    configDigest: 'd'.repeat(64),
    pullRequestDigest: 'e'.repeat(64),
  };
  const intent = {
    type: 'issue-comment.delete' as const,
    key: 'dco-comment:1234',
    principal: 'installation' as const,
    commentId: 1_234,
    expectedOwnerId: 4_243_096,
    expectedOwnerLogin: 'splrad-steward[bot]',
    observedBodyDigest: 'f'.repeat(64),
  };
  const desiredDigest = await controlJsonDigest(intent);
  const mutation = {
    ordinal: 0,
    key: intent.key,
    mutationType: intent.type,
    principal: intent.principal,
    recoveryPolicy: 'live-evidence' as const,
    desiredDigest,
  };
  const withoutPlanId = {
    contractVersion: 1 as const,
    snapshotDigest: await controlJsonDigest({ fixture: 'control-workerd-v2' }),
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
      state: 'pending' as const,
      summary: 'Control v2 workerd fixture',
    },
    mutations: [{
      ...intent,
      desiredDigest,
      preconditions: {
        repositoryId: resolvedContext.repositoryId,
        defaultBranch: resolvedContext.defaultBranch,
        pullNumber: resolvedContext.pullRequestNumber,
        headSha: resolvedContext.headSha,
        manifestBlobSha: resolvedContext.manifestBlobSha,
        configDigest: resolvedContext.configDigest,
        pullRequestDigest: resolvedContext.pullRequestDigest,
      },
    }],
  };
  const planId = await controlJsonDigest(withoutPlanId);
  const canonicalPlanValue = { ...withoutPlanId, planId };
  const canonicalPlan = canonicalControlJson(canonicalPlanValue);
  const planBytes = new TextEncoder().encode(canonicalPlan);
  const plan: StewardRuntimeControlPlanBindingV2 = {
    contractVersion: 1,
    planId,
    planDigest: await controlJsonDigest(canonicalPlanValue),
    preparedGeneration: binding.generation,
    terminalOutcome: 'pending-external',
    canonicalPlanByteLength: planBytes.byteLength,
    canonicalPlanBase64: btoa(String.fromCharCode(...planBytes)),
    mutationCount: 1,
    mutations: [mutation],
  };

  return new Request('https://control.internal/v2/reconcile', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '2',
    },
    body: await canonicalStewardRuntimeControlApplyNextRequestV2Json(
      await buildStewardRuntimeControlApplyNextRequestV2({
        binding,
        expectedControlRevision: {
          stewardCommit: 'a'.repeat(40),
          workerVersionId: controlRuntimeVersionMetadata.id,
          workerVersionTag: controlRuntimeVersionMetadata.tag,
          workerVersionCreatedAt: controlRuntimeVersionMetadata.timestamp,
        },
        resolvedContext,
        plan,
        mutation,
      }),
    ),
  });
}

function diagnosticsRequest(
  repositoryFullName: string =
    controlRuntimeDiagnosticsSubject.repositoryFullName,
): Request {
  return new Request('https://control.internal/v1/runtime-diagnostics', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-steward-internal-protocol': '1',
    },
    body: canonicalStewardRuntimeDiagnosticsControlProbeJson(
      buildStewardRuntimeDiagnosticsControlProbe({
        nonce: 'b'.repeat(64),
        subject: {
          repositoryId: controlRuntimeDiagnosticsSubject.repositoryId,
          repositoryFullName,
        },
        environment: 'production',
      }),
    ),
  });
}

describe('Control runtime in workerd', () => {
  it('authenticates the live repository scope through the GitHub App three-step chain', async () => {
    const response = await controlRuntime.fetch(diagnosticsRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const receipt = parseStewardRuntimeDiagnosticsControlReceipt(
      JSON.parse(await response.text()) as unknown,
    );
    expect(receipt).toEqual({
      transportVersion: 1,
      audience: 'steward-runtime-diagnostics',
      nonce: 'b'.repeat(64),
      subject: {
        repositoryId: controlRuntimeDiagnosticsSubject.repositoryId,
        repositoryFullName: controlRuntimeCanonicalRepositoryFullName,
      },
      environment: 'production',
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: controlRuntimeVersionMetadata.id,
        workerVersionTag: controlRuntimeVersionMetadata.tag,
        workerVersionCreatedAt: controlRuntimeVersionMetadata.timestamp,
      },
    });
  });

  it('rejects a foreign organization before any outbound GitHub request', async () => {
    const response = await controlRuntime.fetch(
      diagnosticsRequest('other/steward-sandbox-install-e2e'),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'repository-access-denied',
    });
  });

  it('binds the runtime-probe receipt to the Worker version-metadata binding', async () => {
    const response = await controlRuntime.fetch(
      controlRequest('runtime-probe'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const receipt = parseStewardRuntimeControlReceipt(
      JSON.parse(await response.text()) as unknown,
    );
    expect(receipt).toEqual({
      schemaVersion: 1,
      state: 'converged',
      subject: {
        repositoryId: 1_298_587_318,
        repositoryFullName: 'splrad/steward-sandbox-install-e2e',
        pullRequestNumber: 6,
      },
      deliveryId: 'control-workerd-runtime-probe',
      generation: 7,
      controlRevision: {
        stewardCommit: 'a'.repeat(40),
        workerVersionId: controlRuntimeVersionMetadata.id,
        workerVersionTag: controlRuntimeVersionMetadata.tag,
        workerVersionCreatedAt: controlRuntimeVersionMetadata.timestamp,
      },
    });
  });

  it('keeps real pull-request reconciliation fail-closed', async () => {
    const response = await controlRuntime.fetch(
      controlRequest('pull-request-reconcile'),
    );

    expect(response.status).toBe(501);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'control-operation-not-implemented',
    });
  });

  it('accepts the strict v2 prepare transport without claiming governance success', async () => {
    const response = await controlRuntime.fetch(
      await controlPrepareRequestV2(),
    );

    expect(response.status).toBe(501);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'control-operation-not-implemented',
    });
  });

  it('revalidates a persisted Control plan in workerd before returning 501', async () => {
    const response = await controlRuntime.fetch(
      await controlApplyRequestV2(),
    );

    expect(response.status).toBe(501);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'control-operation-not-implemented',
    });
  });
});
