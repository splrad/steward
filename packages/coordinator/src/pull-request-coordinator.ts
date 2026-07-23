import { DurableObject } from 'cloudflare:workers';
import {
  coordinatorSchemaVersion,
  parsePullRequestCoordinatorName,
  type CoordinatorAlarmResult,
  type CoordinatorClaimResult,
  type CoordinatorCompleteResult,
  type CoordinatorFailResult,
  type CoordinatorFailureCode,
  type CoordinatorRenewResult,
  type PullRequestCoordinatorSnapshot,
  type PullRequestCoordinatorSubject,
} from './contracts.js';
import {
  createPullRequestCoordinatorState,
  PullRequestCoordinatorStateMachine,
  type CoordinatorDeliveryRecord,
  type PullRequestCoordinatorStoredState,
} from './state.js';

interface CoordinatorStateRow {
  dirty: number;
  failure_code: string | null;
  generation: number;
  lease_delivery_id: string | null;
  lease_expires_at: number | null;
  lease_generation: number | null;
  lease_kind: string | null;
  lease_token: string | null;
  phase: string;
  pull_number: number;
  repository_id: string;
}

interface CoordinatorDeliveryRow {
  accepted_at: number;
  completed_at: number | null;
  covered_generation: number | null;
  delivery_id: string;
  status: string;
}

interface SchemaVersionRow {
  version: number;
}

interface CoordinatorMutation<T> {
  alarmAt: number | null;
  result: T;
}

type CoordinatorSqlValue = ArrayBuffer | string | number | null;

interface CoordinatorSqlCursor<T extends object> {
  one(): T;
  toArray(): T[];
}

interface CoordinatorSqlStorage {
  exec<T extends object>(
    query: string,
    ...bindings: CoordinatorSqlValue[]
  ): CoordinatorSqlCursor<T>;
}

interface CoordinatorDurableObjectState {
  id: {
    readonly name?: string;
  };
  storage: {
    readonly sql: CoordinatorSqlStorage;
    setAlarm(scheduledTime: number): Promise<void>;
    transactionSync<T>(closure: () => T): T;
  };
}

export class PullRequestCoordinator extends DurableObject {
  readonly #ctx: CoordinatorDurableObjectState;
  readonly #subject: PullRequestCoordinatorSubject;

  constructor(ctx: CoordinatorDurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.#ctx = ctx;

    const objectName = ctx.id.name;
    if (objectName === undefined) {
      throw new TypeError(
        'PullRequestCoordinator must be addressed with idFromName().',
      );
    }

    this.#subject = parsePullRequestCoordinatorName(objectName);
    this.#initializeSchema();
  }

