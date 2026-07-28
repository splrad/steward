import {
  RuntimeControlProtocolValidationError,
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from './runtime-control.js';
import {
  STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_CURSOR_LENGTH,
  STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES,
  STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_REPOSITORIES,
  STEWARD_RUNTIME_INSTALLATION_FANOUT_PAGE_SIZE,
  type StewardRuntimeInstallationFanoutPageV1,
  type StewardRuntimeInstallationFanoutStateV1,
} from './runtime-installation-fanout.js';

export const STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION =
  1 as const;
export const STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_MAXIMUM_REQUEST_BYTES =
  16 * 1024;

export interface StewardRuntimeInstallationIndexBootstrapCommandV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION;
  readonly operation: 'installation-index-bootstrap';
  readonly requestId: string;
  readonly requestedAt: string;
  readonly installationId: number;
  readonly expectedControlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeInstallationIndexBootstrapStatusCommandV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION;
  readonly operation: 'inspect-installation-index-bootstrap';
  readonly requestId: string;
  readonly requestedAt: string;
  readonly bootstrapRequestId: string;
  readonly installationId: number;
  readonly expectedBootstrapDigest: string;
}

export interface StewardRuntimeInstallationIndexBootstrapPrincipalV1 {
  readonly accessServiceClientId: string;
}

/**
 * An operator-authorized bootstrap command. This is intentionally independent
 * from ScopeWorkItem: it makes no claim that a GitHub webhook caused the scan.
 */
export interface StewardRuntimeInstallationIndexBootstrapEnvelopeV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION;
  readonly operation: 'installation-index-bootstrap';
  readonly requestId: string;
  readonly requestedAt: string;
  readonly installationId: number;
  readonly expectedControlRevision: StewardRuntimeControlRevisionV1;
  readonly principal: StewardRuntimeInstallationIndexBootstrapPrincipalV1;
}

export interface StewardRuntimeInstallationIndexBootstrapBindingV1 {
  readonly command: StewardRuntimeInstallationIndexBootstrapEnvelopeV1;
  readonly commandDigest: string;
  readonly pass: 1 | 2;
  readonly cursor: string | null;
}

export interface StewardRuntimeInstallationIndexBootstrapPageRequestV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION;
  readonly phase: 'enumerate-index-page';
  readonly binding: StewardRuntimeInstallationIndexBootstrapBindingV1;
}

export interface StewardRuntimeInstallationIndexBootstrapPageReceiptV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION;
  readonly phase: 'enumerated-index-page';
  readonly binding: StewardRuntimeInstallationIndexBootstrapBindingV1;
  readonly installation: {
    readonly state: StewardRuntimeInstallationFanoutStateV1;
    readonly id: number;
  };
  readonly page: StewardRuntimeInstallationFanoutPageV1;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export type StewardRuntimeInstallationIndexBootstrapStatusV1 =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION;
  readonly operation: 'installation-index-bootstrap-status';
  readonly requestId: string;
  readonly commandDigest: string;
  readonly installationId: number;
  readonly status: StewardRuntimeInstallationIndexBootstrapStatusV1;
  readonly lastKnownIndexKnown: boolean;
  readonly repositoryCount: number;
  readonly indexDigest: string | null;
  readonly controlRevision: StewardRuntimeControlRevisionV1 | null;
  readonly failureCode:
    | 'control-revision-conflict'
    | 'installation-absent'
    | 'installation-suspended'
    | 'pagination-conflict'
    | 'pagination-drift'
    | 'pagination-limit'
    | 'runtime-error'
    | null;
  readonly updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const visibleAsciiPattern = /^[\x21-\x7e]+$/;

function invalid(message: string): never {
  throw new RuntimeControlProtocolValidationError(message);
}

function plainRecord(value: unknown, field: string): UnknownRecord {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    invalid(`${field} must be a plain object`);
  }
  return value as UnknownRecord;
}

