import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStewardRuntimeRepositoryFanoutPageReceiptV1,
  type StewardRuntimeRepositoryFanoutPageReceiptV1,
} from '../packages/core/src/runtime-repository-fanout.js';
import {
  buildStewardRuntimeScopeWorkItemV1,
  type StewardRuntimeScopeWorkItemV1,
} from '../packages/core/src/runtime-scope-work-item.js';
import {
  parseRepositoryFanoutCoordinatorName,
  repositoryFanoutCoordinatorName,
  type RepositoryFanoutClaimResult,
  type RepositoryFanoutCompleteResult,
  type RepositoryFanoutFailResult,
  type RepositoryFanoutNextDispatchBatchResult,
  type RepositoryFanoutRecordPageResult,
  type RepositoryFanoutRecordQueueConfirmedResult,
  type RepositoryFanoutReleaseForContinuationResult,
  type RepositoryFanoutSnapshot,
} from '../packages/coordinator/src/repository-fanout-contracts.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

interface TestCoordinatorApi {
  claim(
    scopeItem: unknown,
    leaseDurationMs: number,
  ): Promise<RepositoryFanoutClaimResult>;
  recordPage(
    generation: number,
    leaseToken: string,
    receipt: unknown,
  ): Promise<RepositoryFanoutRecordPageResult>;
  nextDispatchBatch(
    generation: number,
    leaseToken: string,
    limit?: number,
  ): Promise<RepositoryFanoutNextDispatchBatchResult>;
  recordQueueConfirmed(
    generation: number,
    leaseToken: string,
    confirmations: unknown,
  ): Promise<RepositoryFanoutRecordQueueConfirmedResult>;
  complete(
    generation: number,
    leaseToken: string,
  ): Promise<RepositoryFanoutCompleteResult>;
  fail(
    generation: number,
    leaseToken: string,
    failureCode: 'runtime-error',
  ): Promise<RepositoryFanoutFailResult>;
  releaseForContinuation(
    generation: number,
    leaseToken: string,
  ): Promise<RepositoryFanoutReleaseForContinuationResult>;
  alarm(): Promise<void>;
  snapshot(): Promise<RepositoryFanoutSnapshot>;
}

interface TestCoordinatorConstructor {
  new(ctx: unknown, env: unknown): TestCoordinatorApi;
}

const coordinatorModulePath =
  '../packages/coordinator/src/repository-fanout-coordinator.js';
const { RepositoryFanoutCoordinator } = await import(
  coordinatorModulePath
) as unknown as {
  RepositoryFanoutCoordinator: TestCoordinatorConstructor;
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
          throw new Error(`Expected exactly one SQLite row, received ${rows.length}.`);
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

const repositoryId = 86_420;
const controlRevision = {
  stewardCommit: 'a'.repeat(40),
  workerVersionId: '11111111-2222-4333-8444-555555555555',
  workerVersionTag: `steward-${'a'.repeat(40)}`,
  workerVersionCreatedAt: '2026-07-23T16:00:00.000Z',
};

function scopeItem(
  deliveryId: string,
  action: 'edited' | 'renamed' = 'edited',
): StewardRuntimeScopeWorkItemV1 {
  return buildStewardRuntimeScopeWorkItemV1({
    operation: 'scope-reconcile',
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId: 145_952_003,
      repositoryId,
      pullRequests: 'all-open',
    },
    cause: {
      kind: 'github-webhook',
      deliveryId,
      event: 'repository',
      action,
      receivedAt: '2026-07-27T04:00:00.000Z',
    },
  });
}

