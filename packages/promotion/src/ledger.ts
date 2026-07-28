import { DurableObject } from 'cloudflare:workers';
import {
  canonicalRuntimePromotionCommandJson,
  canonicalRuntimePromotionDeployment,
  canonicalRuntimePromotionDeploymentJson,
  minimumRuntimePromotionResolutionQuietMs,
  parseRuntimePromotionCommand,
  type RuntimePromotionAbandonResult,
  type RuntimePromotionCommandV1,
  type RuntimePromotionBeginResult,
  type RuntimePromotionDeployment,
  type RuntimePromotionLedgerEntry,
  type RuntimePromotionLedgerState,
} from './contracts.js';

type SqlValue = string | number | null;

interface SqlCursor<T extends object> {
  one(): T;
  toArray(): T[];
}

interface PromotionState {
  readonly id: { readonly name?: string };
  readonly storage: {
    readonly sql: {
      exec<T extends object>(
        query: string,
        ...bindings: SqlValue[]
      ): SqlCursor<T>;
    };
    transactionSync<T>(closure: () => T): T;
  };
}

interface EntryRow {
  command_json: string;
  principal: string;
  state: string;
  before_json: string;
  desired_json: string;
  after_json: string | null;
  updated_at: string;
}

export class RuntimePromotionLedger extends DurableObject {
  readonly #ctx: PromotionState;

  constructor(ctx: PromotionState, env: unknown) {
    super(ctx as never, env as never);
    this.#ctx = ctx;
    if (ctx.id.name !== 'global-v1') {
      throw new TypeError(
        'RuntimePromotionLedger must use idFromName("global-v1").',
      );
    }
    this.#initialize();
  }

