import {
  RuntimeControlProtocolValidationError,
  parseStewardRuntimeControlRevision,
  type StewardRuntimeControlRevisionV1,
} from './runtime-control.js';
import {
  canonicalStewardRuntimeWorkItemJson,
  parseStewardRuntimeWorkItem,
  type StewardRuntimeWorkItemSubjectV1,
  type StewardRuntimeWorkItem,
} from './runtime-work-item.js';
import {
  deriveStewardRuntimeFanoutDeliveryId,
} from './runtime-repository-fanout.js';
import {
  buildStewardRuntimeScopeWorkItemV1,
} from './runtime-scope-work-item.js';
import { canonicalControlJson, controlJsonDigest } from './control-json.js';

const commitPattern = /^[0-9a-f]{40}$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/;

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

function parseSubject(value: unknown): StewardRuntimeWorkItemSubjectV1 {
  const subject = plainRecord(value, 'subject');
  requireExactKeys(
    subject,
    ['repositoryId', 'repositoryFullName', 'pullRequestNumber'],
    'subject',
  );
  const repositoryFullName = requireString(
    subject.repositoryFullName,
    'subject.repositoryFullName',
  );
  const parts = repositoryFullName.split('/');
  if (
    repositoryFullName !== repositoryFullName.trim()
    || parts.length !== 2
    || !githubLoginPattern.test(parts[0] ?? '')
    || !repositoryNamePattern.test(parts[1] ?? '')
  ) {
    invalid('subject.repositoryFullName must be a canonical GitHub owner/repository name');
  }
  return {
    repositoryId: requirePositiveSafeInteger(
      subject.repositoryId,
      'subject.repositoryId',
    ),
    repositoryFullName,
    pullRequestNumber: requirePositiveSafeInteger(
      subject.pullRequestNumber,
      'subject.pullRequestNumber',
    ),
  };
}

function parseControlRevision(
  value: unknown,
  _field = 'controlRevision',
): StewardRuntimeControlRevisionV1 {
  try {
    return parseStewardRuntimeControlRevision(value);
  } catch (error) {
    if (error instanceof RuntimeControlProtocolValidationError) throw error;
    return invalid('control revision is invalid');
  }
}

export const STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION = 2 as const;
export const STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS = 64;
export const STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES =
  64 * 1_024;
export const STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_ENVELOPE_BYTES =
  128 * 1_024;

const digestPatternV2 = /^[0-9a-f]{64}$/;
const identifierPatternV2 = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const canonicalBase64PatternV2 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type StewardRuntimeControlObjectiveV2 =
  | 'governance'
  | 'classification'
  | 'dco-advisory';
export type StewardRuntimeControlTerminalOutcomeV2 =
  | 'settled'
  | 'pending-external'
  | 'ignored'
  | 'action-required';
export type StewardRuntimeControlPrincipalV2 = 'installation' | 'human';
export type StewardRuntimeControlRecoveryPolicyV2 =
  | 'live-evidence'
  | 'live-evidence-or-action-required';

export interface StewardRuntimeControlBindingV2 {
  readonly workItem: StewardRuntimeWorkItem;
  readonly generation: number;
  readonly objective: StewardRuntimeControlObjectiveV2;
}

export interface StewardRuntimeControlResolvedContextV2
  extends StewardRuntimeWorkItemSubjectV1 {
  readonly headSha: string;
  readonly defaultBranch: string;
  readonly manifestBlobSha: string;
  readonly configDigest: string;
  readonly pullRequestDigest: string;
}

export interface StewardRuntimeControlMutationBindingV2 {
  readonly ordinal: number;
  readonly key: string;
  readonly mutationType: string;
  readonly principal: StewardRuntimeControlPrincipalV2;
  readonly recoveryPolicy: StewardRuntimeControlRecoveryPolicyV2;
  readonly desiredDigest: string;
}

export interface StewardRuntimeControlPlanBindingV2 {
  readonly contractVersion: 1;
  readonly planId: string;
  readonly planDigest: string;
  readonly preparedGeneration: number;
  readonly terminalOutcome: StewardRuntimeControlTerminalOutcomeV2;
  readonly canonicalPlanByteLength: number;
  readonly canonicalPlanBase64: string;
  readonly mutationCount: number;
  readonly mutations: readonly StewardRuntimeControlMutationBindingV2[];
}

export interface StewardRuntimeControlPrepareRequestV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION;
  readonly phase: 'prepare';
  readonly binding: StewardRuntimeControlBindingV2;
}

export interface StewardRuntimeControlPreparedReceiptV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION;
  readonly phase: 'prepared';
  readonly binding: StewardRuntimeControlBindingV2;
  readonly resolvedContext: StewardRuntimeControlResolvedContextV2;
  readonly plan: StewardRuntimeControlPlanBindingV2;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

interface StewardRuntimeControlMutationPhaseRequestV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION;
  readonly binding: StewardRuntimeControlBindingV2;
  readonly expectedControlRevision: StewardRuntimeControlRevisionV1;
  readonly resolvedContext: StewardRuntimeControlResolvedContextV2;
  readonly plan: StewardRuntimeControlPlanBindingV2;
  readonly mutation: StewardRuntimeControlMutationBindingV2;
}

export interface StewardRuntimeControlApplyNextRequestV2
  extends StewardRuntimeControlMutationPhaseRequestV2 {
  readonly phase: 'apply-next';
}

export interface StewardRuntimeControlRecoverRequestV2
  extends StewardRuntimeControlMutationPhaseRequestV2 {
  readonly phase: 'recover';
}

export type StewardRuntimeControlMutationResultStateV2 =
  | 'applied'
  | 'converged'
  | 'not-attempted'
  | 'stale-plan'
  | 'unknown';

