import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeInstallationFanoutPageReceiptV1,
  type StewardRuntimeInstallationFanoutPageReceiptV1,
  type StewardRuntimeInstallationFanoutRootV1,
  type StewardRuntimeInstallationFanoutStateV1,
} from '../packages/core/src/runtime-installation-fanout.js';
import {
  buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  buildStewardRuntimeInstallationIndexBootstrapPageRequestV1,
  buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1,
  deriveStewardRuntimeInstallationIndexBootstrapDigest,
  type StewardRuntimeInstallationIndexBootstrapEnvelopeV1,
} from '../packages/core/src/runtime-installation-index-bootstrap.js';
import {
  buildStewardRuntimeScopeWorkItemV2,
  type StewardRuntimeRepositorySetScopeTargetV2,
} from '../packages/core/src/runtime-scope-work-item.js';
import {
  installationFanoutCoordinatorName,
  parseInstallationFanoutCoordinatorName,
  type InstallationFanoutClaimResult,
  type InstallationFanoutCompleteResult,
  type InstallationFanoutFailResult,
  type InstallationFanoutNextDispatchBatchResult,
  type InstallationFanoutRecordPageResult,
  type InstallationFanoutRecordQueueConfirmedResult,
  type InstallationFanoutReleaseForContinuationResult,
  type InstallationFanoutSnapshot,
  type InstallationIndexBootstrapClaimResult,
  type InstallationIndexBootstrapFailResult,
  type InstallationIndexBootstrapFinalizeResult,
  type InstallationIndexBootstrapRecordPageResult,
  type InstallationIndexBootstrapReleaseResult,
} from '../packages/coordinator/src/installation-fanout-contracts.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

interface TestCoordinatorApi {
  claimIndexBootstrap(
    command: unknown,
    leaseDurationMs: number,
  ): Promise<InstallationIndexBootstrapClaimResult>;
  recordIndexBootstrapPage(
    leaseToken: string,
    receipt: unknown,
  ): Promise<InstallationIndexBootstrapRecordPageResult>;
  finalizeIndexBootstrap(
    leaseToken: string,
  ): Promise<InstallationIndexBootstrapFinalizeResult>;
  releaseIndexBootstrap(
    leaseToken: string,
  ): Promise<InstallationIndexBootstrapReleaseResult>;
  failIndexBootstrap(
    leaseToken: string,
    failureCode: 'runtime-error',
  ): Promise<InstallationIndexBootstrapFailResult>;
  inspectIndexBootstrap(
    requestId: string,
    commandDigest: string,
    principalClientId: string,
  ): Promise<unknown>;
  claim(
    root: unknown,
    leaseDurationMs: number,
  ): Promise<InstallationFanoutClaimResult>;
  recordPage(
    generation: number,
    leaseToken: string,
    receipt: unknown,
  ): Promise<InstallationFanoutRecordPageResult>;
  nextDispatchBatch(
    generation: number,
    leaseToken: string,
    limit?: number,
  ): Promise<InstallationFanoutNextDispatchBatchResult>;
  recordQueueConfirmed(
    generation: number,
    leaseToken: string,
    confirmations: unknown,
  ): Promise<InstallationFanoutRecordQueueConfirmedResult>;
  complete(
    generation: number,
    leaseToken: string,
  ): Promise<InstallationFanoutCompleteResult>;
  fail(
    generation: number,
    leaseToken: string,
    failureCode: 'runtime-error',
  ): Promise<InstallationFanoutFailResult>;
  releaseForContinuation(
    generation: number,
    leaseToken: string,
  ): Promise<InstallationFanoutReleaseForContinuationResult>;
  alarm(): Promise<void>;
  snapshot(): Promise<InstallationFanoutSnapshot>;
}

interface TestCoordinatorConstructor {
  new(ctx: unknown, env: unknown): TestCoordinatorApi;
}

const coordinatorModulePath =
  '../packages/coordinator/src/installation-fanout-coordinator.js';
const { InstallationFanoutCoordinator } = await import(
  coordinatorModulePath
) as unknown as {
  InstallationFanoutCoordinator: TestCoordinatorConstructor;
};

type SqlValue = string | number | null;

class TestSqlStorage {
  readonly database = new DatabaseSync(':memory:');

  exec<T extends object>(query: string, ...bindings: SqlValue[]): {
    one(): T;
    toArray(): T[];
  } {
    const statement = this.database.prepare(query);
    const rows = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query)
      ? statement.all(...bindings) as T[]
      : (statement.run(...bindings), [] as T[]);
    return {
      one(): T {
        if (rows.length !== 1 || rows[0] === undefined) {
          throw new Error(
            `Expected exactly one SQLite row, received ${rows.length}.`,
          );
        }
        return rows[0];
      },
      toArray(): T[] {
        return rows;
      },
    };
  }
}

class TestDurableStorage {
  readonly sql = new TestSqlStorage();
  readonly alarms: number[] = [];