  async claim(
    deliveryId: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorClaimResult> {
    const mutation = this.#mutate((machine) =>
      machine.claim(
        deliveryId,
        leaseDurationMs,
        Date.now(),
        crypto.randomUUID(),
      ),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async renew(
    generation: number,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<CoordinatorRenewResult> {
    const mutation = this.#mutate((machine) =>
      machine.renew(generation, leaseToken, leaseDurationMs, Date.now()),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async complete(
    generation: number,
    leaseToken: string,
  ): Promise<CoordinatorCompleteResult> {
    const mutation = this.#mutate((machine) =>
      machine.complete(generation, leaseToken, Date.now()),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  async fail(
    generation: number,
    leaseToken: string,
    failureCode: CoordinatorFailureCode,
  ): Promise<CoordinatorFailResult> {
    const mutation = this.#mutate((machine) =>
      machine.fail(generation, leaseToken, failureCode, Date.now()),
    );
    await this.#scheduleAlarm(mutation.alarmAt);
    return mutation.result;
  }

  snapshot(): PullRequestCoordinatorSnapshot {
    return this.#ctx.storage.transactionSync(() =>
      this.#loadMachine().snapshot(),
    );
  }

  async alarm(): Promise<void> {
    const mutation = this.#mutate<CoordinatorAlarmResult>((machine) =>
      machine.alarm(Date.now()),
    );

    // An early or superseded alarm is harmless. If a renewed lease is still
    // active, restore its current deadline. No network I/O occurs here.
    await this.#scheduleAlarm(mutation.alarmAt);
  }

  #initializeSchema(): void {
    this.#ctx.storage.transactionSync(() => {
      const sql = this.#ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `);

      const versionRow = sql
        .exec<SchemaVersionRow>(
          'SELECT version FROM coordinator_schema WHERE singleton = 1',
        )
        .toArray()[0];

      if (
        versionRow !== undefined &&
        versionRow.version !== coordinatorSchemaVersion
      ) {
        throw new Error(
          `Unsupported coordinator schema version ${versionRow.version}.`,
        );
      }

      sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          repository_id TEXT NOT NULL,
          pull_number INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('idle', 'leased', 'followup')),
          dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
          lease_delivery_id TEXT,
          lease_generation INTEGER,
          lease_kind TEXT CHECK (lease_kind IN ('delivery', 'followup')),
          lease_token TEXT,
          lease_expires_at INTEGER,
          failure_code TEXT
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS coordinator_deliveries (
          delivery_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
          accepted_at INTEGER NOT NULL,
          completed_at INTEGER,
          covered_generation INTEGER
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS coordinator_deliveries_completed
        ON coordinator_deliveries (status, completed_at)
      `);

      if (versionRow === undefined) {
        sql.exec(
          'INSERT INTO coordinator_schema (singleton, version) VALUES (1, ?)',
          coordinatorSchemaVersion,
        );
      }

      const existing = sql
        .exec<CoordinatorStateRow>(
          'SELECT * FROM coordinator_state WHERE singleton = 1',
        )
        .toArray()[0];

      if (existing === undefined) {
        const initial = createPullRequestCoordinatorState(this.#subject);
        this.#writeState(initial);
        return;
      }

      if (
        existing.repository_id !== this.#subject.repositoryId ||
        existing.pull_number !== this.#subject.pullNumber
      ) {
        throw new Error(
          'Durable Object name does not match its persisted PR subject.',
        );
      }
    });
  }

  #mutate<T>(
    operation: (machine: PullRequestCoordinatorStateMachine) => T,
  ): CoordinatorMutation<T> {
    return this.#ctx.storage.transactionSync(() => {
      const machine = this.#loadMachine();
      const result = operation(machine);
      this.#writeState(machine.exportState());
      return {
        alarmAt: machine.alarmAt(),
        result,
      };
    });
  }

  #loadMachine(): PullRequestCoordinatorStateMachine {
    const sql = this.#ctx.storage.sql;
    const stateRow = sql
      .exec<CoordinatorStateRow>(
        'SELECT * FROM coordinator_state WHERE singleton = 1',
      )
      .one();
    const deliveryRows = sql
      .exec<CoordinatorDeliveryRow>(`
        SELECT
          delivery_id,
          status,
          accepted_at,
          completed_at,
          covered_generation
        FROM coordinator_deliveries
        ORDER BY accepted_at, delivery_id
      `)
      .toArray();

    const lease =
      stateRow.lease_delivery_id === null
        ? null
        : {
            deliveryId: stateRow.lease_delivery_id,
            expiresAt: requireNumber(
              stateRow.lease_expires_at,
              'lease_expires_at',
            ),
            generation: requireNumber(
              stateRow.lease_generation,
              'lease_generation',
            ),
            kind: toLeaseKind(
              requireString(stateRow.lease_kind, 'lease_kind'),
            ),
            token: requireString(stateRow.lease_token, 'lease_token'),
          };

    return new PullRequestCoordinatorStateMachine({
      deliveries: deliveryRows.map(toDeliveryRecord),
      dirty: stateRow.dirty === 1,
      failureCode: toFailureCode(stateRow.failure_code),
      generation: stateRow.generation,
      lease,
      phase: toPhase(stateRow.phase),
      subject: {
        pullNumber: stateRow.pull_number,
        repositoryId: stateRow.repository_id,
      },
    });
  }

  #writeState(state: PullRequestCoordinatorStoredState): void {
    const sql = this.#ctx.storage.sql;
    sql.exec(
      `
        INSERT INTO coordinator_state (
          singleton,
          repository_id,
          pull_number,
          generation,
          phase,
          dirty,
          lease_delivery_id,
          lease_generation,
          lease_kind,
          lease_token,
          lease_expires_at,
          failure_code
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          repository_id = excluded.repository_id,
          pull_number = excluded.pull_number,
          generation = excluded.generation,
          phase = excluded.phase,
          dirty = excluded.dirty,
          lease_delivery_id = excluded.lease_delivery_id,
          lease_generation = excluded.lease_generation,
          lease_kind = excluded.lease_kind,
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          failure_code = excluded.failure_code
      `,
      state.subject.repositoryId,
      state.subject.pullNumber,
      state.generation,
      state.phase,
      state.dirty ? 1 : 0,
      state.lease?.deliveryId ?? null,
      state.lease?.generation ?? null,
      state.lease?.kind ?? null,
      state.lease?.token ?? null,
      state.lease?.expiresAt ?? null,
      state.failureCode,
    );

    sql.exec('DELETE FROM coordinator_deliveries');
    for (const delivery of state.deliveries) {
      sql.exec(
        `
          INSERT INTO coordinator_deliveries (
            delivery_id,
            status,
            accepted_at,
            completed_at,
            covered_generation
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        delivery.deliveryId,
        delivery.status,
        delivery.acceptedAt,
        delivery.completedAt,
        delivery.coveredGeneration,
      );
    }
  }

  async #scheduleAlarm(alarmAt: number | null): Promise<void> {
    if (alarmAt !== null) {
      await this.#ctx.storage.setAlarm(alarmAt);
    }
  }
}

function toDeliveryRecord(
  row: CoordinatorDeliveryRow,
): CoordinatorDeliveryRecord {
  if (row.status !== 'pending' && row.status !== 'completed') {
    throw new Error(`Unsupported delivery state ${row.status}.`);
  }

  return {
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    coveredGeneration: row.covered_generation,
    deliveryId: row.delivery_id,
    status: row.status,
  };
}

function toPhase(
  value: string,
): PullRequestCoordinatorStoredState['phase'] {
  if (value !== 'idle' && value !== 'leased' && value !== 'followup') {
    throw new Error(`Unsupported coordinator phase ${value}.`);
  }
  return value;
}

function toLeaseKind(value: string): 'delivery' | 'followup' {
  if (value !== 'delivery' && value !== 'followup') {
    throw new Error(`Unsupported coordinator lease kind ${value}.`);
  }
  return value;
}

function toFailureCode(
  value: string | null,
): CoordinatorFailureCode | null {
  if (value === null) {
    return null;
  }
  if (
    value === 'control-error' ||
    value === 'dependency-unavailable' ||
    value === 'lease-expired' ||
    value === 'rate-limited' ||
    value === 'runtime-error'
  ) {
    return value;
  }
  throw new Error(`Unsupported coordinator failure code ${value}.`);
}

function requireNumber(value: number | null, name: string): number {
  if (value === null) {
    throw new Error(`Coordinator state is missing ${name}.`);
  }
  return value;
}

function requireString(value: string | null, name: string): string {
  if (value === null) {
    throw new Error(`Coordinator state is missing ${name}.`);
  }
  return value;
}
