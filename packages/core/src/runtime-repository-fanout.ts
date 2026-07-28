import {
  RuntimeControlProtocolValidationError,
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from './runtime-control.js';
import {
  canonicalStewardRuntimeScopeWorkItemJson,
  parseStewardRuntimeScopeWorkItemV1,
  parseStewardRuntimeScopeWorkItemV2,
  type StewardRuntimeRepositoryScopeTargetV2,
  type StewardRuntimeScopeWorkItemV1,
  type StewardRuntimeScopeWorkItemV2,
} from './runtime-scope-work-item.js';
import {
  canonicalStewardRuntimeInstallationRepositoryChildV1Json,
  parseStewardRuntimeInstallationRepositoryChildV1,
  type StewardRuntimeInstallationRepositoryChildV1,
} from './runtime-installation-fanout.js';

export const STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION = 1 as const;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2 = 2 as const;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3 = 3 as const;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_PAGE_SIZE = 100;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PAGES = 30;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PULL_REQUESTS =
  STEWARD_RUNTIME_REPOSITORY_FANOUT_PAGE_SIZE
  * STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PAGES;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_CURSOR_LENGTH = 1_024;
export const STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_ENVELOPE_BYTES =
  128 * 1_024;

export interface StewardRuntimeRepositoryFanoutBindingV1 {
  readonly scopeWorkItem: StewardRuntimeScopeWorkItemV1;
  readonly generation: number;
  readonly pass: 1 | 2;
  readonly cursor: string | null;
}

export interface StewardRuntimeRepositoryFanoutPageRequestV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION;
  readonly phase: 'enumerate-page';
  readonly binding: StewardRuntimeRepositoryFanoutBindingV1;
}

export interface StewardRuntimeRepositoryFanoutRepositoryV1 {
  readonly state: 'live' | 'absent';
  readonly id: number;
  readonly fullName: string | null;
}

export interface StewardRuntimeRepositoryFanoutPageV1 {
  readonly totalCount: number;
  readonly pullRequestNumbers: readonly number[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface StewardRuntimeRepositoryFanoutPageReceiptV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION;
  readonly phase: 'enumerated-page';
  readonly binding: StewardRuntimeRepositoryFanoutBindingV1;
  readonly repository: StewardRuntimeRepositoryFanoutRepositoryV1;
  readonly page: StewardRuntimeRepositoryFanoutPageV1;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeRepositoryFanoutBindingV2 {
  readonly scopeWorkItem:
    StewardRuntimeScopeWorkItemV2
    & { readonly target: StewardRuntimeRepositoryScopeTargetV2 };
  readonly generation: number;
  readonly pass: 1 | 2;
  readonly cursor: string | null;
}

export interface StewardRuntimeRepositoryFanoutPageRequestV2 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2;
  readonly phase: 'enumerate-page';
  readonly binding: StewardRuntimeRepositoryFanoutBindingV2;
}

export interface StewardRuntimeRepositoryFanoutPageReceiptV2 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2;
  readonly phase: 'enumerated-page';
  readonly binding: StewardRuntimeRepositoryFanoutBindingV2;
  readonly repository: StewardRuntimeRepositoryFanoutRepositoryV1;
  readonly page: StewardRuntimeRepositoryFanoutPageV1;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeRepositoryFanoutBindingV3 {
  readonly installationChild: StewardRuntimeInstallationRepositoryChildV1;
  readonly generation: number;
  readonly pass: 1 | 2;
  readonly cursor: string | null;
}

export interface StewardRuntimeRepositoryFanoutPageRequestV3 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3;
  readonly phase: 'enumerate-page';
  readonly binding: StewardRuntimeRepositoryFanoutBindingV3;
}