export interface StewardRuntimeControlMutationResultV2 {
  readonly state: StewardRuntimeControlMutationResultStateV2;
  readonly resourceId: number | null;
  readonly retryAfterSeconds: number | null;
}

export interface StewardRuntimeControlMutationReceiptV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION;
  readonly phase: 'mutation-result';
  readonly binding: StewardRuntimeControlBindingV2;
  readonly resolvedContext: StewardRuntimeControlResolvedContextV2;
  readonly planId: string;
  readonly planDigest: string;
  readonly mutation: StewardRuntimeControlMutationBindingV2;
  readonly result: StewardRuntimeControlMutationResultV2;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

export type StewardRuntimeControlRecoveryResultStateV2 =
  | 'converged'
  | 'action-required'
  | 'unknown';

export interface StewardRuntimeControlRecoveryResultV2 {
  readonly state: StewardRuntimeControlRecoveryResultStateV2;
  readonly resourceId: number | null;
}

export interface StewardRuntimeControlRecoveryReceiptV2 {
  readonly schemaVersion: typeof STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION;
  readonly phase: 'recovery-result';
  readonly binding: StewardRuntimeControlBindingV2;
  readonly resolvedContext: StewardRuntimeControlResolvedContextV2;
  readonly planId: string;
  readonly planDigest: string;
  readonly mutation: StewardRuntimeControlMutationBindingV2;
  readonly result: StewardRuntimeControlRecoveryResultV2;
  readonly controlRevision: StewardRuntimeControlRevisionV1;
}

interface ParsedPlanBindingV2 {
  readonly plan: StewardRuntimeControlPlanBindingV2;
  readonly decodedPlan: UnknownRecord;
}

