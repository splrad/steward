import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimePromotionAbandonResult,
  RuntimePromotionCommandV1,
  RuntimePromotionBeginResult,
  RuntimePromotionDeployment,
  RuntimePromotionLedgerEntry,
} from '../packages/promotion/src/contracts.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

interface LedgerApi {
  begin(value: {
    command: unknown;
    principal: string;
    before: RuntimePromotionDeployment;
    desired: RuntimePromotionDeployment;
    now: string;
  }): Promise<RuntimePromotionBeginResult>;
  settle(value: {
    commandId: string;
    state: 'promoted';
    after: RuntimePromotionDeployment;
    now: string;
  }): Promise<RuntimePromotionLedgerEntry>;
  markUnknown(value: {
    commandId: string;
    after: RuntimePromotionDeployment;
    now: string;
  }): Promise<RuntimePromotionLedgerEntry>;
  abandonUnknown(value: {
    commandId: string;
    worker: string;
    principal: string;
    before: RuntimePromotionDeployment;
    now: string;
  }): Promise<RuntimePromotionAbandonResult>;
  inspect(commandId: string): Promise<RuntimePromotionLedgerEntry | null>;
}

interface LedgerConstructor {
  new(ctx: unknown, env: unknown): LedgerApi;
}

const ledgerModulePath = '../packages/promotion/src/ledger.js';
const { RuntimePromotionLedger } = await import(
  ledgerModulePath
) as unknown as {
  RuntimePromotionLedger: LedgerConstructor;
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
          throw new Error(`Expected one SQLite row, received ${rows.length}.`);
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
}

const stableVersionId = '10000000-0000-4000-8000-000000000001';
const candidateVersionId = '20000000-0000-4000-8000-000000000002';
const before: RuntimePromotionDeployment = {
  id: '30000000-0000-4000-8000-000000000003',
  versions: [
    { versionId: stableVersionId, percentage: 90 },
    { versionId: candidateVersionId, percentage: 10 },
  ],
};
const desired: RuntimePromotionDeployment = {
  id: before.id,
  versions: [
    { versionId: stableVersionId, percentage: 75 },
    { versionId: candidateVersionId, percentage: 25 },
  ],
};

function command(
  commandId: string,
  worker: RuntimePromotionCommandV1['worker'] = 'steward-control',
): RuntimePromotionCommandV1 {
  return {
    schemaVersion: 1,
    commandId,
    requestedAt: '2026-07-28T06:00:00.000Z',
    operation: 'promote',
    worker,
    expectedDeploymentId: before.id,
    stableVersionId,
    candidateVersionId,
    stewardCommit: 'a'.repeat(40),
    candidatePercentage: 25,
  };
}

let ledger: LedgerApi;

beforeEach(() => {
  ledger = new RuntimePromotionLedger(
    {
      id: { name: 'global-v1' },
      storage: new TestDurableStorage(),
    },
    {},
  );
});

describe('RuntimePromotionLedger', () => {
  it('durably recovers an unknown intent and then settles it', async () => {
    const promotion = command(
      '40000000-0000-4000-8000-000000000004',
    );
    await expect(ledger.begin({
      command: promotion,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:01.000Z',
    })).resolves.toMatchObject({
      status: 'begun',
      entry: { state: 'dispatching' },
    });

    await expect(ledger.markUnknown({
      commandId: promotion.commandId,
      after: before,
      now: '2026-07-28T06:00:02.000Z',
    })).resolves.toMatchObject({ state: 'unknown' });

    await expect(ledger.begin({
      command: promotion,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:03.000Z',
    })).resolves.toMatchObject({ status: 'recover' });

    const after = { ...desired, id: '50000000-0000-4000-8000-000000000005' };
    await expect(ledger.settle({
      commandId: promotion.commandId,
      state: 'promoted',
      after,
      now: '2026-07-28T06:00:04.000Z',
    })).resolves.toMatchObject({
      state: 'promoted',
      after: { id: after.id },
    });
    await expect(ledger.inspect(promotion.commandId)).resolves.toMatchObject({
      principal: 'promotion-service-token',
      state: 'promoted',
    });
  });

  it('serializes protected promotion intents for the same Worker', async () => {
    const first = command('60000000-0000-4000-8000-000000000006');
    const second = command('70000000-0000-4000-8000-000000000007');
    await ledger.begin({
      command: first,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:01.000Z',
    });
    await expect(ledger.begin({
      command: second,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:02.000Z',
    })).resolves.toMatchObject({ status: 'busy' });
    await expect(ledger.inspect(second.commandId)).resolves.toBeNull();
  });

  it('isolates active intent locks per Worker and explicitly abandons only after the quiet period', async () => {
    const control = command('71000000-0000-4000-8000-000000000007');
    const recovery = command(
      '72000000-0000-4000-8000-000000000007',
      'steward-recovery',
    );
    await ledger.begin({
      command: control,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:01.000Z',
    });
    await expect(ledger.begin({
      command: recovery,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:02.000Z',
    })).resolves.toMatchObject({ status: 'begun' });

    await ledger.markUnknown({
      commandId: control.commandId,
      after: before,
      now: '2026-07-28T06:00:03.000Z',
    });
    await expect(ledger.abandonUnknown({
      commandId: control.commandId,
      worker: control.worker,
      principal: 'promotion-service-token',
      before,
      now: '2026-07-28T06:01:02.999Z',
    })).resolves.toMatchObject({ status: 'too-early' });
    await expect(ledger.abandonUnknown({
      commandId: control.commandId,
      worker: control.worker,
      principal: 'promotion-service-token',
      before,
      now: '2026-07-28T06:01:03.000Z',
    })).resolves.toMatchObject({
      status: 'abandoned',
      entry: { state: 'abandoned' },
    });
    await expect(ledger.begin({
      command: command('73000000-0000-4000-8000-000000000007'),
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:01:04.000Z',
    })).resolves.toMatchObject({ status: 'begun' });
  });

  it('rejects command ID reuse with different evidence and the wrong DO name', async () => {
    const promotion = command(
      '80000000-0000-4000-8000-000000000008',
    );
    await ledger.begin({
      command: promotion,
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:01.000Z',
    });
    await expect(ledger.begin({
      command: { ...promotion, candidatePercentage: 30 },
      principal: 'promotion-service-token',
      before,
      desired,
      now: '2026-07-28T06:00:02.000Z',
    })).rejects.toThrow(/identity was reused/);
    expect(() => new RuntimePromotionLedger(
      {
        id: { name: 'repository-1' },
        storage: new TestDurableStorage(),
      },
      {},
    )).toThrow(/idFromName\("global-v1"\)/);
  });
});
