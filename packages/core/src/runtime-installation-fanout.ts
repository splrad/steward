import {
  RuntimeControlProtocolValidationError,
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from './runtime-control.js';
import {
  parseStewardRuntimeScopeCauseV2,
  parseStewardRuntimeScopeWorkItemV2,
  type StewardRuntimeInstallationScopeTargetV2,
  type StewardRuntimeRepositorySetScopeTargetV2,
  type StewardRuntimeScopeCauseV2,
  type StewardRuntimeScopeWorkItemV2,
} from './runtime-scope-work-item.js';

export const STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION = 1 as const;
export const STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION =
  1 as const;
export const STEWARD_RUNTIME_INSTALLATION_FANOUT_PAGE_SIZE = 100;
export const STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES = 100;
export const STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_REPOSITORIES =
  STEWARD_RUNTIME_INSTALLATION_FANOUT_PAGE_SIZE
  * STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_PAGES;
export const STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_CURSOR_LENGTH = 1_024;
export const STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_DELIVERY_ID_LENGTH =
  128;
export const STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_ENVELOPE_BYTES =
  128 * 1_024;

export type StewardRuntimeInstallationScopeWorkItemV2 =
  StewardRuntimeScopeWorkItemV2 & {
    readonly target: StewardRuntimeInstallationScopeTargetV2;
  };

export type StewardRuntimeInstallationFanoutScopeWorkItemV2 =
  StewardRuntimeScopeWorkItemV2 & {
    readonly target:
      | StewardRuntimeInstallationScopeTargetV2
      | StewardRuntimeRepositorySetScopeTargetV2;
  };

export interface StewardRuntimeInstallationFanoutRootV1 {
  readonly installationId: number;
  readonly deliveryId: string;
  readonly scopeWorkItem: StewardRuntimeInstallationFanoutScopeWorkItemV2;
}

export interface StewardRuntimeInstallationFanoutBindingV1 {
  readonly root: StewardRuntimeInstallationFanoutRootV1;
  readonly generation: number;
  readonly pass: 1 | 2;
  readonly cursor: string | null;
}

export interface StewardRuntimeInstallationFanoutPageRequestV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION;
  readonly phase: 'enumerate-page';
  readonly binding: StewardRuntimeInstallationFanoutBindingV1;
}

export type StewardRuntimeInstallationFanoutStateV1 =
  | 'live'
  | 'suspended'
  | 'absent';

export interface StewardRuntimeInstallationFanoutInstallationV1 {
  readonly state: StewardRuntimeInstallationFanoutStateV1;
  readonly id: number;
}

