import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeInstallationFanoutDeliveryId,
  buildStewardRuntimeInstallationFanoutPageReceiptV1,
  buildStewardRuntimeInstallationFanoutPageRequestV1,
  buildStewardRuntimeInstallationRepositoryChildV1,
  canonicalStewardRuntimeInstallationFanoutPageReceiptV1Json,
  canonicalStewardRuntimeInstallationFanoutPageRequestV1Json,
  canonicalStewardRuntimeInstallationRepositoryChildV1Json,
  canonicalStewardRuntimeInstallationFanoutRootV1Json,
  deriveStewardRuntimeInstallationFanoutRootDigest,
  parseStewardRuntimeInstallationFanoutPageReceiptV1,
  parseStewardRuntimeInstallationFanoutPageRequestV1,
  parseStewardRuntimeInstallationRepositoryChildV1,
  parseStewardRuntimeInstallationFanoutRootV1,
} from '../packages/core/src/runtime-installation-fanout.js';

const installationId = 145_952_003;
const root = {
  installationId,
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  scopeWorkItem: {
    schemaVersion: 2,
    operation: 'scope-reconcile',
    target: {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event: 'installation',
      action: 'suspend',
      receivedAt: '2026-07-28T03:04:05.678Z',
      ref: null,
    },
  },
} as const;

const controlRevision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: 'd61f54f6-b30a-4e42-8184-c9e7e1cb495d',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-28T03:00:00.000Z',
};

function request() {
  return buildStewardRuntimeInstallationFanoutPageRequestV1({
    binding: {
      root,
      generation: 7,
      pass: 1,
      cursor: null,
    },
  });
}

function receipt() {
  return buildStewardRuntimeInstallationFanoutPageReceiptV1({
    binding: request().binding,
    installation: {
      state: 'live',
      id: installationId,
    },
    page: {
      totalCount: 102,
      repositoryIds: [1_298_587_318, 1_188_419_640],
      hasNextPage: true,
      endCursor: 'cursor-page-2==',
    },
    controlRevision,
  });
}

