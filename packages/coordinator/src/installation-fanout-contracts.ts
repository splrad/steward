import type {
  StewardRuntimeInstallationFanoutRootV1,
  StewardRuntimeInstallationFanoutStateV1,
} from '../../core/src/runtime-installation-fanout.js';
import type {
  StewardRuntimeInstallationIndexBootstrapEnvelopeV1,
  StewardRuntimeInstallationIndexBootstrapStatusReceiptV1,
} from '../../core/src/runtime-installation-index-bootstrap.js';

export const installationFanoutSchemaVersion = 1;
export const installationFanoutCoordinatorNamePrefix =
  'steward-installation-fanout-v1';
export const installationFanoutCompletedDeliveryRetentionLimit = 128;
export const installationFanoutPendingDeliveryRetentionLimit = 128;
export const installationFanoutCompletedDeliveryRetentionMs =
  7 * 24 * 60 * 60 * 1_000;
export const installationFanoutMaximumLeaseDurationMs = 60 * 60 * 1_000;
export const installationFanoutMaximumDispatchBatchSize = 100;

export const installationFanoutFailureCodes = [
  'dependency-unavailable',
  'last-known-index-unavailable',
  'lease-expired',
  'pagination-conflict',
  'pagination-drift',
  'pagination-limit',
  'queue-error',
  'runtime-error',
] as const;

export type InstallationFanoutFailureCode =
  (typeof installationFanoutFailureCodes)[number];

export type InstallationFanoutPhase =
  | 'idle'
  | 'enumerating'
  | 'dispatch'
  | 'followup';

export type InstallationFanoutTargetSource =
  | 'live'
  | 'last-known'
  | 'explicit';

export interface InstallationFanoutDispatchTarget {
  readonly repositoryId: number;
  readonly deliveryId: string;
}

export interface InstallationFanoutQueueConfirmation {
  readonly repositoryId: number;
  readonly deliveryId: string;
}

export interface InstallationFanoutQueueConfirmations {
  readonly confirmations: readonly InstallationFanoutQueueConfirmation[];
}

export type InstallationFanoutClaimResult =
  | {
      readonly status: 'claimed';
      readonly generation: number;
      readonly leaseToken: string;
      readonly expiresAt: number;
      readonly resumed: boolean;
      readonly selectedRoot: StewardRuntimeInstallationFanoutRootV1;
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

export type InstallationFanoutRecordPageResult =
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
      readonly installationState: StewardRuntimeInstallationFanoutStateV1;
      readonly targetSource: InstallationFanoutTargetSource;
      readonly targetCount: number;
    }
  | {
      readonly status: 'failed-closed';
      readonly generation: number;
      readonly reason:
        | 'last-known-index-unavailable'
        | 'pagination-conflict'
        | 'pagination-drift'
        | 'pagination-limit';
    }
  | {
      readonly status: 'conflict' | 'stale';
    };

export type InstallationFanoutNextDispatchBatchResult =
  | {
      readonly status: 'batch';
      readonly generation: number;
      readonly installationState:
        | StewardRuntimeInstallationFanoutStateV1
        | null;
      readonly targetSource: InstallationFanoutTargetSource;
      readonly targets: readonly InstallationFanoutDispatchTarget[];
      readonly remaining: number;
    }
  | {
      readonly status: 'not-ready' | 'stale';
    };

export type InstallationFanoutRecordQueueConfirmedResult =
  | {
      readonly status: 'recorded';
      readonly generation: number;
      readonly newlyConfirmed: number;
      readonly remaining: number;
    }
  | {
      readonly status: 'conflict' | 'stale';
    };

export type InstallationFanoutCompleteResult =
  | {
      readonly status: 'completed' | 'followup';
      readonly generation: number;
    }
  | {
      readonly status: 'not-ready' | 'stale';
    };

export type InstallationFanoutFailResult =
  | {
      readonly status: 'resumable';
      readonly generation: number;
    }
  | {
      readonly status: 'stale';
    };