  transactionSync<T>(closure: () => T): T {
    this.sql.database.exec('BEGIN IMMEDIATE');
    try {
      const result = closure();
      this.sql.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.database.exec('ROLLBACK');
      throw error;
    }
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarms.push(scheduledTime);
  }
}

const installationId = 145_952_003;
const controlRevision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: '11111111-2222-4333-8444-555555555555',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-28T04:00:00.000Z',
};

function root(
  deliveryId: string,
  action: 'created' | 'suspend' | 'deleted' = 'created',
): StewardRuntimeInstallationFanoutRootV1 {
  return {
    installationId,
    deliveryId,
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
        deliveryId,
        event: 'installation',
        action,
        receivedAt: '2026-07-28T04:00:00.000Z',
        ref: null,
      },
    },
  };
}

function repositorySetRoot(
  deliveryId: string,
  repositoryIds: readonly number[],
  cause:
    | {
        readonly event: 'installation_repositories';
        readonly action: 'added' | 'removed';
      }
    | {
        readonly event: 'installation';
        readonly action: 'suspend' | 'deleted';
      } = {
        event: 'installation',
        action: 'suspend',
      },
): StewardRuntimeInstallationFanoutRootV1 {
  const scopeCause = cause.event === 'installation'
    ? {
        kind: 'github-webhook' as const,
        deliveryId,
        event: 'installation' as const,
        action: cause.action,
        receivedAt: '2026-07-28T04:00:00.000Z',
        ref: null,
      }
    : {
        kind: 'github-webhook' as const,
        deliveryId,
        event: 'installation_repositories' as const,
        action: cause.action,
        receivedAt: '2026-07-28T04:00:00.000Z',
        ref: null,
      };
  const target = {
    scope: 'repository-set',
    mode: 'refresh',
    installationId,
    repositoryIds: [...repositoryIds].sort((left, right) => left - right),
    pullRequests: 'all-open',
  } satisfies StewardRuntimeRepositorySetScopeTargetV2;
  const scopeWorkItem = buildStewardRuntimeScopeWorkItemV2({
    operation: 'scope-reconcile',
    target,
    cause: scopeCause,
  });

  return {
    installationId,
    deliveryId,
    scopeWorkItem: {
      ...scopeWorkItem,
      target,
    },
  };
}

function pageReceipt(input: {
  readonly root: StewardRuntimeInstallationFanoutRootV1;
  readonly generation: number;
  readonly pass: 1 | 2;
  readonly state?: StewardRuntimeInstallationFanoutStateV1;
  readonly cursor?: string | null;
  readonly repositoryIds?: readonly number[];
  readonly totalCount?: number;
  readonly endCursor?: string | null;
}): StewardRuntimeInstallationFanoutPageReceiptV1 {
  const state = input.state ?? 'live';
  const repositoryIds = input.repositoryIds ?? [];
  const endCursor = input.endCursor ?? null;
  return buildStewardRuntimeInstallationFanoutPageReceiptV1({
    binding: {
      root: input.root,
      generation: input.generation,
      pass: input.pass,
      cursor: input.cursor ?? null,
    },
    installation: {
      state,
      id: installationId,
    },
    page: {
      totalCount: input.totalCount ?? repositoryIds.length,
      repositoryIds,
      hasNextPage: endCursor !== null,
      endCursor,
    },
    controlRevision,
  });
}

function coordinator(): {
  readonly object: TestCoordinatorApi;
  readonly storage: TestDurableStorage;
} {
  const storage = new TestDurableStorage();
  const ctx = {
    id: { name: installationFanoutCoordinatorName(installationId) },
    storage,
  };
  return {
    object: new InstallationFanoutCoordinator(ctx, {}),
    storage,
  };
}

function lastKnownRepositoryIds(
  storage: TestDurableStorage,
): readonly number[] {
  return storage.sql.exec<{ repository_id: string }>(
    `SELECT repository_id
     FROM installation_fanout_last_known_repositories
     ORDER BY CAST(repository_id AS INTEGER)`,
  ).toArray().map((row) => Number(row.repository_id));
}

function lastKnownControlRevisionJson(
  storage: TestDurableStorage,
): string | null {
  return storage.sql.exec<{ control_revision_json: string | null }>(
    `SELECT control_revision_json
     FROM installation_fanout_last_known_meta
     WHERE singleton = 1`,
  ).one().control_revision_json;
}