describe('installation fan-out page protocol', () => {
  it('round-trips strict request and receipt envelopes with stable bytes', () => {
    const pageRequest = request();
    const pageReceipt = receipt();
    expect(parseStewardRuntimeInstallationFanoutPageRequestV1(pageRequest))
      .toEqual(pageRequest);
    expect(parseStewardRuntimeInstallationFanoutPageReceiptV1(pageReceipt))
      .toEqual(pageReceipt);
    expect(
      canonicalStewardRuntimeInstallationFanoutPageRequestV1Json(pageRequest),
    ).toBe(
      canonicalStewardRuntimeInstallationFanoutPageRequestV1Json({
        ...pageRequest,
        binding: {
          cursor: null,
          pass: 1,
          generation: 7,
          root: {
            scopeWorkItem: root.scopeWorkItem,
            deliveryId: root.deliveryId,
            installationId,
          },
        },
      }),
    );
    expect(
      canonicalStewardRuntimeInstallationFanoutPageReceiptV1Json(pageReceipt),
    ).toBe(
      canonicalStewardRuntimeInstallationFanoutPageReceiptV1Json(
        parseStewardRuntimeInstallationFanoutPageReceiptV1(pageReceipt),
      ),
    );
  });

  it('commits a strict installation ScopeWorkItem V2 with stable bytes', () => {
    const reordered = {
      deliveryId: root.deliveryId,
      installationId,
      scopeWorkItem: {
        target: root.scopeWorkItem.target,
        cause: root.scopeWorkItem.cause,
        operation: 'scope-reconcile',
        schemaVersion: 2,
      },
    };
    expect(canonicalStewardRuntimeInstallationFanoutRootV1Json(reordered))
      .toBe(canonicalStewardRuntimeInstallationFanoutRootV1Json(root));

    const hidden = structuredClone(root) as Record<PropertyKey, unknown>;
    (hidden.scopeWorkItem as Record<PropertyKey, unknown>)[Symbol('hidden')] =
      true;
    expect(() => parseStewardRuntimeInstallationFanoutRootV1(hidden))
      .toThrow('symbol key');
    expect(() =>
      parseStewardRuntimeInstallationFanoutRootV1({
        ...root,
        scopeWorkItem: { unsafe: Number.NaN },
      })).toThrow('safe integers');
    expect(() =>
      parseStewardRuntimeInstallationFanoutRootV1({
        ...root,
        deliveryId: 'different-delivery',
      })).toThrow('ScopeWorkItem delivery ID');
    expect(() =>
      parseStewardRuntimeInstallationFanoutRootV1({
        ...root,
        installationId: installationId + 1,
      })).toThrow('ScopeWorkItem installation ID');
    expect(() =>
      parseStewardRuntimeInstallationFanoutRootV1({
        ...root,
        scopeWorkItem: {
          ...root.scopeWorkItem,
          target: {
            scope: 'repository',
            mode: 'refresh',
            installationId,
            repositoryId: 1_298_587_318,
            pullRequests: 'all-open',
          },
          cause: {
            ...root.scopeWorkItem.cause,
            event: 'repository',
            action: 'edited',
          },
        },
      })).toThrow('installation or repository-set');
  });

  it('requires suspended and absent observations to be empty terminal facts', () => {
    for (const state of ['suspended', 'absent'] as const) {
      const terminal =
        buildStewardRuntimeInstallationFanoutPageReceiptV1({
          binding: request().binding,
          installation: { state, id: installationId },
          page: {
            totalCount: 0,
            repositoryIds: [],
            hasNextPage: false,
            endCursor: null,
          },
          controlRevision,
        });
      expect(parseStewardRuntimeInstallationFanoutPageReceiptV1(terminal))
        .toEqual(terminal);
      expect(() =>
        parseStewardRuntimeInstallationFanoutPageReceiptV1({
          ...terminal,
          page: {
            totalCount: 1,
            repositoryIds: [1_298_587_318],
            hasNextPage: false,
            endCursor: null,
          },
        })).toThrow('empty terminal page');
    }
  });

  it('fails closed on mismatched identities, cursors, and repository pages', () => {
    const cases: unknown[] = [
      { ...request(), unknown: true },
      { ...request(), binding: { ...request().binding, pass: 3 } },
      { ...request(), binding: { ...request().binding, cursor: 'with spaces' } },
      {
        ...receipt(),
        installation: { state: 'live', id: installationId + 1 },
      },
      {
        ...receipt(),
        page: { ...receipt().page, totalCount: 10_001 },
      },
      {
        ...receipt(),
        page: {
          ...receipt().page,
          repositoryIds: [1_298_587_318, 1_298_587_318],
        },
      },
      {
        ...receipt(),
        page: { ...receipt().page, hasNextPage: true, endCursor: null },
      },
      {
        ...receipt(),
        binding: { ...receipt().binding, cursor: 'same' },
        page: { ...receipt().page, endCursor: 'same' },
      },
    ];
    for (const value of cases) {
      expect(() => (
        (value as { phase?: unknown }).phase === 'enumerate-page'
          ? parseStewardRuntimeInstallationFanoutPageRequestV1(value)
          : parseStewardRuntimeInstallationFanoutPageReceiptV1(value)
      )).toThrow();
    }
  });

  it('derives generation- and repository-bound child delivery IDs', async () => {
    const digest =
      await deriveStewardRuntimeInstallationFanoutRootDigest(root);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await expect(deriveStewardRuntimeInstallationFanoutRootDigest(root))
      .resolves.toBe(digest);
    const first = buildStewardRuntimeInstallationFanoutDeliveryId(
      digest,
      7,
      1_298_587_318,
    );
    expect(first).toBe(
      `installation-fanout-v1:${digest}:7:1298587318`,
    );
    expect(
      buildStewardRuntimeInstallationFanoutDeliveryId(
        digest,
        7,
        1_298_587_318,
      ),
    ).toBe(first);
    expect(
      buildStewardRuntimeInstallationFanoutDeliveryId(
        digest,
        8,
        1_298_587_318,
      ),
    ).not.toBe(first);
    expect(
      buildStewardRuntimeInstallationFanoutDeliveryId(
        digest,
        7,
        1_188_419_640,
      ),
    ).not.toBe(first);
  });

  it('builds a bounded child commitment and rejects every tampered binding', async () => {
    const child = await buildStewardRuntimeInstallationRepositoryChildV1({
      root,
      installationId,
      repositoryId: 1_298_587_318,
      installationGeneration: 7,
    });
    expect(child).toMatchObject({
      rootDeliveryId: root.deliveryId,
      rootTargetScope: 'installation',
      installationId,
      repositoryId: 1_298_587_318,
      installationGeneration: 7,
      cause: root.scopeWorkItem.cause,
    });
    expect(child).not.toHaveProperty('root');
    await expect(parseStewardRuntimeInstallationRepositoryChildV1(child))
      .resolves.toEqual(child);
    await expect(
      canonicalStewardRuntimeInstallationRepositoryChildV1Json(child),
    ).resolves.toBe(JSON.stringify(child));

    const cases: unknown[] = [
      { ...child, unknown: true },
      {
        ...child,
        rootDigest:
          `${child.rootDigest[0] === '0' ? '1' : '0'}${child.rootDigest.slice(1)}`,
      },
      { ...child, rootDeliveryId: 'different-delivery' },
      { ...child, rootTargetScope: 'repository-set' },
      { ...child, installationId: installationId + 1 },
      { ...child, repositoryId: child.repositoryId + 1 },
      { ...child, installationGeneration: 8 },
      {
        ...child,
        cause: { ...child.cause, event: 'push', action: null, ref: 'refs/heads/main' },
      },
      { ...child, deliveryId: `${child.deliveryId}-tampered` },
    ];
    for (const value of cases) {
      await expect(parseStewardRuntimeInstallationRepositoryChildV1(value))
        .rejects.toThrow();
    }
  });

  it('binds explicit repository-set children without copying the full set', async () => {
    const repositorySetRoot = {
      installationId,
      deliveryId: 'installation-repositories-delivery',
      scopeWorkItem: {
        schemaVersion: 2,
        operation: 'scope-reconcile',
        target: {
          scope: 'repository-set',
          mode: 'refresh',
          installationId,
          repositoryIds: [10, 20],
          pullRequests: 'all-open',
        },
        cause: {
          kind: 'github-webhook',
          deliveryId: 'installation-repositories-delivery',
          event: 'installation_repositories',
          action: 'removed',
          ref: null,
          receivedAt: '2026-07-28T03:04:05.678Z',
        },
      },
    } as const;
    const child = await buildStewardRuntimeInstallationRepositoryChildV1({
      root: repositorySetRoot,
      installationId,
      repositoryId: 20,
      installationGeneration: 3,
    });
    expect(child.rootTargetScope).toBe('repository-set');
    expect(child).not.toHaveProperty('root');
    await expect(buildStewardRuntimeInstallationRepositoryChildV1({
      root: repositorySetRoot,
      installationId,
      repositoryId: 30,
      installationGeneration: 3,
    })).rejects.toThrow('committed repository set');
    expect(buildStewardRuntimeInstallationFanoutPageRequestV1({
      binding: {
        root: repositorySetRoot,
        generation: 3,
        pass: 1,
        cursor: null,
      },
    })).toMatchObject({
      phase: 'enumerate-page',
      binding: { root: repositorySetRoot },
    });
  });

  it('binds installation suspend and delete snapshots as repository-set roots', async () => {
    for (const action of ['suspend', 'deleted'] as const) {
      const snapshotRoot = {
        installationId,
        deliveryId: `installation-${action}-snapshot`,
        scopeWorkItem: {
          schemaVersion: 2,
          operation: 'scope-reconcile',
          target: {
            scope: 'repository-set',
            mode: 'refresh',
            installationId,
            repositoryIds: [10, 20],
            pullRequests: 'all-open',
          },
          cause: {
            kind: 'github-webhook',
            deliveryId: `installation-${action}-snapshot`,
            event: 'installation',
            action,
            ref: null,
            receivedAt: '2026-07-28T03:04:05.678Z',
          },
        },
      } as const;
      const child = await buildStewardRuntimeInstallationRepositoryChildV1({
        root: snapshotRoot,
        installationId,
        repositoryId: 20,
        installationGeneration: 3,
      });
      await expect(parseStewardRuntimeInstallationRepositoryChildV1(child))
        .resolves.toEqual(child);
      expect(child.rootTargetScope).toBe('repository-set');
      expect(child.cause).toMatchObject({ event: 'installation', action });
      expect(() => buildStewardRuntimeInstallationFanoutPageRequestV1({
        binding: {
          root: snapshotRoot,
          generation: 3,
          pass: 1,
          cursor: null,
        },
      })).toThrow('live enumeration');
    }
  });
});
