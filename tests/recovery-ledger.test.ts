import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliveryRecoveryLedgerSchemaVersion,
  maximumGitHubDeliveryStatusLength,
  maximumGitHubProviderCoverageWindowMs,
  maximumGitHubUnresolvedRedeliveryInspectionEntries,
  parseGitHubDeliveryScanPageInput,
} from '../packages/recovery/src/ledger-contracts.js';
import type {
  DeliveryRecoveryCaptureInput,
  DeliveryRecoveryCaptureResult,
  DeliveryRecoveryInspection,
  DeliveryRecoveryNextReplayResult,
  DeliveryRecoveryReplayAuthorizationResult,
  DeliveryRecoveryReplayOutcomeResult,
  GitHubDeliveryScanBeginResult,
  GitHubDeliveryScanCompletionResult,
  GitHubDeliveryScanInspection,
  GitHubDeliveryScanPageResult,
  GitHubNextRedeliveryResult,
  GitHubRedeliveryOutcomeResult,
  GitHubUnresolvedRedeliveryState,
} from '../packages/recovery/src/ledger-contracts.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

interface TestLedgerApi {
  captureDlq(value: unknown): Promise<DeliveryRecoveryCaptureResult>;
  inspect(limit?: number): Promise<DeliveryRecoveryInspection>;
  authorizeReplay(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayAuthorizationResult>;
  nextReplay(value: unknown): Promise<DeliveryRecoveryNextReplayResult>;
  recordReplayEnqueued(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayOutcomeResult>;
  recordReplayUnknown(
    value: unknown,
  ): Promise<DeliveryRecoveryReplayOutcomeResult>;
  beginGitHubScan(value: unknown): Promise<GitHubDeliveryScanBeginResult>;
  recordGitHubScanPage(
    value: unknown,
  ): Promise<GitHubDeliveryScanPageResult>;
  completeGitHubScan(
    value: unknown,
  ): Promise<GitHubDeliveryScanCompletionResult>;
  nextGitHubRedelivery(
    value: unknown,
  ): Promise<GitHubNextRedeliveryResult>;
  recordGitHubRedeliveryAccepted(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  recordGitHubRedeliveryUnknown(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  recordGitHubRedeliveryDeferred(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  recordGitHubRedeliveryRejected(
    value: unknown,
  ): Promise<GitHubRedeliveryOutcomeResult>;
  inspectGitHubScan(): Promise<GitHubDeliveryScanInspection>;
}

interface TestLedgerConstructor {
  new(ctx: unknown, env: unknown): TestLedgerApi;
}

const ledgerModulePath = '../packages/recovery/src/ledger.js';
const { DeliveryRecoveryLedger } = await import(
  ledgerModulePath
) as unknown as {
  DeliveryRecoveryLedger: TestLedgerConstructor;
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
  #failNextCommit = false;

  failNextCommit(): void {
    this.#failNextCommit = true;
  }

  transactionSync<T>(closure: () => T): T {
    this.sql.database.exec('BEGIN IMMEDIATE');
    try {
      const result = closure();
      if (this.#failNextCommit) {
        this.#failNextCommit = false;
        throw new Error('simulated durable commit failure');
      }
      this.sql.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const timestamp = (minute: number): string =>
  `2026-07-27T12:${String(minute).padStart(2, '0')}:00.000Z`;

const commandIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000009',
] as const;
const scanIds = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000006',
] as const;
const failedGuid = '30000000-0000-4000-8000-000000000001';
const successfulGuid = '30000000-0000-4000-8000-000000000002';
const principal = {
  accessServiceClientId: 'access-service-client.example.access',
};

let ledger: TestLedgerApi;
let storage: TestDurableStorage;

beforeEach(() => {
  storage = new TestDurableStorage();
  ledger = new DeliveryRecoveryLedger(
    {
      id: { name: 'global-v1' },
      storage,
    },
    {},
  );
});

describe('DeliveryRecoveryLedger DLQ replay', () => {
  it('fails closed for unsupported or incomplete persisted schemas', () => {
    const unsupported = new TestDurableStorage();
    unsupported.sql.exec(`
      CREATE TABLE delivery_recovery_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      )
    `);
    unsupported.sql.exec(
      `INSERT INTO delivery_recovery_schema (singleton, version)
       VALUES (1, 99)`,
    );
    expect(() => new DeliveryRecoveryLedger(
      {
        id: { name: 'global-v1' },
        storage: unsupported,
      },
      {},
    )).toThrow('Unsupported delivery recovery schema version 99');

    const incomplete = new TestDurableStorage();
    incomplete.sql.exec(`
      CREATE TABLE delivery_recovery_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      )
    `);
    incomplete.sql.exec(
      `INSERT INTO delivery_recovery_schema (singleton, version)
       VALUES (1, ?)`,
      deliveryRecoveryLedgerSchemaVersion,
    );
    expect(() => new DeliveryRecoveryLedger(
      {
        id: { name: 'global-v1' },
        storage: incomplete,
      },
      {},
    )).toThrow('Delivery recovery entries table');
  });

  it('persists intent before replay and stops a third returned cycle', async () => {
    const body = '{"canonical":"secret-body-not-for-inspection"}';
    const entryId = await sha256(body);
    const first = await ledger.captureDlq(
      capture(entryId, body, 'dlq-message-1', timestamp(0)),
    );
    expect(first).toMatchObject({
      status: 'captured',
      state: 'pending',
      cycleCount: 0,
      replayCount: 0,
    });

    const duplicate = await ledger.captureDlq(
      capture(entryId, body, 'dlq-message-1', timestamp(1), 2),
    );
    expect(duplicate).toMatchObject({
      status: 'duplicate',
      state: 'pending',
      cycleCount: 0,
    });

    for (let replay = 0; replay < 3; replay += 1) {
      const inspection = await ledger.inspect();
      const commandId = commandIds[replay];
      if (commandId === undefined) throw new Error('Missing command fixture.');
      const authorized = await ledger.authorizeReplay({
        commandId,
        principal,
        requestedAt: timestamp(2 + replay * 3),
        entryIds: [entryId],
        expectedLedgerRevision: inspection.ledgerRevision,
      });
      expect(authorized.status).toBe('authorized');

      const ready = await ledger.nextReplay(commandId);
      expect(ready).toMatchObject({
        status: 'ready',
        commandId,
        entryId,
        body,
        replayCount: replay + 1,
      });
      expect(await ledger.nextReplay(commandId)).toEqual(ready);
      const enqueued = await ledger.recordReplayEnqueued({
        commandId,
        entryId,
        recordedAt: timestamp(3 + replay * 3),
      });
      expect(enqueued).toMatchObject({
        status: 'recorded',
        state: 'enqueued',
      });

      const returned = await ledger.captureDlq(
        capture(
          entryId,
          body,
          `dlq-message-${replay + 2}`,
          timestamp(4 + replay * 3),
        ),
      );
      expect(returned.state).toBe(
        replay === 2 ? 'action-required' : 'pending',
      );
      expect(returned.cycleCount).toBe(replay + 1);
    }

    const finalInspection = await ledger.inspect();
    expect(finalInspection.counts).toEqual({
      pending: 0,
      enqueued: 0,
      unknown: 0,
      actionRequired: 1,
      quarantined: 0,
    });
    expect(finalInspection.entries[0]).not.toHaveProperty('body');
    expect(JSON.stringify(finalInspection)).not.toContain(body);
  });

  it('rejects a digest that is not bound to the exact UTF-8 body', async () => {
    const body = '{"canonical":true}';
    await expect(ledger.captureDlq({
      ...capture('0'.repeat(64), body, 'message', timestamp(0)),
      bodyDigest: '0'.repeat(64),
    })).rejects.toThrow('must equal SHA-256');
  });

  it('keeps an unknown command unresolved until a new CAS command', async () => {
    const body = '{"canonical":"unknown-send"}';
    const entryId = await sha256(body);
    await ledger.captureDlq(
      capture(entryId, body, 'unknown-source', timestamp(0)),
    );
    const firstRevision = (await ledger.inspect()).ledgerRevision;
    await ledger.authorizeReplay({
      commandId: commandIds[0],
      principal,
      requestedAt: timestamp(1),
      entryIds: [entryId],
      expectedLedgerRevision: firstRevision,
    });
    await ledger.nextReplay(commandIds[0]);
    await ledger.recordReplayUnknown({
      commandId: commandIds[0],
      entryId,
      recordedAt: timestamp(2),
    });
    expect(await ledger.nextReplay(commandIds[0])).toMatchObject({
      status: 'unresolved',
      entries: [{
        entryId,
        state: 'unknown',
        replayCount: 1,
      }],
    });

    const secondRevision = (await ledger.inspect()).ledgerRevision;
    expect(await ledger.authorizeReplay({
      commandId: commandIds[1],
      principal,
      requestedAt: timestamp(3),
      entryIds: [entryId],
      expectedLedgerRevision: secondRevision,
    })).toMatchObject({ status: 'authorized' });
    expect(await ledger.nextReplay(commandIds[1])).toMatchObject({
      status: 'ready',
      replayCount: 2,
    });
  });
});

describe('DeliveryRecoveryLedger GitHub scan', () => {
  it('accepts the full printable provider status contract', () => {
    const status = `failed ${'x'.repeat(
      maximumGitHubDeliveryStatusLength - 'failed '.length,
    )}`;
    expect(parseGitHubDeliveryScanPageInput({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: null,
      attempts: [{
        attemptId: 1,
        guid: failedGuid,
        deliveredAt: timestamp(0),
        status,
        redelivery: false,
      }],
      recordedAt: timestamp(1),
      leaseExpiresAt: timestamp(9),
    }).attempts[0]?.status).toBe(status);
  });

  it('selects only the newest wholly failed GUID and reconciles it later', async () => {
    const initial = await ledger.inspect();
    const begun = await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(9),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: initial.ledgerRevision,
    });
    expect(begun).toMatchObject({ status: 'begun', generation: 1 });
    const afterLostResponse = await ledger.inspect();
    expect(await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(1),
      scanStartedAt: timestamp(1),
      leaseExpiresAt: timestamp(10),
      coverageMode: 'establish',
      providerWindowStart: timestamp(1),
      takeover: false,
      expectedLedgerRevision: afterLostResponse.ledgerRevision,
    })).toMatchObject({
      status: 'resumed',
      generation: 1,
      scanId: scanIds[0],
    });

    await ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: null,
      attempts: [
        attempt(13, successfulGuid, timestamp(2), 'OK', true),
        attempt(
          11,
          failedGuid,
          timestamp(2),
          'failed to connect to host',
          true,
        ),
        attempt(12, successfulGuid, timestamp(1), 'Failure'),
        attempt(10, failedGuid, timestamp(1), 'Failure'),
      ],
      recordedAt: timestamp(3),
      leaseExpiresAt: timestamp(9),
    });
    await ledger.completeGitHubScan({
      generation: 1,
      scanId: scanIds[0],
      completedAt: timestamp(4),
    });

    const ready = await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(5),
    });
    expect(ready).toMatchObject({
      status: 'ready',
      guid: failedGuid,
      deliveryAttemptId: 11,
      redeliveryCount: 1,
    });
    if (ready.status !== 'ready') throw new Error('Expected redelivery.');
    await ledger.recordGitHubRedeliveryAccepted({
      generation: 1,
      scanId: scanIds[0],
      intentId: ready.intentId,
      recordedAt: timestamp(6),
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(7),
    })).toMatchObject({
      status: 'unresolved',
      counts: { accepted: 1, total: 1 },
    });

