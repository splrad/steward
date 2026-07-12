import { createHash } from 'node:crypto';
import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../../github/src/index.js';
import { inspectAppInstallation, type AppInstallationReport } from './app-installation.js';
import { generateInitFiles, type InitGeneratedFile, type InitPlannedFile, type InitSpec } from './init.js';
import {
  requiredSecretRequirements,
  type SecretVault,
  type StewardSecretName,
} from './secret-input.js';

const initBranch = 'steward/init';
const appClientIdVariable = 'WORKFLOW_AUTOMATION_APP_CLIENT_ID';
const shaPattern = /^[a-f0-9]{40}$/i;

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
  ref?: string;
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

export type InitApplyFileStatus = 'create' | 'unchanged' | 'conflict';
export type InitApplyResourceStatus = 'create' | 'reuse' | 'none';

export interface InitApplyPlan {
  repository: string;
  stewardSha: string;
  defaultBranch: string;
  baseSha: string;
  baseTreeSha: string;
  branchName: string;
  branchStatus: InitApplyResourceStatus;
  branchSha?: string;
  pullRequestStatus: InitApplyResourceStatus;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  files: InitPlannedFile[];
  counts: Record<InitApplyFileStatus, number>;
  missingSecrets: StewardSecretName[];
  variableStatus: 'create' | 'unchanged';
  variableValue: string;
  fingerprint: string;
}

export type InitApplyPreparation =
  | { status: 'blocked'; preflight: AppInstallationReport }
  | { status: 'ready'; plan: InitApplyPlan };

export interface InitApplyReport {
  repository: string;
  branchName?: string;
  branchSha?: string;
  branchStatus: InitApplyResourceStatus;
  pullRequestStatus: InitApplyResourceStatus;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  secretsCreated: StewardSecretName[];
  variableCreated: boolean;
}

