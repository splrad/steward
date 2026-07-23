export const coordinatorSchemaVersion = 1;

export const completedDeliveryRetentionLimit = 128;
export const pendingDeliveryRetentionLimit = 128;
export const completedDeliveryRetentionMs = 7 * 24 * 60 * 60 * 1_000;
export const maximumLeaseDurationMs = 60 * 60 * 1_000;

export const coordinatorFailureCodes = [
  'control-error',
  'dependency-unavailable',
  'lease-expired',
  'rate-limited',
  'runtime-error',
] as const;

export type CoordinatorFailureCode = (typeof coordinatorFailureCodes)[number];

export interface PullRequestCoordinatorSubject {
  repositoryId: string;
  pullNumber: number;
}

export type PullRequestCoordinatorPhase = 'idle' | 'leased' | 'followup';
export type CoordinatorLeaseKind = 'delivery' | 'followup';

export interface CoordinatorLeaseSnapshot {
  deliveryId: string;
  expiresAt: number;
  generation: number;
}

export interface PullRequestCoordinatorSnapshot {
  completedDeliveryCount: number;
  dirty: boolean;
  failureCode: CoordinatorFailureCode | null;
  generation: number;
  lease: CoordinatorLeaseSnapshot | null;
  pendingDeliveryCount: number;
  phase: PullRequestCoordinatorPhase;
  subject: PullRequestCoordinatorSubject;
}

export type CoordinatorClaimResult =
  | {
      status: 'claimed';
      expiresAt: number;
      generation: number;
      leaseToken: string;
    }
  | {
      status: 'duplicate';
    }
  | {
      status: 'busy' | 'coalesced';
      expiresAt: number;
      generation: number;
    };

export type CoordinatorRenewResult =
  | {
      status: 'renewed';
      expiresAt: number;
      generation: number;
    }
  | {
      status: 'stale';
    };

export type CoordinatorCompleteResult =
  | {
      status: 'completed' | 'followup';
      generation: number;
    }
  | {
      status: 'stale';
    };

export type CoordinatorFailResult =
  | {
      status: 'followup';
      generation: number;
    }
  | {
      status: 'stale';
    };

export type CoordinatorAlarmResult =
  | {
      status: 'expired';
      generation: number;
    }
  | {
      status: 'unchanged';
    };

const coordinatorNamePrefix = 'steward-pr-v1';
const deliveryIdPattern = /^[\x21-\x7e]{1,128}$/;
const leaseTokenPattern = /^[\x21-\x7e]{16,256}$/;
const repositoryIdPattern = /^(?:0|[1-9]\d*)$/;

export function normalizeRepositoryId(value: number | string): string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('repositoryId must be a number or decimal string.');
  }
  const normalized =
    typeof value === 'number'
      ? String(assertPositiveSafeInteger(value, 'repositoryId'))
      : value;

  if (
    !repositoryIdPattern.test(normalized) ||
    normalized === '0' ||
    !Number.isSafeInteger(Number(normalized)) ||
    String(Number(normalized)) !== normalized
  ) {
    throw new TypeError(
      'repositoryId must be a canonical positive safe-integer identifier.',
    );
  }

  return normalized;
}

export function assertPullNumber(value: number): number {
  return assertPositiveSafeInteger(value, 'pullNumber');
}

export function assertDeliveryId(value: string): string {
  if (typeof value !== 'string' || !deliveryIdPattern.test(value)) {
    throw new TypeError(
      'deliveryId must contain 1-128 visible ASCII characters.',
    );
  }

  return value;
}

export function assertLeaseDurationMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximumLeaseDurationMs
  ) {
    throw new TypeError(
      `leaseDurationMs must be an integer between 1 and ${maximumLeaseDurationMs}.`,
    );
  }

  return value;
}

export function assertLeaseToken(value: string): string {
  if (typeof value !== 'string' || !leaseTokenPattern.test(value)) {
    throw new TypeError(
      'leaseToken must contain 16-256 visible ASCII characters.',
    );
  }

  return value;
}

export function assertGeneration(value: number): number {
  return assertPositiveSafeInteger(value, 'generation');
}

export function assertTimestamp(value: number, name = 'timestamp'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }

  return value;
}

export function assertFailureCode(
  value: CoordinatorFailureCode,
): CoordinatorFailureCode {
  if (!(coordinatorFailureCodes as readonly string[]).includes(value)) {
    throw new TypeError('failureCode is not a supported coordinator code.');
  }

  return value;
}

export function pullRequestCoordinatorName(
  repositoryId: number | string,
  pullNumber: number,
): string {
  return [
    coordinatorNamePrefix,
    normalizeRepositoryId(repositoryId),
    assertPullNumber(pullNumber),
  ].join(':');
}

export function parsePullRequestCoordinatorName(
  name: string,
): PullRequestCoordinatorSubject {
  const parts = name.split(':');
  if (parts.length !== 3 || parts[0] !== coordinatorNamePrefix) {
    throw new TypeError(
      `Durable Object name must use ${coordinatorNamePrefix}:<repositoryId>:<pullNumber>.`,
    );
  }

  const repositoryId = parts[1];
  const pullNumberText = parts[2];
  if (repositoryId === undefined || pullNumberText === undefined) {
    throw new TypeError('Durable Object name is incomplete.');
  }

  const pullNumber = Number(pullNumberText);
  if (String(pullNumber) !== pullNumberText) {
    throw new TypeError('Durable Object pull number is not canonical.');
  }

  return {
    pullNumber: assertPullNumber(pullNumber),
    repositoryId: normalizeRepositoryId(repositoryId),
  };
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }

  return value;
}