function requireNonNegativeSafeIntegerV2(
  value: unknown,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requireBoundedVisibleAsciiV2(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const text = requireString(value, field);
  if (
    text.length < 1
    || text.length > maximumLength
    || text !== text.trim()
    || !/^[\x21-\x7e]+$/.test(text)
  ) {
    invalid(
      `${field} must be 1-${maximumLength} canonical printable ASCII characters`,
    );
  }
  return text;
}

function requireDigestV2(value: unknown, field: string): string {
  const digest = requireString(value, field);
  if (!digestPatternV2.test(digest)) {
    invalid(`${field} must be a lowercase 64-character digest`);
  }
  return digest;
}

function requireCommitV2(value: unknown, field: string): string {
  const commit = requireString(value, field);
  if (!commitPattern.test(commit)) {
    invalid(`${field} must be a lowercase 40-character commit SHA`);
  }
  return commit;
}

function requireIdentifierV2(value: unknown, field: string): string {
  const identifier = requireString(value, field);
  if (
    identifier.length < 1
    || identifier.length > 64
    || !identifierPatternV2.test(identifier)
  ) {
    invalid(`${field} must be a lowercase dotted or hyphenated identifier of at most 64 characters`);
  }
  return identifier;
}

function requireDefaultBranchV2(value: unknown, field: string): string {
  const branch = requireString(value, field);
  const segments = branch.split('/');
  if (
    branch !== branch.trim()
    || branch === '@'
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.includes('..')
    || branch.includes('@{')
    || branch.includes('//')
    || /[\x00-\x20\x7f~^:?*[\]\\]/.test(branch)
    || new TextEncoder().encode(branch).byteLength > 255
    || segments.some((segment) =>
      segment.length < 1
      || segment.startsWith('.')
      || segment.toLowerCase().endsWith('.lock'))
  ) {
    invalid(`${field} must be a canonical Git branch name of at most 255 UTF-8 bytes`);
  }
  return branch;
}

async function parseBindingV2(
  value: unknown,
  field: string,
): Promise<StewardRuntimeControlBindingV2> {
  const binding = plainRecord(value, field);
  requireExactKeys(binding, ['workItem', 'generation', 'objective'], field);
  const workItem = parseStewardRuntimeWorkItem(binding.workItem);
  if (workItem.operation !== 'pull-request-reconcile') {
    invalid(`${field}.workItem must be a GitHub pull-request reconcile`);
  }
  if (workItem.cause.kind === 'internal-probe') {
    invalid(`${field}.workItem must be a GitHub pull-request reconcile`);
  }
  if (workItem.cause.kind === 'scope-fanout') {
    if (workItem.schemaVersion !== 3) {
      invalid(`${field}.workItem scope fan-out cause requires schema version 3`);
    }
    const scopeWorkItem = buildStewardRuntimeScopeWorkItemV1({
      operation: 'scope-reconcile',
      target: {
        scope: 'repository',
        mode: 'refresh',
        installationId: workItem.installationId,
        repositoryId: workItem.subject.repositoryId,
        pullRequests: 'all-open',
      },
      cause: {
        kind: 'github-webhook',
        deliveryId: workItem.cause.rootDeliveryId,
        event: 'repository',
        action: workItem.cause.action,
        receivedAt: workItem.cause.receivedAt,
      },
    });
    const expectedDeliveryId = await deriveStewardRuntimeFanoutDeliveryId(
      scopeWorkItem,
      workItem.cause.fanoutGeneration,
      workItem.subject.pullRequestNumber,
    );
    if (workItem.cause.deliveryId !== expectedDeliveryId) {
      invalid(`${field}.workItem scope fan-out delivery ID is not derivable from its binding`);
    }
  }
  if (
    binding.objective !== 'governance'
    && binding.objective !== 'classification'
    && binding.objective !== 'dco-advisory'
  ) {
    invalid(`${field}.objective is not a supported Control plan objective`);
  }
  return {
    workItem,
    generation: requirePositiveSafeInteger(
      binding.generation,
      `${field}.generation`,
    ),
    objective: binding.objective,
  };
}

function parseResolvedContextV2(
  value: unknown,
  field: string,
): StewardRuntimeControlResolvedContextV2 {
  const context = plainRecord(value, field);
  requireExactKeys(
    context,
    [
      'repositoryId',
      'repositoryFullName',
      'pullRequestNumber',
      'headSha',
      'defaultBranch',
      'manifestBlobSha',
      'configDigest',
      'pullRequestDigest',
    ],
    field,
  );
  const parsed = parseSubject({
    repositoryId: context.repositoryId,
    repositoryFullName: context.repositoryFullName,
    pullRequestNumber: context.pullRequestNumber,
  });
  return {
    ...parsed,
    headSha: requireCommitV2(context.headSha, `${field}.headSha`),
    defaultBranch: requireDefaultBranchV2(
      context.defaultBranch,
      `${field}.defaultBranch`,
    ),
    manifestBlobSha: requireCommitV2(
      context.manifestBlobSha,
      `${field}.manifestBlobSha`,
    ),
    configDigest: requireDigestV2(
      context.configDigest,
      `${field}.configDigest`,
    ),
    pullRequestDigest: requireDigestV2(
      context.pullRequestDigest,
      `${field}.pullRequestDigest`,
    ),
  };
}

function assertResolvedContextMatchesBindingV2(
  binding: StewardRuntimeControlBindingV2,
  context: StewardRuntimeControlResolvedContextV2,
): void {
  // The queued full name is diagnostic routing evidence, while the numeric
  // repository ID is authoritative. A fresh live read may legitimately return
  // a renamed or case-normalized full name before this plan is prepared.
  if (
    context.repositoryId !== binding.workItem.subject.repositoryId
    || context.pullRequestNumber !== binding.workItem.subject.pullRequestNumber
  ) {
    invalid(
      'resolvedContext must preserve the work-item repository and pull request identifiers',
    );
  }
}

function parseMutationBindingV2(
  value: unknown,
  field: string,
): StewardRuntimeControlMutationBindingV2 {
  const mutation = plainRecord(value, field);
  requireExactKeys(
    mutation,
    [
      'ordinal',
      'key',
      'mutationType',
      'principal',
      'recoveryPolicy',
      'desiredDigest',
    ],
    field,
  );
  if (
    mutation.principal !== 'installation'
    && mutation.principal !== 'human'
  ) {
    invalid(`${field}.principal must be installation or human`);
  }
  if (
    mutation.recoveryPolicy !== 'live-evidence'
    && mutation.recoveryPolicy !== 'live-evidence-or-action-required'
  ) {
    invalid(`${field}.recoveryPolicy is unsupported`);
  }
  if (
    (mutation.principal === 'installation'
      && mutation.recoveryPolicy !== 'live-evidence')
    || (mutation.principal === 'human'
      && mutation.recoveryPolicy !== 'live-evidence-or-action-required')
  ) {
    invalid(`${field}.recoveryPolicy must match its execution principal`);
  }
  return {
    ordinal: requireNonNegativeSafeIntegerV2(
      mutation.ordinal,
      `${field}.ordinal`,
    ),
    key: requireBoundedVisibleAsciiV2(mutation.key, `${field}.key`, 128),
    mutationType: requireIdentifierV2(
      mutation.mutationType,
      `${field}.mutationType`,
    ),
    principal: mutation.principal,
    recoveryPolicy: mutation.recoveryPolicy,
    desiredDigest: requireDigestV2(
      mutation.desiredDigest,
      `${field}.desiredDigest`,
    ),
  };
}

function decodeCanonicalPlanV2(
  encodedValue: unknown,
  declaredByteLength: number,
  field: string,
): { readonly bytes: Uint8Array; readonly text: string; readonly value: UnknownRecord } {
  const encoded = requireString(encodedValue, field);
  if (
    encoded.length < 1
    || !canonicalBase64PatternV2.test(encoded)
  ) {
    invalid(`${field} must use canonical padded standard base64`);
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return invalid(`${field} must use canonical padded standard base64`);
  }
  if (btoa(binary) !== encoded) {
    invalid(`${field} must use canonical padded standard base64`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength !== declaredByteLength
    || bytes.byteLength < 1
    || bytes.byteLength > STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_CANONICAL_PLAN_BYTES
  ) {
    invalid(
      `${field} decoded byte length must match canonicalPlanByteLength and be within the v2 limit`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return invalid(`${field} must contain valid canonical UTF-8 JSON`);
  }
  if (text.startsWith('\uFEFF')) {
    invalid(`${field} must not contain a UTF-8 BOM`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return invalid(`${field} must contain valid canonical UTF-8 JSON`);
  }
  const record = plainRecord(decoded, `${field}.decoded`);
  if (canonicalControlJson(record) !== text) {
    invalid(`${field} must contain canonical Control plan JSON`);
  }
  return { bytes, text, value: record };
}

async function sha256BytesV2(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(bytes).buffer,
    ),
  );
  return [...digest]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function parsePlanBindingV2(
  value: unknown,
  field: string,
): Promise<ParsedPlanBindingV2> {
  const plan = plainRecord(value, field);
  requireExactKeys(
    plan,
    [
      'contractVersion',
      'planId',
      'planDigest',
      'preparedGeneration',
      'terminalOutcome',
      'canonicalPlanByteLength',
      'canonicalPlanBase64',
      'mutationCount',
      'mutations',
    ],
    field,
  );
  if (plan.contractVersion !== 1) {
    invalid(`${field}.contractVersion must be 1`);
  }
  const planId = requireDigestV2(plan.planId, `${field}.planId`);
  const planDigest = requireDigestV2(plan.planDigest, `${field}.planDigest`);
  const preparedGeneration = requirePositiveSafeInteger(
    plan.preparedGeneration,
    `${field}.preparedGeneration`,
  );
  if (
    plan.terminalOutcome !== 'settled'
    && plan.terminalOutcome !== 'pending-external'
    && plan.terminalOutcome !== 'ignored'
    && plan.terminalOutcome !== 'action-required'
  ) {
    invalid(`${field}.terminalOutcome is unsupported`);
  }
  const canonicalPlanByteLength = requirePositiveSafeInteger(
    plan.canonicalPlanByteLength,
    `${field}.canonicalPlanByteLength`,
  );
  const decoded = decodeCanonicalPlanV2(
    plan.canonicalPlanBase64,
    canonicalPlanByteLength,
    `${field}.canonicalPlanBase64`,
  );
  if (await sha256BytesV2(decoded.bytes) !== planDigest) {
    invalid(`${field}.planDigest must bind the canonical Control plan bytes`);
  }
  const {
    planId: _decodedPlanId,
    ...decodedPlanWithoutId
  } = decoded.value;
  if (await controlJsonDigest(decodedPlanWithoutId) !== planId) {
    invalid(`${field}.planId must match the canonical Control plan identity`);
  }
  const mutationCount = requireNonNegativeSafeIntegerV2(
    plan.mutationCount,
    `${field}.mutationCount`,
  );
  if (
    mutationCount > STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS
    || !Array.isArray(plan.mutations)
    || plan.mutations.length !== mutationCount
  ) {
    invalid(
      `${field}.mutations must match mutationCount and contain at most ${STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_MUTATIONS} intents`,
    );
  }
  const mutations = plan.mutations.map((mutation, index) => {
    const parsed = parseMutationBindingV2(
      mutation,
      `${field}.mutations[${index}]`,
    );
    if (parsed.ordinal !== index) {
      invalid(`${field}.mutations must use contiguous zero-based ordinals`);
    }
    return parsed;
  });
  if (new Set(mutations.map((mutation) => mutation.key)).size !== mutations.length) {
    invalid(`${field}.mutations must use unique keys`);
  }
  if (plan.terminalOutcome === 'ignored' && mutationCount !== 0) {
    invalid(`${field}.ignored plans must not contain mutations`);
  }
  return {
    plan: {
      contractVersion: 1,
      planId,
      planDigest,
      preparedGeneration,
      terminalOutcome: plan.terminalOutcome,
      canonicalPlanByteLength,
      canonicalPlanBase64: requireString(
        plan.canonicalPlanBase64,
        `${field}.canonicalPlanBase64`,
      ),
      mutationCount,
      mutations,
    },
    decodedPlan: decoded.value,
  };
}

async function assertDecodedPlanBindingsV2(
  decodedPlan: UnknownRecord,
  binding: StewardRuntimeControlBindingV2,
  context: StewardRuntimeControlResolvedContextV2,
  plan: StewardRuntimeControlPlanBindingV2,
  field: string,
): Promise<void> {
  if (
    decodedPlan.contractVersion !== plan.contractVersion
    || decodedPlan.planId !== plan.planId
    || decodedPlan.objective !== binding.objective
    || decodedPlan.pullRequestDigest !== context.pullRequestDigest
  ) {
    invalid(`${field} identity does not match its canonical Control plan`);
  }
  const outcome = plainRecord(decodedPlan.outcome, `${field}.outcome`);
  const expectedTerminalOutcome =
    outcome.state === 'passed' || outcome.state === 'failed'
      ? 'settled'
      : outcome.state === 'pending'
        ? 'pending-external'
        : outcome.state === 'ignored'
          ? 'ignored'
          : outcome.state === 'action_required'
            ? 'action-required'
            : invalid(`${field}.outcome.state is unsupported`);
  if (plan.terminalOutcome !== expectedTerminalOutcome) {
    invalid(`${field}.terminalOutcome does not match the canonical Control plan outcome`);
  }
  const decodedSubject = plainRecord(decodedPlan.subject, `${field}.subject`);
  const repository = plainRecord(
    decodedSubject.repository,
    `${field}.subject.repository`,
  );
  const pullRequest = plainRecord(
    decodedSubject.pullRequest,
    `${field}.subject.pullRequest`,
  );
  const manifest = plainRecord(
    decodedSubject.manifest,
    `${field}.subject.manifest`,
  );
  const owner = requireString(
    repository.owner,
    `${field}.subject.repository.owner`,
  );
  const name = requireString(
    repository.name,
    `${field}.subject.repository.name`,
  );
  if (
    repository.id !== context.repositoryId
    || `${owner}/${name}` !== context.repositoryFullName
    || repository.defaultBranch !== context.defaultBranch
    || pullRequest.number !== context.pullRequestNumber
    || pullRequest.headSha !== context.headSha
    || manifest.blobSha !== context.manifestBlobSha
    || manifest.configDigest !== context.configDigest
  ) {
    invalid(`${field} subject does not match its resolved live context binding`);
  }
  if (!Array.isArray(decodedPlan.mutations)) {
    invalid(`${field}.mutations must be an array`);
  }
  if (decodedPlan.mutations.length !== plan.mutations.length) {
    invalid(`${field}.mutations do not match the persisted intent bindings`);
  }
  for (const [index, mutationValue] of decodedPlan.mutations.entries()) {
    const mutation = plainRecord(
      mutationValue,
      `${field}.mutations[${index}]`,
    );
    const preconditions = plainRecord(
      mutation.preconditions,
      `${field}.mutations[${index}].preconditions`,
    );
    const expected = plan.mutations[index];
    const {
      desiredDigest: _desiredDigest,
      preconditions: _preconditions,
      ...mutationIntent
    } = mutation;
    if (
      expected === undefined
      || mutation.key !== expected.key
      || mutation.type !== expected.mutationType
      || mutation.principal !== expected.principal
      || mutation.desiredDigest !== expected.desiredDigest
      || preconditions.repositoryId !== context.repositoryId
      || preconditions.defaultBranch !== context.defaultBranch
      || preconditions.pullNumber !== context.pullRequestNumber
      || preconditions.headSha !== context.headSha
      || preconditions.manifestBlobSha !== context.manifestBlobSha
      || preconditions.configDigest !== context.configDigest
      || preconditions.pullRequestDigest !== context.pullRequestDigest
      || await controlJsonDigest(mutationIntent) !== expected.desiredDigest
    ) {
      invalid(`${field}.mutations do not match the persisted intent bindings`);
    }
  }
}

function assertSelectedMutationV2(
  plan: StewardRuntimeControlPlanBindingV2,
  mutation: StewardRuntimeControlMutationBindingV2,
  field: string,
): void {
  const expected = plan.mutations[mutation.ordinal];
  if (
    expected === undefined
    || expected.key !== mutation.key
    || expected.mutationType !== mutation.mutationType
    || expected.principal !== mutation.principal
    || expected.recoveryPolicy !== mutation.recoveryPolicy
    || expected.desiredDigest !== mutation.desiredDigest
  ) {
    invalid(`${field} must select the exact persisted plan intent`);
  }
}

function parseExpectedControlRevisionV2(
  value: unknown,
): StewardRuntimeControlRevisionV1 {
  return parseControlRevision(value, 'expectedControlRevision');
}

function parseMutationResultV2(
  value: unknown,
): StewardRuntimeControlMutationResultV2 {
  const result = plainRecord(value, 'result');
  requireExactKeys(
    result,
    ['state', 'resourceId', 'retryAfterSeconds'],
    'result',
  );
  if (
    result.state !== 'applied'
    && result.state !== 'converged'
    && result.state !== 'not-attempted'
    && result.state !== 'stale-plan'
    && result.state !== 'unknown'
  ) {
    invalid('result.state is unsupported');
  }
  const resourceId = result.resourceId === null
    ? null
    : requirePositiveSafeInteger(result.resourceId, 'result.resourceId');
  const retryAfterSeconds = result.retryAfterSeconds === null
    ? null
    : requireNonNegativeSafeIntegerV2(
        result.retryAfterSeconds,
        'result.retryAfterSeconds',
      );
  if (
    retryAfterSeconds !== null
    && retryAfterSeconds > 900
  ) {
    invalid('result.retryAfterSeconds must not exceed 900');
  }
  if (
    (result.state === 'applied' || result.state === 'converged')
      ? retryAfterSeconds !== null
      : result.state === 'not-attempted'
        ? resourceId !== null || retryAfterSeconds === null
        : resourceId !== null || retryAfterSeconds !== null
  ) {
    invalid('result fields are inconsistent with result.state');
  }
  return {
    state: result.state,
    resourceId,
    retryAfterSeconds,
  };
}

function parseRecoveryResultV2(
  value: unknown,
): StewardRuntimeControlRecoveryResultV2 {
  const result = plainRecord(value, 'result');
  requireExactKeys(result, ['state', 'resourceId'], 'result');
  if (
    result.state !== 'converged'
    && result.state !== 'action-required'
    && result.state !== 'unknown'
  ) {
    invalid('result.state is unsupported');
  }
  const resourceId = result.resourceId === null
    ? null
    : requirePositiveSafeInteger(result.resourceId, 'result.resourceId');
  if (result.state !== 'converged' && resourceId !== null) {
    invalid('result.resourceId is only allowed for converged recovery');
  }
  return { state: result.state, resourceId };
}

function assertRecoveryResultPolicyV2(
  mutation: StewardRuntimeControlMutationBindingV2,
  result: StewardRuntimeControlRecoveryResultV2,
): void {
  if (
    result.state === 'action-required'
    && mutation.recoveryPolicy !== 'live-evidence-or-action-required'
  ) {
    invalid(
      'action-required recovery requires live-evidence-or-action-required policy',
    );
  }
}

function bindingValueV2(
  binding: StewardRuntimeControlBindingV2,
): Record<string, unknown> {
  return {
    workItem: JSON.parse(
      canonicalStewardRuntimeWorkItemJson(binding.workItem),
    ) as unknown,
    generation: binding.generation,
    objective: binding.objective,
  };
}

function resolvedContextValueV2(
  context: StewardRuntimeControlResolvedContextV2,
): Record<string, unknown> {
  return {
    repositoryId: context.repositoryId,
    repositoryFullName: context.repositoryFullName,
    pullRequestNumber: context.pullRequestNumber,
    headSha: context.headSha,
    defaultBranch: context.defaultBranch,
    manifestBlobSha: context.manifestBlobSha,
    configDigest: context.configDigest,
    pullRequestDigest: context.pullRequestDigest,
  };
}

function mutationBindingValueV2(
  mutation: StewardRuntimeControlMutationBindingV2,
): Record<string, unknown> {
  return {
    ordinal: mutation.ordinal,
    key: mutation.key,
    mutationType: mutation.mutationType,
    principal: mutation.principal,
    recoveryPolicy: mutation.recoveryPolicy,
    desiredDigest: mutation.desiredDigest,
  };
}

function planBindingValueV2(
  plan: StewardRuntimeControlPlanBindingV2,
): Record<string, unknown> {
  return {
    contractVersion: plan.contractVersion,
    planId: plan.planId,
    planDigest: plan.planDigest,
    preparedGeneration: plan.preparedGeneration,
    terminalOutcome: plan.terminalOutcome,
    canonicalPlanByteLength: plan.canonicalPlanByteLength,
    canonicalPlanBase64: plan.canonicalPlanBase64,
    mutationCount: plan.mutationCount,
    mutations: plan.mutations.map(mutationBindingValueV2),
  };
}

function controlRevisionValueV2(
  revision: StewardRuntimeControlRevisionV1,
): Record<string, unknown> {
  return {
    stewardCommit: revision.stewardCommit,
    workerVersionId: revision.workerVersionId,
    workerVersionTag: revision.workerVersionTag,
    workerVersionCreatedAt: revision.workerVersionCreatedAt,
  };
}

function mutationResultValueV2(
  result: StewardRuntimeControlMutationResultV2,
): Record<string, unknown> {
  return {
    state: result.state,
    resourceId: result.resourceId,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

function recoveryResultValueV2(
  result: StewardRuntimeControlRecoveryResultV2,
): Record<string, unknown> {
  return {
    state: result.state,
    resourceId: result.resourceId,
  };
}

function assertEnvelopeSizeV2(value: Record<string, unknown>): void {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
    > STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_ENVELOPE_BYTES
  ) {
    invalid(
      `canonical v2 envelope must not exceed ${STEWARD_RUNTIME_CONTROL_V2_MAXIMUM_ENVELOPE_BYTES} UTF-8 bytes`,
    );
  }
}

function prepareRequestValueV2(
  request: StewardRuntimeControlPrepareRequestV2,
): Record<string, unknown> {
  return {
    schemaVersion: request.schemaVersion,
    phase: request.phase,
    binding: bindingValueV2(request.binding),
  };
}

function preparedReceiptValueV2(
  receipt: StewardRuntimeControlPreparedReceiptV2,
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: bindingValueV2(receipt.binding),
    resolvedContext: resolvedContextValueV2(receipt.resolvedContext),
    plan: planBindingValueV2(receipt.plan),
    controlRevision: controlRevisionValueV2(receipt.controlRevision),
  };
}

function mutationPhaseRequestValueV2(
  request:
    | StewardRuntimeControlApplyNextRequestV2
    | StewardRuntimeControlRecoverRequestV2,
): Record<string, unknown> {
  return {
    schemaVersion: request.schemaVersion,
    phase: request.phase,
    binding: bindingValueV2(request.binding),
    expectedControlRevision: controlRevisionValueV2(
      request.expectedControlRevision,
    ),
    resolvedContext: resolvedContextValueV2(request.resolvedContext),
    plan: planBindingValueV2(request.plan),
    mutation: mutationBindingValueV2(request.mutation),
  };
}

function mutationReceiptValueV2(
  receipt: StewardRuntimeControlMutationReceiptV2,
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: bindingValueV2(receipt.binding),
    resolvedContext: resolvedContextValueV2(receipt.resolvedContext),
    planId: receipt.planId,
    planDigest: receipt.planDigest,
    mutation: mutationBindingValueV2(receipt.mutation),
    result: mutationResultValueV2(receipt.result),
    controlRevision: controlRevisionValueV2(receipt.controlRevision),
  };
}

function recoveryReceiptValueV2(
  receipt: StewardRuntimeControlRecoveryReceiptV2,
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    binding: bindingValueV2(receipt.binding),
    resolvedContext: resolvedContextValueV2(receipt.resolvedContext),
    planId: receipt.planId,
    planDigest: receipt.planDigest,
    mutation: mutationBindingValueV2(receipt.mutation),
    result: recoveryResultValueV2(receipt.result),
    controlRevision: controlRevisionValueV2(receipt.controlRevision),
  };
}

export async function parseStewardRuntimeControlPrepareRequestV2(
  value: unknown,
): Promise<StewardRuntimeControlPrepareRequestV2> {
  const request = plainRecord(value, 'request');
  requireExactKeys(request, ['schemaVersion', 'phase', 'binding'], 'request');
  if (
    request.schemaVersion !== STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION
    || request.phase !== 'prepare'
  ) {
    invalid('request must be a Steward runtime Control v2 prepare request');
  }
  const parsed: StewardRuntimeControlPrepareRequestV2 = {
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'prepare',
    binding: await parseBindingV2(request.binding, 'request.binding'),
  };
  assertEnvelopeSizeV2(prepareRequestValueV2(parsed));
  return parsed;
}

export async function buildStewardRuntimeControlPrepareRequestV2(
  input: Omit<StewardRuntimeControlPrepareRequestV2, 'schemaVersion' | 'phase'>,
): Promise<StewardRuntimeControlPrepareRequestV2> {
  const value = plainRecord(input, 'prepare request builder input');
  requireExactKeys(value, ['binding'], 'prepare request builder input');
  return parseStewardRuntimeControlPrepareRequestV2({
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'prepare',
    binding: value.binding,
  });
}

export async function canonicalStewardRuntimeControlPrepareRequestV2Json(
  value: unknown,
): Promise<string> {
  return JSON.stringify(
    prepareRequestValueV2(
      await parseStewardRuntimeControlPrepareRequestV2(value),
    ),
  );
}

export async function parseStewardRuntimeControlPreparedReceiptV2(
  value: unknown,
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'resolvedContext',
      'plan',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion !== STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION
    || receipt.phase !== 'prepared'
  ) {
    invalid('receipt must be a Steward runtime Control v2 prepared receipt');
  }
  const binding = await parseBindingV2(receipt.binding, 'receipt.binding');
  const resolvedContext = parseResolvedContextV2(
    receipt.resolvedContext,
    'receipt.resolvedContext',
  );
  assertResolvedContextMatchesBindingV2(binding, resolvedContext);
  const parsedPlan = await parsePlanBindingV2(receipt.plan, 'receipt.plan');
  if (parsedPlan.plan.preparedGeneration !== binding.generation) {
    invalid('receipt.plan.preparedGeneration must match the prepare generation');
  }
  await assertDecodedPlanBindingsV2(
    parsedPlan.decodedPlan,
    binding,
    resolvedContext,
    parsedPlan.plan,
    'receipt.plan',
  );
  const parsed: StewardRuntimeControlPreparedReceiptV2 = {
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'prepared',
    binding,
    resolvedContext,
    plan: parsedPlan.plan,
    controlRevision: parseControlRevision(
      receipt.controlRevision,
      'receipt.controlRevision',
    ),
  };
  assertEnvelopeSizeV2(preparedReceiptValueV2(parsed));
  return parsed;
}

