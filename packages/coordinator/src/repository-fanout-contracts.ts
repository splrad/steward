import type {
  StewardRuntimeRepositoryScopeTargetV2,
  StewardRuntimeScopeWorkItemV1,
  StewardRuntimeScopeWorkItemV2,
} from '../../core/src/runtime-scope-work-item.js';
import type {
  StewardRuntimeInstallationRepositoryChildV1,
} from '../../core/src/runtime-installation-fanout.js';

export type RepositoryFanoutScopeWorkItem =
  | StewardRuntimeScopeWorkItemV1
  | (
      StewardRuntimeScopeWorkItemV2
      & { readonly target: StewardRuntimeRepositoryScopeTargetV2 }
    );

export type RepositoryFanoutInput =
  | RepositoryFanoutScopeWorkItem
  | StewardRuntimeInstallationRepositoryChildV1;

export const repositoryFanoutSchemaVersion = 1;
export const repositoryFanoutCoordinatorNamePrefix =
  'steward-repository-fanout-v1';
export const repositoryFanoutCompletedDeliveryRetentionLimit = 128;
export const repositoryFanoutPendingDeliveryRetentionLimit = 128;
export const repositoryFanoutCompletedDeliveryRetentionMs =
  7 * 24 * 60 * 60 * 1_000;
export const repositoryFanoutMaximumLeaseDurationMs = 60 * 60 * 1_000;
export const repositoryFanoutMaximumDriftRestarts = 2;
export const repositoryFanoutMaximumDispatchBatchSize = 100;

export const repositoryFanoutFailureCodes = [
  'dependency-unavailable',
  'lease-expired',
  'pagination-conflict',
  'pagination-drift',
  'pagination-limit',
  'queue-error',
  'runtime-error',
] as const;

export type RepositoryFanoutFailureCode =
  (typeof repositoryFanoutFailureCodes)[number];

export type RepositoryFanoutPhase =
  | 'idle'
  | 'enumerating'
  | 'dispatch'
  | 'followup';

export interface RepositoryFanoutDispatchTarget {
  readonly pullRequestNumber: number;
  readonly deliveryId: string;
}

export interface RepositoryFanoutQueueConfirmation {
  readonly pullRequestNumber: number;
  readonly deliveryId: string;
}

export interface RepositoryFanoutQueueConfirmations {
  readonly confirmations: readonly RepositoryFanoutQueueConfirmation[];
}

export type RepositoryFanoutClaimResult =
  | {
      readonly status: 'claimed';
      readonly generation: number;
      readonly leaseToken: string;
      readonly expiresAt: number;
      readonly resumed: boolean;
      readonly selectedScopeItem: RepositoryFanoutInput;
      readonly phase: 'enumerating' | 'dispatch';
      readonly pass: 1 | 2 | null;
      readonly cursor: string | null;
    }
  | {
      readonly status: 'duplicate';
    }
  | {
      readonly status: 'busy' | 'coalesced';
      readonly generation: number;
      readonly expiresAt: number;
    };

export type RepositoryFanoutRecordPageResult =
  | {
      readonly status: 'accepted' | 'duplicate';
      readonly generation: number;
      readonly pass: 1 | 2;
      readonly hasNextPage: boolean;
    }
  | {
      readonly status: 'pass-complete';
      readonly generation: number;
      readonly nextPass: 2;
    }
  | {
      readonly status: 'dispatch-ready';
      readonly generation: number;
      readonly targetCount: number;
    }
  | {
      readonly status: 'restarted';
      readonly generation: number;
      readonly restartCount: number;
      readonly reason: 'pagination-conflict' | 'pagination-drift';
    }
  | {
      readonly status: 'drift-limit';
      readonly generation: number;
      readonly reason:
        | 'pagination-conflict'
        | 'pagination-drift'
        | 'pagination-limit';
    }
  | {
      readonly status: 'conflict' | 'stale';
    };

export type RepositoryFanoutNextDispatchBatchResult =
  | {
      readonly status: 'batch';
      readonly generation: number;
      readonly repositoryFullName: string | null;
      readonly targets: readonly RepositoryFanoutDispatchTarget[];
      readonly remaining: number;
    }
  | {
      readonly status: 'not-ready' | 'stale';
    };

export type RepositoryFanoutRecordQueueConfirmedResult =
  | {
      readonly status: 'recorded';
      readonly generation: number;
      readonly newlyConfirmed: number;
      readonly remaining: number;
    }
  | {
      readonly status: 'conflict' | 'stale';
    };

export type RepositoryFanoutCompleteResult =
  | {
      readonly status: 'completed' | 'followup';
      readonly generation: number;
    }
  | {
      readonly status: 'not-ready' | 'stale';
    };

export type RepositoryFanoutFailResult =
  | {
      readonly status: 'resumable';
      readonly generation: number;
    }
  | {
      readonly status: 'stale';
    };

export type RepositoryFanoutReleaseForContinuationResult =
  | {
      readonly status: 'released';
      readonly generation: number;
    }
  | {
      readonly status: 'stale';
    };

export type RepositoryFanoutAlarmResult =
  | {
      readonly status: 'expired';
      readonly generation: number;
    }
  | {
      readonly status: 'unchanged';
    };

