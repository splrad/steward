export const runtimePromotionSchemaVersion = 1 as const;
export const runtimePromotionWorkers = [
  'steward-control',
  'steward-recovery',
  'steward-coordinator',
  'steward-diagnostics',
  'steward-ingress',
] as const;
export const maximumRuntimePromotionRequestBytes = 16 * 1024;
export const maximumRuntimePromotionCommandAgeMs = 5 * 60 * 1_000;
export const runtimePromotionDispatchLeaseMs = 15_000;
export const minimumRuntimePromotionResolutionQuietMs = 60_000;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const canonicalUtcTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type RuntimePromotionOperation =
  | 'stage'
  | 'promote'
  | 'canary-stop'
  | 'rollback';

export type RuntimePromotionWorker =
  typeof runtimePromotionWorkers[number];

export interface RuntimePromotionCommandV1 {
  readonly schemaVersion: typeof runtimePromotionSchemaVersion;
  readonly commandId: string;
  readonly requestedAt: string;
  readonly operation: RuntimePromotionOperation;
  readonly worker: RuntimePromotionWorker;
  readonly expectedDeploymentId: string;
  readonly stableVersionId: string;
  readonly candidateVersionId: string;
  readonly stewardCommit: string;
  readonly candidatePercentage: number;
}

export interface RuntimePromotionUnknownResolutionV1 {
  readonly schemaVersion: typeof runtimePromotionSchemaVersion;
  readonly requestedAt: string;
  readonly operation: 'abandon';
  readonly commandId: string;
  readonly worker: RuntimePromotionWorker;
  readonly expectedBefore: RuntimePromotionDeployment;
}

export interface RuntimePromotionVersion {
  readonly versionId: string;
  readonly percentage: number;
}

export interface RuntimePromotionDeployment {
  readonly id: string;
  readonly versions: readonly RuntimePromotionVersion[];
}

export type RuntimePromotionLedgerState =
  | 'dispatching'
  | 'unknown'
  | 'staged'
  | 'promoted'
  | 'canary-stopped'
  | 'rolled-back'
  | 'superseded'
  | 'abandoned'
  | 'rejected';

export interface RuntimePromotionLedgerEntry {
  readonly command: RuntimePromotionCommandV1;
  readonly principal: string;
  readonly state: RuntimePromotionLedgerState;
  readonly before: RuntimePromotionDeployment;
  readonly desired: RuntimePromotionDeployment;
  readonly after: RuntimePromotionDeployment | null;
  readonly updatedAt: string;
}

export interface RuntimePromotionBeginResult {
  readonly status: 'begun' | 'recover' | 'completed' | 'busy';
  readonly entry: RuntimePromotionLedgerEntry;
}

export interface RuntimePromotionAbandonResult {
  readonly status: 'abandoned' | 'completed' | 'too-early';
  readonly entry: RuntimePromotionLedgerEntry;
}

export class RuntimePromotionValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime promotion command: ${message}`);
    this.name = 'RuntimePromotionValidationError';
  }
}

function invalid(message: string): never {
  throw new RuntimePromotionValidationError(message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    invalid(`${field} has unsupported or missing fields`);
  }
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') invalid(`${field} must be a non-empty string`);
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = exactString(value, field);
  if (!uuidPattern.test(parsed)) invalid(`${field} must be a lowercase UUID`);
  return parsed;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const parsed = exactString(value, field);
  if (
    !canonicalUtcTimestampPattern.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) {
    invalid(`${field} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function worker(value: unknown): RuntimePromotionWorker {
  const parsed = exactString(value, 'worker');
  if (!(runtimePromotionWorkers as readonly string[]).includes(parsed)) {
    invalid(`worker must be one of ${runtimePromotionWorkers.join(', ')}`);
  }
  return parsed as RuntimePromotionWorker;
}

function strictRuntimePromotionDeployment(
  value: unknown,
  field: string,
): RuntimePromotionDeployment {
  const deployment = record(value, field);
  exactKeys(deployment, ['id', 'versions'], field);
  if (!Array.isArray(deployment.versions)) {
    invalid(`${field}.versions must be an array`);
  }
  return canonicalRuntimePromotionDeployment({
    id: uuid(deployment.id, `${field}.id`),
    versions: deployment.versions.map((candidate, index) => {
      const version = record(candidate, `${field}.versions[${index}]`);
      exactKeys(
        version,
        ['versionId', 'percentage'],
        `${field}.versions[${index}]`,
      );
      if (
        typeof version.percentage !== 'number'
        || !Number.isFinite(version.percentage)
      ) {
        invalid(`${field}.versions[${index}].percentage must be finite`);
      }
      return {
        versionId: uuid(
          version.versionId,
          `${field}.versions[${index}].versionId`,
        ),
        percentage: version.percentage,
      };
    }),
  });
}