function pageReceipt(input: {
  readonly scopeItem: StewardRuntimeScopeWorkItemV1;
  readonly generation: number;
  readonly pass: 1 | 2;
  readonly cursor?: string | null;
  readonly pullRequestNumbers: readonly number[];
  readonly totalCount?: number;
  readonly endCursor?: string | null;
}): StewardRuntimeRepositoryFanoutPageReceiptV1 {
  const endCursor = input.endCursor ?? null;
  return buildStewardRuntimeRepositoryFanoutPageReceiptV1({
    binding: {
      scopeWorkItem: input.scopeItem,
      generation: input.generation,
      pass: input.pass,
      cursor: input.cursor ?? null,
    },
    repository: {
      state: 'live',
      id: repositoryId,
      fullName: 'splrad/LayerScape',
    },
    page: {
      totalCount: input.totalCount ?? input.pullRequestNumbers.length,
      pullRequestNumbers: input.pullRequestNumbers,
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
    id: { name: repositoryFanoutCoordinatorName(repositoryId) },
    storage,
  };
  return {
    object: new RepositoryFanoutCoordinator(ctx, {}),
    storage,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-27T04:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('repository fan-out coordinator contract', () => {
  it('uses one canonical numeric repository-scoped Durable Object name', () => {
    expect(repositoryFanoutCoordinatorName(repositoryId))
      .toBe('steward-repository-fanout-v1:86420');
    expect(
      parseRepositoryFanoutCoordinatorName(
        'steward-repository-fanout-v1:86420',
      ),
    ).toEqual({ repositoryId: '86420' });
    expect(() =>
      parseRepositoryFanoutCoordinatorName(
        'steward-repository-fanout-v1:086420',
      )).toThrow(/canonical positive safe-integer/);
    expect(() =>
      parseRepositoryFanoutCoordinatorName(
        'steward-pr-v1:86420:1',
      )).toThrow(/steward-repository-fanout-v1/);
  });

  it('requires two identical complete passes before dispatch and recovers every response loss idempotently', async () => {
    const { object } = coordinator();
    const item = scopeItem('repository-delivery-two-pass');
    let claim = await object.claim(item, 60_000);
    expect(claim).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: false,
      selectedScopeItem: item,
      phase: 'enumerating',
      pass: 1,
      cursor: null,
    });
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');

    const passOnePageOne = pageReceipt({
      scopeItem: item,
      generation: 1,
      pass: 1,
      pullRequestNumbers: [7],
      totalCount: 2,
      endCursor: 'cursor-pass-one',
    });
    expect(
      await object.recordPage(1, claim.leaseToken, passOnePageOne),
    ).toEqual({
      status: 'accepted',
      generation: 1,
      pass: 1,
      hasNextPage: true,
    });
    expect(
      await object.recordPage(1, claim.leaseToken, passOnePageOne),
    ).toEqual({
      status: 'duplicate',
      generation: 1,
      pass: 1,
      hasNextPage: true,
    });
    expect(
      await object.releaseForContinuation(1, claim.leaseToken),
    ).toEqual({
      status: 'released',
      generation: 1,
    });
    claim = await object.claim(item, 60_000);
    expect(claim).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: true,
      phase: 'enumerating',
      pass: 1,
      cursor: 'cursor-pass-one',
    });
    if (claim.status !== 'claimed') throw new Error('Expected a resumed claim.');

    const passOnePageTwo = pageReceipt({
      scopeItem: item,
      generation: 1,
      pass: 1,
      cursor: 'cursor-pass-one',
      pullRequestNumbers: [11],
      totalCount: 2,
    });
    expect(await object.recordPage(1, claim.leaseToken, passOnePageTwo)).toEqual({
      status: 'pass-complete',
      generation: 1,
      nextPass: 2,
    });
    expect(await object.recordPage(1, claim.leaseToken, passOnePageTwo)).toEqual({
      status: 'duplicate',
      generation: 1,
      pass: 1,
      hasNextPage: false,
    });

    const passTwo = pageReceipt({
      scopeItem: item,
      generation: 1,
      pass: 2,
      pullRequestNumbers: [11, 7],
    });
    expect(await object.recordPage(1, claim.leaseToken, passTwo)).toEqual({
      status: 'dispatch-ready',
      generation: 1,
      targetCount: 2,
    });
    expect(await object.recordPage(1, claim.leaseToken, passTwo)).toEqual({
      status: 'duplicate',
      generation: 1,
      pass: 2,
      hasNextPage: false,
    });

    const batch = await object.nextDispatchBatch(1, claim.leaseToken);
    expect(batch).toMatchObject({
      status: 'batch',
      generation: 1,
      repositoryFullName: 'splrad/LayerScape',
      remaining: 0,
    });
    if (batch.status !== 'batch') throw new Error('Expected a dispatch batch.');
    expect(batch.targets.map((target) => target.pullRequestNumber))
      .toEqual([7, 11]);
    expect(new Set(batch.targets.map((target) => target.deliveryId)).size)
      .toBe(2);

    const firstConfirmation = {
      confirmations: [batch.targets[0]],
    };
    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        firstConfirmation,
      ),
    ).toMatchObject({
      status: 'recorded',
      newlyConfirmed: 1,
      remaining: 1,
    });
    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        firstConfirmation,
      ),
    ).toMatchObject({
      status: 'recorded',
      newlyConfirmed: 0,
      remaining: 1,
    });
    expect(await object.complete(1, claim.leaseToken))
      .toEqual({ status: 'not-ready' });

    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        { confirmations: [batch.targets[1]] },
      ),
    ).toMatchObject({
      status: 'recorded',
      newlyConfirmed: 1,
      remaining: 0,
    });
    expect(await object.complete(1, claim.leaseToken)).toEqual({
      status: 'completed',
      generation: 1,
    });
    expect(await object.claim(item, 60_000)).toEqual({
      status: 'duplicate',
    });
    expect(await object.snapshot()).toMatchObject({
      schemaVersion: 1,
      repositoryId: String(repositoryId),
      phase: 'idle',
      targetCount: 2,
      confirmedTargetCount: 2,
      pendingDeliveryCount: 0,
      completedDeliveryCount: 1,
    });
  });

  it('persists a different delivery as dirty and resumes the same generation after lease loss', async () => {
    const { object } = coordinator();
    const root = scopeItem('repository-delivery-root');
    const later = scopeItem('repository-delivery-later', 'renamed');
    const firstClaim = await object.claim(root, 1_000);
    if (firstClaim.status !== 'claimed') throw new Error('Expected a claim.');

    expect(await object.claim(later, 1_000)).toMatchObject({
      status: 'coalesced',
      generation: 1,
    });
    expect(
      await object.releaseForContinuation(1, firstClaim.leaseToken),
    ).toEqual({
      status: 'released',
      generation: 1,
    });
    const continuation = await object.claim(root, 1_000);
    expect(continuation).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: true,
      phase: 'enumerating',
      pass: 1,
      cursor: null,
    });
    if (continuation.status !== 'claimed') {
      throw new Error('Expected a continuation claim.');
    }
    vi.advanceTimersByTime(1_001);
    await object.alarm();

    const resumed = await object.claim(root, 1_000);
    expect(resumed).toMatchObject({
      status: 'claimed',
      generation: 1,
      resumed: true,
      selectedScopeItem: root,
    });
    if (resumed.status !== 'claimed') throw new Error('Expected a resume.');
    expect(await object.snapshot()).toMatchObject({
      generation: 1,
      phase: 'enumerating',
      dirty: true,
      pendingDeliveryCount: 2,
      failureCode: null,
    });

    const emptyPassOne = pageReceipt({
      scopeItem: root,
      generation: 1,
      pass: 1,
      pullRequestNumbers: [],
    });
    const emptyPassTwo = pageReceipt({
      scopeItem: root,
      generation: 1,
      pass: 2,
      pullRequestNumbers: [],
    });
    await object.recordPage(1, resumed.leaseToken, emptyPassOne);
    await object.recordPage(1, resumed.leaseToken, emptyPassTwo);
    expect(await object.complete(1, resumed.leaseToken)).toEqual({
      status: 'followup',
      generation: 1,
    });

    const next = await object.claim(root, 1_000);
    expect(next).toMatchObject({
      status: 'claimed',
      generation: 2,
      resumed: false,
      selectedScopeItem: later,
    });
  });

  it('bounds pagination drift restarts and leaves the delivery recoverable in a fresh generation', async () => {
    const { object } = coordinator();
    const item = scopeItem('repository-delivery-drift');
    const claim = await object.claim(item, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await object.recordPage(
          1,
          claim.leaseToken,
          pageReceipt({
            scopeItem: item,
            generation: 1,
            pass: 1,
            pullRequestNumbers: [attempt * 2 + 1],
          }),
        ),
      ).toMatchObject({ status: 'pass-complete' });
      const result = await object.recordPage(
        1,
        claim.leaseToken,
        pageReceipt({
          scopeItem: item,
          generation: 1,
          pass: 2,
          pullRequestNumbers: [attempt * 2 + 2],
        }),
      );
      expect(result).toMatchObject(
        attempt < 2
          ? {
              status: 'restarted',
              generation: 1,
              restartCount: attempt + 1,
              reason: 'pagination-drift',
            }
          : {
              status: 'drift-limit',
              generation: 1,
              reason: 'pagination-drift',
            },
      );
    }

    expect(await object.snapshot()).toMatchObject({
      phase: 'followup',
      dirty: true,
      generation: 1,
      targetCount: 0,
      failureCode: 'pagination-drift',
    });
    const recovery = await object.claim(item, 60_000);
    expect(recovery).toMatchObject({
      status: 'claimed',
      generation: 2,
      resumed: false,
    });
  });

  it('rejects a mixed confirmation receipt atomically', async () => {
    const { object } = coordinator();
    const item = scopeItem('repository-delivery-confirmation-conflict');
    const claim = await object.claim(item, 60_000);
    if (claim.status !== 'claimed') throw new Error('Expected a claim.');
    await object.recordPage(
      1,
      claim.leaseToken,
      pageReceipt({
        scopeItem: item,
        generation: 1,
        pass: 1,
        pullRequestNumbers: [3, 4],
      }),
    );
    await object.recordPage(
      1,
      claim.leaseToken,
      pageReceipt({
        scopeItem: item,
        generation: 1,
        pass: 2,
        pullRequestNumbers: [3, 4],
      }),
    );
    const batch = await object.nextDispatchBatch(1, claim.leaseToken);
    if (batch.status !== 'batch') throw new Error('Expected a dispatch batch.');

    expect(
      await object.recordQueueConfirmed(
        1,
        claim.leaseToken,
        {
          confirmations: [
            batch.targets[0],
            {
              pullRequestNumber: batch.targets[1]?.pullRequestNumber,
              deliveryId: 'fanout-v1:wrong',
            },
          ],
        },
      ),
    ).toEqual({ status: 'conflict' });
    expect(await object.snapshot()).toMatchObject({
      targetCount: 2,
      confirmedTargetCount: 0,
    });
  });
});
