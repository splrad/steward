import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../../github/src/index.js';
import {
  normalizeManifest,
  parseManifest,
  SUPPORTED_SCHEMA_VERSION,
  type StewardManifest,
} from '../../manifest/src/index.js';
import { replaceStewardSha, workflowTemplates } from './init.js';

const upgradeBranch = 'steward/upgrade';
const sourceRepositoryPath = '/repos/splrad/steward';
const shaPattern = /^[a-f0-9]{40}$/i;
const schemaUrlPattern = /^https:\/\/raw\.githubusercontent\.com\/splrad\/steward\/([a-f0-9]{40})\/schema\/steward\.schema\.json$/i;

type JsonObject = Record<string, unknown>;

interface RepositoryPayload {
  id?: number;
  full_name?: string;
  default_branch?: string | null;
  archived?: boolean;
  disabled?: boolean;
  permissions?: { admin?: boolean } | null;
}

interface RefPayload {
  object?: { type?: string; sha?: string } | null;
}

interface GitCommitPayload {
  sha?: string;
  tree?: { sha?: string } | null;
}

interface RepositoryCommitPayload {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  files?: Array<{ filename?: string; status?: string }>;
}

interface PullRequestPayload {
  number?: number;
  html_url?: string;
  base?: { ref?: string } | null;
  head?: { ref?: string; sha?: string } | null;
}

export type UpgradeFileStatus = 'create' | 'update' | 'unchanged';
export type UpgradeResourceStatus = 'create' | 'reuse' | 'none';

export interface UpgradeFile {
  path: string;
  status: UpgradeFileStatus;
  digest: string;
  content: string;
  existingDigest?: string;
}

export interface UpgradePlan {
  repository: string;
  defaultBranch: string;
  baseSha: string;
  baseTreeSha: string;
  currentSchemaSha: string;
  currentPins: string[];
  targetSha: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  branchName: string;
  branchStatus: UpgradeResourceStatus;
  branchSha?: string;
  pullRequestStatus: UpgradeResourceStatus;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  files: UpgradeFile[];
  counts: Record<UpgradeFileStatus, number>;
  preservedAdapter?: { path: string; digest: string };
  fingerprint: string;
}

export type UpgradePreparation =
  | { status: 'current'; plan: UpgradePlan }
  | { status: 'ready'; plan: UpgradePlan };