export interface StewardRuntimeRepositoryFanoutPageReceiptV3 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3;
  readonly phase: 'enumerated-page';
  readonly binding: StewardRuntimeRepositoryFanoutBindingV3;
  readonly repository: StewardRuntimeRepositoryFanoutRepositoryV1;
  readonly page: StewardRuntimeRepositoryFanoutPageV1;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export type StewardRuntimeRepositoryFanoutPageReceipt =
  | StewardRuntimeRepositoryFanoutPageReceiptV1
  | StewardRuntimeRepositoryFanoutPageReceiptV2;

export type StewardRuntimeRepositoryFanoutPageReceiptAny =
  | StewardRuntimeRepositoryFanoutPageReceipt
  | StewardRuntimeRepositoryFanoutPageReceiptV3;

type UnknownRecord = Record<string, unknown>;

const githubLoginPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;
const visibleAsciiPattern = /^[\x21-\x7e]+$/;

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

function canonicalCursor(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_CURSOR_LENGTH
    || value !== value.trim()
    || !visibleAsciiPattern.test(value)
  ) {
    invalid(
      `${field} must be 1-${STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_CURSOR_LENGTH} `
      + 'canonical visible ASCII characters',
    );
  }
  return value;
}

function canonicalRepositoryFullName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    invalid(`${field} must be a canonical GitHub owner/repository name`);
  }
  const parts = value.split('/');
  if (
    parts.length !== 2
    || !githubLoginPattern.test(parts[0] ?? '')
    || !repositoryNamePattern.test(parts[1] ?? '')
  ) {
    invalid(`${field} must be a canonical GitHub owner/repository name`);
  }
  return value;
}

function parseBinding(
  value: unknown,
  field: string,
): StewardRuntimeRepositoryFanoutBindingV1 {
  const binding = plainRecord(value, field);
  requireExactKeys(
    binding,
    ['scopeWorkItem', 'generation', 'pass', 'cursor'],
    field,
  );
  const scopeWorkItem = parseStewardRuntimeScopeWorkItemV1(
    binding.scopeWorkItem,
  );
  const generation = positiveSafeInteger(
    binding.generation,
    `${field}.generation`,
  );
  if (binding.pass !== 1 && binding.pass !== 2) {
    invalid(`${field}.pass must be 1 or 2`);
  }
  const cursor = binding.cursor === null
    ? null
    : canonicalCursor(binding.cursor, `${field}.cursor`);
  return {
    scopeWorkItem,
    generation,
    pass: binding.pass,
    cursor,
  };
}

function parseBindingV2(
  value: unknown,
  field: string,
): StewardRuntimeRepositoryFanoutBindingV2 {
  const binding = plainRecord(value, field);
  requireExactKeys(
    binding,
    ['scopeWorkItem', 'generation', 'pass', 'cursor'],
    field,
  );
  const scopeWorkItem = parseStewardRuntimeScopeWorkItemV2(
    binding.scopeWorkItem,
  );
  if (scopeWorkItem.target.scope !== 'repository') {
    invalid(`${field}.scopeWorkItem.target.scope must be repository`);
  }
  const generation = positiveSafeInteger(
    binding.generation,
    `${field}.generation`,
  );
  if (binding.pass !== 1 && binding.pass !== 2) {
    invalid(`${field}.pass must be 1 or 2`);
  }
  const cursor = binding.cursor === null
    ? null
    : canonicalCursor(binding.cursor, `${field}.cursor`);
  return {
    scopeWorkItem: scopeWorkItem as
      StewardRuntimeScopeWorkItemV2
      & { readonly target: StewardRuntimeRepositoryScopeTargetV2 },
    generation,
    pass: binding.pass,
    cursor,
  };
}

