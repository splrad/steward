import {
  canonicalStewardRuntimeDiagnosticsJson,
  parseStewardRuntimeDiagnosticsEnvelope,
  parseStewardRuntimeDiagnosticsSubject,
  type StewardControlRevisionV1,
  type StewardRuntimeDiagnosticsEnvelopeV1,
  type StewardRuntimeDiagnosticsSubjectV1,
} from './runtime-diagnostics.js';
import {
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from './runtime-control.js';

export const STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION = 1 as const;
export const STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE =
  'steward-runtime-diagnostics' as const;

const noncePattern = /^[0-9a-f]{64}$/;
const runtimeEnvironments = ['candidate', 'canary', 'production'] as const;

export interface StewardRuntimeDiagnosticsTransportRequestV1 {
  readonly transportVersion: typeof STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION;
  readonly audience: typeof STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE;
  readonly nonce: string;
  readonly subject: StewardRuntimeDiagnosticsSubjectV1;
}

export interface StewardRuntimeDiagnosticsTransportResponseV1 {
  readonly transportVersion: typeof STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION;
  readonly audience: typeof STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE;
  readonly nonce: string;
  readonly envelope: StewardRuntimeDiagnosticsEnvelopeV1;
}

export interface StewardRuntimeDiagnosticsControlProbeV1 {
  readonly transportVersion: typeof STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION;
  readonly audience: typeof STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE;
  readonly nonce: string;
  readonly subject: StewardRuntimeDiagnosticsSubjectV1;
  readonly environment: StewardControlRevisionV1['environment'];
}

export interface StewardRuntimeDiagnosticsControlReceiptV1 {
  readonly transportVersion: typeof STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION;
  readonly audience: typeof STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE;
  readonly nonce: string;
  readonly subject: StewardRuntimeDiagnosticsSubjectV1;
  readonly environment: StewardControlRevisionV1['environment'];
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export type BuildStewardRuntimeDiagnosticsTransportRequestInput =
  Omit<StewardRuntimeDiagnosticsTransportRequestV1, 'transportVersion' | 'audience'>;

export type BuildStewardRuntimeDiagnosticsTransportResponseInput =
  Omit<StewardRuntimeDiagnosticsTransportResponseV1, 'transportVersion' | 'audience'>;

export type BuildStewardRuntimeDiagnosticsControlProbeInput =
  Omit<StewardRuntimeDiagnosticsControlProbeV1, 'transportVersion' | 'audience'>;

export type BuildStewardRuntimeDiagnosticsControlReceiptInput =
  Omit<StewardRuntimeDiagnosticsControlReceiptV1, 'transportVersion' | 'audience'>;

export class RuntimeDiagnosticsTransportValidationError extends Error {
  constructor(message: string) {
    super(`Invalid Steward runtime diagnostics transport: ${message}`);
    this.name = 'RuntimeDiagnosticsTransportValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new RuntimeDiagnosticsTransportValidationError(message);
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

function requireTransportBinding(value: UnknownRecord, field: string): void {
  if (value.transportVersion !== STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION) {
    invalid(`${field}.transportVersion must be 1`);
  }
  if (value.audience !== STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE) {
    invalid(
      `${field}.audience must be ${STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE}`,
    );
  }
}

function requireNonce(value: unknown, field: string): string {
  if (typeof value !== 'string' || !noncePattern.test(value)) {
    invalid(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requireEnvironment(
  value: unknown,
  field: string,
): StewardControlRevisionV1['environment'] {
  if (
    typeof value !== 'string'
    || !runtimeEnvironments.includes(
      value as StewardControlRevisionV1['environment'],
    )
  ) {
    invalid(`${field} must be one of: ${runtimeEnvironments.join(', ')}`);
  }
  return value as StewardControlRevisionV1['environment'];
}

function requireNested<Value>(
  value: unknown,
  field: string,
  parser: (input: unknown) => Value,
): Value {
  try {
    return parser(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown validation error';
    invalid(`${field} is invalid: ${detail}`);
  }
}

function canonicalSubject(
  subject: StewardRuntimeDiagnosticsSubjectV1,
): Record<string, unknown> {
  return {
    repositoryId: subject.repositoryId,
    repositoryFullName: subject.repositoryFullName,
  };
}

function canonicalControlRevision(
  revision: StewardRuntimeControlRevisionV1,
): Record<string, unknown> {
  return {
    stewardCommit: revision.stewardCommit,
    workerVersionId: revision.workerVersionId,
    workerVersionTag: revision.workerVersionTag,
    workerVersionCreatedAt: revision.workerVersionCreatedAt,
  };
}

export function parseStewardRuntimeDiagnosticsTransportRequest(
  value: unknown,
): StewardRuntimeDiagnosticsTransportRequestV1 {
  const request = plainRecord(value, 'request');
  requireExactKeys(
    request,
    ['transportVersion', 'audience', 'nonce', 'subject'],
    'request',
  );
  requireTransportBinding(request, 'request');
  return {
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: requireNonce(request.nonce, 'request.nonce'),
    subject: requireNested(
      request.subject,
      'request.subject',
      parseStewardRuntimeDiagnosticsSubject,
    ),
  };
}

export function buildStewardRuntimeDiagnosticsTransportRequest(
  input: BuildStewardRuntimeDiagnosticsTransportRequestInput,
): StewardRuntimeDiagnosticsTransportRequestV1 {
  const value = plainRecord(input, 'request builder input');
  requireExactKeys(value, ['nonce', 'subject'], 'request builder input');
  return parseStewardRuntimeDiagnosticsTransportRequest({
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: value.nonce,
    subject: value.subject,
  });
}

export function canonicalStewardRuntimeDiagnosticsTransportRequestJson(
  value: unknown,
): string {
  const request = parseStewardRuntimeDiagnosticsTransportRequest(value);
  return JSON.stringify({
    transportVersion: request.transportVersion,
    audience: request.audience,
    nonce: request.nonce,
    subject: canonicalSubject(request.subject),
  });
}

export function parseStewardRuntimeDiagnosticsTransportResponse(
  value: unknown,
): StewardRuntimeDiagnosticsTransportResponseV1 {
  const response = plainRecord(value, 'response');
  requireExactKeys(
    response,
    ['transportVersion', 'audience', 'nonce', 'envelope'],
    'response',
  );
  requireTransportBinding(response, 'response');
  return {
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: requireNonce(response.nonce, 'response.nonce'),
    envelope: requireNested(
      response.envelope,
      'response.envelope',
      parseStewardRuntimeDiagnosticsEnvelope,
    ),
  };
}

export function buildStewardRuntimeDiagnosticsTransportResponse(
  input: BuildStewardRuntimeDiagnosticsTransportResponseInput,
): StewardRuntimeDiagnosticsTransportResponseV1 {
  const value = plainRecord(input, 'response builder input');
  requireExactKeys(value, ['nonce', 'envelope'], 'response builder input');
  return parseStewardRuntimeDiagnosticsTransportResponse({
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: value.nonce,
    envelope: value.envelope,
  });
}

export function canonicalStewardRuntimeDiagnosticsTransportResponseJson(
  value: unknown,
): string {
  const response = parseStewardRuntimeDiagnosticsTransportResponse(value);
  return JSON.stringify({
    transportVersion: response.transportVersion,
    audience: response.audience,
    nonce: response.nonce,
    envelope: JSON.parse(
      canonicalStewardRuntimeDiagnosticsJson(response.envelope),
    ) as unknown,
  });
}

export function parseStewardRuntimeDiagnosticsControlProbe(
  value: unknown,
): StewardRuntimeDiagnosticsControlProbeV1 {
  const probe = plainRecord(value, 'Control probe');
  requireExactKeys(
    probe,
    ['transportVersion', 'audience', 'nonce', 'subject', 'environment'],
    'Control probe',
  );
  requireTransportBinding(probe, 'Control probe');
  return {
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: requireNonce(probe.nonce, 'Control probe.nonce'),
    subject: requireNested(
      probe.subject,
      'Control probe.subject',
      parseStewardRuntimeDiagnosticsSubject,
    ),
    environment: requireEnvironment(
      probe.environment,
      'Control probe.environment',
    ),
  };
}

export function buildStewardRuntimeDiagnosticsControlProbe(
  input: BuildStewardRuntimeDiagnosticsControlProbeInput,
): StewardRuntimeDiagnosticsControlProbeV1 {
  const value = plainRecord(input, 'Control probe builder input');
  requireExactKeys(
    value,
    ['nonce', 'subject', 'environment'],
    'Control probe builder input',
  );
  return parseStewardRuntimeDiagnosticsControlProbe({
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: value.nonce,
    subject: value.subject,
    environment: value.environment,
  });
}

export function canonicalStewardRuntimeDiagnosticsControlProbeJson(
  value: unknown,
): string {
  const probe = parseStewardRuntimeDiagnosticsControlProbe(value);
  return JSON.stringify({
    transportVersion: probe.transportVersion,
    audience: probe.audience,
    nonce: probe.nonce,
    subject: canonicalSubject(probe.subject),
    environment: probe.environment,
  });
}

export function parseStewardRuntimeDiagnosticsControlReceipt(
  value: unknown,
): StewardRuntimeDiagnosticsControlReceiptV1 {
  const receipt = plainRecord(value, 'Control receipt');
  requireExactKeys(
    receipt,
    [
      'transportVersion',
      'audience',
      'nonce',
      'subject',
      'environment',
      'controlRevision',
    ],
    'Control receipt',
  );
  requireTransportBinding(receipt, 'Control receipt');
  return {
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: requireNonce(receipt.nonce, 'Control receipt.nonce'),
    subject: requireNested(
      receipt.subject,
      'Control receipt.subject',
      parseStewardRuntimeDiagnosticsSubject,
    ),
    environment: requireEnvironment(
      receipt.environment,
      'Control receipt.environment',
    ),
    controlRevision: requireNested(
      receipt.controlRevision,
      'Control receipt.controlRevision',
      parseStewardRuntimeControlRevision,
    ),
  };
}

export function buildStewardRuntimeDiagnosticsControlReceipt(
  input: BuildStewardRuntimeDiagnosticsControlReceiptInput,
): StewardRuntimeDiagnosticsControlReceiptV1 {
  const value = plainRecord(input, 'Control receipt builder input');
  requireExactKeys(
    value,
    ['nonce', 'subject', 'environment', 'controlRevision'],
    'Control receipt builder input',
  );
  return parseStewardRuntimeDiagnosticsControlReceipt({
    transportVersion: STEWARD_RUNTIME_DIAGNOSTICS_TRANSPORT_VERSION,
    audience: STEWARD_RUNTIME_DIAGNOSTICS_AUDIENCE,
    nonce: value.nonce,
    subject: value.subject,
    environment: value.environment,
    controlRevision: value.controlRevision,
  });
}

export function canonicalStewardRuntimeDiagnosticsControlReceiptJson(
  value: unknown,
): string {
  const receipt = parseStewardRuntimeDiagnosticsControlReceipt(value);
  return JSON.stringify({
    transportVersion: receipt.transportVersion,
    audience: receipt.audience,
    nonce: receipt.nonce,
    subject: canonicalSubject(receipt.subject),
    environment: receipt.environment,
    controlRevision: canonicalControlRevision(receipt.controlRevision),
  });
}