export type SecretEncryptor = (value: Buffer, publicKey: string) => Promise<string>;

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function contentPath(filePath: string): string {
  return filePath.split('/').map(segment).join('/');
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

function decodeFile(payload: { type?: string; encoding?: string; content?: string }): string {
  if (payload.type !== 'file' || payload.encoding !== 'base64' || !payload.content) {
    throw new Error('GitHub returned an invalid repository file response');
  }
  return Buffer.from(payload.content.replaceAll(/\s/g, ''), 'base64').toString('utf8');
}

async function optionalGet<T>(transport: GitHubTransport, request: GitHubRequest): Promise<T | null> {
  try {
    return await transport.request<T>(request);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
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
  throw new Error('GitHub init inventory exceeded the 20-page safety limit');
}

function fingerprint(plan: Omit<InitApplyPlan, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');
}

async function remoteFile(
  transport: GitHubTransport,
  path: string,
  file: InitGeneratedFile,
  ref: string,
): Promise<InitPlannedFile> {
  const existing = await optionalGet<{ type?: string; encoding?: string; content?: string }>(transport, {
    path: `${path}/contents/${contentPath(file.path)}`,
    query: { ref },
  });
  if (!existing) return { ...file, status: 'create' };
  const content = decodeFile(existing);
  if (content === file.content) return { ...file, status: 'unchanged' };
  const existingDigest = createHash('sha256').update(content, 'utf8').digest('hex');
  return { ...file, status: 'conflict', existingDigest };
}

async function verifyReusableBranch(input: {
  transport: GitHubTransport;
  path: string;
  branchSha: string;
  baseSha: string;
  generated: InitGeneratedFile[];
  files: InitPlannedFile[];
}): Promise<void> {
  const commit = await input.transport.request<RepositoryCommitPayload>({
    path: `${input.path}/commits/${segment(input.branchSha)}`,
  });
  const parents = commit.parents ?? [];
  const expectedChanges = input.files.filter((file) => file.status === 'create').map((file) => file.path).sort();
  const actualFiles = commit.files ?? [];
  const actualChanges = actualFiles.map((file) => String(file.filename ?? '')).sort();
  if (commit.sha !== input.branchSha || parents.length !== 1 || parents[0]?.sha !== input.baseSha
    || JSON.stringify(actualChanges) !== JSON.stringify(expectedChanges)
    || actualFiles.some((file) => file.status !== 'added')) {
    throw new Error(`Existing branch ${initBranch} is not the exact Steward init commit for the current default-branch head`);
  }
  const branchFiles = await Promise.all(input.generated.map((file) => remoteFile(
    input.transport, input.path, file, input.branchSha,
  )));
  if (branchFiles.some((file) => file.status !== 'unchanged')) {
    throw new Error(`Existing branch ${initBranch} does not contain the exact generated Steward files`);
  }
}

export async function prepareInitApply(input: {
  transport: GitHubTransport;
  owner: string;
  repository: string;
  spec: InitSpec;
  templateDirectory: string;
}): Promise<InitApplyPreparation> {
  const path = repositoryPath(input.owner, input.repository);
  const repository = await input.transport.request<RepositoryPayload>({ path });
  const repositoryId = Number(repository.id ?? 0);
  const fullName = String(repository.full_name ?? '');
  const defaultBranch = String(repository.default_branch ?? '');
  const ownerLogin = String(repository.owner?.login ?? '');
  const ownerType = String(repository.owner?.type ?? '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !fullName || !defaultBranch || !ownerLogin || !ownerType
    || fullName.toLowerCase() !== `${input.owner}/${input.repository}`.toLowerCase()) {
    throw new Error('GitHub returned invalid repository metadata');
  }
  if (repository.archived || repository.disabled) throw new Error('init --apply requires an active repository');
  if (repository.permissions?.admin !== true) throw new Error('init --apply requires repository administrator permission');

  const preflight = await inspectAppInstallation(input.transport, {
    owner: input.owner,
    repository: input.repository,
    repositoryId,
    ownerLogin,
    ownerType,
    manifest: input.spec.manifest,
  });
  if (preflight.status !== 'installed') return { status: 'blocked', preflight };

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

  const generated = await generateInitFiles({ spec: input.spec, templateDirectory: input.templateDirectory });
  const [files, secrets, variables] = await Promise.all([
    Promise.all(generated.map((file) => remoteFile(input.transport, path, file, baseSha))),
    pagedItems<{ secrets?: Array<{ name?: string }> }, { name?: string }>(
      input.transport, { path: `${path}/actions/secrets` }, (payload) => payload.secrets ?? [],
    ),
    pagedItems<{ variables?: Array<{ name?: string; value?: string }> }, { name?: string; value?: string }>(
      input.transport, { path: `${path}/actions/variables` }, (payload) => payload.variables ?? [],
    ),
  ]);
  const counts = { create: 0, unchanged: 0, conflict: 0 };
  for (const file of files) counts[file.status] += 1;
  if (counts.conflict) throw new Error('init --apply found generated-file conflicts on the default branch');

  const presentSecrets = new Set(secrets.map((secret) => String(secret.name ?? '')));
  const missingSecrets = requiredSecretRequirements(input.spec.manifest)
    .map((requirement) => requirement.name)
    .filter((name) => !presentSecrets.has(name));
  const currentVariable = variables.find((variable) => variable.name === appClientIdVariable);
  const variableValue = input.spec.manifest.automation.githubApp.clientId;
  if (currentVariable && currentVariable.value !== variableValue) {
    throw new Error(`${appClientIdVariable} exists with a different value`);
  }
  const variableStatus = currentVariable ? 'unchanged' as const : 'create' as const;

  let branchStatus: InitApplyResourceStatus = 'none';
  let branchSha: string | undefined;
  let pullRequestStatus: InitApplyResourceStatus = 'none';
  let pullRequestNumber: number | undefined;
  let pullRequestUrl: string | undefined;
  if (counts.create) {
    const branchRef = await optionalGet<RefPayload>(input.transport, {
      path: `${path}/git/ref/heads/${segment(initBranch)}`,
    });
    if (branchRef) {
      branchSha = String(branchRef.object?.sha ?? '');
      if (branchRef.object?.type !== 'commit' || !shaPattern.test(branchSha)) {
        throw new Error(`Existing branch ${initBranch} has an invalid reference`);
      }
      await verifyReusableBranch({
        transport: input.transport, path, branchSha, baseSha, generated, files,
      });
      branchStatus = 'reuse';
      const pullRequests = await input.transport.request<PullRequestPayload[]>({
        path: `${path}/pulls`,
        query: { state: 'open', head: `${input.owner}:${initBranch}`, base: defaultBranch, per_page: 100 },
      });
      if (pullRequests.length > 1) throw new Error(`GitHub returned multiple open PRs for ${initBranch}`);
      const pullRequest = pullRequests[0];
      if (pullRequest) {
        const number = Number(pullRequest.number ?? 0);
        const url = safeGitHubUrl(pullRequest.html_url);
        if (!Number.isSafeInteger(number) || number < 1 || !url || pullRequest.base?.ref !== defaultBranch
          || pullRequest.head?.ref !== initBranch || pullRequest.head?.sha !== branchSha) {
          throw new Error(`GitHub returned an invalid open PR for ${initBranch}`);
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

  const withoutFingerprint: Omit<InitApplyPlan, 'fingerprint'> = {
    repository: fullName,
    stewardSha: input.spec.stewardSha,
    defaultBranch,
    baseSha,
    baseTreeSha,
    branchName: initBranch,
    branchStatus,
    ...(branchSha ? { branchSha } : {}),
    pullRequestStatus,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    files,
    counts,
    missingSecrets,
    variableStatus,
    variableValue,
  };
  return { status: 'ready', plan: { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) } };
}

export async function encryptRepositorySecret(value: Buffer, publicKey: string): Promise<string> {
  const { default: sodium } = await import('libsodium-wrappers');
  await sodium.ready;
  let key: Uint8Array | undefined;
  let encrypted: Uint8Array | undefined;
  try {
    key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
    if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) throw new Error('GitHub returned an invalid Actions Secret public key');
    encrypted = sodium.crypto_box_seal(value, key);
    return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  } finally {
    if (encrypted) sodium.memzero(encrypted);
    if (key) sodium.memzero(key);
  }
}

function mutationFailure(phase: string, completed: string[], error: unknown, vault: SecretVault): Error {
  const cause = vault.redact(error instanceof Error ? error.message : String(error));
  const completedSummary = completed.length ? completed.join(', ') : 'none';
  return new Error(`init --apply stopped during ${phase}; completed: ${completedSummary}; rerun after correcting the cause. ${cause}`);
}

export async function executeInitApply(input: {
  transport: GitHubTransport;
  owner: string;
  repository: string;
  plan: InitApplyPlan;
  vault: SecretVault;
  encrypt?: SecretEncryptor;
}): Promise<InitApplyReport> {
  const path = repositoryPath(input.owner, input.repository);
  const completed: string[] = [];
  let phase = 'branch creation';
  let branchSha = input.plan.branchSha;
  let pullRequestNumber = input.plan.pullRequestNumber;
  let pullRequestUrl = input.plan.pullRequestUrl;
  const secretsCreated: StewardSecretName[] = [];
  try {
    if (input.plan.branchStatus === 'create') {
      const entries = input.plan.files.filter((file) => file.status === 'create').map((file) => ({
        path: file.path, mode: '100644', type: 'blob', content: file.content,
      }));
      const tree = await input.transport.request<{ sha?: string }>({
        method: 'POST', path: `${path}/git/trees`, body: { base_tree: input.plan.baseTreeSha, tree: entries },
      });
      const treeSha = String(tree.sha ?? '');
      if (!shaPattern.test(treeSha)) throw new Error('GitHub returned an invalid init tree SHA');
      const commit = await input.transport.request<{ sha?: string }>({
        method: 'POST', path: `${path}/git/commits`,
        body: { message: 'chore: initialize Steward', tree: treeSha, parents: [input.plan.baseSha] },
      });
      branchSha = String(commit.sha ?? '');
      if (!shaPattern.test(branchSha)) throw new Error('GitHub returned an invalid init commit SHA');
      await input.transport.request({
        method: 'POST', path: `${path}/git/refs`, body: { ref: `refs/heads/${input.plan.branchName}`, sha: branchSha },
      });
      completed.push(`branch:${input.plan.branchName}`);
    }

    phase = 'Actions Secret precondition';
    if (input.plan.missingSecrets.length) {
      const currentSecrets = await pagedItems<{ secrets?: Array<{ name?: string }> }, { name?: string }>(
        input.transport, { path: `${path}/actions/secrets` }, (payload) => payload.secrets ?? [],
      );
      const currentNames = new Set(currentSecrets.map((secret) => String(secret.name ?? '')));
      const appeared = input.plan.missingSecrets.filter((name) => currentNames.has(name));
      if (appeared.length) {
        throw new Error(`Refusing to overwrite Actions Secrets created after confirmation: ${appeared.join(', ')}`);
      }
      phase = 'Actions Secret creation';
      const publicKey = await input.transport.request<{ key_id?: string; key?: string }>({
        path: `${path}/actions/secrets/public-key`,
      });
      const keyId = String(publicKey.key_id ?? '');
      const key = String(publicKey.key ?? '');
      if (!keyId || !key) throw new Error('GitHub returned an invalid Actions Secret public key response');
      const encrypt = input.encrypt ?? encryptRepositorySecret;
      for (const name of input.plan.missingSecrets) {
        phase = `Actions Secret precondition (${name})`;
        const existing = await optionalGet<{ name?: string }>(input.transport, {
          path: `${path}/actions/secrets/${segment(name)}`,
        });
        if (existing) throw new Error(`Refusing to overwrite Actions Secret created after confirmation: ${name}`);
        phase = `Actions Secret creation (${name})`;
        await input.vault.use(name, async (value) => {
          const encryptedValue = await encrypt(value, key);
          await input.transport.request({
            method: 'PUT', path: `${path}/actions/secrets/${segment(name)}`,
            body: { encrypted_value: encryptedValue, key_id: keyId },
          });
        });
        secretsCreated.push(name);
        completed.push(`secret:${name}`);
      }
    }

    phase = 'Actions Variable creation';
    if (input.plan.variableStatus === 'create') {
      await input.transport.request({
        method: 'POST', path: `${path}/actions/variables`,
        body: { name: appClientIdVariable, value: input.plan.variableValue },
      });
      completed.push(`variable:${appClientIdVariable}`);
    }

    phase = 'pull request creation';
    if (input.plan.pullRequestStatus === 'create') {
      if (!branchSha) throw new Error('Init branch SHA is unavailable');
      const created = await input.transport.request<PullRequestPayload>({
        method: 'POST', path: `${path}/pulls`, body: {
          title: 'chore: initialize Steward',
          head: input.plan.branchName,
          base: input.plan.defaultBranch,
          body: [
            'Initialize this repository with SPLRAD Steward.',
            '',
            `- Steward SHA: \`${input.plan.stewardSha}\``,
            `- Generated files: ${input.plan.counts.create}`,
            '- Repository Secrets, when required, were configured separately and are not included in this PR.',
          ].join('\n'),
          draft: false,
          maintainer_can_modify: true,
        },
      });
      pullRequestNumber = Number(created.number ?? 0);
      pullRequestUrl = safeGitHubUrl(created.html_url);
      if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1 || !pullRequestUrl) {
        throw new Error('GitHub returned an invalid created pull request');
      }
      completed.push(`pr:${pullRequestNumber}`);
    }
  } catch (error) {
    throw mutationFailure(phase, completed, error, input.vault);
  }

  return {
    repository: input.plan.repository,
    ...(input.plan.branchStatus === 'none' ? {} : { branchName: input.plan.branchName }),
    ...(branchSha ? { branchSha } : {}),
    branchStatus: input.plan.branchStatus,
    pullRequestStatus: input.plan.pullRequestStatus,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    secretsCreated,
    variableCreated: input.plan.variableStatus === 'create',
  };
}
