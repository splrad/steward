export const STEWARD_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

const commitPattern = /^[0-9a-f]{40}$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const canonicalUtcTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const opaqueAsciiPattern = /^[\x20-\x7e]{1,128}$/;

export interface StewardRuntimeDiagnosticsSubjectV1 {
  readonly repositoryId: number;
  readonly repositoryFullName: string;
}

// V1 deliberately carries only immutable revision identifiers. The earlier
// TypeScript-only placeholder exposed an unused optional deployedAt field, but
// no live wire ever implemented it; any future deployment timestamp must enter
// through a new versioned schema instead of weakening this exact-key contract.
export interface StewardControlRevisionV1 {
  readonly stewardCommit: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly environment: 'candidate' | 'canary' | 'production';
}

export interface StewardRuntimeDiagnosticsV1 {
  readonly controlRevision: StewardControlRevisionV1;
  readonly queue: 'ready' | 'degraded';
  readonly control: 'ready' | 'degraded';
  readonly deadLetterQueue: 'clear' | 'pending' | 'unavailable';
}

export interface StewardRuntimeDiagnosticsEnvelopeV1 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION;
  readonly subject: StewardRuntimeDiagnosticsSubjectV1;
  readonly observedAt: string;
  readonly diagnostics: StewardRuntimeDiagnosticsV1;
}

export type BuildStewardRuntimeDiagnosticsEnvelopeInput =
  Omit<StewardRuntimeDiagnosticsEnvelopeV1, 'schemaVersion'>;

export class RuntimeDiagnosticsValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime diagnostics: ${message}`);
    this.name = 'RuntimeDiagnosticsValidationError';
  }
}

function invalid(message: string): never {
  throw new RuntimeDiagnosticsValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  subject: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length
    || actual.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    invalid(`${subject} contains missing or unknown fields`);
  }
}

function requirePositiveId(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  return value;
}

function requireRepositoryFullName(value: unknown, field: string): string {
  const fullName = requireString(value, field);
  const parts = fullName.split('/');
  if (
    parts.length !== 2
    || !githubLoginPattern.test(parts[0] ?? '')
    || !repositoryNamePattern.test(parts[1] ?? '')
  ) {
    invalid(`${field} must be a canonical GitHub owner/repository name`);
  }
  return fullName;
}

function requireCanonicalUtcTimestamp(value: unknown): string {
  const timestamp = requireString(value, 'envelope.observedAt');
  if (
    !canonicalUtcTimestampPattern.test(timestamp)
    || Number.isNaN(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp
  ) {
    invalid('envelope.observedAt must be a canonical UTC Date.toISOString timestamp');
  }
  return timestamp;
}

function requireCommit(value: unknown): string {
  const commit = requireString(value, 'envelope.diagnostics.controlRevision.stewardCommit');
  if (!commitPattern.test(commit)) {
    invalid('envelope.diagnostics.controlRevision.stewardCommit must be a lowercase 40-character commit SHA');
  }
  return commit;
}

function requireOpaqueAscii(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!opaqueAsciiPattern.test(text) || text !== text.trim()) {
    invalid(`${field} must be 1-128 canonical printable ASCII characters`);
  }
  return text;
}

function requireEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    invalid(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as Value;
}

function parseSubject(
  value: unknown,
  field: string,
): StewardRuntimeDiagnosticsSubjectV1 {
  if (!isPlainObject(value)) invalid(`${field} must be a plain object`);
  requireExactKeys(value, ['repositoryId', 'repositoryFullName'], field);
  return {
    repositoryId: requirePositiveId(
      value.repositoryId,
      `${field}.repositoryId`,
    ),
    repositoryFullName: requireRepositoryFullName(
      value.repositoryFullName,
      `${field}.repositoryFullName`,
    ),
  };
}

export function parseStewardRuntimeDiagnosticsSubject(
  value: unknown,
): StewardRuntimeDiagnosticsSubjectV1 {
  return parseSubject(value, 'subject');
}

export function parseStewardRuntimeDiagnosticsEnvelope(
  value: unknown,
): StewardRuntimeDiagnosticsEnvelopeV1 {
  if (!isPlainObject(value)) invalid('envelope must be a plain object');
  requireExactKeys(value, ['schemaVersion', 'subject', 'observedAt', 'diagnostics'], 'envelope');
  if (value.schemaVersion !== STEWARD_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION) {
    invalid('envelope.schemaVersion must be 1');
  }

  if (!isPlainObject(value.diagnostics)) {
    invalid('envelope.diagnostics must be a plain object');
  }
  requireExactKeys(
    value.diagnostics,
    ['controlRevision', 'queue', 'control', 'deadLetterQueue'],
    'envelope.diagnostics',
  );

  if (!isPlainObject(value.diagnostics.controlRevision)) {
    invalid('envelope.diagnostics.controlRevision must be a plain object');
  }
  requireExactKeys(
    value.diagnostics.controlRevision,
    ['stewardCommit', 'workerVersionId', 'workerDeploymentId', 'environment'],
    'envelope.diagnostics.controlRevision',
  );

  return {
    schemaVersion: STEWARD_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    subject: parseSubject(value.subject, 'envelope.subject'),
    observedAt: requireCanonicalUtcTimestamp(value.observedAt),
    diagnostics: {
      controlRevision: {
        stewardCommit: requireCommit(value.diagnostics.controlRevision.stewardCommit),
        workerVersionId: requireOpaqueAscii(
          value.diagnostics.controlRevision.workerVersionId,
          'envelope.diagnostics.controlRevision.workerVersionId',
        ),
        workerDeploymentId: requireOpaqueAscii(
          value.diagnostics.controlRevision.workerDeploymentId,
          'envelope.diagnostics.controlRevision.workerDeploymentId',
        ),
        environment: requireEnum(
          value.diagnostics.controlRevision.environment,
          ['candidate', 'canary', 'production'],
          'envelope.diagnostics.controlRevision.environment',
        ),
      },
      queue: requireEnum(
        value.diagnostics.queue,
        ['ready', 'degraded'],
        'envelope.diagnostics.queue',
      ),
      control: requireEnum(
        value.diagnostics.control,
        ['ready', 'degraded'],
        'envelope.diagnostics.control',
      ),
      deadLetterQueue: requireEnum(
        value.diagnostics.deadLetterQueue,
        ['clear', 'pending', 'unavailable'],
        'envelope.diagnostics.deadLetterQueue',
      ),
    },
  };
}

export function buildStewardRuntimeDiagnosticsEnvelope(
  value: BuildStewardRuntimeDiagnosticsEnvelopeInput,
): StewardRuntimeDiagnosticsEnvelopeV1 {
  if (!isPlainObject(value)) invalid('builder input must be a plain object');
  requireExactKeys(value, ['subject', 'observedAt', 'diagnostics'], 'builder input');
  return parseStewardRuntimeDiagnosticsEnvelope({
    schemaVersion: STEWARD_RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    subject: value.subject,
    observedAt: value.observedAt,
    diagnostics: value.diagnostics,
  });
}

export function canonicalStewardRuntimeDiagnosticsJson(value: unknown): string {
  const envelope = parseStewardRuntimeDiagnosticsEnvelope(value);
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    subject: {
      repositoryId: envelope.subject.repositoryId,
      repositoryFullName: envelope.subject.repositoryFullName,
    },
    observedAt: envelope.observedAt,
    diagnostics: {
      controlRevision: {
        stewardCommit: envelope.diagnostics.controlRevision.stewardCommit,
        workerVersionId: envelope.diagnostics.controlRevision.workerVersionId,
        workerDeploymentId: envelope.diagnostics.controlRevision.workerDeploymentId,
        environment: envelope.diagnostics.controlRevision.environment,
      },
      queue: envelope.diagnostics.queue,
      control: envelope.diagnostics.control,
      deadLetterQueue: envelope.diagnostics.deadLetterQueue,
    },
  });
}

export function canonicalStewardRuntimeDiagnosticsSnapshotJson(value: unknown): string {
  const envelope = parseStewardRuntimeDiagnosticsEnvelope(value);
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    subject: {
      repositoryId: envelope.subject.repositoryId,
      repositoryFullName: envelope.subject.repositoryFullName,
    },
    diagnostics: {
      controlRevision: {
        stewardCommit: envelope.diagnostics.controlRevision.stewardCommit,
        workerVersionId: envelope.diagnostics.controlRevision.workerVersionId,
        workerDeploymentId: envelope.diagnostics.controlRevision.workerDeploymentId,
        environment: envelope.diagnostics.controlRevision.environment,
      },
      queue: envelope.diagnostics.queue,
      control: envelope.diagnostics.control,
      deadLetterQueue: envelope.diagnostics.deadLetterQueue,
    },
  });
}