export type InstallationFanoutReleaseForContinuationResult =
  | {
      readonly status: 'released';
      readonly generation: number;
    }
  | {
      readonly status: 'stale';
    };

export interface InstallationFanoutSnapshot {
  readonly schemaVersion: typeof installationFanoutSchemaVersion;
  readonly installationId: string;
  readonly generation: number;
  readonly phase: InstallationFanoutPhase;
  readonly dirty: boolean;
  readonly lease: {
    readonly generation: number;
    readonly expiresAt: number;
  } | null;
  readonly pass: 1 | 2 | null;
  readonly cursorPresent: boolean;
  readonly pageCount: number;
  readonly pendingDeliveryCount: number;
  readonly completedDeliveryCount: number;
  readonly selectedRootDigest: string | null;
  readonly selectedRootDeliveryId: string | null;
  readonly selectedRootTargetScope:
    | 'installation'
    | 'repository-set'
    | null;
  readonly installationState:
    | StewardRuntimeInstallationFanoutStateV1
    | null;
  readonly targetSource: InstallationFanoutTargetSource | null;
  readonly targetCount: number;
  readonly confirmedTargetCount: number;
  readonly lastKnownIndexKnown: boolean;
  readonly lastKnownRepositoryCount: number;
  readonly failureCode: InstallationFanoutFailureCode | null;
}

export type InstallationIndexBootstrapFailureCode =
  NonNullable<
    StewardRuntimeInstallationIndexBootstrapStatusReceiptV1['failureCode']
  >;

export type InstallationIndexBootstrapClaimResult =
  | {
      readonly status: 'claimed';
      readonly leaseToken: string;
      readonly expiresAt: number;
      readonly resumed: boolean;
      readonly command:
        StewardRuntimeInstallationIndexBootstrapEnvelopeV1;
      readonly commandDigest: string;
      readonly phase: 'enumerating' | 'finalizing';
      readonly pass: 1 | 2 | null;
      readonly cursor: string | null;
    }
  | {
      readonly status: 'duplicate';
      readonly receipt:
        StewardRuntimeInstallationIndexBootstrapStatusReceiptV1;
    }
  | {
      readonly status: 'busy';
      readonly expiresAt: number | null;
    }
  | {
      readonly status: 'conflict';
    };

export type InstallationIndexBootstrapRecordPageResult =
  | {
      readonly status: 'accepted' | 'duplicate';
      readonly pass: 1 | 2;
      readonly hasNextPage: boolean;
    }
  | {
      readonly status: 'pass-complete';
      readonly nextPass: 2;
    }
  | {
      readonly status: 'completed';
      readonly receipt:
        StewardRuntimeInstallationIndexBootstrapStatusReceiptV1;
    }
  | {
      readonly status: 'failed';
      readonly receipt:
        StewardRuntimeInstallationIndexBootstrapStatusReceiptV1;
    }
  | {
      readonly status: 'conflict' | 'stale';
    };

export type InstallationIndexBootstrapReleaseResult =
  | { readonly status: 'released' }
  | { readonly status: 'stale' };

export type InstallationIndexBootstrapFailResult =
  | {
      readonly status: 'failed';
      readonly receipt:
        StewardRuntimeInstallationIndexBootstrapStatusReceiptV1;
    }
  | { readonly status: 'stale' };

export type InstallationIndexBootstrapFinalizeResult =
  | {
      readonly status: 'completed';
      readonly receipt:
        StewardRuntimeInstallationIndexBootstrapStatusReceiptV1;
    }
  | { readonly status: 'not-ready' | 'stale' };

const installationIdPattern = /^(?:0|[1-9]\d*)$/;
const deliveryIdPattern =
  /^installation-fanout-v1:[0-9a-f]{64}:[1-9]\d*:[1-9]\d*$/;

type UnknownRecord = Record<string, unknown>;