function exactKeys(
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
    invalid(`${field} contains missing or unknown fields`);
  }
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requestId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    invalid(`${field} must be a canonical UUID`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) {
    invalid(`${field} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    invalid(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    invalid(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function principal(value: unknown): StewardRuntimeInstallationIndexBootstrapPrincipalV1 {
  const record = plainRecord(value, 'principal');
  exactKeys(record, ['accessServiceClientId'], 'principal');
  if (
    typeof record.accessServiceClientId !== 'string'
    || record.accessServiceClientId.length < 1
    || record.accessServiceClientId.length > 256
    || record.accessServiceClientId !== record.accessServiceClientId.trim()
    || !visibleAsciiPattern.test(record.accessServiceClientId)
  ) {
    invalid('principal.accessServiceClientId is invalid');
  }
  return { accessServiceClientId: record.accessServiceClientId };
}

function revision(
  value: unknown,
  field: string,
): StewardRuntimeControlRevisionV1 {
  try {
    return parseStewardRuntimeControlRevision(value);
  } catch {
    return invalid(`${field} is invalid`);
  }
}

function revisionValue(value: StewardRuntimeControlRevisionV1): UnknownRecord {
  return {
    stewardCommit: value.stewardCommit,
    workerVersionId: value.workerVersionId,
    workerVersionTag: value.workerVersionTag,
    workerVersionCreatedAt: value.workerVersionCreatedAt,
  };
}

function commandValue(
  value: StewardRuntimeInstallationIndexBootstrapCommandV1,
): UnknownRecord {
  return {
    schemaVersion: value.schemaVersion,
    operation: value.operation,
    requestId: value.requestId,
    requestedAt: value.requestedAt,
    installationId: value.installationId,
    expectedControlRevision: revisionValue(value.expectedControlRevision),
  };
}

function envelopeValue(
  value: StewardRuntimeInstallationIndexBootstrapEnvelopeV1,
): UnknownRecord {
  return {
    ...commandValue(value),
    principal: {
      accessServiceClientId: value.principal.accessServiceClientId,
    },
  };
}

export function parseStewardRuntimeInstallationIndexBootstrapCommandV1(
  value: unknown,
): StewardRuntimeInstallationIndexBootstrapCommandV1 {
  const record = plainRecord(value, 'installation index bootstrap command');
  exactKeys(record, [
    'schemaVersion',
    'operation',
    'requestId',
    'requestedAt',
    'installationId',
    'expectedControlRevision',
  ], 'installation index bootstrap command');
  if (
    record.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION
    || record.operation !== 'installation-index-bootstrap'
  ) {
    invalid('installation index bootstrap command identity is invalid');
  }
  return {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    operation: 'installation-index-bootstrap',
    requestId: requestId(record.requestId, 'requestId'),
    requestedAt: timestamp(record.requestedAt, 'requestedAt'),
    installationId: positiveSafeInteger(
      record.installationId,
      'installationId',
    ),
    expectedControlRevision: revision(
      record.expectedControlRevision,
      'expectedControlRevision',
    ),
  };
}

export function canonicalStewardRuntimeInstallationIndexBootstrapCommandV1Json(
  value: unknown,
): string {
  return JSON.stringify(commandValue(
    parseStewardRuntimeInstallationIndexBootstrapCommandV1(value),
  ));
}

export function parseStewardRuntimeInstallationIndexBootstrapStatusCommandV1(
  value: unknown,
): StewardRuntimeInstallationIndexBootstrapStatusCommandV1 {
  const record = plainRecord(
    value,
    'installation index bootstrap status command',
  );
  exactKeys(record, [
    'schemaVersion',
    'operation',
    'requestId',
    'requestedAt',
    'bootstrapRequestId',
    'installationId',
    'expectedBootstrapDigest',
  ], 'installation index bootstrap status command');
  if (
    record.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION
    || record.operation !== 'inspect-installation-index-bootstrap'
  ) {
    invalid('installation index bootstrap status command identity is invalid');
  }
  return {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    operation: 'inspect-installation-index-bootstrap',
    requestId: requestId(record.requestId, 'requestId'),
    requestedAt: timestamp(record.requestedAt, 'requestedAt'),
    bootstrapRequestId: requestId(
      record.bootstrapRequestId,
      'bootstrapRequestId',
    ),
    installationId: positiveSafeInteger(
      record.installationId,
      'installationId',
    ),
    expectedBootstrapDigest: digest(
      record.expectedBootstrapDigest,
      'expectedBootstrapDigest',
    ),
  };
}

export function parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(
  value: unknown,
): StewardRuntimeInstallationIndexBootstrapEnvelopeV1 {
  const record = plainRecord(value, 'installation index bootstrap envelope');
  exactKeys(record, [
    'schemaVersion',
    'operation',
    'requestId',
    'requestedAt',
    'installationId',
    'expectedControlRevision',
    'principal',
  ], 'installation index bootstrap envelope');
  const command = parseStewardRuntimeInstallationIndexBootstrapCommandV1({
    schemaVersion: record.schemaVersion,
    operation: record.operation,
    requestId: record.requestId,
    requestedAt: record.requestedAt,
    installationId: record.installationId,
    expectedControlRevision: record.expectedControlRevision,
  });
  return {
    ...command,
    principal: principal(record.principal),
  };
}

export function buildStewardRuntimeInstallationIndexBootstrapEnvelopeV1(
  builder: {
    readonly command: StewardRuntimeInstallationIndexBootstrapCommandV1;
    readonly accessServiceClientId: string;
  },
): StewardRuntimeInstallationIndexBootstrapEnvelopeV1 {
  const command =
    parseStewardRuntimeInstallationIndexBootstrapCommandV1(builder.command);
  return parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1({
    ...commandValue(command),
    principal: { accessServiceClientId: builder.accessServiceClientId },
  });
}

export function canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(
  value: unknown,
): string {
  return JSON.stringify(envelopeValue(
    parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(value),
  ));
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function deriveStewardRuntimeInstallationIndexBootstrapDigest(
  value: unknown,
): Promise<string> {
  return await sha256(
    'steward-runtime-installation-index-bootstrap-v1\n'
    + canonicalStewardRuntimeInstallationIndexBootstrapEnvelopeV1Json(value),
  );
}

export async function deriveStewardRuntimeInstallationRepositoryIndexDigest(
  repositoryIdsValue: readonly number[],
): Promise<string> {
  if (
    !Array.isArray(repositoryIdsValue)
    || repositoryIdsValue.length
      > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_REPOSITORIES
  ) {
    invalid('repository index is invalid');
  }
  const repositoryIds = repositoryIdsValue.map((value, index) =>
    positiveSafeInteger(value, `repositoryIds[${index}]`));
  if (
    new Set(repositoryIds).size !== repositoryIds.length
    || repositoryIds.some(
      (value, index) => index > 0 && repositoryIds[index - 1]! >= value,
    )
  ) {
    invalid('repository index must be unique and strictly ascending');
  }
  return await sha256(
    'steward-runtime-installation-repository-index-v1\n'
    + JSON.stringify(repositoryIds),
  );
}

function binding(
  value: unknown,
): StewardRuntimeInstallationIndexBootstrapBindingV1 {
  const record = plainRecord(value, 'binding');
  exactKeys(
    record,
    ['command', 'commandDigest', 'pass', 'cursor'],
    'binding',
  );
  if (record.pass !== 1 && record.pass !== 2) {
    invalid('binding.pass must be 1 or 2');
  }
  if (
    record.cursor !== null
    && (
      typeof record.cursor !== 'string'
      || record.cursor.length < 1
      || record.cursor.length
        > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_CURSOR_LENGTH
      || record.cursor !== record.cursor.trim()
      || !visibleAsciiPattern.test(record.cursor)
    )
  ) {
    invalid('binding.cursor is invalid');
  }
  return {
    command:
      parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(record.command),
    commandDigest: digest(record.commandDigest, 'binding.commandDigest'),
    pass: record.pass,
    cursor: record.cursor as string | null,
  };
}

function bindingValue(
  value: StewardRuntimeInstallationIndexBootstrapBindingV1,
): UnknownRecord {
  return {
    command: envelopeValue(value.command),
    commandDigest: value.commandDigest,
    pass: value.pass,
    cursor: value.cursor,
  };
}

export async function parseStewardRuntimeInstallationIndexBootstrapPageRequestV1(
  value: unknown,
): Promise<StewardRuntimeInstallationIndexBootstrapPageRequestV1> {
  const record = plainRecord(value, 'bootstrap page request');
  exactKeys(record, ['schemaVersion', 'phase', 'binding'], 'bootstrap page request');
  if (
    record.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION
    || record.phase !== 'enumerate-index-page'
  ) {
    invalid('bootstrap page request identity is invalid');
  }
  const parsedBinding = binding(record.binding);
  if (
    await deriveStewardRuntimeInstallationIndexBootstrapDigest(
      parsedBinding.command,
    ) !== parsedBinding.commandDigest
  ) {
    invalid('bootstrap page request command digest is invalid');
  }
  return {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    phase: 'enumerate-index-page',
    binding: parsedBinding,
  };
}

export async function buildStewardRuntimeInstallationIndexBootstrapPageRequestV1(
  builder: {
    readonly command: StewardRuntimeInstallationIndexBootstrapEnvelopeV1;
    readonly pass: 1 | 2;
    readonly cursor: string | null;
  },
): Promise<StewardRuntimeInstallationIndexBootstrapPageRequestV1> {
  const command =
    parseStewardRuntimeInstallationIndexBootstrapEnvelopeV1(builder.command);
  return await parseStewardRuntimeInstallationIndexBootstrapPageRequestV1({
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    phase: 'enumerate-index-page',
    binding: {
      command,
      commandDigest:
        await deriveStewardRuntimeInstallationIndexBootstrapDigest(command),
      pass: builder.pass,
      cursor: builder.cursor,
    },
  });
}

export async function canonicalStewardRuntimeInstallationIndexBootstrapPageRequestV1Json(
  value: unknown,
): Promise<string> {
  const parsed =
    await parseStewardRuntimeInstallationIndexBootstrapPageRequestV1(value);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValue(parsed.binding),
  });
}

function installation(value: unknown): {
  readonly state: StewardRuntimeInstallationFanoutStateV1;
  readonly id: number;
} {
  const record = plainRecord(value, 'installation');
  exactKeys(record, ['state', 'id'], 'installation');
  if (
    record.state !== 'live'
    && record.state !== 'suspended'
    && record.state !== 'absent'
  ) {
    invalid('installation.state is invalid');
  }
  return {
    state: record.state,
    id: positiveSafeInteger(record.id, 'installation.id'),
  };
}

function page(value: unknown): StewardRuntimeInstallationFanoutPageV1 {
  const record = plainRecord(value, 'page');
  exactKeys(
    record,
    ['totalCount', 'repositoryIds', 'hasNextPage', 'endCursor'],
    'page',
  );
  const totalCount = nonNegativeSafeInteger(record.totalCount, 'page.totalCount');
  if (
    totalCount > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_REPOSITORIES
    || !Array.isArray(record.repositoryIds)
    || record.repositoryIds.length > STEWARD_RUNTIME_INSTALLATION_FANOUT_PAGE_SIZE
    || typeof record.hasNextPage !== 'boolean'
  ) {
    invalid('page shape is invalid');
  }
  const repositoryIds = record.repositoryIds.map((entry, index) =>
    positiveSafeInteger(entry, `page.repositoryIds[${index}]`));
  if (new Set(repositoryIds).size !== repositoryIds.length) {
    invalid('page.repositoryIds contains duplicates');
  }
  if (
    record.endCursor !== null
    && (
      typeof record.endCursor !== 'string'
      || record.endCursor.length < 1
      || record.endCursor.length
        > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_CURSOR_LENGTH
      || record.endCursor !== record.endCursor.trim()
      || !visibleAsciiPattern.test(record.endCursor)
    )
  ) {
    invalid('page.endCursor is invalid');
  }
  if (
    record.hasNextPage !== (record.endCursor !== null)
    || (!record.hasNextPage && repositoryIds.length > totalCount)
  ) {
    invalid('page continuation is invalid');
  }
  return {
    totalCount,
    repositoryIds,
    hasNextPage: record.hasNextPage,
    endCursor: record.endCursor as string | null,
  };
}

export async function parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
  value: unknown,
): Promise<StewardRuntimeInstallationIndexBootstrapPageReceiptV1> {
  const record = plainRecord(value, 'bootstrap page receipt');
  exactKeys(
    record,
    ['schemaVersion', 'phase', 'binding', 'installation', 'page', 'controlRevision'],
    'bootstrap page receipt',
  );
  if (
    record.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION
    || record.phase !== 'enumerated-index-page'
  ) {
    invalid('bootstrap page receipt identity is invalid');
  }
  const parsedBinding = binding(record.binding);
  if (
    await deriveStewardRuntimeInstallationIndexBootstrapDigest(
      parsedBinding.command,
    ) !== parsedBinding.commandDigest
  ) {
    invalid('bootstrap page receipt command digest is invalid');
  }
  const parsedInstallation = installation(record.installation);
  const parsedPage = page(record.page);
  const parsedRevision = revision(record.controlRevision, 'controlRevision');
  if (
    parsedInstallation.id !== parsedBinding.command.installationId
    || (
      parsedInstallation.state !== 'live'
      && (
        parsedPage.totalCount !== 0
        || parsedPage.repositoryIds.length !== 0
        || parsedPage.hasNextPage
        || parsedPage.endCursor !== null
      )
    )
  ) {
    invalid('bootstrap page receipt installation binding is invalid');
  }
  return {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    phase: 'enumerated-index-page',
    binding: parsedBinding,
    installation: parsedInstallation,
    page: parsedPage,
    controlRevision: parsedRevision,
  };
}

export async function buildStewardRuntimeInstallationIndexBootstrapPageReceiptV1(
  builder: Omit<
    StewardRuntimeInstallationIndexBootstrapPageReceiptV1,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeInstallationIndexBootstrapPageReceiptV1> {
  return await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1({
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    phase: 'enumerated-index-page',
    binding: builder.binding,
    installation: builder.installation,
    page: builder.page,
    controlRevision: builder.controlRevision,
  });
}

export async function canonicalStewardRuntimeInstallationIndexBootstrapPageReceiptV1Json(
  value: unknown,
): Promise<string> {
  const parsed =
    await parseStewardRuntimeInstallationIndexBootstrapPageReceiptV1(value);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValue(parsed.binding),
    installation: parsed.installation,
    page: parsed.page,
    controlRevision: revisionValue(parsed.controlRevision),
  });
}

export function parseStewardRuntimeInstallationIndexBootstrapStatusReceiptV1(
  value: unknown,
): StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 {
  const record = plainRecord(value, 'bootstrap status receipt');
  exactKeys(record, [
    'schemaVersion',
    'operation',
    'requestId',
    'commandDigest',
    'installationId',
    'status',
    'lastKnownIndexKnown',
    'repositoryCount',
    'indexDigest',
    'controlRevision',
    'failureCode',
    'updatedAt',
  ], 'bootstrap status receipt');
  if (
    record.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION
    || record.operation !== 'installation-index-bootstrap-status'
    || (
      record.status !== 'pending'
      && record.status !== 'running'
      && record.status !== 'completed'
      && record.status !== 'failed'
    )
    || typeof record.lastKnownIndexKnown !== 'boolean'
  ) {
    invalid('bootstrap status receipt identity is invalid');
  }
  const allowedFailures = new Set([
    'control-revision-conflict',
    'installation-absent',
    'installation-suspended',
    'pagination-conflict',
    'pagination-drift',
    'pagination-limit',
    'runtime-error',
  ]);
  if (
    record.failureCode !== null
    && (
      typeof record.failureCode !== 'string'
      || !allowedFailures.has(record.failureCode)
    )
  ) {
    invalid('bootstrap status receipt failureCode is invalid');
  }
  if (
    record.indexDigest !== null
    && (typeof record.indexDigest !== 'string' || !digestPattern.test(record.indexDigest))
  ) {
    invalid('bootstrap status receipt indexDigest is invalid');
  }
  const parsedRevision = record.controlRevision === null
    ? null
    : revision(record.controlRevision, 'controlRevision');
  const parsed: StewardRuntimeInstallationIndexBootstrapStatusReceiptV1 = {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_INDEX_BOOTSTRAP_SCHEMA_VERSION,
    operation: 'installation-index-bootstrap-status',
    requestId: requestId(record.requestId, 'requestId'),
    commandDigest: digest(record.commandDigest, 'commandDigest'),
    installationId: positiveSafeInteger(record.installationId, 'installationId'),
    status: record.status,
    lastKnownIndexKnown: record.lastKnownIndexKnown,
    repositoryCount: nonNegativeSafeInteger(
      record.repositoryCount,
      'repositoryCount',
    ),
    indexDigest: record.indexDigest as string | null,
    controlRevision: parsedRevision,
    failureCode: record.failureCode as StewardRuntimeInstallationIndexBootstrapStatusReceiptV1['failureCode'],
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
  if (
    (parsed.status === 'completed') !== parsed.lastKnownIndexKnown
    || (
      parsed.status === 'completed'
      && (parsed.indexDigest === null || parsed.controlRevision === null)
    )
    || (
      parsed.status !== 'completed'
      && (parsed.indexDigest !== null || parsed.controlRevision !== null)
    )
    || ((parsed.status === 'failed') !== (parsed.failureCode !== null))
  ) {
    invalid('bootstrap status receipt terminal fields are invalid');
  }
  return parsed;
}

export function canonicalStewardRuntimeInstallationIndexBootstrapStatusReceiptV1Json(
  value: unknown,
): string {
  const parsed =
    parseStewardRuntimeInstallationIndexBootstrapStatusReceiptV1(value);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    operation: parsed.operation,
    requestId: parsed.requestId,
    commandDigest: parsed.commandDigest,
    installationId: parsed.installationId,
    status: parsed.status,
    lastKnownIndexKnown: parsed.lastKnownIndexKnown,
    repositoryCount: parsed.repositoryCount,
    indexDigest: parsed.indexDigest,
    controlRevision: parsed.controlRevision === null
      ? null
      : revisionValue(parsed.controlRevision),
    failureCode: parsed.failureCode,
    updatedAt: parsed.updatedAt,
  });
}
