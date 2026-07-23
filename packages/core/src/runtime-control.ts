import {
  canonicalStewardRuntimeWorkItemJson,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeWorkItemSubjectV1,
  type StewardRuntimeWorkItemV1,
} from './runtime-work-item.js';

export const STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION = 1 as const;

const commitPattern = /^[0-9a-f]{40}$/;
const workerVersionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const opaqueAsciiPattern = /^[\x21-\x7e]{1,128}$/;
const workerVersionTagPattern = /^steward-([0-9a-f]{40})$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;

export interface StewardRuntimeControlRequestV1 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION;
  readonly workItem: StewardRuntimeWorkItemV1;
  readonly generation: number;
}

export interface StewardRuntimeControlRevisionV1 {
  readonly stewardCommit: string;
  readonly workerVersionId: string;
  readonly workerVersionTag: string;
  readonly workerVersionCreatedAt: string;
}

export interface StewardRuntimeControlReceiptV1 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION;
  readonly state: 'converged';
  readonly subject: StewardRuntimeWorkItemSubjectV1;
  readonly deliveryId: string;
  readonly generation: number;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export class RuntimeControlProtocolValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime Control protocol: ${message}`);
    this.name = 'RuntimeControlProtocolValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new RuntimeControlProtocolValidationError(message);
}

function plainRecord(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} must be a plain object`);
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
    || actual.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    invalid(`${field} contains missing or unknown fields`);
  }
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  return value;
}

function requireOpaqueAscii(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text !== text.trim() || !opaqueAsciiPattern.test(text)) {
    invalid(`${field} must be 1-128 canonical printable ASCII characters`);
  }
  return text;
}

function parseSubject(value: unknown): StewardRuntimeWorkItemSubjectV1 {
  const subject = plainRecord(value, 'receipt.subject');
  requireExactKeys(
    subject,
    ['repositoryId', 'repositoryFullName', 'pullRequestNumber'],
    'receipt.subject',
  );
  const repositoryFullName = requireString(
    subject.repositoryFullName,
    'receipt.subject.repositoryFullName',
  );
  const parts = repositoryFullName.split('/');
  if (
    repositoryFullName !== repositoryFullName.trim()
    || parts.length !== 2
    || !githubLoginPattern.test(parts[0] ?? '')
    || !repositoryNamePattern.test(parts[1] ?? '')
  ) {
    invalid('receipt.subject.repositoryFullName must be a canonical GitHub owner/repository name');
  }
  return {
    repositoryId: requirePositiveSafeInteger(
      subject.repositoryId,
      'receipt.subject.repositoryId',
    ),
    repositoryFullName,
    pullRequestNumber: requirePositiveSafeInteger(
      subject.pullRequestNumber,
      'receipt.subject.pullRequestNumber',
    ),
  };
}

function parseControlRevision(value: unknown): StewardRuntimeControlRevisionV1 {
  const revision = plainRecord(value, 'receipt.controlRevision');
  requireExactKeys(
    revision,
    [
      'stewardCommit',
      'workerVersionId',
      'workerVersionTag',
      'workerVersionCreatedAt',
    ],
    'receipt.controlRevision',
  );
  const stewardCommit = requireString(
    revision.stewardCommit,
    'receipt.controlRevision.stewardCommit',
  );
  if (!commitPattern.test(stewardCommit)) {
    invalid('receipt.controlRevision.stewardCommit must be a lowercase 40-character commit SHA');
  }
  const workerVersionId = requireString(
    revision.workerVersionId,
    'receipt.controlRevision.workerVersionId',
  );
  if (!workerVersionIdPattern.test(workerVersionId)) {
    invalid('receipt.controlRevision.workerVersionId must be a lowercase UUID');
  }
  const workerVersionTag = requireString(
    revision.workerVersionTag,
    'receipt.controlRevision.workerVersionTag',
  );
  if (
    !workerVersionTagPattern.test(workerVersionTag)
    || workerVersionTag !== `steward-${stewardCommit}`
  ) {
    invalid(
      'receipt.controlRevision.workerVersionTag must bind the Steward commit',
    );
  }
  return {
    stewardCommit,
    workerVersionId,
    workerVersionTag,
    // Cloudflare intentionally types version metadata timestamps as opaque
    // strings. Preserve the exact bounded value instead of inventing a wire
    // format stricter than the platform contract.
    workerVersionCreatedAt: requireOpaqueAscii(
      revision.workerVersionCreatedAt,
      'receipt.controlRevision.workerVersionCreatedAt',
    ),
  };
}