async function establishLiveIndex(
  object: TestCoordinatorApi,
  rootItem: StewardRuntimeInstallationFanoutRootV1,
  repositoryIds: readonly number[],
): Promise<void> {
  const claim = await object.claim(rootItem, 60_000);
  if (claim.status !== 'claimed') throw new Error('Expected a claim.');
  expect(
    await object.recordPage(
      claim.generation,
      claim.leaseToken,
      pageReceipt({
        root: rootItem,
        generation: claim.generation,
        pass: 1,
        repositoryIds,
      }),
    ),
  ).toMatchObject({ status: 'pass-complete' });
  expect(
    await object.recordPage(
      claim.generation,
      claim.leaseToken,
      pageReceipt({
        root: rootItem,
        generation: claim.generation,
        pass: 2,
        repositoryIds: [...repositoryIds].reverse(),
      }),
    ),
  ).toMatchObject({
    status: 'dispatch-ready',
    targetSource: 'live',
    targetCount: repositoryIds.length,
  });
  const batch = await object.nextDispatchBatch(
    claim.generation,
    claim.leaseToken,
  );
  if (batch.status !== 'batch') throw new Error('Expected a batch.');
  if (batch.targets.length > 0) {
    await object.recordQueueConfirmed(
      claim.generation,
      claim.leaseToken,
      { confirmations: batch.targets },
    );
  }
  expect(await object.complete(claim.generation, claim.leaseToken))
    .toMatchObject({ status: 'completed' });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T04:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('installation fan-out coordinator contract', () => {
  it('uses one canonical installation-scoped Durable Object name', () => {
    expect(installationFanoutCoordinatorName(installationId))
      .toBe('steward-installation-fanout-v1:145952003');
    expect(
      parseInstallationFanoutCoordinatorName(
        'steward-installation-fanout-v1:145952003',
      ),
    ).toEqual({ installationId: '145952003' });
    expect(() =>
      parseInstallationFanoutCoordinatorName(
        'steward-installation-fanout-v1:0145952003',
      )).toThrow(/canonical positive safe-integer/);
    expect(() =>
      parseInstallationFanoutCoordinatorName(
        'steward-repository-fanout-v1:145952003',
      )).toThrow(/steward-installation-fanout-v1/);
  });

  it('requires two identical repository sets and reuses targets after response loss', async () => {
    const { object } = coordinator();
    const item = root('installation-root-two-pass');
    let claim = await object.claim(item, 60_000);
    expect(claim).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: false,
      phase: 'enumerating',
      pass: 1,
      cursor: null,
    });
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');

    const firstPage = pageReceipt({
      root: item,
      generation: 1,
      pass: 1,
      repositoryIds: [7],
      totalCount: 2,
      endCursor: 'cursor-pass-one',
    });
    expect(await object.recordPage(1, claim.leaseToken, firstPage)).toEqual({
      status: 'accepted',
      generation: 1,
      pass: 1,
      hasNextPage: true,
    });
    expect(await object.recordPage(1, claim.leaseToken, firstPage)).toEqual({
      status: 'duplicate',
      generation: 1,
      pass: 1,
      hasNextPage: true,
    });
    expect(
      await object.releaseForContinuation(1, claim.leaseToken),
    ).toEqual({ status: 'released', generation: 1 });
    claim = await object.claim(item, 60_000);
    expect(claim).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: true,
      pass: 1,
      cursor: 'cursor-pass-one',
    });
    if (claim.status !== 'claimed') throw new Error('Expected a resume.');

    expect(
      await object.recordPage(
        1,
        claim.leaseToken,
        pageReceipt({
          root: item,
          generation: 1,
          pass: 1,
          cursor: 'cursor-pass-one',
          repositoryIds: [11],
          totalCount: 2,
        }),
      ),
    ).toEqual({ status: 'pass-complete', generation: 1, nextPass: 2 });
    expect(
      await object.recordPage(
        1,
        claim.leaseToken,
        pageReceipt({
          root: item,
          generation: 1,
          pass: 2,
          repositoryIds: [11, 7],
        }),
      ),
    ).toEqual({
      status: 'dispatch-ready',
      generation: 1,
      installationState: 'live',
      targetSource: 'live',
      targetCount: 2,
    });

    const firstBatch = await object.nextDispatchBatch(1, claim.leaseToken);
    const lostResponseRetry =
      await object.nextDispatchBatch(1, claim.leaseToken);
    expect(lostResponseRetry).toEqual(firstBatch);
    if (firstBatch.status !== 'batch') throw new Error('Expected a batch.');
    expect(firstBatch.targets.map((target) => target.repositoryId))
      .toEqual([7, 11]);
    expect(firstBatch.targets.every((target) =>
      /^installation-fanout-v1:[0-9a-f]{64}:1:\d+$/.test(target.deliveryId)))
      .toBe(true);

    const firstConfirmation = { confirmations: [firstBatch.targets[0]] };
    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        firstConfirmation,
      ),
    ).toMatchObject({ newlyConfirmed: 1, remaining: 1 });
    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        firstConfirmation,
      ),
    ).toMatchObject({ newlyConfirmed: 0, remaining: 1 });
    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        { confirmations: [firstBatch.targets[1]] },
      ),
    ).toMatchObject({ newlyConfirmed: 1, remaining: 0 });
    expect(await object.complete(1, claim.leaseToken)).toEqual({
      status: 'completed',
      generation: 1,
    });
    expect(await object.claim(item, 60_000)).toEqual({
      status: 'duplicate',
    });
    expect(await object.snapshot()).toMatchObject({
      schemaVersion: 1,
      installationId: String(installationId),
      phase: 'idle',
      targetCount: 2,
      confirmedTargetCount: 2,
      lastKnownIndexKnown: true,
      lastKnownRepositoryCount: 2,
    });
  });

  it('coalesces a later root as dirty and advances through follow-up', async () => {
    const { object } = coordinator();
    const first = root('installation-root-first');
    const later = root('installation-root-later', 'deleted');
    const claim = await object.claim(first, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');
    expect(await object.claim(later, 60_000)).toMatchObject({
      status: 'coalesced',
      generation: 1,
    });
    await object.recordPage(
      1,
      claim.leaseToken,
      pageReceipt({ root: first, generation: 1, pass: 1 }),
    );
    await object.recordPage(
      1,
      claim.leaseToken,
      pageReceipt({ root: first, generation: 1, pass: 2 }),
    );
    expect(await object.complete(1, claim.leaseToken)).toEqual({
      status: 'followup',
      generation: 1,
    });
    const followup = await object.claim(first, 60_000);
    expect(followup).toMatchObject({
      status: 'claimed',
      generation: 2,
      resumed: false,
      selectedRoot: later,
    });
  });

  it('dispatches teardown snapshot roots directly and preserves their association', async () => {
    const { object } = coordinator();
    const item = repositorySetRoot(
      'installation-suspend-snapshot-direct',
      [11, 7],
    );
    const claim = await object.claim(item, 60_000);
    expect(claim).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: false,
      selectedRoot: item,
      phase: 'dispatch',
      pass: null,
      cursor: null,
    });
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');

    expect(await object.snapshot()).toMatchObject({
      phase: 'dispatch',
      selectedRootDeliveryId: item.deliveryId,
      selectedRootTargetScope: 'repository-set',
      selectedRootDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      installationState: null,
      targetSource: 'explicit',
      targetCount: 2,
    });
    const batch = await object.nextDispatchBatch(
      claim.generation,
      claim.leaseToken,
    );
    expect(batch).toMatchObject({
      status: 'batch',
      installationState: null,
      targetSource: 'explicit',
      remaining: 0,
    });
    if (batch.status !== 'batch') throw new Error('Expected a batch.');
    expect(batch.targets.map((target) => target.repositoryId))
      .toEqual([7, 11]);
  });

  it('uses a first-ever installation teardown snapshot as the durable index', async () => {
    const { object } = coordinator();
    const item = repositorySetRoot(
      'installation-suspend-complete-snapshot',
      [7, 11],
      { event: 'installation', action: 'suspend' },
    );
    const claim = await object.claim(item, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');
    expect(claim).toMatchObject({
      phase: 'dispatch',
      selectedRoot: item,
    });
    expect(await object.snapshot()).toMatchObject({
      lastKnownIndexKnown: true,
      lastKnownRepositoryCount: 2,
      targetSource: 'explicit',
      targetCount: 2,
    });
    const batch = await object.nextDispatchBatch(
      claim.generation,
      claim.leaseToken,
    );
    if (batch.status !== 'batch') throw new Error('Expected a batch.');
    expect(batch.targets.map((target) => target.repositoryId)).toEqual([7, 11]);
  });

  it('unions a delayed teardown snapshot without shrinking a newer live index', async () => {
    const { object, storage } = coordinator();
    await establishLiveIndex(
      object,
      root('installation-live-before-delayed-teardown'),
      [7, 11],
    );
    expect(lastKnownControlRevisionJson(storage)).not.toBeNull();

    const delayed = repositorySetRoot(
      'installation-delayed-suspend-snapshot',
      [11, 13],
      { event: 'installation', action: 'suspend' },
    );
    const delayedClaim = await object.claim(delayed, 60_000);
    if (delayedClaim.status !== 'claimed') {
      throw new Error('Expected a delayed snapshot claim.');
    }
    const delayedBatch = await object.nextDispatchBatch(
      delayedClaim.generation,
      delayedClaim.leaseToken,
    );
    if (delayedBatch.status !== 'batch') {
      throw new Error('Expected a delayed snapshot batch.');
    }
    expect(delayedBatch.targets.map((target) => target.repositoryId))
      .toEqual([11, 13]);
    await object.recordQueueConfirmed(
      delayedClaim.generation,
      delayedClaim.leaseToken,
      { confirmations: delayedBatch.targets },
    );
    await object.complete(
      delayedClaim.generation,
      delayedClaim.leaseToken,
    );
    expect(lastKnownRepositoryIds(storage)).toEqual([7, 11, 13]);
    expect(lastKnownControlRevisionJson(storage)).toBeNull();

    const laterMissingSnapshot = root(
      'installation-terminal-after-delayed-snapshot',
      'suspend',
    );
    const laterClaim = await object.claim(laterMissingSnapshot, 60_000);
    if (laterClaim.status !== 'claimed') {
      throw new Error('Expected a terminal installation claim.');
    }
    for (const pass of [1, 2] as const) {
      await object.recordPage(
        laterClaim.generation,
        laterClaim.leaseToken,
        pageReceipt({
          root: laterMissingSnapshot,
          generation: laterClaim.generation,
          pass,
          state: 'suspended',
        }),
      );
    }
    const laterBatch = await object.nextDispatchBatch(
      laterClaim.generation,
      laterClaim.leaseToken,
    );
    if (laterBatch.status !== 'batch') {
      throw new Error('Expected a last-known batch.');
    }
    expect(laterBatch.targets.map((target) => target.repositoryId))
      .toEqual([7, 11, 13]);
  });

  it('preserves an exact live revision for a teardown snapshot subset', async () => {
    const { object, storage } = coordinator();
    await establishLiveIndex(
      object,
      root('installation-live-before-subset-snapshot'),
      [7, 11],
    );
    const exactRevision = lastKnownControlRevisionJson(storage);

    const subset = repositorySetRoot(
      'installation-delayed-subset-snapshot',
      [11],
      { event: 'installation', action: 'deleted' },
    );
    const claim = await object.claim(subset, 60_000);
    expect(claim).toMatchObject({ status: 'claimed', phase: 'dispatch' });
    expect(lastKnownRepositoryIds(storage)).toEqual([7, 11]);
    expect(lastKnownControlRevisionJson(storage)).toBe(exactRevision);
  });

  it('refreshes the authoritative index for repository deltas before teardown', async () => {
    const { object } = coordinator();
    await establishLiveIndex(
      object,
      root('installation-root-live-before-deltas'),
      [7],
    );
    const runDelta = async (
      item: StewardRuntimeInstallationFanoutRootV1,
      liveRepositoryIds: readonly number[],
    ): Promise<void> => {
      const claim = await object.claim(item, 60_000);
      if (claim.status !== 'claimed') throw new Error('Expected a claim.');
      expect(claim).toMatchObject({ phase: 'enumerating', pass: 1 });
      for (const pass of [1, 2] as const) {
        await object.recordPage(
          claim.generation,
          claim.leaseToken,
          pageReceipt({
            root: item,
            generation: claim.generation,
            pass,
            repositoryIds: liveRepositoryIds,
          }),
        );
      }
      const batch = await object.nextDispatchBatch(
        claim.generation,
        claim.leaseToken,
      );
      if (batch.status !== 'batch') throw new Error('Expected a batch.');
      expect(batch.targets.map((target) => target.repositoryId))
        .toEqual(item.scopeWorkItem.target.scope === 'repository-set'
          ? item.scopeWorkItem.target.repositoryIds
          : []);
      await object.recordQueueConfirmed(
        claim.generation,
        claim.leaseToken,
        { confirmations: batch.targets },
      );
      expect(await object.complete(claim.generation, claim.leaseToken))
        .toMatchObject({ status: 'completed' });
    };

    const added = repositorySetRoot(
      'installation-repositories-added-after-warm',
      [11],
      { event: 'installation_repositories', action: 'added' },
    );
    await runDelta(added, [7, 11]);
    expect(await object.snapshot()).toMatchObject({
      lastKnownIndexKnown: true,
      lastKnownRepositoryCount: 2,
    });

    const removed = repositorySetRoot(
      'installation-repositories-removed-after-warm',
      [7],
      { event: 'installation_repositories', action: 'removed' },
    );
    await runDelta(removed, [11]);
    expect(await object.snapshot()).toMatchObject({
      lastKnownIndexKnown: true,
      lastKnownRepositoryCount: 1,
    });

    const suspended = root(
      'installation-suspend-after-deltas',
      'suspend',
    );
    const suspendedClaim = await object.claim(suspended, 60_000);
    if (suspendedClaim.status !== 'claimed') {
      throw new Error('Expected a claim.');
    }
    for (const pass of [1, 2] as const) {
      await object.recordPage(
        suspendedClaim.generation,
        suspendedClaim.leaseToken,
        pageReceipt({
          root: suspended,
          generation: suspendedClaim.generation,
          pass,
          state: 'suspended',
        }),
      );
    }
    const suspendedBatch = await object.nextDispatchBatch(
      suspendedClaim.generation,
      suspendedClaim.leaseToken,
    );
    if (suspendedBatch.status !== 'batch') {
      throw new Error('Expected a batch.');
    }
    expect(suspendedBatch.targets.map((target) => target.repositoryId))
      .toEqual([11]);
  });

  it('invalidates a stale index when a delta observes terminal installation state', async () => {
    const { object } = coordinator();
    await establishLiveIndex(
      object,
      root('installation-root-live-before-terminal-delta'),
      [7, 11],
    );
    const delta = repositorySetRoot(
      'installation-repositories-removed-during-suspend',
      [11],
      { event: 'installation_repositories', action: 'removed' },
    );
    const claim = await object.claim(delta, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');
    for (const pass of [1, 2] as const) {
      await object.recordPage(
        claim.generation,
        claim.leaseToken,
        pageReceipt({
          root: delta,
          generation: claim.generation,
          pass,
          state: 'suspended',
        }),
      );
    }
    expect(await object.snapshot()).toMatchObject({
      phase: 'dispatch',
      installationState: 'suspended',
      targetSource: 'explicit',
      lastKnownIndexKnown: false,
      lastKnownRepositoryCount: 0,
    });
    const batch = await object.nextDispatchBatch(
      claim.generation,
      claim.leaseToken,
    );
    if (batch.status !== 'batch') throw new Error('Expected a batch.');
    expect(batch.targets.map((target) => target.repositoryId)).toEqual([11]);
    await object.recordQueueConfirmed(
      claim.generation,
      claim.leaseToken,
      { confirmations: batch.targets },
    );
    await object.complete(claim.generation, claim.leaseToken);

    const snapshot = repositorySetRoot(
      'installation-suspend-after-terminal-delta',
      [7, 11],
      { event: 'installation', action: 'suspend' },
    );
    const snapshotClaim = await object.claim(snapshot, 60_000);
    expect(snapshotClaim).toMatchObject({ status: 'claimed', phase: 'dispatch' });
    expect(await object.snapshot()).toMatchObject({
      lastKnownIndexKnown: true,
      lastKnownRepositoryCount: 2,
    });
  });

  it('completes only the selected explicit root and retains later explicit and full roots', async () => {
    const { object } = coordinator();
    const first = repositorySetRoot('explicit-root-first', [7]);
    const second = repositorySetRoot('explicit-root-second', [11]);
    const full = root('installation-root-after-explicit');

    const firstClaim = await object.claim(first, 60_000);
    if (firstClaim.status !== 'claimed') throw new Error('Expected a claim.');
    expect(await object.claim(second, 60_000)).toMatchObject({
      status: 'coalesced',
      generation: 1,
    });
    expect(await object.claim(full, 60_000)).toMatchObject({
      status: 'coalesced',
      generation: 1,
    });
    const firstBatch = await object.nextDispatchBatch(
      firstClaim.generation,
      firstClaim.leaseToken,
    );
    if (firstBatch.status !== 'batch') throw new Error('Expected a batch.');
    await object.recordQueueConfirmed(
      firstClaim.generation,
      firstClaim.leaseToken,
      { confirmations: firstBatch.targets },
    );
    expect(
      await object.complete(
        firstClaim.generation,
        firstClaim.leaseToken,
      ),
    ).toEqual({ status: 'followup', generation: 1 });

    const secondClaim = await object.claim(first, 60_000);
    expect(secondClaim).toMatchObject({
      status: 'claimed',
      generation: 2,
      resumed: false,
      selectedRoot: second,
      phase: 'dispatch',
    });
    if (secondClaim.status !== 'claimed') throw new Error('Expected a claim.');
    const secondBatch = await object.nextDispatchBatch(
      secondClaim.generation,
      secondClaim.leaseToken,
    );
    if (secondBatch.status !== 'batch') throw new Error('Expected a batch.');
    expect(secondBatch.targets.map((target) => target.repositoryId))
      .toEqual([11]);
    await object.recordQueueConfirmed(
      secondClaim.generation,
      secondClaim.leaseToken,
      { confirmations: secondBatch.targets },
    );
    expect(
      await object.complete(
        secondClaim.generation,
        secondClaim.leaseToken,
      ),
    ).toEqual({ status: 'followup', generation: 2 });

    const fullClaim = await object.claim(first, 60_000);
    expect(fullClaim).toMatchObject({
      status: 'claimed',
      generation: 3,
      resumed: false,
      selectedRoot: full,
      phase: 'enumerating',
      pass: 1,
    });
  });

  it('uses the last-known repository index for suspended and absent roots', async () => {
    const { object } = coordinator();
    await establishLiveIndex(
      object,
      root('installation-root-live'),
      [7, 11],
    );

    for (const [index, state] of ([
      'suspended',
      'absent',
    ] as const).entries()) {
      const rootItem = root(
        `installation-root-${state}`,
        state === 'suspended' ? 'suspend' : 'deleted',
      );
      const claim = await object.claim(rootItem, 60_000);
      if (claim.status !== 'claimed') throw new Error('Expected a claim.');
      const generation = index + 2;
      expect(claim.generation).toBe(generation);
      await object.recordPage(
        generation,
        claim.leaseToken,
        pageReceipt({
          root: rootItem,
          generation,
          pass: 1,
          state,
        }),
      );
      expect(
        await object.recordPage(
          generation,
          claim.leaseToken,
          pageReceipt({
            root: rootItem,
            generation,
            pass: 2,
            state,
          }),
        ),
      ).toEqual({
        status: 'dispatch-ready',
        generation,
        installationState: state,
        targetSource: 'last-known',
        targetCount: 2,
      });
      const batch = await object.nextDispatchBatch(
        generation,
        claim.leaseToken,
      );
      if (batch.status !== 'batch') throw new Error('Expected a batch.');
      expect(batch.targets.map((target) => target.repositoryId))
        .toEqual([7, 11]);
      await object.recordQueueConfirmed(
        generation,
        claim.leaseToken,
        { confirmations: batch.targets },
      );
      await object.complete(generation, claim.leaseToken);
    }
    expect(await object.snapshot()).toMatchObject({
      lastKnownIndexKnown: true,
      lastKnownRepositoryCount: 2,
      installationState: 'absent',
      targetSource: 'last-known',
    });
  });

  it('fails closed when a suspended installation has no last-known index', async () => {
    const { object } = coordinator();
    const item = root('installation-root-unknown-index', 'suspend');
    const claim = await object.claim(item, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');
    await object.recordPage(
      1,
      claim.leaseToken,
      pageReceipt({
        root: item,
        generation: 1,
        pass: 1,
        state: 'suspended',
      }),
    );
    expect(
      await object.recordPage(
        1,
        claim.leaseToken,
        pageReceipt({
          root: item,
          generation: 1,
          pass: 2,
          state: 'suspended',
        }),
      ),
    ).toEqual({
      status: 'failed-closed',
      generation: 1,
      reason: 'last-known-index-unavailable',
    });
    expect(await object.snapshot()).toMatchObject({
      phase: 'followup',
      dirty: true,
      failureCode: 'last-known-index-unavailable',
      targetCount: 0,
      lastKnownIndexKnown: false,
    });
    expect(await object.claim(item, 60_000)).toMatchObject({
      status: 'claimed',
      generation: 2,
      resumed: false,
    });
  });

  it('fails closed instead of dispatching when the two live sets drift', async () => {
    const { object } = coordinator();
    const item = root('installation-root-drift');
    const claim = await object.claim(item, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');
    await object.recordPage(
      1,
      claim.leaseToken,
      pageReceipt({
        root: item,
        generation: 1,
        pass: 1,
        repositoryIds: [7],
      }),
    );
    expect(
      await object.recordPage(
        1,
        claim.leaseToken,
        pageReceipt({
          root: item,
          generation: 1,
          pass: 2,
          repositoryIds: [11],
        }),
      ),
    ).toEqual({
      status: 'failed-closed',
      generation: 1,
      reason: 'pagination-drift',
    });
    expect(await object.snapshot()).toMatchObject({
      phase: 'followup',
      dirty: true,
      targetCount: 0,
      lastKnownIndexKnown: false,
      failureCode: 'pagination-drift',
    });
  });
});

function bootstrapEnvelope(
  requestId = '11111111-2222-4333-8444-555555555555',
  expectedRevision = controlRevision,
): StewardRuntimeInstallationIndexBootstrapEnvelopeV1 {
  return buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
    command: {
      schemaVersion: 1,
      operation: 'installation-index-bootstrap',
      requestId,
      requestedAt: '2026-07-28T04:01:00.000Z',
      installationId,
      expectedControlRevision: expectedRevision,
    },
    accessServiceClientId: 'bootstrap-service-client',
  });
}