    const revision = (await ledger.inspect()).ledgerRevision;
    await ledger.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal,
      requestedAt: timestamp(8),
      scanStartedAt: timestamp(8),
      leaseExpiresAt: timestamp(17),
      coverageMode: 'continue',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: revision,
    });
    await ledger.recordGitHubScanPage({
      generation: 2,
      scanId: scanIds[1],
      cursor: null,
      nextCursor: null,
      attempts: [
        attempt(14, failedGuid, timestamp(7), 'OK', true),
      ],
      recordedAt: timestamp(9),
      leaseExpiresAt: timestamp(17),
    });
    await ledger.completeGitHubScan({
      generation: 2,
      scanId: scanIds[1],
      completedAt: timestamp(10),
    });
    expect(await ledger.inspectGitHubScan()).toMatchObject({
      generation: 2,
      checkpoint: timestamp(8),
      active: null,
      unresolvedRedeliveryIntents: 0,
    });
  });

  it('fences a possible send before I/O even if outcome persistence fails', async () => {
    const storage = new TestDurableStorage();
    const isolated = new DeliveryRecoveryLedger(
      { id: { name: 'global-v1' }, storage },
      {},
    );
    await isolated.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(9),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await isolated.inspect()).ledgerRevision,
    });
    await isolated.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: null,
      attempts: [attempt(10, failedGuid, timestamp(1), 'Failure')],
      recordedAt: timestamp(2),
      leaseExpiresAt: timestamp(9),
    });
    await isolated.completeGitHubScan({
      generation: 1,
      scanId: scanIds[0],
      completedAt: timestamp(3),
    });
    const ready = await isolated.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(4),
    });
    if (ready.status !== 'ready') throw new Error('Expected redelivery.');

    // Model: GitHub returned 202, but committing its accepted outcome failed.
    storage.failNextCommit();
    await expect(isolated.recordGitHubRedeliveryAccepted({
      generation: 1,
      scanId: scanIds[0],
      intentId: ready.intentId,
      recordedAt: timestamp(5),
    })).rejects.toThrow('simulated durable commit failure');

    expect(await isolated.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(6),
    })).toMatchObject({
      status: 'unresolved',
      counts: { dispatching: 1, total: 1 },
    });
  });

  it('surfaces only scan-related historical possible sends until a newer attempt reconciles them', async () => {
    for (const state of ['dispatching', 'unknown'] as const) {
      const isolatedStorage = new TestDurableStorage();
      const isolated = new DeliveryRecoveryLedger(
        { id: { name: 'global-v1' }, storage: isolatedStorage },
        {},
      );
      await isolated.beginGitHubScan({
        commandId: commandIds[0],
        scanId: scanIds[0],
        principal,
        requestedAt: timestamp(0),
        scanStartedAt: timestamp(0),
        leaseExpiresAt: timestamp(9),
        coverageMode: 'establish',
        providerWindowStart: timestamp(0),
        takeover: false,
        expectedLedgerRevision: (await isolated.inspect()).ledgerRevision,
      });
      await isolated.recordGitHubScanPage({
        generation: 1,
        scanId: scanIds[0],
        cursor: null,
        nextCursor: null,
        attempts: [
          attempt(11, successfulGuid, timestamp(2), 'Failure'),
          attempt(10, failedGuid, timestamp(1), 'Failure'),
        ],
        recordedAt: timestamp(3),
        leaseExpiresAt: timestamp(9),
      });
      await isolated.completeGitHubScan({
        generation: 1,
        scanId: scanIds[0],
        completedAt: timestamp(4),
      });
      const related = await isolated.nextGitHubRedelivery({
        generation: 1,
        scanId: scanIds[0],
        preparedAt: timestamp(4),
      });
      if (related.status !== 'ready') {
        throw new Error('Expected related redelivery.');
      }
      expect(related.guid).toBe(failedGuid);
      if (state === 'unknown') {
        await isolated.recordGitHubRedeliveryUnknown({
          generation: 1,
          scanId: scanIds[0],
          intentId: related.intentId,
          recordedAt: timestamp(4),
        });
      }
      const unrelated = await isolated.nextGitHubRedelivery({
        generation: 1,
        scanId: scanIds[0],
        preparedAt: timestamp(4),
      });
      expect(unrelated).toMatchObject({
        status: 'ready',
        guid: successfulGuid,
      });

      await isolated.beginGitHubScan({
        commandId: commandIds[1],
        scanId: scanIds[1],
        principal,
        requestedAt: timestamp(5),
        scanStartedAt: timestamp(5),
        leaseExpiresAt: timestamp(14),
        coverageMode: 'continue',
        providerWindowStart: timestamp(0),
        takeover: false,
        expectedLedgerRevision: (await isolated.inspect()).ledgerRevision,
      });
      await isolated.recordGitHubScanPage({
        generation: 2,
        scanId: scanIds[1],
        cursor: null,
        nextCursor: null,
        attempts: [
          attempt(10, failedGuid, timestamp(1), 'Failure'),
        ],
        recordedAt: timestamp(6),
        leaseExpiresAt: timestamp(14),
      });
      await isolated.completeGitHubScan({
        generation: 2,
        scanId: scanIds[1],
        completedAt: timestamp(7),
      });
      const unresolved = await isolated.nextGitHubRedelivery({
        generation: 2,
        scanId: scanIds[1],
        preparedAt: timestamp(8),
      });
      expect(unresolved).toMatchObject({
        status: 'unresolved',
        counts: { [state]: 1, total: 1 },
      });

      await isolated.beginGitHubScan({
        commandId: commandIds[2],
        scanId: scanIds[2],
        principal,
        requestedAt: timestamp(9),
        scanStartedAt: timestamp(9),
        leaseExpiresAt: timestamp(18),
        coverageMode: 'continue',
        providerWindowStart: timestamp(0),
        takeover: false,
        expectedLedgerRevision: (await isolated.inspect()).ledgerRevision,
      });
      await isolated.recordGitHubScanPage({
        generation: 3,
        scanId: scanIds[2],
        cursor: null,
        nextCursor: null,
        attempts: [
          attempt(12, failedGuid, timestamp(8), 'Failure', true),
        ],
        recordedAt: timestamp(10),
        leaseExpiresAt: timestamp(18),
      });
      await isolated.completeGitHubScan({
        generation: 3,
        scanId: scanIds[2],
        completedAt: timestamp(11),
      });
      expect(await isolated.nextGitHubRedelivery({
        generation: 3,
        scanId: scanIds[2],
        preparedAt: timestamp(12),
      })).toMatchObject({
        status: 'ready',
        guid: failedGuid,
        deliveryAttemptId: 12,
        redeliveryCount: 2,
      });
    }
  });

  it('treats an exact OK in any historical generation as delivered', async () => {
    await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(9),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });
    await ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: null,
      attempts: [attempt(10, failedGuid, timestamp(1), 'OK')],
      recordedAt: timestamp(2),
      leaseExpiresAt: timestamp(9),
    });
    await ledger.completeGitHubScan({
      generation: 1,
      scanId: scanIds[0],
      completedAt: timestamp(3),
    });

    await ledger.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal,
      requestedAt: timestamp(4),
      scanStartedAt: timestamp(4),
      leaseExpiresAt: timestamp(13),
      coverageMode: 'continue',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });
    await ledger.recordGitHubScanPage({
      generation: 2,
      scanId: scanIds[1],
      cursor: null,
      nextCursor: null,
      attempts: [attempt(11, failedGuid, timestamp(5), 'Failure', true)],
      recordedAt: timestamp(6),
      leaseExpiresAt: timestamp(13),
    });
    await ledger.completeGitHubScan({
      generation: 2,
      scanId: scanIds[1],
      completedAt: timestamp(7),
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 2,
      scanId: scanIds[1],
      preparedAt: timestamp(8),
    })).toMatchObject({ status: 'complete' });
  });

  it('uses a GUID/status-first index for historical exact-OK lookup', () => {
    const plan = storage.sql.exec<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT 1
       FROM delivery_recovery_github_attempts AS successful
       WHERE successful.guid = ?
         AND successful.status = 'OK'
       LIMIT 1`,
      failedGuid,
    ).toArray();
    expect(plan.some((row) =>
      row.detail.includes(
        'delivery_recovery_github_attempts_guid_status',
      )
    )).toBe(true);
  });

  it('lists unresolved redeliveries in stable action-priority order', async () => {
    const preparedAt = timestamp(1);
    insertGitHubIntent(storage, {
      index: 7,
      generation: 7,
      state: 'prepared',
      preparedAt,
    });
    insertGitHubIntent(storage, {
      index: 6,
      generation: 6,
      state: 'deferred',
      preparedAt,
      settledAt: timestamp(2),
      outcomeReason: 'rate-limited',
      retryAfter: timestamp(3),
    });
    insertGitHubIntent(storage, {
      index: 5,
      generation: 5,
      state: 'accepted',
      preparedAt,
      dispatchStartedAt: timestamp(2),
      settledAt: timestamp(3),
    });
    insertGitHubIntent(storage, {
      index: 4,
      generation: 4,
      state: 'rejected',
      preparedAt,
      dispatchStartedAt: timestamp(2),
      settledAt: timestamp(3),
      outcomeReason: 'provider-rejected',
    });
    insertGitHubIntent(storage, {
      index: 3,
      generation: 3,
      state: 'dispatching',
      preparedAt,
      dispatchStartedAt: timestamp(2),
    });
    insertGitHubIntent(storage, {
      index: 2,
      generation: 2,
      state: 'unknown',
      preparedAt,
      dispatchStartedAt: timestamp(2),
      settledAt: timestamp(3),
    });
    insertGitHubIntent(storage, {
      index: 1,
      generation: 1,
      state: 'unknown',
      preparedAt,
      dispatchStartedAt: timestamp(2),
      settledAt: timestamp(3),
    });

    const inspection = await ledger.inspectGitHubScan();
    expect(inspection.redeliveryIntents).toEqual({
      prepared: 1,
      dispatching: 1,
      deferred: 1,
      accepted: 1,
      unknown: 2,
      rejected: 1,
      total: 7,
    });
    expect(inspection.unresolvedRedeliveries.truncated).toBe(false);
    expect(
      inspection.unresolvedRedeliveries.entries.map((entry) => entry.state),
    ).toEqual([
      'unknown',
      'unknown',
      'dispatching',
      'rejected',
      'accepted',
      'deferred',
      'prepared',
    ]);
    expect(inspection.unresolvedRedeliveries.entries[0]).toEqual({
      intentId: fixtureUuid(1, 4),
      generation: 1,
      guid: fixtureUuid(1, 3),
      selectedAttemptId: 1,
      selectedDeliveredAt: timestamp(0),
      redeliveryCount: 1,
      state: 'unknown',
      preparedAt,
      dispatchStartedAt: timestamp(2),
      settledAt: timestamp(3),
      outcomeReason: null,
      retryAfter: null,
    });
    expect(
      inspection.unresolvedRedeliveries.entries.every(
        (entry) => !Object.hasOwn(entry, 'body'),
      ),
    ).toBe(true);
  });

  it('bounds unresolved redelivery inspection to one hundred entries', async () => {
    for (
      let index = 1;
      index <= maximumGitHubUnresolvedRedeliveryInspectionEntries + 1;
      index += 1
    ) {
      insertGitHubIntent(storage, {
        index,
        generation: 1,
        state: 'prepared',
        preparedAt: new Date(
          Date.parse(timestamp(0)) + index * 1_000,
        ).toISOString(),
      });
    }
    const inspection = await ledger.inspectGitHubScan();
    expect(inspection.redeliveryIntents).toMatchObject({
      prepared: 101,
      total: 101,
    });
    expect(inspection.unresolvedRedeliveries).toMatchObject({
      truncated: true,
    });
    expect(inspection.unresolvedRedeliveries.entries).toHaveLength(
      maximumGitHubUnresolvedRedeliveryInspectionEntries,
    );
    expect(inspection.unresolvedRedeliveries.entries[0]?.intentId).toBe(
      fixtureUuid(1, 4),
    );
    expect(inspection.unresolvedRedeliveries.entries.at(-1)?.intentId).toBe(
      fixtureUuid(100, 4),
    );
  });

  it('floors the trusted checkpoint to the provider second', async () => {
    const scanStartedAt = '2026-07-27T12:00:00.987Z';
    await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: scanStartedAt,
      scanStartedAt,
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'establish',
      providerWindowStart: '2026-07-27T12:00:00.000Z',
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });
    await ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: null,
      attempts: [],
      recordedAt: timestamp(1),
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
    });
    expect(await ledger.completeGitHubScan({
      generation: 1,
      scanId: scanIds[0],
      completedAt: timestamp(2),
    })).toMatchObject({
      checkpoint: '2026-07-27T12:00:00.000Z',
    });
    expect(await ledger.inspectGitHubScan()).toMatchObject({
      checkpoint: '2026-07-27T12:00:00.000Z',
    });
  });

  it('allows an authorized rotated principal to take over an expired lease', async () => {
    const revision = (await ledger.inspect()).ledgerRevision;
    await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(9),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: revision,
    });

    expect(await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(6),
      scanStartedAt: timestamp(6),
      leaseExpiresAt: timestamp(15),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    })).toMatchObject({
      status: 'resumed',
      generation: 1,
      cursor: null,
      leaseExpiresAt: timestamp(9),
    });

    await expect(ledger.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal: {
        accessServiceClientId: 'rotated-principal.example.access',
      },
      requestedAt: timestamp(5),
      scanStartedAt: timestamp(5),
      leaseExpiresAt: timestamp(14),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: true,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'active-scan-conflict',
    });

    await expect(ledger.beginGitHubScan({
      commandId: commandIds[2],
      scanId: scanIds[2],
      principal: {
        accessServiceClientId: 'rotated-principal.example.access',
      },
      requestedAt: timestamp(10),
      scanStartedAt: timestamp(10),
      leaseExpiresAt: timestamp(19),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'scan-takeover-required',
    });

    expect(await ledger.beginGitHubScan({
      commandId: commandIds[3],
      scanId: scanIds[3],
      principal: {
        accessServiceClientId: 'rotated-principal.example.access',
      },
      requestedAt: timestamp(10),
      scanStartedAt: timestamp(10),
      leaseExpiresAt: timestamp(19),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: true,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    })).toMatchObject({ status: 'begun', generation: 2 });
    expect(storage.sql.exec<{
      generation: number;
      principal: string;
      state: string;
      superseded_by_generation: number | null;
    }>(
      `SELECT generation, principal, state, superseded_by_generation
       FROM delivery_recovery_github_scans
       ORDER BY generation`,
    ).toArray()).toEqual([
      {
        generation: 1,
        principal: principal.accessServiceClientId,
        state: 'superseded',
        superseded_by_generation: 2,
      },
      {
        generation: 2,
        principal: 'rotated-principal.example.access',
        state: 'active',
        superseded_by_generation: null,
      },
    ]);
    expect(await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(11),
      scanStartedAt: timestamp(11),
      leaseExpiresAt: timestamp(20),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    })).toMatchObject({ status: 'superseded', generation: 1 });
  });

  it('fails closed on within-page and cross-page ordering drift', async () => {
    await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(9),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });

    await expect(ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: 'next',
      attempts: [
        attempt(1, failedGuid, timestamp(2), 'Failure'),
        attempt(2, successfulGuid, timestamp(2), 'Failure'),
      ],
      recordedAt: timestamp(3),
      leaseExpiresAt: timestamp(9),
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'page-order-conflict',
    });
    await expect(ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: 'next',
      attempts: [
        attempt(3, failedGuid, timestamp(1), 'Failure'),
        attempt(2, successfulGuid, timestamp(2), 'Failure'),
      ],
      recordedAt: timestamp(3),
      leaseExpiresAt: timestamp(9),
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'page-order-conflict',
    });

    await ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: 'next',
      attempts: [
        attempt(4, failedGuid, timestamp(2), 'Failure'),
        attempt(3, successfulGuid, timestamp(1), 'Failure'),
      ],
      recordedAt: timestamp(3),
      leaseExpiresAt: timestamp(9),
    });
    await expect(ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: 'next',
      nextCursor: null,
      attempts: [
        attempt(5, failedGuid, timestamp(2), 'Failure'),
      ],
      recordedAt: timestamp(4),
      leaseExpiresAt: timestamp(10),
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'page-order-conflict',
    });
    expect(await ledger.inspectGitHubScan()).toMatchObject({
      active: {
        pageCount: 1,
        attemptCount: 2,
        cursor: 'next',
        terminalPageSeen: false,
      },
    });
  });

  it('requires explicit establishment and preserves provider retention gaps', async () => {
    const storage = new TestDurableStorage();
    const isolated = new DeliveryRecoveryLedger(
      { id: { name: 'global-v1' }, storage },
      {},
    );
    storage.sql.exec(
      `UPDATE delivery_recovery_state
       SET github_checkpoint = ?,
           github_coverage_status = 'retained-window',
           github_coverage_from = ?,
           github_provider_window_start = ?`,
      timestamp(0),
      timestamp(0),
      timestamp(0),
    );
    const isolatedRevision = (await isolated.inspect()).ledgerRevision;
    await expect(isolated.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(5),
      scanStartedAt: timestamp(5),
      leaseExpiresAt: timestamp(14),
      coverageMode: 'continue',
      providerWindowStart: timestamp(1),
      takeover: false,
      expectedLedgerRevision: isolatedRevision,
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'coverage-establishment-required',
    });
    expect(await isolated.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal,
      requestedAt: timestamp(5),
      scanStartedAt: timestamp(5),
      leaseExpiresAt: timestamp(14),
      coverageMode: 'establish',
      providerWindowStart: timestamp(1),
      takeover: false,
      expectedLedgerRevision: isolatedRevision,
    })).toMatchObject({
      status: 'begun',
      coverage: {
        status: 'retention-gap',
        coverageFrom: timestamp(1),
        gap: {
          reason: 'provider-retention',
          from: timestamp(0),
          to: timestamp(1),
        },
      },
    });
  });

  it('requires establishment when a prior gap is followed by a new retention gap', async () => {
    const storage = new TestDurableStorage();
    const isolated = new DeliveryRecoveryLedger(
      { id: { name: 'global-v1' }, storage },
      {},
    );
    const checkpoint = '2026-07-20T12:00:00.000Z';
    const providerWindowStart = '2026-07-24T12:15:00.000Z';
    storage.sql.exec(
      `UPDATE delivery_recovery_state
       SET github_checkpoint = ?,
           github_coverage_status = 'retention-gap',
           github_coverage_from = '2026-07-19T12:00:00.000Z',
           github_provider_window_start = '2026-07-19T12:00:00.000Z',
           github_gap_reason = 'provider-retention',
           github_gap_from = '2026-07-18T12:00:00.000Z',
           github_gap_to = '2026-07-19T12:00:00.000Z'`,
      checkpoint,
    );
    const revision = (await isolated.inspect()).ledgerRevision;
    await expect(isolated.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: '2026-07-27T12:00:00.000Z',
      scanStartedAt: '2026-07-27T12:00:00.000Z',
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'continue',
      providerWindowStart,
      takeover: false,
      expectedLedgerRevision: revision,
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'coverage-establishment-required',
    });

    expect(await isolated.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal,
      requestedAt: '2026-07-27T12:00:00.000Z',
      scanStartedAt: '2026-07-27T12:00:00.000Z',
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'establish',
      providerWindowStart,
      takeover: false,
      expectedLedgerRevision: revision,
    })).toMatchObject({
      status: 'begun',
      coverage: {
        status: 'retention-gap',
        coverageFrom: providerWindowStart,
        providerWindowStart,
        gap: {
          reason: 'provider-retention',
          from: checkpoint,
          to: providerWindowStart,
        },
      },
    });
    await isolated.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[1],
      cursor: null,
      nextCursor: null,
      attempts: [],
      recordedAt: '2026-07-27T12:01:00.000Z',
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
    });
    await isolated.completeGitHubScan({
      generation: 1,
      scanId: scanIds[1],
      completedAt: '2026-07-27T12:02:00.000Z',
    });
    expect(await isolated.inspectGitHubScan()).toMatchObject({
      checkpoint: '2026-07-27T12:00:00.000Z',
      coverage: {
        status: 'retention-gap',
        coverageFrom: providerWindowStart,
        gap: {
          reason: 'provider-retention',
          from: checkpoint,
          to: providerWindowStart,
        },
      },
    });
  });

  it('enforces initial coverage establishment and the safe provider boundary', async () => {
    const scanStartedAt = '2026-07-27T12:00:00.000Z';
    const scanStartedMs = Date.parse(scanStartedAt);
    const safeProviderStart = new Date(
      scanStartedMs - maximumGitHubProviderCoverageWindowMs,
    ).toISOString();
    const initialRevision = (await ledger.inspect()).ledgerRevision;
    await expect(ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: scanStartedAt,
      scanStartedAt,
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'continue',
      providerWindowStart: safeProviderStart,
      takeover: false,
      expectedLedgerRevision: initialRevision,
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'coverage-establishment-required',
    });
    expect(await ledger.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal,
      requestedAt: scanStartedAt,
      scanStartedAt,
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'establish',
      providerWindowStart: safeProviderStart,
      takeover: false,
      expectedLedgerRevision: initialRevision,
    })).toMatchObject({
      status: 'begun',
      coverage: {
        status: 'retention-gap',
        coverageFrom: safeProviderStart,
      },
    });

    const tooOldStorage = new TestDurableStorage();
    const tooOld = new DeliveryRecoveryLedger(
      { id: { name: 'global-v1' }, storage: tooOldStorage },
      {},
    );
    await expect(tooOld.beginGitHubScan({
      commandId: commandIds[2],
      scanId: scanIds[2],
      principal,
      requestedAt: scanStartedAt,
      scanStartedAt,
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'establish',
      providerWindowStart: new Date(
        Date.parse(safeProviderStart) - 1,
      ).toISOString(),
      takeover: false,
      expectedLedgerRevision: (await tooOld.inspect()).ledgerRevision,
    })).rejects.toThrow('operation safety margin');

    const boundaryStorage = new TestDurableStorage();
    const boundary = new DeliveryRecoveryLedger(
      { id: { name: 'global-v1' }, storage: boundaryStorage },
      {},
    );
    boundaryStorage.sql.exec(
      `UPDATE delivery_recovery_state
       SET github_checkpoint = ?,
           github_coverage_status = 'retained-window',
           github_coverage_from = ?,
           github_provider_window_start = ?`,
      safeProviderStart,
      safeProviderStart,
      safeProviderStart,
    );
    expect(await boundary.beginGitHubScan({
      commandId: commandIds[3],
      scanId: scanIds[3],
      principal,
      requestedAt: scanStartedAt,
      scanStartedAt,
      leaseExpiresAt: '2026-07-27T12:09:00.000Z',
      coverageMode: 'continue',
      providerWindowStart: safeProviderStart,
      takeover: false,
      expectedLedgerRevision: (await boundary.inspect()).ledgerRevision,
    })).toMatchObject({
      status: 'begun',
      coverage: {
        status: 'retained-window',
        coverageFrom: safeProviderStart,
      },
    });
  });

  it('caps rolling lease renewal at the original absolute deadline', async () => {
    await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(5),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });
    await ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: 'next',
      attempts: [],
      recordedAt: timestamp(4),
      leaseExpiresAt: timestamp(9),
    });
    await expect(ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: 'next',
      nextCursor: null,
      attempts: [],
      recordedAt: timestamp(8),
      leaseExpiresAt: '2026-07-27T12:10:00.001Z',
    })).rejects.toMatchObject({
      name: 'DeliveryRecoveryConflictError',
      code: 'scan-binding-conflict',
    });
    expect(await ledger.inspectGitHubScan()).toMatchObject({
      active: {
        cursor: 'next',
        pageCount: 1,
        leaseExpiresAt: timestamp(9),
      },
    });
  });

  it('reuses a deferred intent and lets a later scan supersede it', async () => {
    await ledger.beginGitHubScan({
      commandId: commandIds[0],
      scanId: scanIds[0],
      principal,
      requestedAt: timestamp(0),
      scanStartedAt: timestamp(0),
      leaseExpiresAt: timestamp(9),
      coverageMode: 'establish',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });
    await ledger.recordGitHubScanPage({
      generation: 1,
      scanId: scanIds[0],
      cursor: null,
      nextCursor: null,
      attempts: [attempt(10, failedGuid, timestamp(1), 'Failure')],
      recordedAt: timestamp(2),
      leaseExpiresAt: timestamp(9),
    });
    await ledger.completeGitHubScan({
      generation: 1,
      scanId: scanIds[0],
      completedAt: timestamp(3),
    });
    const first = await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(4),
    });
    if (first.status !== 'ready') throw new Error('Expected redelivery.');
    await ledger.recordGitHubRedeliveryDeferred({
      generation: 1,
      scanId: scanIds[0],
      intentId: first.intentId,
      recordedAt: timestamp(5),
      reason: 'control-revision-conflict',
      retryAfter: timestamp(8),
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(7),
    })).toMatchObject({
      status: 'deferred',
      intentId: first.intentId,
    });
    const retried = await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(8),
    });
    expect(retried).toMatchObject({
      status: 'ready',
      intentId: first.intentId,
      redeliveryCount: 1,
    });
    if (retried.status !== 'ready') throw new Error('Expected retry.');
    await ledger.recordGitHubRedeliveryDeferred({
      generation: 1,
      scanId: scanIds[0],
      intentId: retried.intentId,
      recordedAt: timestamp(8),
      reason: 'control-revision-conflict',
      retryAfter: timestamp(9),
    });

    await ledger.beginGitHubScan({
      commandId: commandIds[1],
      scanId: scanIds[1],
      principal,
      requestedAt: timestamp(10),
      scanStartedAt: timestamp(10),
      leaseExpiresAt: timestamp(19),
      coverageMode: 'continue',
      providerWindowStart: timestamp(0),
      takeover: false,
      expectedLedgerRevision: (await ledger.inspect()).ledgerRevision,
    });
    await ledger.recordGitHubScanPage({
      generation: 2,
      scanId: scanIds[1],
      cursor: null,
      nextCursor: null,
      attempts: [attempt(10, failedGuid, timestamp(1), 'Failure')],
      recordedAt: timestamp(11),
      leaseExpiresAt: timestamp(19),
    });
    await ledger.completeGitHubScan({
      generation: 2,
      scanId: scanIds[1],
      completedAt: timestamp(12),
    });
    expect(await ledger.inspectGitHubScan()).toMatchObject({
      redeliveryIntents: { deferred: 0, total: 0 },
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 2,
      scanId: scanIds[1],
      preparedAt: timestamp(13),
    })).toMatchObject({
      status: 'ready',
      redeliveryCount: 1,
    });
  });

  it('fences a rejected GUID across scans until a newer attempt is observed', async () => {
    await recordCompletedGitHubScan(ledger, {
      generation: 1,
      commandId: commandIds[0],
      scanId: scanIds[0],
      scanStartedMinute: 0,
      attempts: [attempt(10, failedGuid, timestamp(0), 'Failure')],
    });
    const first = await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(3),
    });
    if (first.status !== 'ready') throw new Error('Expected redelivery.');
    await ledger.recordGitHubRedeliveryRejected({
      generation: 1,
      scanId: scanIds[0],
      intentId: first.intentId,
      recordedAt: timestamp(4),
      reason: 'invalid-request',
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(5),
    })).toMatchObject({
      status: 'unresolved',
      counts: { rejected: 1, total: 1 },
    });

    await recordCompletedGitHubScan(ledger, {
      generation: 2,
      commandId: commandIds[1],
      scanId: scanIds[1],
      scanStartedMinute: 5,
      attempts: [attempt(10, failedGuid, timestamp(0), 'Failure')],
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 2,
      scanId: scanIds[1],
      preparedAt: timestamp(8),
    })).toMatchObject({
      status: 'unresolved',
      counts: { rejected: 1, total: 1 },
    });
    expect(storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM delivery_recovery_github_redelivery_intents`,
    ).one().count).toBe(1);

    await recordCompletedGitHubScan(ledger, {
      generation: 3,
      commandId: commandIds[2],
      scanId: scanIds[2],
      scanStartedMinute: 9,
      attempts: [attempt(11, failedGuid, timestamp(8), 'Failure', true)],
    });
    const second = await ledger.nextGitHubRedelivery({
      generation: 3,
      scanId: scanIds[2],
      preparedAt: timestamp(12),
    });
    expect(second).toMatchObject({
      status: 'ready',
      guid: failedGuid,
      deliveryAttemptId: 11,
      redeliveryCount: 2,
    });
    if (second.status !== 'ready') throw new Error('Expected redelivery.');
    expect(storage.sql.exec<{
      state: string;
      observed_attempt_id: number | null;
    }>(
      `SELECT state, observed_attempt_id
       FROM delivery_recovery_github_redelivery_intents
       WHERE intent_id = ?`,
      first.intentId,
    ).one()).toEqual({
      state: 'reconciled',
      observed_attempt_id: 11,
    });
    await ledger.recordGitHubRedeliveryRejected({
      generation: 3,
      scanId: scanIds[2],
      intentId: second.intentId,
      recordedAt: timestamp(13),
      reason: 'provider-rejected',
    });

    await recordCompletedGitHubScan(ledger, {
      generation: 4,
      commandId: commandIds[3],
      scanId: scanIds[3],
      scanStartedMinute: 14,
      attempts: [attempt(12, failedGuid, timestamp(13), 'Failure', true)],
    });
    const third = await ledger.nextGitHubRedelivery({
      generation: 4,
      scanId: scanIds[3],
      preparedAt: timestamp(17),
    });
    expect(third).toMatchObject({
      status: 'ready',
      deliveryAttemptId: 12,
      redeliveryCount: 3,
    });
    if (third.status !== 'ready') throw new Error('Expected redelivery.');
    await ledger.recordGitHubRedeliveryRejected({
      generation: 4,
      scanId: scanIds[3],
      intentId: third.intentId,
      recordedAt: timestamp(18),
      reason: 'provider-rejected',
    });

    await recordCompletedGitHubScan(ledger, {
      generation: 5,
      commandId: commandIds[4],
      scanId: scanIds[4],
      scanStartedMinute: 19,
      attempts: [attempt(13, failedGuid, timestamp(18), 'Failure', true)],
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 5,
      scanId: scanIds[4],
      preparedAt: timestamp(22),
    })).toMatchObject({
      status: 'unresolved',
      counts: { rejected: 1, total: 1 },
    });

    await recordCompletedGitHubScan(ledger, {
      generation: 6,
      commandId: commandIds[5],
      scanId: scanIds[5],
      scanStartedMinute: 24,
      attempts: [attempt(14, failedGuid, timestamp(23), 'OK', true)],
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 6,
      scanId: scanIds[5],
      preparedAt: timestamp(27),
    })).toMatchObject({ status: 'complete' });
    expect(await ledger.inspectGitHubScan()).toMatchObject({
      redeliveryIntents: { rejected: 0, total: 0 },
    });
  });

  it('does not let an unrelated historical rejection block another GUID', async () => {
    await recordCompletedGitHubScan(ledger, {
      generation: 1,
      commandId: commandIds[0],
      scanId: scanIds[0],
      scanStartedMinute: 0,
      attempts: [attempt(10, failedGuid, timestamp(0), 'Failure')],
    });
    const rejected = await ledger.nextGitHubRedelivery({
      generation: 1,
      scanId: scanIds[0],
      preparedAt: timestamp(3),
    });
    if (rejected.status !== 'ready') throw new Error('Expected redelivery.');
    await ledger.recordGitHubRedeliveryRejected({
      generation: 1,
      scanId: scanIds[0],
      intentId: rejected.intentId,
      recordedAt: timestamp(4),
      reason: 'provider-rejected',
    });

    await recordCompletedGitHubScan(ledger, {
      generation: 2,
      commandId: commandIds[1],
      scanId: scanIds[1],
      scanStartedMinute: 5,
      attempts: [attempt(20, successfulGuid, timestamp(4), 'Failure')],
    });
    expect(await ledger.nextGitHubRedelivery({
      generation: 2,
      scanId: scanIds[1],
      preparedAt: timestamp(8),
    })).toMatchObject({
      status: 'ready',
      guid: successfulGuid,
      deliveryAttemptId: 20,
      redeliveryCount: 1,
    });
  });
});

