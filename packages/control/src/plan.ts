import { sha256HexUtf8 } from '../../manifest/src/index.js';
import type { GitHubPullRequest } from '../../github/src/index.js';
import { parseStewardCheckExternalId } from '../../core/src/index.js';
import {
  controlPlanContractVersion,
  type ControlMutation,
  type ControlMutationIntent,
  type ControlMutationPreconditions,
  type ControlPlan,
  type ControlPlanOutcome,
  type ControlPlanSubject,
  type ControlObjective,
} from './contracts.js';
import { controlPullRequestInput } from './snapshot.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((child, index) => canonicalValue(child, `${path}/${index}`));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, canonicalValue(child, `${path}/${key}`)]));
  }
  throw new TypeError(`${path} is not JSON serializable`);
}

export function canonicalControlJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, '$'));
}

export function controlJsonDigest(value: unknown): Promise<string> {
  return sha256HexUtf8(canonicalControlJson(value));
}

type UnknownRecord = Record<string, unknown>;

function strictRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const record = value as UnknownRecord;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${path}/${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in record)) throw new TypeError(`${path}/${key} is required`);
  }
  return record;
}

function stringField(record: UnknownRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new TypeError(`${path}/${key} must be a string`);
  return value;
}

function numberField(record: UnknownRecord, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path}/${key} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${path} must be an array of strings`);
  }
  return value;
}

function assertSubjectEnvelope(value: unknown): void {
  const subject = strictRecord(value, '$/subject', ['repository', 'pullRequest', 'manifest', 'platform']);
  const repository = strictRecord(
    subject.repository,
    '$/subject/repository',
    ['id', 'owner', 'name', 'defaultBranch'],
  );
  numberField(repository, 'id', '$/subject/repository');
  stringField(repository, 'owner', '$/subject/repository');
  stringField(repository, 'name', '$/subject/repository');
  stringField(repository, 'defaultBranch', '$/subject/repository');
  const pullRequest = strictRecord(subject.pullRequest, '$/subject/pullRequest', ['number', 'headSha']);
  numberField(pullRequest, 'number', '$/subject/pullRequest');
  stringField(pullRequest, 'headSha', '$/subject/pullRequest');
  const manifest = strictRecord(subject.manifest, '$/subject/manifest', ['blobSha', 'configDigest']);
  stringField(manifest, 'blobSha', '$/subject/manifest');
  stringField(manifest, 'configDigest', '$/subject/manifest');
  const platform = strictRecord(subject.platform, '$/subject/platform', ['appId', 'clientId', 'appSlug']);
  numberField(platform, 'appId', '$/subject/platform');
  stringField(platform, 'clientId', '$/subject/platform');
  stringField(platform, 'appSlug', '$/subject/platform');
}

function assertPreconditionsEnvelope(value: unknown, path: string): void {
  const preconditions = strictRecord(value, path, [
    'repositoryId',
    'defaultBranch',
    'pullNumber',
    'headSha',
    'manifestBlobSha',
    'configDigest',
    'pullRequestDigest',
  ]);
  numberField(preconditions, 'repositoryId', path);
  stringField(preconditions, 'defaultBranch', path);
  numberField(preconditions, 'pullNumber', path);
  stringField(preconditions, 'headSha', path);
  stringField(preconditions, 'manifestBlobSha', path);
  stringField(preconditions, 'configDigest', path);
  stringField(preconditions, 'pullRequestDigest', path);
}

function assertCheckInputEnvelope(value: unknown, path: string, mode: 'create' | 'update'): void {
  const required = mode === 'create' ? ['name', 'status', 'headSha'] : ['name', 'status'];
  const input = strictRecord(value, path, required, [
    'externalId',
    'conclusion',
    'detailsUrl',
    'title',
    'summary',
  ]);
  for (const key of Object.keys(input)) stringField(input, key, path);
  if (!['queued', 'in_progress', 'completed'].includes(String(input.status))) {
    throw new TypeError(`${path}/status is unsupported`);
  }
  if (input.conclusion !== undefined && ![
    'success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required',
  ].includes(String(input.conclusion))) {
    throw new TypeError(`${path}/conclusion is unsupported`);
  }
  if (input.status === 'completed' && input.conclusion === undefined) {
    throw new TypeError(`${path}/conclusion is required for a completed Check Run`);
  }
  if (input.status !== 'completed' && input.conclusion !== undefined) {
    throw new TypeError(`${path}/conclusion is not allowed before a Check Run completes`);
  }
}

function assertMutationEnvelope(value: unknown, index: number): void {
  const path = `$/mutations/${index}`;
  const base = strictRecord(value, path, ['type', 'key', 'principal', 'desiredDigest', 'preconditions'], [
    'label',
    'labels',
    'observedBodyDigest',
    'mode',
    'checkRunId',
    'input',
    'commentId',
    'expectedOwnerId',
    'expectedOwnerLogin',
    'observedLabelsDigest',
    'observedCheckExternalId',
  ]);
  const type = stringField(base, 'type', path);
  stringField(base, 'key', path);
  stringField(base, 'principal', path);
  stringField(base, 'desiredDigest', path);
  assertPreconditionsEnvelope(base.preconditions, `${path}/preconditions`);
  if (type === 'repository-label.ensure') {
    strictRecord(value, path, [
      'type', 'key', 'principal', 'desiredDigest', 'preconditions', 'label',
    ]);
    const label = strictRecord(base.label, `${path}/label`, ['name', 'color', 'description']);
    for (const key of ['name', 'color', 'description']) stringField(label, key, `${path}/label`);
    return;
  }
  if (type === 'issue-labels.add') {
    strictRecord(value, path, [
      'type', 'key', 'principal', 'desiredDigest', 'preconditions', 'labels', 'observedLabelsDigest',
    ]);
    stringArray(base.labels, `${path}/labels`);
    stringField(base, 'observedLabelsDigest', path);
    return;
  }
  if (type === 'issue-label.remove') {
    strictRecord(value, path, [
      'type', 'key', 'principal', 'desiredDigest', 'preconditions', 'label', 'observedLabelsDigest',
    ]);
    stringField(base, 'label', path);
    stringField(base, 'observedLabelsDigest', path);
    return;
  }
  if (type === 'check-run.upsert') {
    const mode = stringField(base, 'mode', path);
    if (mode === 'create') {
      strictRecord(value, path, [
        'type', 'key', 'principal', 'desiredDigest', 'preconditions', 'mode', 'input', 'observedLabelsDigest',
        'observedCheckExternalId',
      ]);
      assertCheckInputEnvelope(base.input, `${path}/input`, mode);
      stringField(base, 'observedLabelsDigest', path);
      stringField(base, 'observedCheckExternalId', path);
      return;
    }
    if (mode === 'update') {
      strictRecord(value, path, [
        'type', 'key', 'principal', 'desiredDigest', 'preconditions', 'mode', 'checkRunId', 'input', 'observedLabelsDigest',
        'observedCheckExternalId',
      ]);
      numberField(base, 'checkRunId', path);
      assertCheckInputEnvelope(base.input, `${path}/input`, mode);
      stringField(base, 'observedLabelsDigest', path);
      stringField(base, 'observedCheckExternalId', path);
      return;
    }
    throw new TypeError(`${path}/mode is unsupported`);
  }
  if (type === 'issue-comment.delete') {
    strictRecord(value, path, [
      'type',
      'key',
      'principal',
      'desiredDigest',
      'preconditions',
      'commentId',
      'expectedOwnerId',
      'expectedOwnerLogin',
      'observedBodyDigest',
    ]);
    numberField(base, 'commentId', path);
    numberField(base, 'expectedOwnerId', path);
    stringField(base, 'expectedOwnerLogin', path);
    stringField(base, 'observedBodyDigest', path);
    return;
  }
  throw new TypeError(`${path}/type is unsupported`);
}

function assertPlanEnvelope(value: unknown): asserts value is ControlPlan {
  const plan = strictRecord(value, '$', [
    'contractVersion',
    'planId',
    'snapshotDigest',
    'pullRequestDigest',
    'objective',
    'subject',
    'outcome',
    'mutations',
  ]);
  numberField(plan, 'contractVersion', '$');
  stringField(plan, 'planId', '$');
  stringField(plan, 'snapshotDigest', '$');
  stringField(plan, 'pullRequestDigest', '$');
  const objective = stringField(plan, 'objective', '$');
  if (!['classification', 'dco-advisory'].includes(objective)) throw new TypeError('$/objective is unsupported');
  assertSubjectEnvelope(plan.subject);
  const outcome = strictRecord(plan.outcome, '$/outcome', ['state', 'summary']);
  const state = stringField(outcome, 'state', '$/outcome');
  if (!['passed', 'pending', 'failed', 'action_required', 'ignored'].includes(state)) {
    throw new TypeError('$/outcome/state is unsupported');
  }
  stringField(outcome, 'summary', '$/outcome');
  if (!Array.isArray(plan.mutations)) throw new TypeError('$/mutations must be an array');
  plan.mutations.forEach(assertMutationEnvelope);
}

export function assertControlSubject(subject: ControlPlanSubject): void {
  if (!Number.isSafeInteger(subject.repository.id) || subject.repository.id <= 0) {
    throw new Error('Control subject requires a positive repository ID');
  }
  if (!subject.repository.owner.trim() || !subject.repository.name.trim()
    || subject.repository.owner !== subject.repository.owner.trim()
    || subject.repository.name !== subject.repository.name.trim()) {
    throw new Error('Control subject requires a repository owner and name');
  }
  if (!subject.repository.defaultBranch.trim()
    || subject.repository.defaultBranch !== subject.repository.defaultBranch.trim()) {
    throw new Error('Control subject requires a default branch without surrounding whitespace');
  }
  if (!Number.isSafeInteger(subject.pullRequest.number) || subject.pullRequest.number <= 0) {
    throw new Error('Control subject requires a positive pull request number');
  }
  if (!/^[a-f0-9]{40}$/i.test(subject.pullRequest.headSha)) {
    throw new Error('Control subject requires a valid pull request head SHA');
  }
  if (!subject.manifest.blobSha.trim() || subject.manifest.blobSha !== subject.manifest.blobSha.trim()) {
    throw new Error('Control subject requires a Manifest source revision without surrounding whitespace');
  }
  if (!/^[a-f0-9]{64}$/i.test(subject.manifest.configDigest)) {
    throw new Error('Control subject requires a valid Manifest config digest');
  }
  if (!subject.platform.appSlug.trim() || subject.platform.appSlug !== subject.platform.appSlug.trim()) {
    throw new Error('Control subject requires a GitHub App slug without surrounding whitespace');
  }
  if (!Number.isSafeInteger(subject.platform.appId) || subject.platform.appId <= 0) {
    throw new Error('Control subject requires a positive GitHub App ID');
  }
  if (!subject.platform.clientId.trim() || subject.platform.clientId !== subject.platform.clientId.trim()) {
    throw new Error('Control subject requires a GitHub App client ID without surrounding whitespace');
  }
}

function mutationPreconditions(
  subject: ControlPlanSubject,
  pullRequestDigest: string,
): ControlMutationPreconditions {
  return {
    repositoryId: subject.repository.id,
    defaultBranch: subject.repository.defaultBranch,
    pullNumber: subject.pullRequest.number,
    headSha: subject.pullRequest.headSha.toLowerCase(),
    manifestBlobSha: subject.manifest.blobSha,
    configDigest: subject.manifest.configDigest.toLowerCase(),
    pullRequestDigest: pullRequestDigest.toLowerCase(),
  };
}

function normalizedSubject(subject: ControlPlanSubject): ControlPlanSubject {
  return {
    repository: {
      id: subject.repository.id,
      owner: subject.repository.owner,
      name: subject.repository.name,
      defaultBranch: subject.repository.defaultBranch,
    },
    pullRequest: {
      number: subject.pullRequest.number,
      headSha: subject.pullRequest.headSha.toLowerCase(),
    },
    manifest: {
      blobSha: subject.manifest.blobSha,
      configDigest: subject.manifest.configDigest.toLowerCase(),
    },
    platform: {
      appId: subject.platform.appId,
      clientId: subject.platform.clientId,
      appSlug: subject.platform.appSlug.toLowerCase(),
    },
  };
}

function mutationIntent(mutation: ControlMutation): ControlMutationIntent {
  const { desiredDigest: _desiredDigest, preconditions: _preconditions, ...intent } = mutation;
  return intent;
}

function planIdentity(plan: Omit<ControlPlan, 'planId'>): Promise<string> {
  return controlJsonDigest(plan);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function assertObjectiveMutations(plan: ControlPlan): void {
  for (const mutation of plan.mutations) {
    const allowed = plan.objective === 'classification'
      ? ['repository-label.ensure', 'issue-labels.add', 'issue-label.remove', 'check-run.upsert'].includes(mutation.type)
      : mutation.type === 'issue-comment.delete';
    if (!allowed) {
      throw new Error(`Control objective ${plan.objective} does not allow mutation ${mutation.type}`);
    }
  }
}

function assertClassificationCheckProtocol(plan: ControlPlan): void {
  if (plan.objective !== 'classification') return;
  if (plan.mutations.length === 0) {
    if (plan.outcome.state !== 'ignored') {
      throw new Error('Classification Control plan without a lease must be ignored');
    }
    return;
  }
  const checks = plan.mutations.filter((mutation): mutation is Extract<ControlMutation, {
    type: 'check-run.upsert';
  }> => mutation.type === 'check-run.upsert');
  const start = plan.mutations[0];
  const complete = plan.mutations.at(-1);
  const boundIdentity = (externalId: string | undefined, checkId: string, configDigest: string): boolean => {
    const identity = parseStewardCheckExternalId(externalId);
    return identity?.repositoryId === plan.subject.repository.id
      && identity.prNumber === plan.subject.pullRequest.number
      && identity.headSha === plan.subject.pullRequest.headSha
      && identity.checkId === checkId
      && identity.configDigest === configDigest;
  };
  if (plan.outcome.state === 'ignored') {
    if (plan.mutations.length !== 1
      || checks.length !== 1
      || complete?.type !== 'check-run.upsert'
      || complete.key !== 'check-run:pr-classification:complete'
      || complete.mode !== 'update'
      || complete.input.name !== 'PR Classification Gate'
      || complete.input.status !== 'completed'
      || complete.input.conclusion !== 'success'
      || !boundIdentity(complete.observedCheckExternalId, 'pr-class-lease', '0'.repeat(64))
      || !boundIdentity(complete.input.externalId, 'pr-class-off', plan.subject.manifest.configDigest)) {
      throw new Error('Disabled Classification Control plan violates the lease completion protocol');
    }
    return;
  }
  if (checks.length !== 2
    || start?.type !== 'check-run.upsert'
    || complete?.type !== 'check-run.upsert'
    || start.key !== 'check-run:pr-classification:start'
    || complete.key !== 'check-run:pr-classification:complete'
    || start.mode !== 'update'
    || complete.mode !== 'update'
    || start.checkRunId !== complete.checkRunId
    || start.input.status !== 'in_progress'
    || start.input.conclusion !== undefined
    || complete.input.status !== 'completed'
    || complete.input.conclusion !== 'success'
    || start.input.name !== 'PR Classification Gate'
    || start.input.name !== complete.input.name
    || !start.input.externalId
    || !complete.input.externalId
    || !boundIdentity(start.input.externalId, 'pr-class-lease', '0'.repeat(64))
    || !boundIdentity(complete.input.externalId, 'pr-classification', plan.subject.manifest.configDigest)
    || start.input.externalId !== start.observedCheckExternalId
    || complete.observedCheckExternalId !== start.input.externalId
    || complete.input.externalId === start.input.externalId
    || plan.outcome.state !== 'passed') {
    throw new Error('Classification Control plan violates the start/complete Check protocol');
  }
}

function assertMutationStructure(plan: ControlPlan, mutation: ControlMutation): void {
  if (!mutation.key.trim()) throw new Error('Control mutation requires a stable key');
  if (mutation.principal !== 'installation') {
    throw new Error(`Control mutation ${mutation.key} has an unsupported principal`);
  }
  if (mutation.type === 'repository-label.ensure') {
    if (!mutation.label.name.trim() || !/^[a-f0-9]{6}$/i.test(mutation.label.color.replace(/^#/, ''))) {
      throw new Error(`Control mutation ${mutation.key} contains an invalid repository label`);
    }
    return;
  }
  if (mutation.type === 'issue-labels.add') {
    if (!mutation.labels.length || mutation.labels.some((label) => !label.trim())
      || !validDigest(mutation.observedLabelsDigest)) {
      throw new Error(`Control mutation ${mutation.key} requires non-empty issue labels`);
    }
    return;
  }
  if (mutation.type === 'issue-label.remove') {
    if (!mutation.label.trim() || !validDigest(mutation.observedLabelsDigest)) {
      throw new Error(`Control mutation ${mutation.key} requires an issue label and observed label digest`);
    }
    return;
  }
  if (mutation.type === 'check-run.upsert') {
    if (!mutation.input.name.trim() || !mutation.input.status
      || !validDigest(mutation.observedLabelsDigest)
      || !mutation.observedCheckExternalId.trim()
      || mutation.observedCheckExternalId !== mutation.observedCheckExternalId.trim()) {
      throw new Error(`Control mutation ${mutation.key} contains an invalid Check Run input`);
    }
    if ((mutation.input.status === 'completed') !== (mutation.input.conclusion !== undefined)) {
      throw new Error(`Control mutation ${mutation.key} contains an invalid Check Run status and conclusion combination`);
    }
    if (mutation.mode === 'update') {
      if (!Number.isSafeInteger(mutation.checkRunId) || Number(mutation.checkRunId) <= 0) {
        throw new Error(`Control mutation ${mutation.key} requires a Check Run ID`);
      }
      if ('headSha' in mutation.input) {
        throw new Error(`Control mutation ${mutation.key} update must not contain a head SHA`);
      }
      return;
    }
    if (!('headSha' in mutation.input) || mutation.input.headSha !== plan.subject.pullRequest.headSha) {
      throw new Error(`Control mutation ${mutation.key} requires the bound pull request head SHA`);
    }
    return;
  }
  if (mutation.type === 'issue-comment.delete') {
    const expectedAppBotLogin = `${plan.subject.platform.appSlug.toLowerCase()}[bot]`;
    if (!Number.isSafeInteger(mutation.commentId) || mutation.commentId <= 0
      || !Number.isSafeInteger(mutation.expectedOwnerId) || mutation.expectedOwnerId <= 0
      || mutation.expectedOwnerLogin !== expectedAppBotLogin
      || !validDigest(mutation.observedBodyDigest)) {
      throw new Error(`Control mutation ${mutation.key} contains an invalid issue comment precondition`);
    }
    return;
  }
  throw new Error(`Control mutation ${String((mutation as { type?: unknown }).type)} is unsupported`);
}

export async function finalizeControlPlan(input: {
  objective: ControlObjective;
  subject: ControlPlanSubject;
  pullRequest: GitHubPullRequest;
  snapshot: unknown;
  outcome: ControlPlanOutcome;
  mutations: readonly ControlMutationIntent[];
}): Promise<ControlPlan> {
  assertControlSubject(input.subject);
  if (input.pullRequest.number !== input.subject.pullRequest.number
    || input.pullRequest.head.sha.toLowerCase() !== input.subject.pullRequest.headSha.toLowerCase()
    || input.pullRequest.base.ref !== input.subject.repository.defaultBranch
    || input.pullRequest.state !== 'open') {
    throw new Error('Control plan pull request does not match its subject');
  }
  const subject = normalizedSubject(input.subject);
  const pullRequestDigest = await controlJsonDigest(controlPullRequestInput(input.pullRequest));
  const preconditions = mutationPreconditions(subject, pullRequestDigest);
  const keys = new Set<string>();
  const mutations: ControlMutation[] = [];
  for (const intent of input.mutations) {
    if (!intent.key.trim()) throw new Error('Control mutation requires a stable key');
    if (keys.has(intent.key)) throw new Error(`Control plan contains duplicate mutation key ${intent.key}`);
    keys.add(intent.key);
    const desiredDigest = await controlJsonDigest(intent);
    mutations.push({ ...intent, desiredDigest, preconditions: { ...preconditions } });
  }
  const withoutId = {
    contractVersion: controlPlanContractVersion,
    snapshotDigest: await controlJsonDigest(input.snapshot),
    pullRequestDigest,
    objective: input.objective,
    subject,
    outcome: input.outcome,
    mutations,
  };
  const plan = JSON.parse(canonicalControlJson({
    ...withoutId,
    planId: await planIdentity(withoutId),
  })) as ControlPlan;
  await verifyControlPlan(plan);
  return plan;
}

export async function verifyControlPlan(plan: ControlPlan): Promise<void> {
  assertPlanEnvelope(plan);
  if (plan.contractVersion !== controlPlanContractVersion) {
    throw new Error(`Unsupported Control plan contract version ${String(plan.contractVersion)}`);
  }
  assertControlSubject(plan.subject);
  assertObjectiveMutations(plan);
  assertClassificationCheckProtocol(plan);
  if (!/^[a-f0-9]{64}$/i.test(plan.snapshotDigest)
    || !/^[a-f0-9]{64}$/i.test(plan.pullRequestDigest)
    || !/^[a-f0-9]{64}$/i.test(plan.planId)) {
    throw new Error('Control plan contains an invalid digest');
  }
  const expectedPreconditions = mutationPreconditions(normalizedSubject(plan.subject), plan.pullRequestDigest);
  const keys = new Set<string>();
  for (const mutation of plan.mutations) {
    assertMutationStructure(plan, mutation);
    if (keys.has(mutation.key)) throw new Error(`Control plan contains duplicate mutation key ${mutation.key}`);
    keys.add(mutation.key);
    if (canonicalControlJson(mutation.preconditions) !== canonicalControlJson(expectedPreconditions)) {
      throw new Error(`Control mutation ${mutation.key} does not match plan preconditions`);
    }
    if (!validDigest(mutation.desiredDigest)) {
      throw new Error(`Control mutation ${mutation.key} contains an invalid desired digest`);
    }
    const expectedDigest = await controlJsonDigest(mutationIntent(mutation));
    if (expectedDigest !== mutation.desiredDigest) {
      throw new Error(`Control mutation ${mutation.key} desired digest does not match its intent`);
    }
  }
  const { planId: _planId, ...withoutId } = plan;
  if (await planIdentity(withoutId) !== plan.planId) throw new Error('Control plan identity does not match its content');
}

export function assertControlPlanSubject(plan: ControlPlan, subject: ControlPlanSubject): void {
  assertControlSubject(subject);
  if (canonicalControlJson(plan.subject) !== canonicalControlJson(normalizedSubject(subject))) {
    throw new Error('Control plan subject does not match the current runtime subject');
  }
}