export interface StewardRuntimeInstallationFanoutPageV1 {
  readonly totalCount: number;
  readonly repositoryIds: readonly number[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface StewardRuntimeInstallationFanoutPageReceiptV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION;
  readonly phase: 'enumerated-page';
  readonly binding: StewardRuntimeInstallationFanoutBindingV1;
  readonly installation: StewardRuntimeInstallationFanoutInstallationV1;
  readonly page: StewardRuntimeInstallationFanoutPageV1;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export interface StewardRuntimeInstallationRepositoryChildV1 {
  readonly schemaVersion:
    typeof STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION;
  readonly operation: 'installation-repository-fanout';
  readonly rootDigest: string;
  readonly rootTargetDigest: string;
  readonly rootDeliveryId: string;
  readonly rootTargetScope: 'installation' | 'repository-set';
  readonly installationId: number;
  readonly repositoryId: number;
  readonly installationGeneration: number;
  readonly cause: StewardRuntimeScopeCauseV2;
  readonly deliveryId: string;
}

type UnknownRecord = Record<string, unknown>;
type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

const visibleAsciiPattern = /^[\x21-\x7e]+$/;
const rootDigestPattern = /^[0-9a-f]{64}$/;
const maximumJsonDepth = 32;

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

function canonicalVisibleAscii(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || !visibleAsciiPattern.test(value)
  ) {
    invalid(
      `${field} must be 1-${maximumLength} canonical visible ASCII characters`,
    );
  }
  return value;
}

function canonicalJsonValue(
  value: unknown,
  field: string,
  depth = 0,
): CanonicalJson {
  if (depth > maximumJsonDepth) {
    invalid(`${field} exceeds the maximum JSON nesting depth`);
  }
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      invalid(`${field} numbers must be safe integers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalJsonValue(entry, `${field}[${index}]`, depth + 1));
  }
  const record = plainRecord(value, field);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== 'string')) {
    invalid(`${field} contains a symbol key`);
  }
  const result: Record<string, CanonicalJson> = {};
  for (const key of (keys as string[]).sort()) {
    result[key] = canonicalJsonValue(
      record[key],
      `${field}.${key}`,
      depth + 1,
    );
  }
  return result;
}

function parseRoot(
  value: unknown,
  field: string,
): StewardRuntimeInstallationFanoutRootV1 {
  const root = plainRecord(value, field);
  requireExactKeys(
    root,
    ['installationId', 'deliveryId', 'scopeWorkItem'],
    field,
  );
  const canonicalScopeWorkItem = canonicalJsonValue(
    root.scopeWorkItem,
    `${field}.scopeWorkItem`,
  );
  if (
    canonicalScopeWorkItem === null
    || Array.isArray(canonicalScopeWorkItem)
    || typeof canonicalScopeWorkItem !== 'object'
  ) {
    invalid(`${field}.scopeWorkItem must be a JSON object`);
  }
  let scopeWorkItem: StewardRuntimeScopeWorkItemV2;
  try {
    scopeWorkItem = parseStewardRuntimeScopeWorkItemV2(canonicalScopeWorkItem);
  } catch {
    invalid(`${field}.scopeWorkItem must be a valid ScopeWorkItem V2`);
  }
  if (
    scopeWorkItem.target.scope !== 'installation'
    && scopeWorkItem.target.scope !== 'repository-set'
  ) {
    invalid(
      `${field}.scopeWorkItem.target.scope must be installation or repository-set`,
    );
  }
  const installationId = positiveSafeInteger(
    root.installationId,
    `${field}.installationId`,
  );
  const deliveryId = canonicalVisibleAscii(
    root.deliveryId,
    `${field}.deliveryId`,
    STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_DELIVERY_ID_LENGTH,
  );
  if (scopeWorkItem.target.installationId !== installationId) {
    invalid(
      `${field}.installationId must match the ScopeWorkItem installation ID`,
    );
  }
  if (scopeWorkItem.cause.deliveryId !== deliveryId) {
    invalid(`${field}.deliveryId must match the ScopeWorkItem delivery ID`);
  }
  return {
    installationId,
    deliveryId,
    scopeWorkItem:
      scopeWorkItem as StewardRuntimeInstallationFanoutScopeWorkItemV2,
  };
}

function parseBinding(
  value: unknown,
  field: string,
): StewardRuntimeInstallationFanoutBindingV1 {
  const binding = plainRecord(value, field);
  requireExactKeys(binding, ['root', 'generation', 'pass', 'cursor'], field);
  if (binding.pass !== 1 && binding.pass !== 2) {
    invalid(`${field}.pass must be 1 or 2`);
  }
  return {
    root: parseRoot(binding.root, `${field}.root`),
    generation: positiveSafeInteger(
      binding.generation,
      `${field}.generation`,
    ),
    pass: binding.pass,
    cursor: binding.cursor === null
      ? null
      : canonicalVisibleAscii(
          binding.cursor,
          `${field}.cursor`,
          STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_CURSOR_LENGTH,
        ),
  };
}

function rootSupportsLiveEnumeration(
  root: StewardRuntimeInstallationFanoutRootV1,
): boolean {
  return root.scopeWorkItem.target.scope === 'installation'
    || (
      root.scopeWorkItem.target.scope === 'repository-set'
      && root.scopeWorkItem.cause.event === 'installation_repositories'
    );
}

function parseInstallation(
  value: unknown,
  field: string,
): StewardRuntimeInstallationFanoutInstallationV1 {
  const installation = plainRecord(value, field);
  requireExactKeys(installation, ['state', 'id'], field);
  if (
    installation.state !== 'live'
    && installation.state !== 'suspended'
    && installation.state !== 'absent'
  ) {
    invalid(`${field}.state must be live, suspended, or absent`);
  }
  return {
    state: installation.state,
    id: positiveSafeInteger(installation.id, `${field}.id`),
  };
}

function parsePage(
  value: unknown,
  field: string,
): StewardRuntimeInstallationFanoutPageV1 {
  const page = plainRecord(value, field);
  requireExactKeys(
    page,
    ['totalCount', 'repositoryIds', 'hasNextPage', 'endCursor'],
    field,
  );
  const totalCount = nonNegativeSafeInteger(
    page.totalCount,
    `${field}.totalCount`,
  );
  if (totalCount > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_REPOSITORIES) {
    invalid(
      `${field}.totalCount must not exceed `
      + STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_REPOSITORIES,
    );
  }
  if (!Array.isArray(page.repositoryIds)) {
    invalid(`${field}.repositoryIds must be an array`);
  }
  if (
    page.repositoryIds.length
      > STEWARD_RUNTIME_INSTALLATION_FANOUT_PAGE_SIZE
  ) {
    invalid(
      `${field}.repositoryIds must not exceed `
      + STEWARD_RUNTIME_INSTALLATION_FANOUT_PAGE_SIZE,
    );
  }
  const repositoryIds = page.repositoryIds.map((repositoryId, index) =>
    positiveSafeInteger(repositoryId, `${field}.repositoryIds[${index}]`));
  if (new Set(repositoryIds).size !== repositoryIds.length) {
    invalid(`${field}.repositoryIds must be unique within a page`);
  }
  if (repositoryIds.length > totalCount) {
    invalid(`${field}.repositoryIds cannot exceed totalCount`);
  }
  if (typeof page.hasNextPage !== 'boolean') {
    invalid(`${field}.hasNextPage must be a boolean`);
  }
  const endCursor = page.endCursor === null
    ? null
    : canonicalVisibleAscii(
        page.endCursor,
        `${field}.endCursor`,
        STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_CURSOR_LENGTH,
      );
  if (
    (page.hasNextPage && endCursor === null)
    || (!page.hasNextPage && endCursor !== null)
  ) {
    invalid(`${field}.endCursor is inconsistent with hasNextPage`);
  }
  return {
    totalCount,
    repositoryIds,
    hasNextPage: page.hasNextPage,
    endCursor,
  };
}

function rootValue(
  root: StewardRuntimeInstallationFanoutRootV1,
): Record<string, unknown> {
  return {
    installationId: root.installationId,
    deliveryId: root.deliveryId,
    scopeWorkItem: root.scopeWorkItem,
  };
}

function scopeCauseValue(
  cause: StewardRuntimeScopeCauseV2,
): Record<string, unknown> {
  return {
    kind: cause.kind,
    deliveryId: cause.deliveryId,
    event: cause.event,
    action: cause.action,
    ref: cause.ref,
    receivedAt: cause.receivedAt,
  };
}

function rootTargetValue(
  target:
    | StewardRuntimeInstallationScopeTargetV2
    | StewardRuntimeRepositorySetScopeTargetV2,
): Record<string, unknown> {
  return target.scope === 'installation'
    ? {
        scope: target.scope,
        mode: target.mode,
        installationId: target.installationId,
        repositories: target.repositories,
        pullRequests: target.pullRequests,
        ...(target.accountId === undefined
          ? {}
          : { accountId: target.accountId }),
      }
    : {
        scope: target.scope,
        mode: target.mode,
        installationId: target.installationId,
        repositoryIds: [...target.repositoryIds],
        pullRequests: target.pullRequests,
      };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveRootTargetDigest(
  target:
    | StewardRuntimeInstallationScopeTargetV2
    | StewardRuntimeRepositorySetScopeTargetV2,
): Promise<string> {
  return await sha256Hex([
    'steward-runtime-installation-fanout-target-v1',
    JSON.stringify(rootTargetValue(target)),
  ].join('\u0000'));
}

async function deriveCompactRootDigest(input: {
  readonly installationId: number;
  readonly rootDeliveryId: string;
  readonly rootTargetScope: 'installation' | 'repository-set';
  readonly rootTargetDigest: string;
  readonly cause: StewardRuntimeScopeCauseV2;
}): Promise<string> {
  return await sha256Hex([
    'steward-runtime-installation-fanout-root-v1',
    JSON.stringify({
      installationId: input.installationId,
      rootDeliveryId: input.rootDeliveryId,
      rootTargetScope: input.rootTargetScope,
      rootTargetDigest: input.rootTargetDigest,
      cause: scopeCauseValue(input.cause),
    }),
  ].join('\u0000'));
}

function repositoryChildValue(
  child: StewardRuntimeInstallationRepositoryChildV1,
): Record<string, unknown> {
  return {
    schemaVersion: child.schemaVersion,
    operation: child.operation,
    rootDigest: child.rootDigest,
    rootTargetDigest: child.rootTargetDigest,
    rootDeliveryId: child.rootDeliveryId,
    rootTargetScope: child.rootTargetScope,
    installationId: child.installationId,
    repositoryId: child.repositoryId,
    installationGeneration: child.installationGeneration,
    cause: scopeCauseValue(child.cause),
    deliveryId: child.deliveryId,
  };
}

function bindingValue(
  binding: StewardRuntimeInstallationFanoutBindingV1,
): Record<string, unknown> {
  return {
    root: rootValue(binding.root),
    generation: binding.generation,
    pass: binding.pass,
    cursor: binding.cursor,
  };
}

function installationValue(
  installation: StewardRuntimeInstallationFanoutInstallationV1,
): Record<string, unknown> {
  return {
    state: installation.state,
    id: installation.id,
  };
}

function pageValue(
  page: StewardRuntimeInstallationFanoutPageV1,
): Record<string, unknown> {
  return {
    totalCount: page.totalCount,
    repositoryIds: [...page.repositoryIds],
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
      > STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_ENVELOPE_BYTES
  ) {
    invalid(
      `installation fan-out envelope must not exceed `
      + `${STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_ENVELOPE_BYTES} `
      + 'UTF-8 bytes',
    );
  }
}

export function parseStewardRuntimeInstallationFanoutRootV1(
  value: unknown,
): StewardRuntimeInstallationFanoutRootV1 {
  const root = parseRoot(value, 'root');
  assertEnvelopeSize(rootValue(root));
  return root;
}

export function canonicalStewardRuntimeInstallationFanoutRootV1Json(
  value: unknown,
): string {
  const root = parseStewardRuntimeInstallationFanoutRootV1(value);
  return JSON.stringify(rootValue(root));
}

export function parseStewardRuntimeInstallationFanoutPageRequestV1(
  value: unknown,
): StewardRuntimeInstallationFanoutPageRequestV1 {
  const request = plainRecord(value, 'request');
  requireExactKeys(request, ['schemaVersion', 'phase', 'binding'], 'request');
  if (
    request.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION
    || request.phase !== 'enumerate-page'
  ) {
    invalid('request must be a Steward installation fan-out page request');
  }
  const binding = parseBinding(request.binding, 'request.binding');
  if (!rootSupportsLiveEnumeration(binding.root)) {
    invalid(
      'request root must target an installation or installation repository delta for live enumeration',
    );
  }
  const parsed: StewardRuntimeInstallationFanoutPageRequestV1 = {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION,
    phase: 'enumerate-page',
    binding,
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValue(parsed.binding),
  });
  return parsed;
}

export function buildStewardRuntimeInstallationFanoutPageRequestV1(
  input: Omit<
    StewardRuntimeInstallationFanoutPageRequestV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeInstallationFanoutPageRequestV1 {
  const builder = plainRecord(input, 'request builder input');
  requireExactKeys(builder, ['binding'], 'request builder input');
  return parseStewardRuntimeInstallationFanoutPageRequestV1({
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION,
    phase: 'enumerate-page',
    binding: builder.binding,
  });
}

export function canonicalStewardRuntimeInstallationFanoutPageRequestV1Json(
  value: unknown,
): string {
  const request = parseStewardRuntimeInstallationFanoutPageRequestV1(value);
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    phase: request.phase,
    binding: bindingValue(request.binding),
  });
}

export function parseStewardRuntimeInstallationFanoutPageReceiptV1(
  value: unknown,
): StewardRuntimeInstallationFanoutPageReceiptV1 {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'installation',
      'page',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION
    || receipt.phase !== 'enumerated-page'
  ) {
    invalid('receipt must be a Steward installation fan-out page receipt');
  }
  const binding = parseBinding(receipt.binding, 'receipt.binding');
  if (!rootSupportsLiveEnumeration(binding.root)) {
    invalid(
      'receipt root must target an installation or installation repository delta for live enumeration',
    );
  }
  const installation = parseInstallation(
    receipt.installation,
    'receipt.installation',
  );
  const page = parsePage(receipt.page, 'receipt.page');
  if (installation.id !== binding.root.installationId) {
    invalid('receipt.installation.id must match the root installation ID');
  }
  if (
    installation.state !== 'live'
    && (
      page.totalCount !== 0
      || page.repositoryIds.length !== 0
      || page.hasNextPage
      || page.endCursor !== null
    )
  ) {
    invalid(
      'a suspended or absent installation must return an empty terminal page',
    );
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
  const parsed: StewardRuntimeInstallationFanoutPageReceiptV1 = {
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION,
    phase: 'enumerated-page',
    binding,
    installation,
    page,
    controlRevision,
  };
  assertEnvelopeSize({
    schemaVersion: parsed.schemaVersion,
    phase: parsed.phase,
    binding: bindingValue(parsed.binding),
    installation: installationValue(parsed.installation),
    page: pageValue(parsed.page),
    controlRevision: revisionValue(parsed.controlRevision),
  });
  return parsed;
}

export function buildStewardRuntimeInstallationFanoutPageReceiptV1(
  input: Omit<
    StewardRuntimeInstallationFanoutPageReceiptV1,
    'schemaVersion' | 'phase'
  >,
): StewardRuntimeInstallationFanoutPageReceiptV1 {
  const builder = plainRecord(input, 'receipt builder input');
  requireExactKeys(
    builder,
    ['binding', 'installation', 'page', 'controlRevision'],
    'receipt builder input',
  );
  return parseStewardRuntimeInstallationFanoutPageReceiptV1({
    schemaVersion: STEWARD_RUNTIME_INSTALLATION_FANOUT_SCHEMA_VERSION,
    phase: 'enumerated-page',
    binding: builder.binding,
    installation: builder.installation,
    page: builder.page,
    controlRevision: builder.controlRevision,
  });
}

export function canonicalStewardRuntimeInstallationFanoutPageReceiptV1Json(
  value: unknown,
): string {
  const receipt = parseStewardRuntimeInstallationFanoutPageReceiptV1(value);
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: bindingValue(receipt.binding),
    installation: installationValue(receipt.installation),
    page: pageValue(receipt.page),
    controlRevision: revisionValue(receipt.controlRevision),
  });
}

export async function deriveStewardRuntimeInstallationFanoutRootDigest(
  value: unknown,
): Promise<string> {
  const root = parseStewardRuntimeInstallationFanoutRootV1(value);
  return await deriveCompactRootDigest({
    installationId: root.installationId,
    rootDeliveryId: root.deliveryId,
    rootTargetScope: root.scopeWorkItem.target.scope,
    rootTargetDigest: await deriveRootTargetDigest(root.scopeWorkItem.target),
    cause: root.scopeWorkItem.cause,
  });
}

export function buildStewardRuntimeInstallationFanoutDeliveryId(
  rootDigest: string,
  fanoutGeneration: number,
  repositoryId: number,
): string {
  if (typeof rootDigest !== 'string' || !rootDigestPattern.test(rootDigest)) {
    invalid('rootDigest must be a lowercase SHA-256 hex digest');
  }
  const generation = positiveSafeInteger(
    fanoutGeneration,
    'fanoutGeneration',
  );
  const normalizedRepositoryId = positiveSafeInteger(
    repositoryId,
    'repositoryId',
  );
  return [
    'installation-fanout-v1',
    rootDigest,
    String(generation),
    String(normalizedRepositoryId),
  ].join(':');
}

export async function parseStewardRuntimeInstallationRepositoryChildV1(
  value: unknown,
): Promise<StewardRuntimeInstallationRepositoryChildV1> {
  const child = plainRecord(value, 'child');
  requireExactKeys(
    child,
    [
      'schemaVersion',
      'operation',
      'rootDigest',
      'rootTargetDigest',
      'rootDeliveryId',
      'rootTargetScope',
      'installationId',
      'repositoryId',
      'installationGeneration',
      'cause',
      'deliveryId',
    ],
    'child',
  );
  if (
    child.schemaVersion
      !== STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION
    || child.operation !== 'installation-repository-fanout'
  ) {
    invalid('child must be a Steward installation repository child');
  }
  const rootDigest = canonicalVisibleAscii(
    child.rootDigest,
    'child.rootDigest',
    64,
  );
  if (!rootDigestPattern.test(rootDigest)) {
    invalid('child.rootDigest must be a lowercase SHA-256 hex digest');
  }
  const rootTargetDigest = canonicalVisibleAscii(
    child.rootTargetDigest,
    'child.rootTargetDigest',
    64,
  );
  if (!rootDigestPattern.test(rootTargetDigest)) {
    invalid('child.rootTargetDigest must be a lowercase SHA-256 hex digest');
  }
  const rootDeliveryId = canonicalVisibleAscii(
    child.rootDeliveryId,
    'child.rootDeliveryId',
    STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_DELIVERY_ID_LENGTH,
  );
  if (
    child.rootTargetScope !== 'installation'
    && child.rootTargetScope !== 'repository-set'
  ) {
    invalid('child.rootTargetScope must be installation or repository-set');
  }
  const installationId = positiveSafeInteger(
    child.installationId,
    'child.installationId',
  );
  const repositoryId = positiveSafeInteger(
    child.repositoryId,
    'child.repositoryId',
  );
  const installationGeneration = positiveSafeInteger(
    child.installationGeneration,
    'child.installationGeneration',
  );
  let cause: StewardRuntimeScopeCauseV2;
  try {
    cause = parseStewardRuntimeScopeCauseV2(child.cause);
  } catch {
    invalid('child.cause must be a valid ScopeWorkItem V2 cause');
  }
  if (cause.deliveryId !== rootDeliveryId) {
    invalid('child.rootDeliveryId must match child.cause.deliveryId');
  }
  const installationRootCause =
    cause.event === 'custom_property'
    || cause.event === 'membership'
    || cause.event === 'installation'
    || cause.event === 'installation_target'
    || (
      cause.event === 'team'
      && (
        cause.action === 'created'
        || cause.action === 'edited'
        || cause.action === 'deleted'
      )
    );
  const repositorySetRootCause =
    cause.event === 'installation_repositories'
    || (
      cause.event === 'installation'
      && (cause.action === 'suspend' || cause.action === 'deleted')
    );
  if (
    (
      child.rootTargetScope === 'installation'
      && !installationRootCause
    )
    || (
      child.rootTargetScope === 'repository-set'
      && !repositorySetRootCause
    )
  ) {
    invalid('child cause is incompatible with child.rootTargetScope');
  }
  const expectedRootDigest = await deriveCompactRootDigest({
    installationId,
    rootDeliveryId,
    rootTargetScope: child.rootTargetScope,
    rootTargetDigest,
    cause,
  });
  if (rootDigest !== expectedRootDigest) {
    invalid('child.rootDigest must match the compact root commitment');
  }
  const deliveryId = canonicalVisibleAscii(
    child.deliveryId,
    'child.deliveryId',
    STEWARD_RUNTIME_INSTALLATION_FANOUT_MAXIMUM_DELIVERY_ID_LENGTH,
  );
  const expectedDeliveryId = buildStewardRuntimeInstallationFanoutDeliveryId(
    rootDigest,
    installationGeneration,
    repositoryId,
  );
  if (deliveryId !== expectedDeliveryId) {
    invalid(
      'child.deliveryId must match the root, generation, and repository ID',
    );
  }
  const parsed: StewardRuntimeInstallationRepositoryChildV1 = {
    schemaVersion:
      STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION,
    operation: 'installation-repository-fanout',
    rootDigest,
    rootTargetDigest,
    rootDeliveryId,
    rootTargetScope: child.rootTargetScope,
    installationId,
    repositoryId,
    installationGeneration,
    cause,
    deliveryId,
  };
  assertEnvelopeSize(repositoryChildValue(parsed));
  return parsed;
}

export async function buildStewardRuntimeInstallationRepositoryChildV1(
  input: {
    readonly root: StewardRuntimeInstallationFanoutRootV1;
    readonly installationId: number;
    readonly repositoryId: number;
    readonly installationGeneration: number;
  },
): Promise<StewardRuntimeInstallationRepositoryChildV1> {
  const builder = plainRecord(input, 'child builder input');
  requireExactKeys(
    builder,
    ['root', 'installationId', 'repositoryId', 'installationGeneration'],
    'child builder input',
  );
  const root = parseStewardRuntimeInstallationFanoutRootV1(builder.root);
  const rootTargetDigest =
    await deriveRootTargetDigest(root.scopeWorkItem.target);
  const rootDigest = await deriveCompactRootDigest({
    installationId: root.installationId,
    rootDeliveryId: root.deliveryId,
    rootTargetScope: root.scopeWorkItem.target.scope,
    rootTargetDigest,
    cause: root.scopeWorkItem.cause,
  });
  const repositoryId = positiveSafeInteger(
    builder.repositoryId,
    'child builder input.repositoryId',
  );
  const installationGeneration = positiveSafeInteger(
    builder.installationGeneration,
    'child builder input.installationGeneration',
  );
  if (builder.installationId !== root.installationId) {
    invalid('child builder installation ID must match the committed root');
  }
  if (
    root.scopeWorkItem.target.scope === 'repository-set'
    && !root.scopeWorkItem.target.repositoryIds.includes(repositoryId)
  ) {
    invalid('child repository ID must belong to the committed repository set');
  }
  return await parseStewardRuntimeInstallationRepositoryChildV1({
    schemaVersion:
      STEWARD_RUNTIME_INSTALLATION_REPOSITORY_CHILD_SCHEMA_VERSION,
    operation: 'installation-repository-fanout',
    rootDigest,
    rootTargetDigest,
    rootDeliveryId: root.deliveryId,
    rootTargetScope: root.scopeWorkItem.target.scope,
    installationId: root.installationId,
    repositoryId,
    installationGeneration,
    cause: root.scopeWorkItem.cause,
    deliveryId: buildStewardRuntimeInstallationFanoutDeliveryId(
      rootDigest,
      installationGeneration,
      repositoryId,
    ),
  });
}

export async function canonicalStewardRuntimeInstallationRepositoryChildV1Json(
  value: unknown,
): Promise<string> {
  const child =
    await parseStewardRuntimeInstallationRepositoryChildV1(value);
  return JSON.stringify(repositoryChildValue(child));
}