export function parseRuntimePromotionCommand(
  value: unknown,
): RuntimePromotionCommandV1 {
  const command = record(value, 'command');
  exactKeys(command, [
    'schemaVersion',
    'commandId',
    'requestedAt',
    'operation',
    'worker',
    'expectedDeploymentId',
    'stableVersionId',
    'candidateVersionId',
    'stewardCommit',
    'candidatePercentage',
  ], 'command');
  if (command.schemaVersion !== runtimePromotionSchemaVersion) {
    invalid('schemaVersion must be 1');
  }
  const operation = exactString(command.operation, 'operation');
  if (!['stage', 'promote', 'canary-stop', 'rollback'].includes(operation)) {
    invalid('operation is unsupported');
  }
  const parsedWorker = worker(command.worker);
  const requestedAt = canonicalTimestamp(command.requestedAt, 'requestedAt');
  const stableVersionId = uuid(command.stableVersionId, 'stableVersionId');
  const candidateVersionId = uuid(
    command.candidateVersionId,
    'candidateVersionId',
  );
  if (
    !Number.isInteger(command.candidatePercentage)
    || Number(command.candidatePercentage) < 0
    || Number(command.candidatePercentage) > 100
  ) {
    invalid('candidatePercentage must be an integer from 0 through 100');
  }
  const candidatePercentage = Number(command.candidatePercentage);
  if (operation === 'promote' && candidatePercentage < 1) {
    invalid('promote requires a positive candidatePercentage');
  }
  if (operation !== 'promote' && candidatePercentage !== 0) {
    invalid(`${operation} requires candidatePercentage 0`);
  }
  const stewardCommit = exactString(command.stewardCommit, 'stewardCommit');
  if (!commitPattern.test(stewardCommit)) {
    invalid('stewardCommit must be a lowercase 40-character commit SHA');
  }
  return {
    schemaVersion: runtimePromotionSchemaVersion,
    commandId: uuid(command.commandId, 'commandId'),
    requestedAt,
    operation: operation as RuntimePromotionOperation,
    worker: parsedWorker,
    expectedDeploymentId: uuid(
      command.expectedDeploymentId,
      'expectedDeploymentId',
    ),
    stableVersionId,
    candidateVersionId,
    stewardCommit,
    candidatePercentage,
  };
}

export function parseRuntimePromotionUnknownResolution(
  value: unknown,
): RuntimePromotionUnknownResolutionV1 {
  const resolution = record(value, 'resolution');
  exactKeys(resolution, [
    'schemaVersion',
    'requestedAt',
    'operation',
    'commandId',
    'worker',
    'expectedBefore',
  ], 'resolution');
  if (resolution.schemaVersion !== runtimePromotionSchemaVersion) {
    invalid('schemaVersion must be 1');
  }
  if (resolution.operation !== 'abandon') {
    invalid('resolution operation must be abandon');
  }
  return {
    schemaVersion: runtimePromotionSchemaVersion,
    requestedAt: canonicalTimestamp(resolution.requestedAt, 'requestedAt'),
    operation: 'abandon',
    commandId: uuid(resolution.commandId, 'commandId'),
    worker: worker(resolution.worker),
    expectedBefore: strictRuntimePromotionDeployment(
      resolution.expectedBefore,
      'expectedBefore',
    ),
  };
}

export function assertFreshRuntimePromotionCommand(
  command: RuntimePromotionCommandV1,
  now: Date,
): void {
  const age = now.getTime() - Date.parse(command.requestedAt);
  if (age < 0 || age > maximumRuntimePromotionCommandAgeMs) {
    invalid('requestedAt is outside the allowed freshness window');
  }
}

export function assertFreshRuntimePromotionResolution(
  resolution: RuntimePromotionUnknownResolutionV1,
  now: Date,
): void {
  const age = now.getTime() - Date.parse(resolution.requestedAt);
  if (age < 0 || age > maximumRuntimePromotionCommandAgeMs) {
    invalid('requestedAt is outside the allowed freshness window');
  }
}

export function desiredRuntimePromotionDeployment(
  command: RuntimePromotionCommandV1,
): RuntimePromotionDeployment {
  if (
    command.stableVersionId === command.candidateVersionId
    || command.operation === 'rollback'
  ) {
    return canonicalRuntimePromotionDeployment({
      id: command.expectedDeploymentId,
      versions: [{
        versionId: command.stableVersionId,
        percentage: 100,
      }],
    });
  }
  return canonicalRuntimePromotionDeployment({
    id: command.expectedDeploymentId,
    versions: [
      {
        versionId: command.stableVersionId,
        percentage: 100 - command.candidatePercentage,
      },
      {
        versionId: command.candidateVersionId,
        percentage: command.candidatePercentage,
      },
    ],
  });
}

export function canonicalRuntimePromotionDeployment(
  value: RuntimePromotionDeployment,
): RuntimePromotionDeployment {
  if (!uuidPattern.test(value.id)) {
    invalid('deployment.id must be a lowercase UUID');
  }
  if (value.versions.length < 1 || value.versions.length > 2) {
    invalid('deployment must contain one or two versions');
  }
  const versions = value.versions.map((item) => {
    if (!uuidPattern.test(item.versionId)) {
      invalid('deployment versionId must be a lowercase UUID');
    }
    if (
      typeof item.percentage !== 'number'
      || !Number.isFinite(item.percentage)
      || item.percentage < 0
      || item.percentage > 100
    ) {
      invalid('deployment percentage must be finite and between 0 and 100');
    }
    return {
      versionId: item.versionId,
      percentage: item.percentage,
    };
  }).sort((left, right) => left.versionId.localeCompare(right.versionId));
  if (
    new Set(versions.map((item) => item.versionId)).size !== versions.length
    || Math.abs(versions.reduce((sum, item) => sum + item.percentage, 0) - 100)
      > 0.001
  ) {
    invalid('deployment versions must be unique and total 100 percent');
  }
  return { id: value.id, versions };
}

export function sameRuntimePromotionTraffic(
  left: RuntimePromotionDeployment,
  right: RuntimePromotionDeployment,
): boolean {
  return JSON.stringify(canonicalRuntimePromotionDeployment({
    ...left,
    id: right.id,
  })) === JSON.stringify(canonicalRuntimePromotionDeployment(right));
}

export function canonicalRuntimePromotionCommandJson(value: unknown): string {
  return JSON.stringify(parseRuntimePromotionCommand(value));
}

export function canonicalRuntimePromotionDeploymentJson(
  value: RuntimePromotionDeployment,
): string {
  return JSON.stringify(canonicalRuntimePromotionDeployment(value));
}