async function parseBindingV3(
  value: unknown,
  field: string,
): Promise<StewardRuntimeRepositoryFanoutBindingV3> {
  const binding = plainRecord(value, field);
  requireExactKeys(
    binding,
    ['installationChild', 'generation', 'pass', 'cursor'],
    field,
  );
  const installationChild =
    await parseStewardRuntimeInstallationRepositoryChildV1(
      binding.installationChild,
    );
  const generation = positiveSafeInteger(
    binding.generation,
    `${field}.generation`,
  );
  if (binding.pass !== 1 && binding.pass !== 2) {
    invalid(`${field}.pass must be 1 or 2`);
  }
  const cursor = binding.cursor === null
    ? null
    : canonicalCursor(binding.cursor, `${field}.cursor`);
  return {
    installationChild,
    generation,
    pass: binding.pass,
    cursor,
  };
}

function parseRepository(
  value: unknown,
  field: string,
): StewardRuntimeRepositoryFanoutRepositoryV1 {
  const repository = plainRecord(value, field);
  requireExactKeys(repository, ['state', 'id', 'fullName'], field);
  if (repository.state !== 'live' && repository.state !== 'absent') {
    invalid(`${field}.state must be live or absent`);
  }
  const id = positiveSafeInteger(repository.id, `${field}.id`);
  const fullName = repository.fullName === null
    ? null
    : canonicalRepositoryFullName(repository.fullName, `${field}.fullName`);
  if (
    (repository.state === 'live' && fullName === null)
    || (repository.state === 'absent' && fullName !== null)
  ) {
    invalid(`${field}.fullName is inconsistent with repository state`);
  }
  return { state: repository.state, id, fullName };
}

function parsePage(
  value: unknown,
  field: string,
): StewardRuntimeRepositoryFanoutPageV1 {
  const page = plainRecord(value, field);
  requireExactKeys(
    page,
    ['totalCount', 'pullRequestNumbers', 'hasNextPage', 'endCursor'],
    field,
  );
  const totalCount = nonNegativeSafeInteger(
    page.totalCount,
    `${field}.totalCount`,
  );
  if (totalCount > STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PULL_REQUESTS) {
    invalid(
      `${field}.totalCount must not exceed `
      + STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_PULL_REQUESTS,
    );
  }
  if (!Array.isArray(page.pullRequestNumbers)) {
    invalid(`${field}.pullRequestNumbers must be an array`);
  }
  if (
    page.pullRequestNumbers.length
      > STEWARD_RUNTIME_REPOSITORY_FANOUT_PAGE_SIZE
  ) {
    invalid(
      `${field}.pullRequestNumbers must not exceed `
      + STEWARD_RUNTIME_REPOSITORY_FANOUT_PAGE_SIZE,
    );
  }
  const pullRequestNumbers = page.pullRequestNumbers.map((number, index) =>
    positiveSafeInteger(number, `${field}.pullRequestNumbers[${index}]`));
  if (new Set(pullRequestNumbers).size !== pullRequestNumbers.length) {
    invalid(`${field}.pullRequestNumbers must be unique within a page`);
  }
  if (pullRequestNumbers.length > totalCount) {
    invalid(`${field}.pullRequestNumbers cannot exceed totalCount`);
  }
  if (typeof page.hasNextPage !== 'boolean') {
    invalid(`${field}.hasNextPage must be a boolean`);
  }
  const endCursor = page.endCursor === null
    ? null
    : canonicalCursor(page.endCursor, `${field}.endCursor`);
  if (
    (page.hasNextPage && endCursor === null)
    || (!page.hasNextPage && endCursor !== null)
  ) {
    invalid(`${field}.endCursor is inconsistent with hasNextPage`);
  }
  return {
    totalCount,
    pullRequestNumbers,
    hasNextPage: page.hasNextPage,
    endCursor,
  };
}

function bindingValue(
  binding: StewardRuntimeRepositoryFanoutBindingV1,
): Record<string, unknown> {
  return {
    scopeWorkItem: JSON.parse(
      canonicalStewardRuntimeScopeWorkItemJson(binding.scopeWorkItem),
    ) as unknown,
    generation: binding.generation,
    pass: binding.pass,
    cursor: binding.cursor,
  };
}