function insertGitHubIntent(
  target: TestDurableStorage,
  value: {
    readonly index: number;
    readonly generation: number;
    readonly state: GitHubUnresolvedRedeliveryState;
    readonly preparedAt: string;
    readonly dispatchStartedAt?: string | null;
    readonly settledAt?: string | null;
    readonly outcomeReason?: string | null;
    readonly retryAfter?: string | null;
  },
): void {
  target.sql.exec(
    `INSERT INTO delivery_recovery_github_redelivery_intents (
       intent_id,
       generation,
       guid,
       selected_attempt_id,
       selected_delivered_at,
       redelivery_count,
       state,
       prepared_at,
       dispatch_started_at,
       settled_at,
       observed_attempt_id,
       outcome_reason,
       retry_after
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`,
    fixtureUuid(value.index, 4),
    value.generation,
    fixtureUuid(value.index, 3),
    value.index,
    timestamp(0),
    value.state,
    value.preparedAt,
    value.dispatchStartedAt ?? null,
    value.settledAt ?? null,
    value.outcomeReason ?? null,
    value.retryAfter ?? null,
  );
}

function fixtureUuid(index: number, namespace: number): string {
  return `${namespace}0000000-0000-4000-8000-`
    + String(index).padStart(12, '0');
}

function capture(
  entryId: string,
  body: string,
  sourceMessageId: string,
  capturedAt: string,
  attempts = 1,
): DeliveryRecoveryCaptureInput {
  return {
    entryId,
    bodyDigest: entryId,
    body,
    byteLength: new TextEncoder().encode(body).byteLength,
    eligible: true,
    envelopeKind: 'work-item-v1',
    deliveryId: 'github-delivery',
    repositoryId: 42,
    pullRequestNumber: 7,
    quarantineReason: null,
    sourceQueue: 'steward-events-dlq',
    sourceMessageId,
    sourceTimestamp: capturedAt,
    attempts,
    capturedAt,
  };
}

