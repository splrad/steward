import { describe, expect, it } from 'vitest';
import {
  buildStewardRuntimeRepositoryFanoutPageReceiptV1,
  buildStewardRuntimeRepositoryFanoutPageRequestV1,
  buildStewardRuntimeScopeWorkItemV1,
  canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json,
  canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json,
  deriveStewardRuntimeFanoutDeliveryId,
  parseStewardRuntimeRepositoryFanoutPageReceiptV1,
  parseStewardRuntimeRepositoryFanoutPageRequestV1,
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
});