function bindingValueV2(
  binding: StewardRuntimeRepositoryFanoutBindingV2,
): Record<string, unknown> {
  return {
    scopeWorkItem: JSON.parse(
      canonicalStewardRuntimeScopeWorkItemJson(binding.scopeWorkItem),
    ) as unknown,
    generation: binding.generation,
    pass: binding.pass,
    cursor: binding.cursor,
  };
}

async function bindingValueV3(
  binding: StewardRuntimeRepositoryFanoutBindingV3,
): Promise<Record<string, unknown>> {
  return {
    installationChild: JSON.parse(
      await canonicalStewardRuntimeInstallationRepositoryChildV1Json(
        binding.installationChild,
      ),
    ) as unknown,
    generation: binding.generation,
    pass: binding.pass,
    cursor: binding.cursor,
  };
}

function repositoryValue(
  repository: StewardRuntimeRepositoryFanoutRepositoryV1,
): Record<string, unknown> {
  return {
    state: repository.state,
    id: repository.id,
    fullName: repository.fullName,
  };
}

function pageValue(
  page: StewardRuntimeRepositoryFanoutPageV1,
): Record<string, unknown> {
  return {
    totalCount: page.totalCount,
    pullRequestNumbers: [...page.pullRequestNumbers],
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
  };
}

function revisionValue(
  revision: StewardRuntimeControlRevisionV1,
): Record<string, unknown> {
  return {
    stewardCommit: revision.stewardCommit,
    workerVersionId: revision.workerVersionId,
    workerVersionTag: revision.workerVersionTag,
    workerVersionCreatedAt: revision.workerVersionCreatedAt,
  };
}

function assertEnvelopeSize(value: unknown): void {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
      > STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_ENVELOPE_BYTES
  ) {
    invalid(
      `repository fan-out envelope must not exceed `
      + `${STEWARD_RUNTIME_REPOSITORY_FANOUT_MAXIMUM_ENVELOPE_BYTES} UTF-8 bytes`,
    );
  }
}

export function parseStewardRuntimeRepositoryFanoutPageRequestV1(
  value: unknown,
): StewardRuntimeRepositoryFanoutPageRequestV1 {
  const request = plainRecord(value, 'request');
  requireExactKeys(request, ['schemaVersion', 'phase', 'binding'], 'request');
  if (
    request.schemaVersion
      !== STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION
    || request.phase !== 'enumerate-page'
  ) {
    invalid('request must be a Steward repository fan-out page request');
  }
  const parsed: StewardRuntimeRepositoryFanoutPageRequestV1 = {
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION,
    phase: 'enumerate-page',
    binding: parseBinding(request.binding, 'request.binding'),
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValue(parsed.binding),
  });
  return parsed;
}

export function buildStewardRuntimeRepositoryFanoutPageRequestV1(
  input: Omit<
    StewardRuntimeRepositoryFanoutPageRequestV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeRepositoryFanoutPageRequestV1 {
  const builder = plainRecord(input, 'request builder input');
  requireExactKeys(builder, ['binding'], 'request builder input');
  return parseStewardRuntimeRepositoryFanoutPageRequestV1({
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION,
    phase: 'enumerate-page',
    binding: builder.binding,
  });
}

export function canonicalStewardRuntimeRepositoryFanoutPageRequestV1Json(
  value: unknown,
): string {
  const request = parseStewardRuntimeRepositoryFanoutPageRequestV1(value);
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    phase: request.phase,
    binding: bindingValue(request.binding),
  });
}