function attempt(
  attemptId: number,
  guid: string,
  deliveredAt: string,
  status: string,
  redelivery = false,
): {
  readonly attemptId: number;
  readonly guid: string;
  readonly deliveredAt: string;
  readonly status: string;
  readonly redelivery: boolean;
} {
  return { attemptId, guid, deliveredAt, status, redelivery };
}

async function recordCompletedGitHubScan(
  target: TestLedgerApi,
  value: {
    readonly generation: number;
    readonly commandId: string;
    readonly scanId: string;
    readonly scanStartedMinute: number;
    readonly attempts: readonly ReturnType<typeof attempt>[];
  },
): Promise<void> {
  const begun = await target.beginGitHubScan({
    commandId: value.commandId,
    scanId: value.scanId,
    principal,
    requestedAt: timestamp(value.scanStartedMinute),
    scanStartedAt: timestamp(value.scanStartedMinute),
    leaseExpiresAt: timestamp(value.scanStartedMinute + 9),
    coverageMode: value.generation === 1 ? 'establish' : 'continue',
    providerWindowStart: timestamp(0),
    takeover: false,
    expectedLedgerRevision: (await target.inspect()).ledgerRevision,
  });
  expect(begun).toMatchObject({
    status: 'begun',
    generation: value.generation,
    scanId: value.scanId,
  });
  await target.recordGitHubScanPage({
    generation: value.generation,
    scanId: value.scanId,
    cursor: null,
    nextCursor: null,
    attempts: value.attempts,
    recordedAt: timestamp(value.scanStartedMinute + 1),
    leaseExpiresAt: timestamp(value.scanStartedMinute + 9),
  });
  await target.completeGitHubScan({
    generation: value.generation,
    scanId: value.scanId,
    completedAt: timestamp(value.scanStartedMinute + 2),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    ),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