export async function buildStewardRuntimeControlPreparedReceiptV2(
  input: Omit<StewardRuntimeControlPreparedReceiptV2, 'schemaVersion' | 'phase'>,
): Promise<StewardRuntimeControlPreparedReceiptV2> {
  const value = plainRecord(input, 'prepared receipt builder input');
  requireExactKeys(
    value,
    ['binding', 'resolvedContext', 'plan', 'controlRevision'],
    'prepared receipt builder input',
  );
  return parseStewardRuntimeControlPreparedReceiptV2({
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'prepared',
    binding: value.binding,
    resolvedContext: value.resolvedContext,
    plan: value.plan,
    controlRevision: value.controlRevision,
  });
}

export async function canonicalStewardRuntimeControlPreparedReceiptV2Json(
  value: unknown,
): Promise<string> {
  return JSON.stringify(
    preparedReceiptValueV2(
      await parseStewardRuntimeControlPreparedReceiptV2(value),
    ),
  );
}

async function parseMutationPhaseRequestV2(
  value: unknown,
  expectedPhase: 'apply-next' | 'recover',
): Promise<
  StewardRuntimeControlApplyNextRequestV2
  | StewardRuntimeControlRecoverRequestV2
> {
  const request = plainRecord(value, 'request');
  requireExactKeys(
    request,
    [
      'schemaVersion',
      'phase',
      'binding',
      'expectedControlRevision',
      'resolvedContext',
      'plan',
      'mutation',
    ],
    'request',
  );
  if (
    request.schemaVersion !== STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION
    || request.phase !== expectedPhase
  ) {
    invalid(`request must be a Steward runtime Control v2 ${expectedPhase} request`);
  }
  const binding = await parseBindingV2(request.binding, 'request.binding');
  const resolvedContext = parseResolvedContextV2(
    request.resolvedContext,
    'request.resolvedContext',
  );
  assertResolvedContextMatchesBindingV2(binding, resolvedContext);
  const parsedPlan = await parsePlanBindingV2(request.plan, 'request.plan');
  if (
    expectedPhase === 'apply-next'
      ? binding.generation !== parsedPlan.plan.preparedGeneration
      : binding.generation <= parsedPlan.plan.preparedGeneration
  ) {
    invalid(
      expectedPhase === 'apply-next'
        ? 'apply-next must execute under the generation that prepared the plan'
        : 'recover must execute under a generation newer than the prepared plan',
    );
  }
  await assertDecodedPlanBindingsV2(
    parsedPlan.decodedPlan,
    binding,
    resolvedContext,
    parsedPlan.plan,
    'request.plan',
  );
  const mutation = parseMutationBindingV2(
    request.mutation,
    'request.mutation',
  );
  assertSelectedMutationV2(parsedPlan.plan, mutation, 'request.mutation');
  const common = {
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    binding,
    expectedControlRevision: parseExpectedControlRevisionV2(
      request.expectedControlRevision,
    ),
    resolvedContext,
    plan: parsedPlan.plan,
    mutation,
  };
  const parsed = expectedPhase === 'apply-next'
    ? { ...common, phase: 'apply-next' as const }
    : { ...common, phase: 'recover' as const };
  assertEnvelopeSizeV2(mutationPhaseRequestValueV2(parsed));
  return parsed;
}