export function parseStewardRuntimeControlRequest(
  value: unknown,
): StewardRuntimeControlRequestV1 {
  const request = plainRecord(value, 'request');
  requireExactKeys(request, ['schemaVersion', 'workItem', 'generation'], 'request');
  if (request.schemaVersion !== STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION) {
    invalid('request.schemaVersion must be 1');
  }
  return {
    schemaVersion: STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION,
    workItem: parseStewardRuntimeWorkItem(request.workItem),
    generation: requirePositiveSafeInteger(request.generation, 'request.generation'),
  };
}

export function buildStewardRuntimeControlRequest(
  input: Omit<StewardRuntimeControlRequestV1, 'schemaVersion'>,
): StewardRuntimeControlRequestV1 {
  const value = plainRecord(input, 'request builder input');
  requireExactKeys(value, ['workItem', 'generation'], 'request builder input');
  return parseStewardRuntimeControlRequest({
    schemaVersion: STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION,
    workItem: value.workItem,
    generation: value.generation,
  });
}

export function canonicalStewardRuntimeControlRequestJson(value: unknown): string {
  const request = parseStewardRuntimeControlRequest(value);
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    workItem: JSON.parse(canonicalStewardRuntimeWorkItemJson(request.workItem)) as unknown,
    generation: request.generation,
  });
}

export function parseStewardRuntimeControlReceipt(
  value: unknown,
): StewardRuntimeControlReceiptV1 {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'state',
      'subject',
      'deliveryId',
      'generation',
      'controlRevision',
    ],
    'receipt',
  );
  if (receipt.schemaVersion !== STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION) {
    invalid('receipt.schemaVersion must be 1');
  }
  if (receipt.state !== 'converged') {
    invalid('receipt.state must be converged');
  }
  return {
    schemaVersion: STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION,
    state: 'converged',
    subject: parseSubject(receipt.subject),
    deliveryId: requireOpaqueAscii(receipt.deliveryId, 'receipt.deliveryId'),
    generation: requirePositiveSafeInteger(receipt.generation, 'receipt.generation'),
    controlRevision: parseControlRevision(receipt.controlRevision),
  };
}

export function buildStewardRuntimeControlReceipt(
  input: Omit<StewardRuntimeControlReceiptV1, 'schemaVersion' | 'state'>,
): StewardRuntimeControlReceiptV1 {
  const value = plainRecord(input, 'receipt builder input');
  requireExactKeys(
    value,
    ['subject', 'deliveryId', 'generation', 'controlRevision'],
    'receipt builder input',
  );
  return parseStewardRuntimeControlReceipt({
    schemaVersion: STEWARD_RUNTIME_CONTROL_SCHEMA_VERSION,
    state: 'converged',
    subject: value.subject,
    deliveryId: value.deliveryId,
    generation: value.generation,
    controlRevision: value.controlRevision,
  });
}

export function canonicalStewardRuntimeControlReceiptJson(value: unknown): string {
  const receipt = parseStewardRuntimeControlReceipt(value);
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    state: receipt.state,
    subject: {
      repositoryId: receipt.subject.repositoryId,
      repositoryFullName: receipt.subject.repositoryFullName,
      pullRequestNumber: receipt.subject.pullRequestNumber,
    },
    deliveryId: receipt.deliveryId,
    generation: receipt.generation,
    controlRevision: {
      stewardCommit: receipt.controlRevision.stewardCommit,
      workerVersionId: receipt.controlRevision.workerVersionId,
      workerVersionTag: receipt.controlRevision.workerVersionTag,
      workerVersionCreatedAt: receipt.controlRevision.workerVersionCreatedAt,
    },
  });
}
