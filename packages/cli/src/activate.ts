import { createHash } from 'node:crypto';
import { parseStewardCheckExternalId } from '../../core/src/index.js';
import type { GitHubCheckRun, GitHubRequest, GitHubTransport } from '../../github/src/index.js';
import {
  manifestDigest,
  normalizeManifest,
  parseManifest,
  type StewardManifest,
} from '../../manifest/src/index.js';
import { inspectAppInstallation } from './app-installation.js';

const matrixGateName = 'PR Validation Matrix Gate';
const matrixWorkflow = 'pr-validation-matrix.yml';
const matrixWorkflowPath = `.github/workflows/${matrixWorkflow}`;
const dedicatedRulesetName = 'SPLRAD Steward';
const legacyStewardChecks = new Set(['Main Authorization Gate', 'Copilot Code Review Gate']);
const shaPattern = /^[a-f0-9]{40}$/i;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface RepositoryPayload {
  id?: number;
  full_name?: string;
  default_branch?: string | null;
  archived?: boolean;
  disabled?: boolean;
  permissions?: { admin?: boolean } | null;
  owner?: { login?: string; type?: string } | null;
}

interface RefPayload {
  object?: { type?: string; sha?: string } | null;
}

interface PullPayload {
  number?: number;
  state?: string;
  base?: { ref?: string } | null;
  head?: { sha?: string } | null;
}

interface RulesetPayload {
  id?: number;
  name?: string;
  target?: string;
  source_type?: string;
  source?: string;
  enforcement?: string;
  bypass_actors?: JsonObject[];
  conditions?: JsonObject;
  rules?: JsonObject[];
}

interface RulesetWriteBody extends JsonObject {
  name: string;
  target: 'branch';
  enforcement: 'active';
  bypass_actors: JsonObject[];
  conditions: JsonObject;
  rules: JsonObject[];
}

export interface ActivateDispatchPlan {
  repository: string;
  defaultBranch: string;
  baseSha: string;
  pullRequest: number;
  headSha: string;
}

export interface ActivateRulesetPlan {
  repository: string;
  repositoryId: number;
  defaultBranch: string;
  baseSha: string;
  configDigest: string;
  pullRequest: number;
  headSha: string;
  appId: number;
  appSlug: string;
  action: 'create' | 'update' | 'none';
  rulesetId?: number;
  rulesetName: string;
  removedChecks: string[];
  preservedChecks: string[];
  requestBody: RulesetWriteBody;
  fingerprint: string;
}

export type ActivatePreparation =
  | { status: 'dispatch-required'; plan: ActivateDispatchPlan }
  | { status: 'ready'; plan: ActivateRulesetPlan }
  | { status: 'active'; plan: ActivateRulesetPlan };

export interface ActivateReport {
  repository: string;
  action: 'created' | 'updated';
  rulesetId: number;
  rulesetName: string;
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function decodeFile(payload: { type?: string; encoding?: string; content?: string }): string {
  if (payload.type !== 'file' || payload.encoding !== 'base64' || !payload.content) {
    throw new Error('GitHub returned an invalid Steward manifest file response');
  }
  return Buffer.from(payload.content.replaceAll(/\s/g, ''), 'base64').toString('utf8');
}

function parseManifestFile(content: string): StewardManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Steward manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeManifest(parseManifest(raw));
}

async function pagedItems<TPayload, TItem>(
  transport: GitHubTransport,
  request: GitHubRequest,
  items: (payload: TPayload) => readonly TItem[],
): Promise<TItem[]> {
  const collected: TItem[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await transport.request<TPayload>({
      ...request,
      query: { ...request.query, page, per_page: 100 },
    });
    const batch = [...items(payload)];
    collected.push(...batch);
    if (batch.length < 100) return collected;
  }
  throw new Error('GitHub activate inventory exceeded the 20-page safety limit');
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function planFingerprint(plan: Omit<ActivateRulesetPlan, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(plan as unknown as JsonValue)), 'utf8').digest('hex');
}

function stringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`GitHub ruleset ${label} is invalid`);
  }
  return value as string[];
}