export function parseStewardRuntimeRepositoryFanoutPageReceiptV1(
  value: unknown,
): StewardRuntimeRepositoryFanoutPageReceiptV1 {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'repository',
      'page',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion
      !== STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION
    || receipt.phase !== 'enumerated-page'
  ) {
    invalid('receipt must be a Steward repository fan-out page receipt');
  }
  const binding = parseBinding(receipt.binding, 'receipt.binding');
  const repository = parseRepository(receipt.repository, 'receipt.repository');
  const page = parsePage(receipt.page, 'receipt.page');
  if (repository.id !== binding.scopeWorkItem.target.repositoryId) {
    invalid('receipt.repository.id must match the scope repository ID');
  }
  if (
    repository.state === 'absent'
    && (
      page.totalCount !== 0
      || page.pullRequestNumbers.length !== 0
      || page.hasNextPage
      || page.endCursor !== null
    )
  ) {
    invalid('an absent repository must return an empty terminal page');
  }
  if (
    binding.cursor !== null
    && page.endCursor === binding.cursor
  ) {
    invalid('receipt.page.endCursor must advance beyond the request cursor');
  }
  let controlRevision: StewardRuntimeControlRevisionV1;
  try {
    controlRevision = parseStewardRuntimeControlRevision(
      receipt.controlRevision,
    );
  } catch {
    invalid('receipt.controlRevision is invalid');
  }
  const parsed: StewardRuntimeRepositoryFanoutPageReceiptV1 = {
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION,
    phase: 'enumerated-page',
    binding,
    repository,
    page,
    controlRevision,
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValue(parsed.binding),
    repository: repositoryValue(parsed.repository),
    page: pageValue(parsed.page),
    controlRevision: revisionValue(parsed.controlRevision),
  });
  return parsed;
}

export function buildStewardRuntimeRepositoryFanoutPageReceiptV1(
  input: Omit<
    StewardRuntimeRepositoryFanoutPageReceiptV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeRepositoryFanoutPageReceiptV1 {
  const builder = plainRecord(input, 'receipt builder input');
  requireExactKeys(
    builder,
    ['binding', 'repository', 'page', 'controlRevision'],
    'receipt builder input',
  );
  return parseStewardRuntimeRepositoryFanoutPageReceiptV1({
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION,
    phase: 'enumerated-page',
    binding: builder.binding,
    repository: builder.repository,
    page: builder.page,
    controlRevision: builder.controlRevision,
  });
}

export function canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(
  value: unknown,
): string {
  const receipt = parseStewardRuntimeRepositoryFanoutPageReceiptV1(value);
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: bindingValue(receipt.binding),
    repository: repositoryValue(receipt.repository),
    page: pageValue(receipt.page),
    controlRevision: revisionValue(receipt.controlRevision),
  });
}

export function parseStewardRuntimeRepositoryFanoutPageRequestV2(
  value: unknown,
): StewardRuntimeRepositoryFanoutPageRequestV2 {
  const request = plainRecord(value, 'request');
  requireExactKeys(request, ['schemaVersion', 'phase', 'binding'], 'request');
  if (
    request.schemaVersion
      !== STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2
    || request.phase !== 'enumerate-page'
  ) {
    invalid('request must be a Steward repository fan-out v2 page request');
  }
  const parsed: StewardRuntimeRepositoryFanoutPageRequestV2 = {
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2,
    phase: 'enumerate-page',
    binding: parseBindingV2(request.binding, 'request.binding'),
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValueV2(parsed.binding),
  });
  return parsed;
}

export function buildStewardRuntimeRepositoryFanoutPageRequestV2(
  input: Omit<
    StewardRuntimeRepositoryFanoutPageRequestV2,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeRepositoryFanoutPageRequestV2 {
  const builder = plainRecord(input, 'request builder input');
  requireExactKeys(builder, ['binding'], 'request builder input');
  return parseStewardRuntimeRepositoryFanoutPageRequestV2({
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2,
    phase: 'enumerate-page',
    binding: builder.binding,
  });
}

export function canonicalStewardRuntimeRepositoryFanoutPageRequestV2Json(
  value: unknown,
): string {
  const request = parseStewardRuntimeRepositoryFanoutPageRequestV2(value);
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    phase: request.phase,
    binding: bindingValueV2(request.binding),
  });
}

