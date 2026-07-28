import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeInstallationRepositoryChildV1,
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  buildStewardRuntimeScopeWorkItemV2,
  buildStewardRuntimeWorkItemV3,
  buildStewardRuntimeWorkItemV4,
  buildStewardRuntimeWorkItemV5,
  canonicalStewardRuntimeInstallationRepositoryChildV1Json,
  canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json,
  canonicalStewardRuntimeScopeWorkItemJson,
  canonicalStewardRuntimeWorkItemJson,
  deriveStewardRuntimeFanoutDeliveryId,
  deriveStewardRuntimeFanoutDeliveryIdV2,
  deriveStewardRuntimeFanoutDeliveryIdV3,
  type StewardRuntimeScopeWorkItemV1,
  type StewardRuntimeRepositoryScopeTargetV2,
  type StewardRuntimeScopeWorkItemV2,
  type StewardRuntimeWorkItemV2,
} from '../packages/core/src/index.js';
import {
  classifyDeadLetterBody,
  maximumCapturedDeadLetterBodyBytes,
} from '../packages/recovery/src/capture.js';

const workItem: StewardRuntimeWorkItemV2 = {
  schemaVersion: 2,
  operation: 'pull-request-reconcile',
  installationId: 145_952_003,
  subject: {
    repositoryId: 1_298_587_318,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
    pullRequestNumber: 6,
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: '33f08dc0-7caf-11f1-8d3a-340f601f41b1',
    event: 'pull_request',
    action: 'synchronize',
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
};

const scopeItem: StewardRuntimeScopeWorkItemV1 = {
  schemaVersion: 1,
  operation: 'scope-reconcile',
  target: {
    scope: 'repository',
    mode: 'refresh',
    installationId: 145_952_003,
    repositoryId: 1_298_587_318,
    pullRequests: 'all-open',
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    event: 'repository',
    action: 'renamed',
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
};

const scopeItemV2: StewardRuntimeScopeWorkItemV2 & {
  readonly target: StewardRuntimeRepositoryScopeTargetV2;
} = {
  schemaVersion: 2,
  operation: 'scope-reconcile',
  target: {
    scope: 'repository',
    mode: 'refresh',
    installationId: 145_952_003,
    repositoryId: 1_298_587_318,
    pullRequests: 'all-open',
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: 'push-delivery-1',
    event: 'push',
    action: null,
    ref: 'refs/heads/main',
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
};

const workItemV3 = buildStewardRuntimeWorkItemV3({
  operation: 'pull-request-reconcile',
  installationId: 145_952_003,
  subject: {
    repositoryId: 1_298_587_318,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
    pullRequestNumber: 6,
  },
  cause: {
    kind: 'scope-fanout',
    deliveryId: await deriveStewardRuntimeFanoutDeliveryId(
      scopeItem,
      7,
      6,
    ),
    rootDeliveryId: scopeItem.cause.deliveryId,
    scopeSchemaVersion: 1,
    fanoutGeneration: 7,
    event: scopeItem.cause.event,
    action: scopeItem.cause.action,
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
});

const workItemV4 = buildStewardRuntimeWorkItemV4({
  operation: 'pull-request-reconcile',
  installationId: 145_952_003,
  subject: {
    repositoryId: 1_298_587_318,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
    pullRequestNumber: 6,
  },
  cause: {
    kind: 'scope-fanout-2',
    deliveryId: await deriveStewardRuntimeFanoutDeliveryIdV2(
      scopeItemV2,
      7,
      6,
    ),
    rootDeliveryId: scopeItemV2.cause.deliveryId,
    scopeSchemaVersion: 2,
    fanoutGeneration: 7,
    event: 'push',
    action: null,
    ref: 'refs/heads/main',
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
});

const installationScope = buildStewardRuntimeScopeWorkItemV2({
  operation: 'scope-reconcile',
  target: {
    scope: 'repository-set',
    mode: 'refresh',
    installationId: 145_952_003,
    repositoryIds: [1_298_587_318],
    pullRequests: 'all-open',
  },
  cause: {
    kind: 'github-webhook',
    deliveryId: 'installation-repositories-recovery-capture',
    event: 'installation_repositories',
    action: 'removed',
    ref: null,
    receivedAt: '2026-07-27T12:00:00.000Z',
  },
});
if (installationScope.target.scope !== 'repository-set') {
  throw new Error('Installation fixture must use repository-set scope.');
}
const installationChild =
  await buildStewardRuntimeInstallationRepositoryChildV1({
    root: {
      installationId: installationScope.target.installationId,
      deliveryId: installationScope.cause.deliveryId,
      scopeWorkItem: {
        ...installationScope,
        target: installationScope.target,
      },
    },
    installationId: installationScope.target.installationId,
    repositoryId: installationScope.target.repositoryIds[0]!,
    installationGeneration: 4,
  });
const workItemV5 = buildStewardRuntimeWorkItemV5({
  operation: 'pull-request-reconcile',
  installationId: installationChild.installationId,
  subject: {
    repositoryId: installationChild.repositoryId,
    repositoryFullName: 'splrad/steward-sandbox-install-e2e',
    pullRequestNumber: 6,
  },
  cause: {
    kind: 'scope-fanout-3',
    deliveryId: await deriveStewardRuntimeFanoutDeliveryIdV3(
      installationChild,
      9,
      6,
    ),
    rootDeliveryId: installationChild.rootDeliveryId,
    installationChild,
    repositoryFanoutGeneration: 9,
    event: installationChild.cause.event,
    action: installationChild.cause.action,
    ref: installationChild.cause.ref,
    receivedAt: installationChild.cause.receivedAt,
  },
});

describe('dead-letter capture classification', () => {
  it('captures and permits exact replay of an operator bootstrap envelope', async () => {
    const stewardCommit = 'a'.repeat(40);
    const envelope =
      buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
        command: {
          schemaVersion: 1,
          operation: 'installation-index-bootstrap',
          requestId: '11111111-2222-4333-8444-555555555555',
          requestedAt: '2026-07-28T04:01:00.000Z',
          installationId: 145_952_003,
          expectedControlRevision: {
            stewardCommit,
            workerVersionId: '11111111-2222-4333-8444-555555555555',
            workerVersionTag: `steward-${stewardCommit}`,
            workerVersionCreatedAt: '2026-07-28T04:00:00.000Z',
          },
        },
        accessServiceClientId: 'bootstrap-service-client',
      });
    const body =
      canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
        envelope,
      );
    await expect(classifyDeadLetterBody(body)).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'installation-index-bootstrap-v1',
      deliveryId: null,
      repositoryId: null,
      pullRequestNumber: null,
      body,
    });
    await expect(classifyDeadLetterBody(`${body}\n`)).resolves.toMatchObject({
      eligible: false,
      quarantineReason: 'installation-index-bootstrap-noncanonical',
    });
  });
  it('accepts exact canonical PR and repository envelopes for replay', async () => {
    const workBody = canonicalStewardRuntimeWorkItemJson(workItem);
    const work = await classifyDeadLetterBody(workBody);
    expect(work).toMatchObject({
      eligible: true,
      envelopeKind: 'work-item-v2',
      body: workBody,
      deliveryId: workItem.cause.deliveryId,
      repositoryId: workItem.subject.repositoryId,
      pullRequestNumber: workItem.subject.pullRequestNumber,
    });
    expect(work.entryId).toBe(work.bodyDigest);

    const scopeBody = canonicalStewardRuntimeScopeWorkItemJson(scopeItem);
    await expect(classifyDeadLetterBody(scopeBody)).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'scope-work-item-v1',
      deliveryId: scopeItem.cause.deliveryId,
      repositoryId: scopeItem.target.repositoryId,
      pullRequestNumber: null,
    });

    await expect(classifyDeadLetterBody(
      canonicalStewardRuntimeScopeWorkItemJson(scopeItemV2),
    )).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'scope-work-item-v2',
      deliveryId: scopeItemV2.cause.deliveryId,
      repositoryId: scopeItemV2.target.repositoryId,
    });
    await expect(classifyDeadLetterBody(
      canonicalStewardRuntimeWorkItemJson(workItemV4),
    )).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'work-item-v4',
      deliveryId: workItemV4.cause.deliveryId,
      repositoryId: workItemV4.subject.repositoryId,
    });
    await expect(classifyDeadLetterBody(
      canonicalStewardRuntimeWorkItemJson(workItemV3),
    )).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'work-item-v3',
      deliveryId: workItemV3.cause.deliveryId,
    });
    await expect(classifyDeadLetterBody(
      await canonicalStewardRuntimeInstallationRepositoryChildV1Json(
        installationChild,
      ),
    )).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'installation-repository-child-v1',
      deliveryId: installationChild.deliveryId,
    });
    await expect(classifyDeadLetterBody(
      canonicalStewardRuntimeWorkItemJson(workItemV5),
    )).resolves.toMatchObject({
      eligible: true,
      envelopeKind: 'work-item-v5',
      deliveryId: workItemV5.cause.deliveryId,
    });
  });

  it('quarantines canonical-looking fan-out work with underived provenance', async () => {
    const invalidV3 = {
      ...workItemV3,
      cause: {
        ...workItemV3.cause,
        deliveryId: `fanout-v1:${'0'.repeat(64)}`,
      },
    };
    const invalidV4 = {
      ...workItemV4,
      cause: {
        ...workItemV4.cause,
        deliveryId: `fanout-v2:${'0'.repeat(64)}`,
      },
    };
    if (workItemV5.cause.kind !== 'scope-fanout-3') {
      throw new Error('V5 fixture must use scope-fanout-3.');
    }
    const invalidV5Commitment = {
      ...workItemV5,
      cause: {
        ...workItemV5.cause,
        installationChild: {
          ...workItemV5.cause.installationChild,
          rootTargetDigest: '0'.repeat(64),
        },
      },
    };
    const invalidV5Delivery = {
      ...workItemV5,
      cause: {
        ...workItemV5.cause,
        deliveryId: `fanout-v3:${'0'.repeat(64)}`,
      },
    };

    for (const invalid of [
      invalidV3,
      invalidV4,
      invalidV5Commitment,
      invalidV5Delivery,
    ]) {
      const body = canonicalStewardRuntimeWorkItemJson(invalid);
      await expect(classifyDeadLetterBody(body)).resolves.toMatchObject({
        eligible: false,
        envelopeKind: 'quarantined',
        quarantineReason: 'unsupported-queue-envelope',
      });
    }
  });

  it('quarantines noncanonical, malformed, non-text, and unsupported bodies', async () => {
    const noncanonical = JSON.stringify(
      JSON.parse(canonicalStewardRuntimeWorkItemJson(workItem)),
      null,
      2,
    );
    await expect(classifyDeadLetterBody(noncanonical)).resolves.toMatchObject({
      eligible: false,
      envelopeKind: 'quarantined',
      quarantineReason: 'work-item-noncanonical',
    });
    await expect(classifyDeadLetterBody('{')).resolves.toMatchObject({
      eligible: false,
      quarantineReason: 'queue-body-invalid-json',
    });
    await expect(classifyDeadLetterBody({ body: 'unexpected' })).resolves
      .toMatchObject({
        eligible: false,
        quarantineReason: 'queue-body-not-text',
      });
    await expect(classifyDeadLetterBody('{"schemaVersion":99}')).resolves
      .toMatchObject({
        eligible: false,
        quarantineReason: 'unsupported-queue-envelope',
      });
  });

  it('stores bounded metadata rather than an oversized poison body', async () => {
    const oversized = 'x'.repeat(maximumCapturedDeadLetterBodyBytes + 1);
    const classified = await classifyDeadLetterBody(oversized);
    expect(classified).toMatchObject({
      eligible: false,
      quarantineReason: 'queue-body-too-large',
    });
    expect(classified.body).not.toContain(oversized);
    expect(classified.byteLength).toBeLessThan(1_024);
    expect(classified.entryId).toBe(classified.bodyDigest);
  });
});