function patternMatches(pattern: string, ref: string, defaultBranch: string): boolean | null {
  if (pattern === '~ALL' || pattern === '~DEFAULT_BRANCH') return pattern === '~ALL' || ref === `refs/heads/${defaultBranch}`;
  if (!/[?*\[]/.test(pattern)) return pattern === ref;
  if (pattern.includes('[')) return null;
  const escaped = pattern.replace(/[.+^${}()|\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`).test(ref);
}

function targetsDefaultBranch(ruleset: RulesetPayload, defaultBranch: string): boolean | null {
  const conditions = ruleset.conditions?.ref_name;
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) {
    throw new Error(`GitHub ruleset ${String(ruleset.id ?? '')} has invalid ref_name conditions`);
  }
  const include = stringArray(conditions.include, 'ref_name.include');
  const exclude = stringArray(conditions.exclude, 'ref_name.exclude');
  const ref = `refs/heads/${defaultBranch}`;
  const excluded = exclude.map((pattern) => patternMatches(pattern, ref, defaultBranch));
  if (excluded.includes(true)) return false;
  const included = include.map((pattern) => patternMatches(pattern, ref, defaultBranch));
  if (included.includes(true)) return excluded.includes(null) ? null : true;
  return included.includes(null) || excluded.includes(null) ? null : false;
}

function checkList(rule: JsonObject): JsonObject[] | null {
  if (rule.type !== 'required_status_checks') return null;
  const parameters = rule.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('GitHub ruleset required_status_checks parameters are invalid');
  }
  const checks = parameters.required_status_checks;
  if (!Array.isArray(checks) || checks.some((check) => !check || typeof check !== 'object' || Array.isArray(check))) {
    throw new Error('GitHub ruleset required_status_checks list is invalid');
  }
  return checks as JsonObject[];
}

function checkContext(check: JsonObject): string {
  return typeof check.context === 'string' ? check.context : '';
}

function hasStewardMarker(ruleset: RulesetPayload): boolean {
  return ruleset.name === dedicatedRulesetName || (ruleset.rules ?? []).some((rule) => (
    checkList(rule)?.some((check) => legacyStewardChecks.has(checkContext(check)) || checkContext(check) === matrixGateName)
  ));
}

function validateRuleset(ruleset: RulesetPayload): void {
  if (!Number.isSafeInteger(ruleset.id) || Number(ruleset.id) < 1 || !ruleset.name
    || ruleset.target !== 'branch' || !ruleset.source_type || !ruleset.source
    || !['active', 'disabled', 'evaluate'].includes(String(ruleset.enforcement ?? ''))
    || !Array.isArray(ruleset.bypass_actors) || !ruleset.conditions || !Array.isArray(ruleset.rules)) {
    throw new Error('GitHub returned an invalid repository ruleset');
  }
}

function writableBypassActors(actors: JsonObject[]): JsonObject[] {
  return actors.map((actor) => {
    const actorType = typeof actor.actor_type === 'string' ? actor.actor_type : '';
    const bypassMode = typeof actor.bypass_mode === 'string' ? actor.bypass_mode : '';
    const actorId = actor.actor_id;
    if (!['Integration', 'OrganizationAdmin', 'RepositoryRole', 'Team', 'DeployKey', 'User'].includes(actorType)
      || !['always', 'pull_request', 'exempt'].includes(bypassMode)
      || (actorType !== 'OrganizationAdmin' && actorType !== 'DeployKey'
        && (!Number.isSafeInteger(actorId) || Number(actorId) < 1))
      || (actorType === 'DeployKey' && actorId !== null)) {
      throw new Error('GitHub ruleset contains an invalid bypass actor');
    }
    return { actor_id: actorType === 'OrganizationAdmin' ? null : actorId!, actor_type: actorType, bypass_mode: bypassMode };
  });
}

function writableConditions(conditions: JsonObject): JsonObject {
  if (Object.keys(conditions).some((key) => key !== 'ref_name')) {
    throw new Error('GitHub repository ruleset contains unsupported condition fields');
  }
  const refName = conditions.ref_name;
  if (!refName || typeof refName !== 'object' || Array.isArray(refName)) {
    throw new Error('GitHub ruleset ref_name conditions are invalid');
  }
  return {
    ref_name: {
      include: stringArray(refName.include, 'ref_name.include'),
      exclude: stringArray(refName.exclude, 'ref_name.exclude'),
    },
  };
}

function createBody(appId: number): RulesetWriteBody {
  return {
    name: dedicatedRulesetName,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: matrixGateName, integration_id: appId }],
      },
    }],
  };
}

function updateBody(ruleset: RulesetPayload, appId: number): {
  body: RulesetWriteBody;
  removedChecks: string[];
  preservedChecks: string[];
} {
  validateRuleset(ruleset);
  const rules = structuredClone(ruleset.rules!);
  const required = rules.filter((rule) => rule.type === 'required_status_checks');
  if (required.length > 1) throw new Error(`Ruleset ${ruleset.id} contains multiple required_status_checks rules`);
  const removedChecks: string[] = [];
  const preservedChecks: string[] = [];
  const matrix = { context: matrixGateName, integration_id: appId } satisfies JsonObject;
  if (required.length) {
    const rule = required[0]!;
    const checks = checkList(rule)!;
    const preserved = checks.filter((check) => {
      const context = checkContext(check);
      if (legacyStewardChecks.has(context)) {
        if (!removedChecks.includes(context)) removedChecks.push(context);
        return false;
      }
      if (context === matrixGateName) return false;
      if (context) preservedChecks.push(context);
      return true;
    });
    (rule.parameters as JsonObject).required_status_checks = [...preserved, matrix];
  } else {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [matrix],
      },
    });
  }
  return {
    body: {
      name: ruleset.name!,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: writableBypassActors(ruleset.bypass_actors!),
      conditions: writableConditions(ruleset.conditions!),
      rules,
    },
    removedChecks,
    preservedChecks,
  };
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export async function prepareActivate(
  transport: GitHubTransport,
  options: { owner: string; repository: string; pullRequest: number },
): Promise<ActivatePreparation> {
  const path = repositoryPath(options.owner, options.repository);
  const repository = await transport.request<RepositoryPayload>({ path });
  const repositoryId = Number(repository.id ?? 0);
  const fullName = String(repository.full_name ?? '');
  const defaultBranch = String(repository.default_branch ?? '');
  const ownerLogin = String(repository.owner?.login ?? '');
  const ownerType = String(repository.owner?.type ?? '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !fullName || !defaultBranch || !ownerLogin || !ownerType
    || fullName.toLowerCase() !== `${options.owner}/${options.repository}`.toLowerCase()) {
    throw new Error('GitHub returned invalid repository metadata');
  }
  if (repository.archived || repository.disabled) throw new Error('activate requires an active repository');
  if (repository.permissions?.admin !== true) throw new Error('activate requires repository administrator permission');

  const baseRef = await transport.request<RefPayload>({ path: `${path}/git/ref/heads/${segment(defaultBranch)}` });
  const baseSha = String(baseRef.object?.sha ?? '').toLowerCase();
  if (baseRef.object?.type !== 'commit' || !shaPattern.test(baseSha)) {
    throw new Error('GitHub returned an invalid default-branch reference');
  }
  const manifestFile = await transport.request<{ type?: string; encoding?: string; content?: string }>({
    path: `${path}/contents/.github/steward.json`, query: { ref: baseSha },
  });
  const manifest = parseManifestFile(decodeFile(manifestFile));
  const configDigest = manifestDigest(manifest);
  const matrixEnabled = manifest.features.classification || manifest.features.dcoAdvisory
    || manifest.features.governance || manifest.features.copilotReview;
  if (!matrixEnabled) throw new Error('activate requires at least one PR Matrix feature in the Steward manifest');
  const callerFile = await transport.request<{ type?: string; encoding?: string; content?: string }>({
    path: `${path}/contents/.github/workflows/${matrixWorkflow}`, query: { ref: baseSha },
  });
  const caller = decodeFile(callerFile);
  const callerUses = [...caller.matchAll(
    /^\s*uses:\s*['"]?splrad\/steward\/\.github\/workflows\/pr-validation-matrix\.yml@([a-f0-9]{40})['"]?(?:\s+#.*)?$/gim,
  )];
  if (!/^\s+workflow_dispatch\s*:/m.test(caller) || callerUses.length !== 1) {
    throw new Error(`activate requires a valid ${matrixWorkflowPath} on the default branch`);
  }
  const pull = await transport.request<PullPayload>({ path: `${path}/pulls/${segment(options.pullRequest)}` });
  const headSha = String(pull.head?.sha ?? '').toLowerCase();
  if (pull.number !== options.pullRequest || pull.state !== 'open' || pull.base?.ref !== defaultBranch || !shaPattern.test(headSha)) {
    throw new Error(`activate requires an open PR targeting the current default branch (${defaultBranch})`);
  }

  const installation = await inspectAppInstallation(transport, {
    owner: options.owner,
    repository: options.repository,
    repositoryId,
    ownerLogin,
    ownerType,
    manifest,
  });
  if (installation.status !== 'installed' || !installation.appId) {
    throw new Error(`activate requires a verifiable GitHub App installation: ${installation.summary}`);
  }
  const appId = installation.appId;
  const checks = await pagedItems<{ check_runs?: GitHubCheckRun[] }, GitHubCheckRun>(transport, {
    path: `${path}/commits/${segment(headSha)}/check-runs`, query: { filter: 'all' },
  }, (payload) => payload.check_runs ?? []);
  const trustedCheck = checks.find((check) => {
    if (check.name !== matrixGateName || Number(check.app?.id ?? 0) !== appId
      || String(check.app?.slug ?? '').toLowerCase() !== manifest.automation.githubApp.slug.toLowerCase()) return false;
    const identity = parseStewardCheckExternalId(check.external_id);
    return Boolean(identity
      && identity.repositoryId === repositoryId
      && identity.prNumber === options.pullRequest
      && identity.headSha === headSha
      && identity.checkId === 'validation-matrix'
      && identity.configDigest === configDigest);
  });
  if (!trustedCheck) {
    return {
      status: 'dispatch-required',
      plan: { repository: fullName, defaultBranch, baseSha, pullRequest: options.pullRequest, headSha },
    };
  }

  const summaries = await pagedItems<RulesetPayload[], RulesetPayload>(transport, {
    path: `${path}/rulesets`, query: { includes_parents: true },
  }, (payload) => payload);
  const details = await Promise.all(summaries.filter((summary) => summary.target === 'branch' && summary.id)
    .map(async (summary) => {
      const detail = await transport.request<RulesetPayload>({ path: `${path}/rulesets/${segment(summary.id!)}` });
      const sourceType = detail.source_type ?? summary.source_type;
      const source = detail.source ?? summary.source;
      return {
        ...detail,
        ...(sourceType ? { source_type: sourceType } : {}),
        ...(source ? { source } : {}),
      };
    }));
  for (const ruleset of details) validateRuleset(ruleset);
  const marked = details.filter(hasStewardMarker);
  const applicable: RulesetPayload[] = [];
  for (const ruleset of marked) {
    const targets = targetsDefaultBranch(ruleset, defaultBranch);
    if (targets === null) throw new Error(`Cannot safely determine whether ruleset ${ruleset.id} targets the default branch`);
    if (!targets && ruleset.name === dedicatedRulesetName) {
      throw new Error(`Dedicated ruleset ${ruleset.id} does not target the default branch`);
    }
    if (targets) applicable.push(ruleset);
  }
  const inherited = applicable.filter((ruleset) => ruleset.source_type !== 'Repository'
    || ruleset.source?.toLowerCase() !== fullName.toLowerCase());
  if (inherited.length) {
    throw new Error(`Cannot replace Steward checks in inherited ruleset ${inherited[0]!.id}; update the source ruleset manually`);
  }
  if (applicable.length > 1) throw new Error('Cannot safely activate Steward because multiple default-branch rulesets contain Steward checks');

  const selected = applicable[0];
  const merged = selected ? updateBody(selected, appId) : {
    body: createBody(appId), removedChecks: [], preservedChecks: [],
  };
  const action = selected
    ? sameJson(merged.body, {
      name: selected.name!, target: 'branch', enforcement: selected.enforcement as JsonValue,
      bypass_actors: writableBypassActors(selected.bypass_actors!),
      conditions: writableConditions(selected.conditions!),
      rules: selected.rules!,
    }) ? 'none' : 'update'
    : 'create';
  const withoutFingerprint: Omit<ActivateRulesetPlan, 'fingerprint'> = {
    repository: fullName,
    repositoryId,
    defaultBranch,
    baseSha,
    configDigest,
    pullRequest: options.pullRequest,
    headSha,
    appId,
    appSlug: manifest.automation.githubApp.slug,
    action,
    ...(selected?.id ? { rulesetId: selected.id } : {}),
    rulesetName: selected?.name ?? dedicatedRulesetName,
    removedChecks: merged.removedChecks,
    preservedChecks: merged.preservedChecks,
    requestBody: merged.body,
  };
  const plan = { ...withoutFingerprint, fingerprint: planFingerprint(withoutFingerprint) };
  return { status: action === 'none' ? 'active' : 'ready', plan };
}

export async function dispatchActivate(transport: GitHubTransport, plan: ActivateDispatchPlan): Promise<void> {
  const [owner, repository] = plan.repository.split('/') as [string, string];
  await transport.request({
    method: 'POST',
    path: `${repositoryPath(owner, repository)}/actions/workflows/${matrixWorkflow}/dispatches`,
    body: {
      ref: plan.defaultBranch,
      inputs: { pr_number: String(plan.pullRequest), head_sha: plan.headSha, scope: 'full', mode: 'enforce' },
    },
  });
}

export async function executeActivate(
  transport: GitHubTransport,
  plan: ActivateRulesetPlan,
): Promise<ActivateReport> {
  if (plan.action === 'none') throw new Error('activate plan is already active');
  if (plan.action === 'update' && (!Number.isSafeInteger(plan.rulesetId) || Number(plan.rulesetId) < 1)) {
    throw new Error('activate update plan is missing a ruleset ID');
  }
  const [owner, repository] = plan.repository.split('/') as [string, string];
  const path = repositoryPath(owner, repository);
  const response = await transport.request<RulesetPayload>({
    method: plan.action === 'create' ? 'POST' : 'PUT',
    path: plan.action === 'create' ? `${path}/rulesets` : `${path}/rulesets/${segment(plan.rulesetId!)}`,
    body: plan.requestBody,
  });
  const rulesetId = Number(response.id ?? 0);
  if (!Number.isSafeInteger(rulesetId) || rulesetId < 1 || response.name !== plan.rulesetName) {
    throw new Error('GitHub returned an invalid activated ruleset response');
  }
  return {
    repository: plan.repository,
    action: plan.action === 'create' ? 'created' : 'updated',
    rulesetId,
    rulesetName: plan.rulesetName,
  };
}