export function parseStewardRuntimeRepositoryFanoutPageReceiptV2(
  value: unknown,
): StewardRuntimeRepositoryFanoutPageReceiptV2 {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'repository',
      'page',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion
      !== STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2
    || receipt.phase !== 'enumerated-page'
  ) {
    invalid('receipt must be a Steward repository fan-out v2 page receipt');
  }
  const binding = parseBindingV2(receipt.binding, 'receipt.binding');
  const repository = parseRepository(receipt.repository, 'receipt.repository');
  const page = parsePage(receipt.page, 'receipt.page');
  if (repository.id !== binding.scopeWorkItem.target.repositoryId) {
    invalid('receipt.repository.id must match the scope repository ID');
  }
  if (
    repository.state === 'absent'
    && (
      page.totalCount !== 0
      || page.pullRequestNumbers.length !== 0
      || page.hasNextPage
      || page.endCursor !== null
    )
  ) {
    invalid('an absent repository must return an empty terminal page');
  }
  if (binding.cursor !== null && page.endCursor === binding.cursor) {
    invalid('receipt.page.endCursor must advance beyond the request cursor');
  }
  let controlRevision: StewardRuntimeControlRevisionV1;
  try {
    controlRevision = parseStewardRuntimeControlRevision(
      receipt.controlRevision,
    );
  } catch {
    invalid('receipt.controlRevision is invalid');
  }
  const parsed: StewardRuntimeRepositoryFanoutPageReceiptV2 = {
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2,
    phase: 'enumerated-page',
    binding,
    repository,
    page,
    controlRevision,
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValueV2(parsed.binding),
    repository: repositoryValue(parsed.repository),
    page: pageValue(parsed.page),
    controlRevision: revisionValue(parsed.controlRevision),
  });
  return parsed;
}

export function buildStewardRuntimeRepositoryFanoutPageReceiptV2(
  input: Omit<
    StewardRuntimeRepositoryFanoutPageReceiptV2,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeRepositoryFanoutPageReceiptV2 {
  const builder = plainRecord(input, 'receipt builder input');
  requireExactKeys(
    builder,
    ['binding', 'repository', 'page', 'controlRevision'],
    'receipt builder input',
  );
  return parseStewardRuntimeRepositoryFanoutPageReceiptV2({
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V2,
    phase: 'enumerated-page',
    binding: builder.binding,
    repository: builder.repository,
    page: builder.page,
    controlRevision: builder.controlRevision,
  });
}

export function canonicalStewardRuntimeRepositoryFanoutPageReceiptV2Json(
  value: unknown,
): string {
  const receipt = parseStewardRuntimeRepositoryFanoutPageReceiptV2(value);
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: bindingValueV2(receipt.binding),
    repository: repositoryValue(receipt.repository),
    page: pageValue(receipt.page),
    controlRevision: revisionValue(receipt.controlRevision),
  });
}

export async function parseStewardRuntimeRepositoryFanoutPageRequestV3(
  value: unknown,
): Promise<StewardRuntimeRepositoryFanoutPageRequestV3> {
  const request = plainRecord(value, 'request');
  requireExactKeys(request, ['schemaVersion', 'phase', 'binding'], 'request');
  if (
    request.schemaVersion
      !== STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3
    || request.phase !== 'enumerate-page'
  ) {
    invalid('request must be a Steward repository fan-out v3 page request');
  }
  const parsed: StewardRuntimeRepositoryFanoutPageRequestV3 = {
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3,
    phase: 'enumerate-page',
    binding: await parseBindingV3(request.binding, 'request.binding'),
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: await bindingValueV3(parsed.binding),
  });
  return parsed;
}

