import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeRepositoryFanoutPageReceiptV1,
  buildStewardRuntimeRepositoryFanoutPageReceiptV2,
  buildStewardRuntimeRepositoryFanoutPageReceiptV3,
  buildStewardRuntimeRepositoryFanoutPageRequestV1,
  buildStewardRuntimeRepositoryFanoutPageRequestV2,
  buildStewardRuntimeRepositoryFanoutPageRequestV3,
  buildStewardRuntimeInstallationRepositoryChildV1,
  buildStewardRuntimeScopeWorkItemV1,
  buildStewardRuntimeScopeWorkItemV2,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV2Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV2Json,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV3Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json,
  deriveStewardRuntimeFanoutDeliveryId,
  deriveStewardRuntimeFanoutDeliveryIdV2,
  deriveStewardRuntimeFanoutDeliveryIdV3,
  parseStewardRuntimeRepositoryFanoutPageReceiptV1,
  parseStewardRuntimeRepositoryFanoutPageRequestV1,
  parseStewardRuntimeRepositoryFanoutPageReceiptV2,
  parseStewardRuntimeRepositoryFanoutPageRequestV2,
  parseStewardRuntimeRepositoryFanoutPageReceiptV3,
  parseStewardRuntimeRepositoryFanoutPageRequestV3,
  type StewardRuntimeRepositoryScopeTargetV2,
  type StewardRuntimeScopeWorkItemV2,
  type StewardRuntimeControlRevisionV1,
} from '../packages/core/src/index.js';

const scopeWorkItem = buildStewardRuntimeScopeWorkItemV1({
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
    receivedAt: '2026-07-27T03:04:05.678Z',
  },
});

const revision: StewardRuntimeControlRevisionV1 = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-27T03:00:00.000Z',
};

const pushScopeWorkItem = buildStewardRuntimeScopeWorkItemV2({
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
    receivedAt: '2026-07-27T03:04:05.678Z',
  },
}) as StewardRuntimeScopeWorkItemV2 & {
  readonly target: StewardRuntimeRepositoryScopeTargetV2;
};

function request() {
  return buildStewardRuntimeRepositoryFanoutPageRequestV1({
    binding: {
      scopeWorkItem,
      generation: 7,
      pass: 1,
      cursor: null,
    },
  });
}

function receipt() {
  return buildStewardRuntimeRepositoryFanoutPageReceiptV1({
    binding: request().binding,
    repository: {
      state: 'live',
      id: scopeWorkItem.target.repositoryId,
      fullName: 'splrad/LayerScape',
    },
    page: {
      totalCount: 102,
      pullRequestNumbers: [130, 131],
      hasNextPage: true,
      endCursor: 'cursor-page-2==',
    },
    controlRevision: revision,
  });
}