async function bootstrapReceipt(input: {
  readonly command: StewardRuntimeInstallationIndexBootstrapEnvelopeV1;
  readonly pass: 1 | 2;
  readonly cursor?: string | null;
  readonly state?: StewardRuntimeInstallationFanoutStateV1;
  readonly repositoryIds?: readonly number[];
  readonly totalCount?: number;
  readonly endCursor?: string | null;
}) {
  const request =
    await buildStewardRuntimeInstallationIndexBootstrapPageRequestV1({
      command: input.command,
      pass: input.pass,
      cursor: input.cursor ?? null,
    });
  const repositoryIds = input.repositoryIds ?? [];
  const endCursor = input.endCursor ?? null;
  return await buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1({
    binding: request.binding,
    installation: {
      state: input.state ?? 'live',
      id: installationId,
    },
    page: {
      totalCount: input.totalCount ?? repositoryIds.length,
      repositoryIds,
      hasNextPage: endCursor !== null,
      endCursor,
    },
    controlRevision,
  });
}

describe('installation index bootstrap coordinator contract', () => {
  it('atomically establishes a brand-new index after stable passes with zero children', async () => {
    const current = coordinator();
    const command = bootstrapEnvelope();
    const digest =
      await deriveStewardRuntimeInstallationIndexBootstrapDigest(command);
    const first = await current.object.claimIndexBootstrap(command, 60_000);
    expect(first).toMatchObject({
      status: 'claimed',
      phase: 'enumerating',
      pass: 1,
      cursor: null,
    });
    if (first.status !== 'claimed') throw new Error('Expected bootstrap claim.');

    expect(await current.object.claim(root('blocked-by-bootstrap'), 60_000))
      .toMatchObject({ status: 'busy' });
    expect(await current.object.recordIndexBootstrapPage(
      first.leaseToken,
      await bootstrapReceipt({
        command,
        pass: 1,
        repositoryIds: [101, 202],
      }),
    )).toEqual({ status: 'pass-complete', nextPass: 2 });
    expect(await current.object.releaseIndexBootstrap(first.leaseToken))
      .toEqual({ status: 'released' });

    const second = await current.object.claimIndexBootstrap(command, 60_000);
    if (second.status !== 'claimed') {
      throw new Error('Expected second bootstrap pass.');
    }
    expect(second).toMatchObject({ pass: 2, resumed: true });
    expect(await current.object.recordIndexBootstrapPage(
      second.leaseToken,
      await bootstrapReceipt({
        command,
        pass: 2,
        repositoryIds: [101, 202],
      }),
    )).toEqual({ status: 'accepted', pass: 2, hasNextPage: false });
    expect(await current.object.releaseIndexBootstrap(second.leaseToken))
      .toEqual({ status: 'released' });

    const evicted = new InstallationFanoutCoordinator({
      id: { name: installationFanoutCoordinatorName(installationId) },
      storage: current.storage,
    }, {});
    const finalClaim = await evicted.claimIndexBootstrap(command, 60_000);
    expect(finalClaim).toMatchObject({
      status: 'claimed',
      phase: 'finalizing',
      pass: null,
    });
    if (finalClaim.status !== 'claimed') {
      throw new Error('Expected finalization claim.');
    }
    const finalized = await evicted.finalizeIndexBootstrap(
      finalClaim.leaseToken,
    );
    expect(finalized).toMatchObject({
      status: 'completed',
      receipt: {
        status: 'completed',
        lastKnownIndexKnown: true,
        repositoryCount: 2,
        commandDigest: digest,
        controlRevision,
      },
    });
    expect(current.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM installation_fanout_targets',
    ).one().count).toBe(0);
    expect(await evicted.inspectIndexBootstrap(
      command.requestId,
      digest,
      command.principal.accessServiceClientId,
    )).toMatchObject({
      status: 'completed',
      repositoryCount: 2,
    });
    await expect(evicted.inspectIndexBootstrap(
      command.requestId,
      digest,
      'different-service-client',
    )).rejects.toThrow(/conflicts/i);
    expect(await evicted.claimIndexBootstrap(command, 60_000))
      .toMatchObject({ status: 'duplicate' });
    expect(await evicted.claim(root('fanout-after-bootstrap'), 60_000))
      .toMatchObject({ status: 'claimed' });
  });

  it.each(['suspended', 'absent'] as const)(
    'fails terminally when Control reports the installation %s',
    async (state) => {
      const { object } = coordinator();
      const command = bootstrapEnvelope(
        state === 'suspended'
          ? '22222222-3333-4444-8555-666666666666'
          : '33333333-4444-4555-8666-777777777777',
      );
      const claim = await object.claimIndexBootstrap(command, 60_000);
      if (claim.status !== 'claimed') throw new Error('Expected a claim.');
      expect(await object.recordIndexBootstrapPage(
        claim.leaseToken,
        await bootstrapReceipt({ command, pass: 1, state }),
      )).toMatchObject({
        status: 'failed',
        receipt: {
          status: 'failed',
          failureCode: state === 'suspended'
            ? 'installation-suspended'
            : 'installation-absent',
        },
      });
    },
  );

  it('fails closed on pass drift and conflicting reuse of a request ID', async () => {
    const { object } = coordinator();
    const command = bootstrapEnvelope(
      '44444444-5555-4666-8777-888888888888',
    );
    const first = await object.claimIndexBootstrap(command, 60_000);
    if (first.status !== 'claimed') throw new Error('Expected a claim.');
    await object.recordIndexBootstrapPage(
      first.leaseToken,
      await bootstrapReceipt({
        command,
        pass: 1,
        repositoryIds: [10],
      }),
    );
    await object.releaseIndexBootstrap(first.leaseToken);
    const second = await object.claimIndexBootstrap(command, 60_000);
    if (second.status !== 'claimed') throw new Error('Expected second pass.');
    expect(await object.recordIndexBootstrapPage(
      second.leaseToken,
      await bootstrapReceipt({
        command,
        pass: 2,
        repositoryIds: [11],
      }),
    )).toMatchObject({
      status: 'failed',
      receipt: {
        status: 'failed',
        failureCode: 'pagination-drift',
      },
    });

    const altered = bootstrapEnvelope(command.requestId, {
      ...controlRevision,
      stewardCommit: 'b'.repeat(40),
      workerVersionTag: `steward-${'b'.repeat(40)}`,
    });
    expect(await object.claimIndexBootstrap(altered, 60_000))
      .toEqual({ status: 'conflict' });
  });
});