export async function buildStewardRuntimeRepositoryFanoutPageRequestV3(
  input: Omit<
    StewardRuntimeRepositoryFanoutPageRequestV3,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeRepositoryFanoutPageRequestV3> {
  const builder = plainRecord(input, 'request builder input');
  requireExactKeys(builder, ['binding'], 'request builder input');
  return await parseStewardRuntimeRepositoryFanoutPageRequestV3({
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3,
    phase: 'enumerate-page',
    binding: builder.binding,
  });
}

export async function canonicalStewardRuntimeRepositoryFanoutPageRequestV3Json(
  value: unknown,
): Promise<string> {
  const request = await parseStewardRuntimeRepositoryFanoutPageRequestV3(value);
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    phase: request.phase,
    binding: await bindingValueV3(request.binding),
  });
}

export async function parseStewardRuntimeRepositoryFanoutPageReceiptV3(
  value: unknown,
): Promise<StewardRuntimeRepositoryFanoutPageReceiptV3> {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'repository',
      'page',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion
      !== STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3
    || receipt.phase !== 'enumerated-page'
  ) {
    invalid('receipt must be a Steward repository fan-out v3 page receipt');
  }
  const binding = await parseBindingV3(receipt.binding, 'receipt.binding');
  const repository = parseRepository(receipt.repository, 'receipt.repository');
  const page = parsePage(receipt.page, 'receipt.page');
  if (repository.id !== binding.installationChild.repositoryId) {
    invalid('receipt.repository.id must match the installation child repository ID');
  }
  if (
    repository.state === 'absent'
    && (
      page.totalCount !== 0
      || page.pullRequestNumbers.length !== 0
      || page.hasNextPage
      || page.endCursor !== null
    )
  ) {
    invalid('an absent repository must return an empty terminal page');
  }
  if (binding.cursor !== null && page.endCursor === binding.cursor) {
    invalid('receipt.page.endCursor must advance beyond the request cursor');
  }
  let controlRevision: StewardRuntimeControlRevisionV1;
  try {
    controlRevision = parseStewardRuntimeControlRevision(
      receipt.controlRevision,
    );
  } catch {
    invalid('receipt.controlRevision is invalid');
  }
  const parsed: StewardRuntimeRepositoryFanoutPageReceiptV3 = {
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3,
    phase: 'enumerated-page',
    binding,
    repository,
    page,
    controlRevision,
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: await bindingValueV3(parsed.binding),
    repository: repositoryValue(parsed.repository),
    page: pageValue(parsed.page),
    controlRevision: revisionValue(parsed.controlRevision),
  });
  return parsed;
}

export async function buildStewardRuntimeRepositoryFanoutPageReceiptV3(
  input: Omit<
    StewardRuntimeRepositoryFanoutPageReceiptV3,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeRepositoryFanoutPageReceiptV3> {
  const builder = plainRecord(input, 'receipt builder input');
  requireExactKeys(
    builder,
    ['binding', 'repository', 'page', 'controlRevision'],
    'receipt builder input',
  );
  return await parseStewardRuntimeRepositoryFanoutPageReceiptV3({
    schemaVersion: STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3,
    phase: 'enumerated-page',
    binding: builder.binding,
    repository: builder.repository,
    page: builder.page,
    controlRevision: builder.controlRevision,
  });
}

export async function canonicalStewardRuntimeRepositoryFanoutPageReceiptV3Json(
  value: unknown,
): Promise<string> {
  const receipt = await parseStewardRuntimeRepositoryFanoutPageReceiptV3(value);
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: await bindingValueV3(receipt.binding),
    repository: repositoryValue(receipt.repository),
    page: pageValue(receipt.page),
    controlRevision: revisionValue(receipt.controlRevision),
  });
}

export async function parseStewardRuntimeRepositoryFanoutPageReceiptAny(
  value: unknown,
): Promise<StewardRuntimeRepositoryFanoutPageReceiptAny> {
  const receipt = plainRecord(value, 'receipt');
  return receipt.schemaVersion
    === STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3
    ? await parseStewardRuntimeRepositoryFanoutPageReceiptV3(value)
    : parseStewardRuntimeRepositoryFanoutPageReceipt(value);
}