describe('repository fan-out page protocol', () => {
  it('round-trips a strict request and receipt with stable canonical bytes', () => {
    const pageRequest = request();
    const pageReceipt = receipt();

    expect(parseStewardRuntimeRepositoryFanoutPageRequestV1(pageRequest))
      .toEqual(pageRequest);
    expect(parseStewardRuntimeRepositoryFanoutPageReceiptV1(pageReceipt))
      .toEqual(pageReceipt);
    expect(canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json(pageRequest))
      .toBe(JSON.stringify(pageRequest));
    expect(canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(pageReceipt))
      .toBe(JSON.stringify(pageReceipt));
  });

  it('binds repository identity, cursor advancement, and absent tombstones', () => {
    expect(() => parseStewardRuntimeRepositoryFanoutPageReceiptV1({
      ...receipt(),
      repository: { ...receipt().repository, id: 99 },
    })).toThrow('must match the scope repository ID');
    expect(() => parseStewardRuntimeRepositoryFanoutPageReceiptV1({
      ...receipt(),
      binding: { ...receipt().binding, cursor: 'same' },
      page: { ...receipt().page, endCursor: 'same' },
    })).toThrow('must advance');
    expect(() => parseStewardRuntimeRepositoryFanoutPageReceiptV1({
      ...receipt(),
      repository: {
        state: 'absent',
        id: scopeWorkItem.target.repositoryId,
        fullName: null,
      },
    })).toThrow('empty terminal page');

    const absent = buildStewardRuntimeRepositoryFanoutPageReceiptV1({
      binding: request().binding,
      repository: {
        state: 'absent',
        id: scopeWorkItem.target.repositoryId,
        fullName: null,
      },
      page: {
        totalCount: 0,
        pullRequestNumbers: [],
        hasNextPage: false,
        endCursor: null,
      },
      controlRevision: revision,
    });
    expect(parseStewardRuntimeRepositoryFanoutPageReceiptV1(absent))
      .toEqual(absent);
  });

  it('fails closed on unknown fields, invalid pages, and malformed cursors', () => {
    const cases: unknown[] = [
      { ...request(), unknown: true },
      { ...request(), binding: { ...request().binding, pass: 3 } },
      { ...request(), binding: { ...request().binding, cursor: 'with spaces' } },
      {
        ...receipt(),
        page: { ...receipt().page, totalCount: 3_001 },
      },
      {
        ...receipt(),
        page: { ...receipt().page, pullRequestNumbers: [130, 130] },
      },
      {
        ...receipt(),
        page: { ...receipt().page, hasNextPage: true, endCursor: null },
      },
      {
        ...receipt(),
        repository: {
          state: 'live',
          id: scopeWorkItem.target.repositoryId,
          fullName: null,
        },
      },
    ];
    for (const value of cases) {
      expect(() => (
        (value as { phase?: unknown }).phase === 'enumerate-page'
          ? parseStewardRuntimeRepositoryFanoutPageRequestV1(value)
          : parseStewardRuntimeRepositoryFanoutPageReceiptV1(value)
      )).toThrow();
    }

    const symbolRequest = request() as unknown as Record<PropertyKey, unknown>;
    symbolRequest[Symbol('hidden')] = true;
    expect(() => parseStewardRuntimeRepositoryFanoutPageRequestV1(symbolRequest))
      .toThrow('missing or unknown fields');
  });

  it('derives deterministic, generation- and PR-bound child delivery IDs', async () => {
    const first = await deriveStewardRuntimeFanoutDeliveryId(
      scopeWorkItem,
      7,
      130,
    );
    expect(first).toMatch(/^fanout-v1:[0-9a-f]{64}$/);
    await expect(deriveStewardRuntimeFanoutDeliveryId(scopeWorkItem, 7, 130))
      .resolves.toBe(first);
    await expect(deriveStewardRuntimeFanoutDeliveryId(scopeWorkItem, 8, 130))
      .resolves.not.toBe(first);
    await expect(deriveStewardRuntimeFanoutDeliveryId(scopeWorkItem, 7, 131))
      .resolves.not.toBe(first);
  });

  it('round-trips repository-fanout-v2 and uses a distinct deterministic ID domain', async () => {
    const pageRequest = buildStewardRuntimeRepositoryFanoutPageRequestV2({
      binding: {
        scopeWorkItem: pushScopeWorkItem,
        generation: 7,
        pass: 1,
        cursor: null,
      },
    });
    const pageReceipt = buildStewardRuntimeRepositoryFanoutPageReceiptV2({
      binding: pageRequest.binding,
      repository: {
        state: 'live',
        id: pushScopeWorkItem.target.repositoryId,
        fullName: 'splrad/LayerScape',
      },
      page: {
        totalCount: 1,
        pullRequestNumbers: [130],
        hasNextPage: false,
        endCursor: null,
      },
      controlRevision: revision,
    });
    expect(parseStewardRuntimeRepositoryFanoutPageRequestV2(pageRequest))
      .toEqual(pageRequest);
    expect(parseStewardRuntimeRepositoryFanoutPageReceiptV2(pageReceipt))
      .toEqual(pageReceipt);
    expect(canonicalStewardRuntimeRepositoryFanoutPageRequestV2Json(pageRequest))
      .toBe(JSON.stringify(pageRequest));
    expect(canonicalStewardRuntimeRepositoryFanoutPageReceiptV2Json(pageReceipt))
      .toBe(JSON.stringify(pageReceipt));

    const deliveryId = await deriveStewardRuntimeFanoutDeliveryIdV2(
      pushScopeWorkItem,
      7,
      130,
    );
    expect(deliveryId).toMatch(/^fanout-v2:[0-9a-f]{64}$/);
    await expect(deriveStewardRuntimeFanoutDeliveryIdV2(
      pushScopeWorkItem,
      7,
      130,
    )).resolves.toBe(deliveryId);
    await expect(deriveStewardRuntimeFanoutDeliveryId(
      scopeWorkItem,
      7,
      130,
    )).resolves.not.toBe(deliveryId);
  });

  it('keeps non-repository scope-v2 targets outside repository-fanout-v2', () => {
    const installationScope = buildStewardRuntimeScopeWorkItemV2({
      operation: 'scope-reconcile',
      target: {
        scope: 'installation',
        mode: 'refresh',
        installationId: 145_952_003,
        repositories: 'all-live',
        pullRequests: 'all-open',
      },
      cause: {
        kind: 'github-webhook',
        deliveryId: 'property-delivery-1',
        event: 'custom_property',
        action: 'updated',
        ref: null,
        receivedAt: '2026-07-27T03:04:05.678Z',
      },
    });
    expect(() => parseStewardRuntimeRepositoryFanoutPageRequestV2({
      schemaVersion: 2,
      phase: 'enumerate-page',
      binding: {
        scopeWorkItem: installationScope,
        generation: 7,
        pass: 1,
        cursor: null,
      },
    })).toThrow('must be repository');
  });

  it('binds repository-fanout-v3 to a strict bounded installation child', async () => {
    const scopeWorkItem = buildStewardRuntimeScopeWorkItemV2({
      operation: 'scope-reconcile',
      target: {
        scope: 'installation',
        mode: 'refresh',
        installationId: 145_952_003,
        repositories: 'all-live',
        pullRequests: 'all-open',
      },
      cause: {
        kind: 'github-webhook',
        deliveryId: 'installation-root-v3',
        event: 'installation',
        action: 'created',
        ref: null,
        receivedAt: '2026-07-27T03:04:05.678Z',
      },
    });
    if (scopeWorkItem.target.scope !== 'installation') {
      throw new Error('fan-out v3 fixture must use installation scope');
    }
    const root = {
      installationId: 145_952_003,
      deliveryId: 'installation-root-v3',
      scopeWorkItem: {
        ...scopeWorkItem,
        target: scopeWorkItem.target,
      },
    } as const;
    const installationChild =
      await buildStewardRuntimeInstallationRepositoryChildV1({
        root,
        installationId: root.installationId,
        repositoryId: 1_298_587_318,
        installationGeneration: 4,
      });
    const requestV3 =
      await buildStewardRuntimeRepositoryFanoutPageRequestV3({
        binding: {
          installationChild,
          generation: 9,
          pass: 1,
          cursor: null,
        },
      });
    const receiptV3 =
      await buildStewardRuntimeRepositoryFanoutPageReceiptV3({
        binding: requestV3.binding,
        repository: {
          state: 'live',
          id: installationChild.repositoryId,
          fullName: 'splrad/LayerScape',
        },
        page: {
          totalCount: 1,
          pullRequestNumbers: [130],
          hasNextPage: false,
          endCursor: null,
        },
        controlRevision: revision,
      });
    const requestJson =
      await canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json(
        requestV3,
      );
    const receiptJson =
      await canonicalStewardRuntimeRepositoryFanoutPageReceiptV3Json(
        receiptV3,
      );
    await expect(
      parseStewardRuntimeRepositoryFanoutPageRequestV3(
        JSON.parse(requestJson),
      ),
    ).resolves.toEqual(requestV3);
    await expect(
      parseStewardRuntimeRepositoryFanoutPageReceiptV3(
        JSON.parse(receiptJson),
      ),
    ).resolves.toEqual(receiptV3);
    await expect(
      deriveStewardRuntimeFanoutDeliveryIdV3(
        installationChild,
        9,
        130,
      ),
    ).resolves.toMatch(/^fanout-v3:[0-9a-f]{64}$/);

    const forged = JSON.parse(requestJson) as {
      binding: { installationChild: { rootTargetDigest: string } };
    };
    forged.binding.installationChild.rootTargetDigest = 'f'.repeat(64);
    await expect(
      parseStewardRuntimeRepositoryFanoutPageRequestV3(forged),
    ).rejects.toThrow('compact root commitment');
  });
});