export interface RepositoryFanoutSnapshot {
  readonly schemaVersion: typeof repositoryFanoutSchemaVersion;
  readonly repositoryId: string;
  readonly generation: number;
  readonly phase: RepositoryFanoutPhase;
  readonly dirty: boolean;
  readonly lease: {
    readonly generation: number;
    readonly expiresAt: number;
  } | null;
  readonly pass: 1 | 2 | null;
  readonly cursorPresent: boolean;
  readonly pageCount: number;
  readonly restartCount: number;
  readonly pendingDeliveryCount: number;
  readonly completedDeliveryCount: number;
  readonly targetCount: number;
  readonly confirmedTargetCount: number;
  readonly failureCode: RepositoryFanoutFailureCode | null;
}

const repositoryIdPattern = /^(?:0|[1-9]\d*)$/;
const visibleAsciiPattern = /^[\x21-\x7e]{1,128}$/;

type UnknownRecord = Record<string, unknown>;

export function normalizeRepositoryFanoutRepositoryId(
  value: number | string,
): string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('repositoryId must be a number or decimal string.');
  }
  const normalized = typeof value === 'number'
    ? String(assertPositiveSafeInteger(value, 'repositoryId'))
    : value;
  if (
    !repositoryIdPattern.test(normalized)
    || normalized === '0'
    || !Number.isSafeInteger(Number(normalized))
    || String(Number(normalized)) !== normalized
  ) {
    throw new TypeError(
      'repositoryId must be a canonical positive safe-integer identifier.',
    );
  }
  return normalized;
}

export function repositoryFanoutCoordinatorName(
  repositoryId: number | string,
): string {
  return [
    repositoryFanoutCoordinatorNamePrefix,
    normalizeRepositoryFanoutRepositoryId(repositoryId),
  ].join(':');
}

export function parseRepositoryFanoutCoordinatorName(name: string): {
  readonly repositoryId: string;
} {
  if (typeof name !== 'string') {
    throw new TypeError('Durable Object name must be a string.');
  }
  const parts = name.split(':');
  if (
    parts.length !== 2
    || parts[0] !== repositoryFanoutCoordinatorNamePrefix
    || parts[1] === undefined
  ) {
    throw new TypeError(
      `Durable Object name must use `
      + `${repositoryFanoutCoordinatorNamePrefix}:<repositoryId>.`,
    );
  }
  return {
    repositoryId: normalizeRepositoryFanoutRepositoryId(parts[1]),
  };
}

export function assertRepositoryFanoutLeaseDurationMs(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > repositoryFanoutMaximumLeaseDurationMs
  ) {
    throw new TypeError(
      `leaseDurationMs must be an integer between 1 and `
      + `${repositoryFanoutMaximumLeaseDurationMs}.`,
    );
  }
  return value;
}

export function assertRepositoryFanoutGeneration(value: number): number {
  return assertPositiveSafeInteger(value, 'generation');
}

export function assertRepositoryFanoutLeaseToken(value: string): string {
  if (
    typeof value !== 'string'
    || value.length < 16
    || value.length > 256
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new TypeError(
      'leaseToken must contain 16-256 visible ASCII characters.',
    );
  }
  return value;
}

export function assertRepositoryFanoutFailureCode(
  value: RepositoryFanoutFailureCode,
): RepositoryFanoutFailureCode {
  if (!(repositoryFanoutFailureCodes as readonly string[]).includes(value)) {
    throw new TypeError('failureCode is not a supported repository fan-out code.');
  }
  return value;
}

export function assertRepositoryFanoutDispatchBatchSize(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > repositoryFanoutMaximumDispatchBatchSize
  ) {
    throw new TypeError(
      `limit must be an integer between 1 and `
      + `${repositoryFanoutMaximumDispatchBatchSize}.`,
    );
  }
  return value;
}

export function parseRepositoryFanoutQueueConfirmations(
  value: unknown,
): RepositoryFanoutQueueConfirmations {
  const root = plainRecord(value, 'confirmation receipt');
  requireExactKeys(root, ['confirmations'], 'confirmation receipt');
  if (
    !Array.isArray(root.confirmations)
    || root.confirmations.length < 1
    || root.confirmations.length > repositoryFanoutMaximumDispatchBatchSize
  ) {
    throw new TypeError(
      `confirmation receipt.confirmations must contain 1-`
      + `${repositoryFanoutMaximumDispatchBatchSize} entries.`,
    );
  }
  const confirmations = root.confirmations.map((candidate, index) => {
    const record = plainRecord(
      candidate,
      `confirmation receipt.confirmations[${index}]`,
    );
    requireExactKeys(
      record,
      ['pullRequestNumber', 'deliveryId'],
      `confirmation receipt.confirmations[${index}]`,
    );
    const deliveryId = record.deliveryId;
    if (typeof deliveryId !== 'string' || !visibleAsciiPattern.test(deliveryId)) {
      throw new TypeError(
        `confirmation receipt.confirmations[${index}].deliveryId is invalid.`,
      );
    }
    return {
      pullRequestNumber: assertPositiveSafeInteger(
        record.pullRequestNumber,
        `confirmation receipt.confirmations[${index}].pullRequestNumber`,
      ),
      deliveryId,
    };
  });
  const identities = confirmations.map(
    (confirmation) =>
      `${confirmation.pullRequestNumber}\u0000${confirmation.deliveryId}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('confirmation receipt contains duplicate entries.');
  }
  return { confirmations };
}

function plainRecord(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  return value as UnknownRecord;
}

function requireExactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  field: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length
    || actual.some(
      (key) => typeof key !== 'string' || !expected.includes(key),
    )
  ) {
    throw new TypeError(`${field} contains missing or unknown fields.`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return Number(value);
}