  async begin(value: {
    readonly command: unknown;
    readonly principal: string;
    readonly before: RuntimePromotionDeployment;
    readonly desired: RuntimePromotionDeployment;
    readonly now: string;
  }): Promise<RuntimePromotionBeginResult> {
    const command = parseRuntimePromotionCommand(value.command);
    const commandJson = canonicalRuntimePromotionCommandJson(command);
    const before = canonicalRuntimePromotionDeployment(value.before);
    const desired = canonicalRuntimePromotionDeployment(value.desired);
    if (!value.principal || !value.now) throw new TypeError('Promotion ledger provenance is required.');

    return this.#ctx.storage.transactionSync(() => {
      const existing = this.#load(command.commandId);
      if (existing) {
        if (
          canonicalRuntimePromotionCommandJson(existing.command) !== commandJson
          || existing.principal !== value.principal
          || canonicalRuntimePromotionDeploymentJson(existing.before)
            !== canonicalRuntimePromotionDeploymentJson(before)
          || canonicalRuntimePromotionDeploymentJson(existing.desired)
            !== canonicalRuntimePromotionDeploymentJson(desired)
        ) {
          throw new TypeError('Promotion command identity was reused with different evidence.');
        }
        return {
          status: existing.state === 'unknown'
            ? 'recover'
            : existing.state === 'dispatching'
              ? 'busy'
              : 'completed',
          entry: existing,
        };
      }
      const active = this.#ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM runtime_promotion_commands
          WHERE worker = ?
            AND state IN ('dispatching', 'unknown')`,
        command.worker,
      ).one().count;
      if (active !== 0) {
        const busy: RuntimePromotionLedgerEntry = {
          command,
          principal: value.principal,
          state: 'rejected',
          before,
          desired,
          after: null,
          updatedAt: value.now,
        };
        return { status: 'busy', entry: busy };
      }
      this.#ctx.storage.sql.exec(
        `INSERT INTO runtime_promotion_commands (
           command_id, worker, command_json, principal, state, before_json,
           desired_json, after_json, updated_at
         ) VALUES (?, ?, ?, ?, 'dispatching', ?, ?, NULL, ?)`,
        command.commandId,
        command.worker,
        commandJson,
        value.principal,
        canonicalRuntimePromotionDeploymentJson(before),
        canonicalRuntimePromotionDeploymentJson(desired),
        value.now,
      );
      return {
        status: 'begun',
        entry: this.#load(command.commandId)!,
      };
    });
  }

  async settle(value: {
    readonly commandId: string;
    readonly state: Exclude<
      RuntimePromotionLedgerState,
      'dispatching' | 'unknown'
    >;
    readonly after: RuntimePromotionDeployment | null;
    readonly now: string;
  }): Promise<RuntimePromotionLedgerEntry> {
    if (![
      'staged',
      'promoted',
      'canary-stopped',
      'rolled-back',
      'superseded',
      'abandoned',
      'rejected',
    ].includes(value.state)) {
      throw new TypeError('Promotion settlement state is invalid.');
    }
    return this.#update(
      value.commandId,
      value.state,
      value.after,
      value.now,
    );
  }

  async markUnknown(value: {
    readonly commandId: string;
    readonly after: RuntimePromotionDeployment | null;
    readonly now: string;
  }): Promise<RuntimePromotionLedgerEntry> {
    return this.#update(
      value.commandId,
      'unknown',
      value.after,
      value.now,
    );
  }

  async abandonUnknown(value: {
    readonly commandId: string;
    readonly worker: string;
    readonly principal: string;
    readonly before: RuntimePromotionDeployment;
    readonly now: string;
  }): Promise<RuntimePromotionAbandonResult> {
    const before = canonicalRuntimePromotionDeployment(value.before);
    return this.#ctx.storage.transactionSync(() => {
      const existing = this.#load(value.commandId);
      if (!existing) throw new TypeError('Promotion command does not exist.');
      if (
        existing.command.worker !== value.worker
        || existing.principal !== value.principal
        || canonicalRuntimePromotionDeploymentJson(existing.before)
          !== canonicalRuntimePromotionDeploymentJson(before)
      ) {
        throw new TypeError('Promotion resolution evidence does not match.');
      }
      if (existing.state !== 'unknown') {
        return { status: 'completed', entry: existing };
      }
      const quietMs = Date.parse(value.now) - Date.parse(existing.updatedAt);
      if (
        !Number.isFinite(quietMs)
        || quietMs < minimumRuntimePromotionResolutionQuietMs
      ) {
        return { status: 'too-early', entry: existing };
      }
      this.#writeState(
        value.commandId,
        'abandoned',
        before,
        value.now,
      );
      return {
        status: 'abandoned',
        entry: this.#load(value.commandId)!,
      };
    });
  }

  async inspect(commandId: string): Promise<RuntimePromotionLedgerEntry | null> {
    return this.#load(commandId) ?? null;
  }

  #update(
    commandId: string,
    state: RuntimePromotionLedgerState,
    after: RuntimePromotionDeployment | null,
    now: string,
  ): RuntimePromotionLedgerEntry {
    return this.#ctx.storage.transactionSync(() => {
      const existing = this.#load(commandId);
      if (!existing) throw new TypeError('Promotion command does not exist.');
      if (
        existing.state !== 'dispatching'
        && existing.state !== 'unknown'
      ) {
        return existing;
      }
      this.#writeState(commandId, state, after, now);
      return this.#load(commandId)!;
    });
  }

  #writeState(
    commandId: string,
    state: RuntimePromotionLedgerState,
    after: RuntimePromotionDeployment | null,
    now: string,
  ): void {
    this.#ctx.storage.sql.exec(
      `UPDATE runtime_promotion_commands
          SET state = ?, after_json = ?, updated_at = ?
        WHERE command_id = ?`,
      state,
      after === null
        ? null
        : canonicalRuntimePromotionDeploymentJson(after),
      now,
      commandId,
    );
  }

  #load(commandId: string): RuntimePromotionLedgerEntry | undefined {
    const rows = this.#ctx.storage.sql.exec<EntryRow>(
      `SELECT command_json, principal, state, before_json, desired_json,
              after_json, updated_at
         FROM runtime_promotion_commands
        WHERE command_id = ?`,
      commandId,
    ).toArray();
    const row = rows[0];
    if (!row) return undefined;
    return {
      command: parseRuntimePromotionCommand(JSON.parse(row.command_json)),
      principal: row.principal,
      state: row.state as RuntimePromotionLedgerState,
      before: canonicalRuntimePromotionDeployment(JSON.parse(
        row.before_json,
      ) as RuntimePromotionDeployment),
      desired: canonicalRuntimePromotionDeployment(JSON.parse(
        row.desired_json,
      ) as RuntimePromotionDeployment),
      after: row.after_json === null
        ? null
        : canonicalRuntimePromotionDeployment(JSON.parse(
            row.after_json,
          ) as RuntimePromotionDeployment),
      updatedAt: row.updated_at,
    };
  }

  #initialize(): void {
    this.#ctx.storage.sql.exec(
       `CREATE TABLE IF NOT EXISTS runtime_promotion_commands (
          command_id TEXT PRIMARY KEY,
          worker TEXT NOT NULL,
          command_json TEXT NOT NULL,
         principal TEXT NOT NULL,
         state TEXT NOT NULL CHECK (
           state IN (
              'dispatching', 'unknown', 'staged', 'promoted',
              'canary-stopped', 'rolled-back', 'superseded', 'abandoned',
              'rejected'
           )
         ),
         before_json TEXT NOT NULL,
         desired_json TEXT NOT NULL,
         after_json TEXT,
         updated_at TEXT NOT NULL
       )`,
    );
    this.#ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS runtime_promotion_active
         ON runtime_promotion_commands (worker, state)`,
    );
  }
}