export interface UpgradeReport {
  repository: string;
  targetSha: string;
  branchName: string;
  branchSha: string;
  branchStatus: UpgradeResourceStatus;
  pullRequestStatus: UpgradeResourceStatus;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function contentPath(filePath: string): string {
  return filePath.split('/').map(segment).join('/');
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeFile(payload: { type?: string; encoding?: string; content?: string }, label: string): string {
  if (payload.type !== 'file' || payload.encoding !== 'base64' || !payload.content) {
    throw new Error(`GitHub returned an invalid ${label} file response`);
  }
  return Buffer.from(payload.content.replaceAll(/\s/g, ''), 'base64').toString('utf8');
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function safeGitHubUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function safeRepositoryPath(value: string): boolean {
  const parts = value.split('/');
  return Boolean(value) && !value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') && !value.includes(':')
    && parts.every((part) => Boolean(part) && part !== '.' && part !== '..');
}

function repositoryPathArgument(value: string): string | undefined {
  if (value.startsWith('-') || value.includes('://')) return undefined;
  const explicitlyRelative = value.startsWith('./');
  const candidate = value.startsWith('./') ? value.slice(2) : value;
  const pathLike = explicitlyRelative || candidate.includes('/') || /\.(?:cjs|js|mjs|ps1|py|sh|ts)$/i.test(candidate);
  return pathLike && safeRepositoryPath(candidate) ? candidate : undefined;
}

async function optionalGet<T>(transport: GitHubTransport, request: GitHubRequest): Promise<T | null> {
  try {
    return await transport.request<T>(request);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

async function repositoryFile(
  transport: GitHubTransport,
  path: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  const payload = await optionalGet<{ type?: string; encoding?: string; content?: string }>(transport, {
    path: `${path}/contents/${contentPath(filePath)}`,
    query: { ref },
  });
  return payload ? decodeFile(payload, filePath) : null;
}

function workflowPin(content: string, called: string): string {
  const escaped = called.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...content.matchAll(new RegExp(
    `uses:\\s*['"]?splrad/steward/\\.github/workflows/${escaped}@([a-f0-9]{40})['"]?`,
    'gi',
  ))];
  if (matches.length !== 1) throw new Error(`Existing ${called} caller is not uniquely pinned to a complete Steward SHA`);
  return matches[0]![1]!.toLowerCase();
}

function targetSchema(content: string): { schema: JsonObject; version: number } {
  const schema = object(parseJson(content, 'target Steward schema'), 'target Steward schema');
  const properties = object(schema.properties, 'target Steward schema properties');
  const version = object(properties.schemaVersion, 'target Steward schemaVersion');
  if (typeof version.const !== 'number' || !Number.isSafeInteger(version.const) || version.const < 1) {
    throw new Error('Target Steward schema has an invalid schemaVersion const');
  }
  return { schema, version: version.const };
}

function migrateManifest(current: StewardManifest, targetSha: string, targetVersion: number): StewardManifest {
  const sourceVersion = Number(current.schemaVersion);
  if (sourceVersion !== SUPPORTED_SCHEMA_VERSION || targetVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`This Steward CLI cannot migrate schemaVersion ${sourceVersion} to ${targetVersion}`);
  }
  const migrated = structuredClone(current) as StewardManifest;
  migrated.$schema = `https://raw.githubusercontent.com/splrad/steward/${targetSha}/schema/steward.schema.json`;
  migrated.schemaVersion = targetVersion as typeof SUPPORTED_SCHEMA_VERSION;
  return normalizeManifest(parseManifest(migrated));
}

function validateTargetManifest(schema: JsonObject, manifest: StewardManifest): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    const issues = (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
    throw new Error(`Migrated manifest is invalid for the target Steward schema:\n- ${issues.join('\n- ')}`);
  }
}

function plannedFile(path: string, content: string, existing: string | null): UpgradeFile {
  const status: UpgradeFileStatus = existing === null ? 'create' : existing === content ? 'unchanged' : 'update';
  return {
    path,
    status,
    digest: digest(content),
    content,
    ...(status === 'update' && existing !== null ? { existingDigest: digest(existing) } : {}),
  };
}

function fingerprint(plan: Omit<UpgradePlan, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');
}

async function verifyReusableBranch(input: {
  transport: GitHubTransport;
  path: string;
  branchSha: string;
  baseSha: string;
  files: UpgradeFile[];
}): Promise<void> {
  const commit = await input.transport.request<RepositoryCommitPayload>({
    path: `${input.path}/commits/${segment(input.branchSha)}`,
  });
  const changed = input.files.filter((file) => file.status !== 'unchanged');
  const expected = new Map(changed.map((file) => [file.path, file.status === 'create' ? 'added' : 'modified']));
  const actual = commit.files ?? [];
  if (commit.sha !== input.branchSha || commit.parents?.length !== 1 || commit.parents[0]?.sha !== input.baseSha
    || actual.length !== expected.size
    || actual.some((file) => expected.get(String(file.filename ?? '')) !== file.status)) {
    throw new Error(`Existing branch ${upgradeBranch} is not the exact Steward upgrade commit for the current default-branch head`);
  }
  for (const file of changed) {
    const content = await repositoryFile(input.transport, input.path, file.path, input.branchSha);
    if (content !== file.content) throw new Error(`Existing branch ${upgradeBranch} does not contain the exact upgraded ${file.path}`);
  }
}

export async function prepareUpgrade(input: {
  transport: GitHubTransport;
  owner: string;
  repository: string;
  targetSha: string;
}): Promise<UpgradePreparation> {
  const targetSha = input.targetSha.toLowerCase();
  if (!shaPattern.test(targetSha)) throw new Error('upgrade target must be a complete 40-character commit SHA');
  const path = repositoryPath(input.owner, input.repository);
  const repository = await input.transport.request<RepositoryPayload>({ path });
  const fullName = String(repository.full_name ?? '');
  const defaultBranch = String(repository.default_branch ?? '');
  if (!fullName || !defaultBranch || fullName.toLowerCase() !== `${input.owner}/${input.repository}`.toLowerCase()) {
    throw new Error('GitHub returned invalid repository metadata');
  }
  if (repository.archived || repository.disabled) throw new Error('upgrade requires an active repository');
  if (repository.permissions?.admin !== true) throw new Error('upgrade requires repository administrator permission');

  const baseRef = await input.transport.request<RefPayload>({
    path: `${path}/git/ref/heads/${segment(defaultBranch)}`,
  });
  const baseSha = String(baseRef.object?.sha ?? '');
  if (baseRef.object?.type !== 'commit' || !shaPattern.test(baseSha)) {
    throw new Error('GitHub returned an invalid default-branch reference');
  }
  const baseCommit = await input.transport.request<GitCommitPayload>({
    path: `${path}/git/commits/${segment(baseSha)}`,
  });
  const baseTreeSha = String(baseCommit.tree?.sha ?? '');
  if (!shaPattern.test(baseTreeSha)) throw new Error('GitHub returned an invalid default-branch tree');

  const manifestContent = await repositoryFile(input.transport, path, '.github/steward.json', baseSha);
  if (manifestContent === null) throw new Error('upgrade requires .github/steward.json on the default branch');
  const rawManifest = object(parseJson(manifestContent, 'Steward manifest'), 'Steward manifest');
  const currentSchemaMatch = String(rawManifest.$schema ?? '').match(schemaUrlPattern);
  if (!currentSchemaMatch) throw new Error('Steward manifest $schema is not pinned to a complete splrad/steward SHA');
  const currentSchemaSha = currentSchemaMatch[1]!.toLowerCase();
  const currentManifest = normalizeManifest(parseManifest(rawManifest));
  const unsupportedFeatures = [
    ...(currentManifest.features.prAutomation ? ['prAutomation'] : []),
    ...(currentManifest.features.dcoAdvisory ? ['dcoAdvisory'] : []),
  ];
  if (unsupportedFeatures.length) {
    throw new Error(
      `upgrade cannot safely manage unsupported enabled features: ${unsupportedFeatures.join(', ')}`,
    );
  }

  const targetCommit = await input.transport.request<{ sha?: string }>({
    path: `${sourceRepositoryPath}/commits/${segment(targetSha)}`,
  });
  if (String(targetCommit.sha ?? '').toLowerCase() !== targetSha) {
    throw new Error('GitHub did not resolve the exact requested Steward target SHA');
  }
  const cache = new Map<string, string>();
  const stewardFile = async (ref: string, filePath: string): Promise<string> => {
    const key = `${ref}:${filePath}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const content = await repositoryFile(input.transport, sourceRepositoryPath, filePath, ref);
    if (content === null) throw new Error(`Steward ${ref.slice(0, 12)} does not contain ${filePath}`);
    cache.set(key, content);
    return content;
  };

  const schemaContent = await stewardFile(targetSha, 'schema/steward.schema.json');
  const resolvedSchema = targetSchema(schemaContent);
  const schemaVersion = resolvedSchema.version;
  const migratedManifest = migrateManifest(currentManifest, targetSha, schemaVersion);
  validateTargetManifest(resolvedSchema.schema, migratedManifest);
  const generated = new Map<string, string>();
  generated.set('.github/steward.json', `${JSON.stringify(migratedManifest, null, 2)}\n`);

  const currentPins = new Set([currentSchemaSha]);
  const currentDependabot = await repositoryFile(input.transport, path, '.github/dependabot.yml', baseSha);
  if (currentDependabot !== null) {
    const ownedDependabot = await stewardFile(currentSchemaSha, 'templates/init/dependabot.yml');
    if (currentDependabot !== ownedDependabot) {
      throw new Error('Existing .github/dependabot.yml is not the Steward-generated template and will not be overwritten');
    }
  }
  generated.set('.github/dependabot.yml', await stewardFile(targetSha, 'templates/init/dependabot.yml'));

  for (const workflow of workflowTemplates(currentManifest)) {
    const current = await repositoryFile(input.transport, path, workflow.destination, baseSha);
    if (current !== null) {
      const called = workflow.template.split('/').at(-1)!;
      const pin = workflowPin(current, called);
      currentPins.add(pin);
      const previousTemplate = await stewardFile(pin, `templates/${workflow.template}`);
      if (current !== replaceStewardSha(previousTemplate, pin, workflow.template)) {
        throw new Error(`Existing ${workflow.destination} is not the Steward-generated template and will not be overwritten`);
      }
    }
    const targetTemplate = await stewardFile(targetSha, `templates/${workflow.template}`);
    generated.set(workflow.destination, replaceStewardSha(targetTemplate, targetSha, workflow.template));
  }

  for (const pin of [...currentPins].sort()) {
    if (pin === targetSha) continue;
    const comparison = await input.transport.request<{ status?: string }>({
      path: `${sourceRepositoryPath}/compare/${segment(pin)}...${segment(targetSha)}`,
    });
    if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
      throw new Error(`Target Steward SHA is not an upgrade from current pin ${pin}`);
    }
  }

  let preservedAdapter: UpgradePlan['preservedAdapter'];
  if (currentManifest.features.release && currentManifest.release) {
    const adapterPath = currentManifest.release.adapterCommand
      .map(repositoryPathArgument)
      .find((argument) => argument !== undefined);
    if (adapterPath) {
      const adapter = await repositoryFile(input.transport, path, adapterPath, baseSha);
      if (adapter === null) throw new Error(`Release adapter ${adapterPath} does not exist on the default branch`);
      preservedAdapter = { path: adapterPath, digest: digest(adapter) };
    }
  }

  const files: UpgradeFile[] = [];
  for (const [filePath, content] of [...generated.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    files.push(plannedFile(filePath, content, await repositoryFile(input.transport, path, filePath, baseSha)));
  }
  const counts = { create: 0, update: 0, unchanged: 0 };
  for (const file of files) counts[file.status] += 1;

  let branchStatus: UpgradeResourceStatus = 'none';
  let branchSha: string | undefined;
  let pullRequestStatus: UpgradeResourceStatus = 'none';
  let pullRequestNumber: number | undefined;
  let pullRequestUrl: string | undefined;
  if (counts.create + counts.update > 0) {
    const branchRef = await optionalGet<RefPayload>(input.transport, {
      path: `${path}/git/ref/heads/${segment(upgradeBranch)}`,
    });
    if (branchRef) {
      branchSha = String(branchRef.object?.sha ?? '');
      if (branchRef.object?.type !== 'commit' || !shaPattern.test(branchSha)) {
        throw new Error(`Existing branch ${upgradeBranch} has an invalid reference`);
      }
      await verifyReusableBranch({ transport: input.transport, path, branchSha, baseSha, files });
      branchStatus = 'reuse';
      const pulls = await input.transport.request<PullRequestPayload[]>({
        path: `${path}/pulls`,
        query: { state: 'open', head: `${input.owner}:${upgradeBranch}`, base: defaultBranch, per_page: 100 },
      });
      if (pulls.length > 1) throw new Error(`GitHub returned multiple open PRs for ${upgradeBranch}`);
      const pull = pulls[0];
      if (pull) {
        const number = Number(pull.number ?? 0);
        const url = safeGitHubUrl(pull.html_url);
        if (!Number.isSafeInteger(number) || number < 1 || !url || pull.base?.ref !== defaultBranch
          || pull.head?.ref !== upgradeBranch || pull.head?.sha !== branchSha) {
          throw new Error(`GitHub returned an invalid open PR for ${upgradeBranch}`);
        }
        pullRequestStatus = 'reuse';
        pullRequestNumber = number;
        pullRequestUrl = url;
      } else {
        pullRequestStatus = 'create';
      }
    } else {
      branchStatus = 'create';
      pullRequestStatus = 'create';
    }
  }

  const withoutFingerprint: Omit<UpgradePlan, 'fingerprint'> = {
    repository: fullName,
    defaultBranch,
    baseSha,
    baseTreeSha,
    currentSchemaSha,
    currentPins: [...currentPins].sort(),
    targetSha,
    sourceSchemaVersion: currentManifest.schemaVersion,
    targetSchemaVersion: schemaVersion,
    branchName: upgradeBranch,
    branchStatus,
    ...(branchSha ? { branchSha } : {}),
    pullRequestStatus,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    files,
    counts,
    ...(preservedAdapter ? { preservedAdapter } : {}),
  };
  const plan = { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
  return counts.create + counts.update === 0 ? { status: 'current', plan } : { status: 'ready', plan };
}

function mutationFailure(phase: string, completed: string[], error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(`upgrade stopped during ${phase}; completed: ${completed.length ? completed.join(', ') : 'none'}; rerun after correcting the cause. ${cause}`);
}

export async function executeUpgrade(input: {
  transport: GitHubTransport;
  owner: string;
  repository: string;
  plan: UpgradePlan;
}): Promise<UpgradeReport> {
  const path = repositoryPath(input.owner, input.repository);
  const changed = input.plan.files.filter((file) => file.status !== 'unchanged');
  if (!changed.length) throw new Error('upgrade plan contains no changes');
  const completed: string[] = [];
  let phase = 'branch creation';
  let branchSha = input.plan.branchSha;
  let pullRequestNumber = input.plan.pullRequestNumber;
  let pullRequestUrl = input.plan.pullRequestUrl;
  try {
    if (input.plan.branchStatus === 'create') {
      const tree = await input.transport.request<{ sha?: string }>({
        method: 'POST',
        path: `${path}/git/trees`,
        body: {
          base_tree: input.plan.baseTreeSha,
          tree: changed.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
        },
      });
      const treeSha = String(tree.sha ?? '');
      if (!shaPattern.test(treeSha)) throw new Error('GitHub returned an invalid upgrade tree SHA');
      const commit = await input.transport.request<{ sha?: string }>({
        method: 'POST',
        path: `${path}/git/commits`,
        body: {
          message: `chore: upgrade Steward to ${input.plan.targetSha.slice(0, 12)}`,
          tree: treeSha,
          parents: [input.plan.baseSha],
        },
      });
      branchSha = String(commit.sha ?? '');
      if (!shaPattern.test(branchSha)) throw new Error('GitHub returned an invalid upgrade commit SHA');
      await input.transport.request({
        method: 'POST',
        path: `${path}/git/refs`,
        body: { ref: `refs/heads/${input.plan.branchName}`, sha: branchSha },
      });
      completed.push(`branch:${input.plan.branchName}`);
    }

    phase = 'pull request creation';
    if (input.plan.pullRequestStatus === 'create') {
      if (!branchSha) throw new Error('Upgrade branch SHA is unavailable');
      const created = await input.transport.request<PullRequestPayload>({
        method: 'POST',
        path: `${path}/pulls`,
        body: {
          title: `chore: upgrade Steward to ${input.plan.targetSha.slice(0, 12)}`,
          head: input.plan.branchName,
          base: input.plan.defaultBranch,
          body: [
            'Upgrade this repository with SPLRAD Steward.',
            '',
            `- Target Steward SHA: \`${input.plan.targetSha}\``,
            `- Schema migration: v${input.plan.sourceSchemaVersion} -> v${input.plan.targetSchemaVersion}`,
            `- Managed files changed: ${input.plan.counts.create + input.plan.counts.update}`,
            '- Project release adapters and repository credentials are not modified.',
          ].join('\n'),
          draft: false,
          maintainer_can_modify: true,
        },
      });
      pullRequestNumber = Number(created.number ?? 0);
      pullRequestUrl = safeGitHubUrl(created.html_url);
      if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1 || !pullRequestUrl) {
        throw new Error('GitHub returned an invalid created upgrade pull request');
      }
      completed.push(`pr:${pullRequestNumber}`);
    }
  } catch (error) {
    throw mutationFailure(phase, completed, error);
  }
  if (!branchSha || !pullRequestNumber || !pullRequestUrl) throw new Error('upgrade did not produce a complete branch and pull request result');
  return {
    repository: input.plan.repository,
    targetSha: input.plan.targetSha,
    branchName: input.plan.branchName,
    branchSha,
    branchStatus: input.plan.branchStatus,
    pullRequestStatus: input.plan.pullRequestStatus,
    pullRequestNumber,
    pullRequestUrl,
  };
}