export async function parseStewardRuntimeControlApplyNextRequestV2(
  value: unknown,
): Promise<StewardRuntimeControlApplyNextRequestV2> {
  return await parseMutationPhaseRequestV2(
    value,
    'apply-next',
  ) as StewardRuntimeControlApplyNextRequestV2;
}

export async function buildStewardRuntimeControlApplyNextRequestV2(
  input: Omit<
    StewardRuntimeControlApplyNextRequestV2,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeControlApplyNextRequestV2> {
  const value = plainRecord(input, 'apply-next request builder input');
  requireExactKeys(
    value,
    [
      'binding',
      'expectedControlRevision',
      'resolvedContext',
      'plan',
      'mutation',
    ],
    'apply-next request builder input',
  );
  return parseStewardRuntimeControlApplyNextRequestV2({
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'apply-next',
    binding: value.binding,
    expectedControlRevision: value.expectedControlRevision,
    resolvedContext: value.resolvedContext,
    plan: value.plan,
    mutation: value.mutation,
  });
}

export async function canonicalStewardRuntimeControlApplyNextRequestV2Json(
  value: unknown,
): Promise<string> {
  return JSON.stringify(
    mutationPhaseRequestValueV2(
      await parseStewardRuntimeControlApplyNextRequestV2(value),
    ),
  );
}

export async function parseStewardRuntimeControlRecoverRequestV2(
  value: unknown,
): Promise<StewardRuntimeControlRecoverRequestV2> {
  return await parseMutationPhaseRequestV2(
    value,
    'recover',
  ) as StewardRuntimeControlRecoverRequestV2;
}

export async function buildStewardRuntimeControlRecoverRequestV2(
  input: Omit<
    StewardRuntimeControlRecoverRequestV2,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeControlRecoverRequestV2> {
  const value = plainRecord(input, 'recover request builder input');
  requireExactKeys(
    value,
    [
      'binding',
      'expectedControlRevision',
      'resolvedContext',
      'plan',
      'mutation',
    ],
    'recover request builder input',
  );
  return parseStewardRuntimeControlRecoverRequestV2({
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'recover',
    binding: value.binding,
    expectedControlRevision: value.expectedControlRevision,
    resolvedContext: value.resolvedContext,
    plan: value.plan,
    mutation: value.mutation,
  });
}

export async function canonicalStewardRuntimeControlRecoverRequestV2Json(
  value: unknown,
): Promise<string> {
  return JSON.stringify(
    mutationPhaseRequestValueV2(
      await parseStewardRuntimeControlRecoverRequestV2(value),
    ),
  );
}

export async function parseStewardRuntimeControlMutationReceiptV2(
  value: unknown,
): Promise<StewardRuntimeControlMutationReceiptV2> {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'resolvedContext',
      'planId',
      'planDigest',
      'mutation',
      'result',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion !== STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION
    || receipt.phase !== 'mutation-result'
  ) {
    invalid('receipt must be a Steward runtime Control v2 mutation receipt');
  }
  const binding = await parseBindingV2(receipt.binding, 'receipt.binding');
  const resolvedContext = parseResolvedContextV2(
    receipt.resolvedContext,
    'receipt.resolvedContext',
  );
  assertResolvedContextMatchesBindingV2(binding, resolvedContext);
  const parsed: StewardRuntimeControlMutationReceiptV2 = {
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'mutation-result',
    binding,
    resolvedContext,
    planId: requireDigestV2(receipt.planId, 'receipt.planId'),
    planDigest: requireDigestV2(receipt.planDigest, 'receipt.planDigest'),
    mutation: parseMutationBindingV2(
      receipt.mutation,
      'receipt.mutation',
    ),
    result: parseMutationResultV2(receipt.result),
    controlRevision: parseControlRevision(
      receipt.controlRevision,
      'receipt.controlRevision',
    ),
  };
  assertEnvelopeSizeV2(mutationReceiptValueV2(parsed));
  return parsed;
}

export async function buildStewardRuntimeControlMutationReceiptV2(
  input: Omit<
    StewardRuntimeControlMutationReceiptV2,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeControlMutationReceiptV2> {
  const value = plainRecord(input, 'mutation receipt builder input');
  requireExactKeys(
    value,
    [
      'binding',
      'resolvedContext',
      'planId',
      'planDigest',
      'mutation',
      'result',
      'controlRevision',
    ],
    'mutation receipt builder input',
  );
  return parseStewardRuntimeControlMutationReceiptV2({
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'mutation-result',
    binding: value.binding,
    resolvedContext: value.resolvedContext,
    planId: value.planId,
    planDigest: value.planDigest,
    mutation: value.mutation,
    result: value.result,
    controlRevision: value.controlRevision,
  });
}

export async function canonicalStewardRuntimeControlMutationReceiptV2Json(
  value: unknown,
): Promise<string> {
  return JSON.stringify(
    mutationReceiptValueV2(
      await parseStewardRuntimeControlMutationReceiptV2(value),
    ),
  );
}

export async function parseStewardRuntimeControlRecoveryReceiptV2(
  value: unknown,
): Promise<StewardRuntimeControlRecoveryReceiptV2> {
  const receipt = plainRecord(value, 'receipt');
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'phase',
      'binding',
      'resolvedContext',
      'planId',
      'planDigest',
      'mutation',
      'result',
      'controlRevision',
    ],
    'receipt',
  );
  if (
    receipt.schemaVersion !== STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION
    || receipt.phase !== 'recovery-result'
  ) {
    invalid('receipt must be a Steward runtime Control v2 recovery receipt');
  }
  const binding = await parseBindingV2(receipt.binding, 'receipt.binding');
  const resolvedContext = parseResolvedContextV2(
    receipt.resolvedContext,
    'receipt.resolvedContext',
  );
  assertResolvedContextMatchesBindingV2(binding, resolvedContext);
  const parsed: StewardRuntimeControlRecoveryReceiptV2 = {
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'recovery-result',
    binding,
    resolvedContext,
    planId: requireDigestV2(receipt.planId, 'receipt.planId'),
    planDigest: requireDigestV2(receipt.planDigest, 'receipt.planDigest'),
    mutation: parseMutationBindingV2(
      receipt.mutation,
      'receipt.mutation',
    ),
    result: parseRecoveryResultV2(receipt.result),
    controlRevision: parseControlRevision(
      receipt.controlRevision,
      'receipt.controlRevision',
    ),
  };
  assertRecoveryResultPolicyV2(parsed.mutation, parsed.result);
  assertEnvelopeSizeV2(recoveryReceiptValueV2(parsed));
  return parsed;
}

export async function buildStewardRuntimeControlRecoveryReceiptV2(
  input: Omit<
    StewardRuntimeControlRecoveryReceiptV2,
    'schemaVersion' | 'phase'
  >,
): Promise<StewardRuntimeControlRecoveryReceiptV2> {
  const value = plainRecord(input, 'recovery receipt builder input');
  requireExactKeys(
    value,
    [
      'binding',
      'resolvedContext',
      'planId',
      'planDigest',
      'mutation',
      'result',
      'controlRevision',
    ],
    'recovery receipt builder input',
  );
  return parseStewardRuntimeControlRecoveryReceiptV2({
    schemaVersion: STEWARD_RUNTIME_CONTROL_V2_SCHEMA_VERSION,
    phase: 'recovery-result',
    binding: value.binding,
    resolvedContext: value.resolvedContext,
    planId: value.planId,
    planDigest: value.planDigest,
    mutation: value.mutation,
    result: value.result,
    controlRevision: value.controlRevision,
  });
}

export async function canonicalStewardRuntimeControlRecoveryReceiptV2Json(
  value: unknown,
): Promise<string> {
  return JSON.stringify(
    recoveryReceiptValueV2(
      await parseStewardRuntimeControlRecoveryReceiptV2(value),
    ),
  );
}