export async function canonicalStewardRuntimeRepositoryFanoutPageReceiptAnyJson(
  value: unknown,
): Promise<string> {
  const receipt = await parseStewardRuntimeRepositoryFanoutPageReceiptAny(
    value,
  );
  return receipt.schemaVersion
    === STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION_V3
    ? await canonicalStewardRuntimeRepositoryFanoutPageReceiptV3Json(receipt)
    : canonicalStewardRuntimeRepositoryFanoutPageReceiptJson(receipt);
}

export function parseStewardRuntimeRepositoryFanoutPageReceipt(
  value: unknown,
): StewardRuntimeRepositoryFanoutPageReceipt {
  const receipt = plainRecord(value, 'receipt');
  return receipt.schemaVersion
    === STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION
    ? parseStewardRuntimeRepositoryFanoutPageReceiptV1(value)
    : parseStewardRuntimeRepositoryFanoutPageReceiptV2(value);
}

export function canonicalStewardRuntimeRepositoryFanoutPageReceiptJson(
  value: unknown,
): string {
  const receipt = parseStewardRuntimeRepositoryFanoutPageReceipt(value);
  return receipt.schemaVersion === STEWARD_RUNTIME_REPOSITORY_FANOUT_SCHEMA_VERSION
    ? canonicalStewardRuntimeRepositoryFanoutPageReceiptV1Json(receipt)
    : canonicalStewardRuntimeRepositoryFanoutPageReceiptV2Json(receipt);
}

export async function deriveStewardRuntimeFanoutDeliveryId(
  scopeWorkItem: unknown,
  fanoutGeneration: number,
  pullRequestNumber: number,
): Promise<string> {
  const scope = parseStewardRuntimeScopeWorkItemV1(scopeWorkItem);
  const generation = positiveSafeInteger(
    fanoutGeneration,
    'fanoutGeneration',
  );
  const pullNumber = positiveSafeInteger(
    pullRequestNumber,
    'pullRequestNumber',
  );
  const input = [
    'steward-runtime-fanout-v1',
    canonicalStewardRuntimeScopeWorkItemJson(scope),
    String(generation),
    String(pullNumber),
  ].join('\u0000');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `fanout-v1:${hex}`;
}

export async function deriveStewardRuntimeFanoutDeliveryIdV2(
  scopeWorkItem: unknown,
  fanoutGeneration: number,
  pullRequestNumber: number,
): Promise<string> {
  const scope = parseStewardRuntimeScopeWorkItemV2(scopeWorkItem);
  if (scope.target.scope !== 'repository') {
    invalid('scopeWorkItem.target.scope must be repository');
  }
  const generation = positiveSafeInteger(
    fanoutGeneration,
    'fanoutGeneration',
  );
  const pullNumber = positiveSafeInteger(
    pullRequestNumber,
    'pullRequestNumber',
  );
  const input = [
    'steward-runtime-fanout-v2',
    canonicalStewardRuntimeScopeWorkItemJson(scope),
    String(generation),
    String(pullNumber),
  ].join('\u0000');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `fanout-v2:${hex}`;
}

export async function deriveStewardRuntimeFanoutDeliveryIdV3(
  installationChild: unknown,
  fanoutGeneration: number,
  pullRequestNumber: number,
): Promise<string> {
  const child = await parseStewardRuntimeInstallationRepositoryChildV1(
    installationChild,
  );
  const generation = positiveSafeInteger(
    fanoutGeneration,
    'fanoutGeneration',
  );
  const pullNumber = positiveSafeInteger(
    pullRequestNumber,
    'pullRequestNumber',
  );
  const input = [
    'steward-runtime-fanout-v3',
    await canonicalStewardRuntimeInstallationRepositoryChildV1Json(child),
    String(generation),
    String(pullNumber),
  ].join('\u0000');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `fanout-v3:${hex}`;
}