export function normalizeInstallationFanoutInstallationId(
  value: number | string,
): string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('installationId must be a number or decimal string.');
  }
  const normalized = typeof value === 'number'
    ? String(assertPositiveSafeInteger(value, 'installationId'))
    : value;
  if (
    !installationIdPattern.test(normalized)
    || normalized === '0'
    || !Number.isSafeInteger(Number(normalized))
    || String(Number(normalized)) !== normalized
  ) {
    throw new TypeError(
      'installationId must be a canonical positive safe-integer identifier.',
    );
  }
  return normalized;
}

export function installationFanoutCoordinatorName(
  installationId: number | string,
): string {
  return [
    installationFanoutCoordinatorNamePrefix,
    normalizeInstallationFanoutInstallationId(installationId),
  ].join(':');
}

export function parseInstallationFanoutCoordinatorName(name: string): {
  readonly installationId: string;
} {
  if (typeof name !== 'string') {
    throw new TypeError('Durable Object name must be a string.');
  }
  const parts = name.split(':');
  if (
    parts.length !== 2
    || parts[0] !== installationFanoutCoordinatorNamePrefix
    || parts[1] === undefined
  ) {
    throw new TypeError(
      `Durable Object name must use `
      + `${installationFanoutCoordinatorNamePrefix}:<installationId>.`,
    );
  }
  return {
    installationId: normalizeInstallationFanoutInstallationId(parts[1]),
  };
}

export function assertInstallationFanoutLeaseDurationMs(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > installationFanoutMaximumLeaseDurationMs
  ) {
    throw new TypeError(
      `leaseDurationMs must be an integer between 1 and `
      + `${installationFanoutMaximumLeaseDurationMs}.`,
    );
  }
  return value;
}

export function assertInstallationFanoutGeneration(value: number): number {
  return assertPositiveSafeInteger(value, 'generation');
}

export function assertInstallationFanoutLeaseToken(value: string): string {
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

export function assertInstallationFanoutFailureCode(
  value: InstallationFanoutFailureCode,
): InstallationFanoutFailureCode {
  if (!(installationFanoutFailureCodes as readonly string[]).includes(value)) {
    throw new TypeError(
      'failureCode is not a supported installation fan-out code.',
    );
  }
  return value;
}

export function assertInstallationFanoutDispatchBatchSize(
  value: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > installationFanoutMaximumDispatchBatchSize
  ) {
    throw new TypeError(
      `limit must be an integer between 1 and `
      + `${installationFanoutMaximumDispatchBatchSize}.`,
    );
  }
  return value;
}

export function parseInstallationFanoutQueueConfirmations(
  value: unknown,
): InstallationFanoutQueueConfirmations {
  const root = plainRecord(value, 'confirmation receipt');
  requireExactKeys(root, ['confirmations'], 'confirmation receipt');
  if (
    !Array.isArray(root.confirmations)
    || root.confirmations.length < 1
    || root.confirmations.length > installationFanoutMaximumDispatchBatchSize
  ) {
    throw new TypeError(
      `confirmation receipt.confirmations must contain 1-`
      + `${installationFanoutMaximumDispatchBatchSize} entries.`,
    );
  }
  const confirmations = root.confirmations.map((candidate, index) => {
    const field = `confirmation receipt.confirmations[${index}]`;
    const record = plainRecord(candidate, field);
    requireExactKeys(record, ['repositoryId', 'deliveryId'], field);
    if (
      typeof record.deliveryId !== 'string'
      || !deliveryIdPattern.test(record.deliveryId)
    ) {
      throw new TypeError(`${field}.deliveryId is invalid.`);
    }
    return {
      repositoryId: assertPositiveSafeInteger(
        record.repositoryId,
        `${field}.repositoryId`,
      ),
      deliveryId: record.deliveryId,
    };
  });
  const identities = confirmations.map(
    (confirmation) =>
      `${confirmation.repositoryId}\u0000${confirmation.deliveryId}`,
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
