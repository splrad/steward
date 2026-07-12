import { createHash } from 'node:crypto';
import { parseReleaseAdapterContext, parseReleasePlan, stewardCheckExternalId } from '../../packages/core/src/index.js';
import { loadDefaultBranchManifest } from '../../packages/manifest/src/index.js';
import { GitHubRepositoryClient, createGitHubRestTransport, type GitHubCheckRun } from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';
import { graphqlApiBase, type StewardRuntimeEnvironment } from './context.js';
import { readReleaseStatusWithClient } from './release-status.js';

function parseJson(value: string, name: string): unknown {
  try { return JSON.parse(value); } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function reconcilePublishedRelease(input: {
  inputs: StewardActionInputs;
  environment: StewardRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
}): Promise<{ state: 'passed'; summary: string; releaseUrl?: string }> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('release-reconcile requires an explicit GitHub token');
  const context = parseReleaseAdapterContext(parseJson(input.inputs.releaseContext ?? '', 'release-context'));
  const plan = parseReleasePlan(parseJson(input.inputs.releasePlan ?? '', 'release-plan'));
  const [owner, repository] = context.repository.fullName.split('/') as [string, string];
  const restApiUrl = input.environment.GITHUB_API_URL?.trim() || 'https://api.github.com/';
  const transportOptions = input.fetch ? { fetch: input.fetch } : {};
  const client = new GitHubRepositoryClient(
    createGitHubRestTransport({ token, baseUrl: restApiUrl, ...transportOptions }),
    createGitHubRestTransport({ token, baseUrl: graphqlApiBase(restApiUrl), ...transportOptions }),
  );
  const metadata = await client.getRepository(owner, repository);
  if (metadata.id !== context.repository.id
    || metadata.fullName.toLowerCase() !== context.repository.fullName.toLowerCase()) {
    throw new Error('Release context repository does not match current repository metadata');
  }
  const manifest = await loadDefaultBranchManifest(client, owner, repository);
  if (!manifest.manifest.features.release) throw new Error('Release feature is disabled in the default-branch Manifest');
  const status = await readReleaseStatusWithClient(client, context, plan);
  if (status.decision.reason !== 'already-published' || !status.release?.html_url) {
    throw new Error('release-reconcile requires an existing complete publication');
  }

  const inputDigest = createHash('sha256').update(JSON.stringify({ context, plan }), 'utf8').digest('hex');
  const externalId = stewardCheckExternalId({
    repositoryId: metadata.id,
    prNumber: context.pullRequest.number,
    headSha: context.pullRequest.mergeSha,
    checkId: 'release-reconcile',
    configDigest: manifest.configDigest,
    inputDigest,
  });
  const detailsUrl = input.environment.GITHUB_RUN_ID
    ? `${(input.environment.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')}/${metadata.fullName}/actions/runs/${input.environment.GITHUB_RUN_ID}`
    : undefined;
  const checks = await client.listCommitCheckRuns(owner, repository, context.pullRequest.mergeSha);
  const existing = checks
    .filter((check) => check.name === 'Release' && check.external_id === externalId
      && String(check.app?.slug ?? '') === manifest.manifest.automation.githubApp.slug)
    .sort((left, right) => left.id - right.id)
    .at(-1);
  const update = {
    name: 'Release',
    status: 'completed' as const,
    conclusion: 'success' as const,
    externalId,
    ...(detailsUrl ? { detailsUrl } : {}),
    title: '发布已确认',
    summary: `${plan.tagName} 已指向当前 merge commit，Release 已公开。`,
  };
  const check: GitHubCheckRun = existing
    ? await client.updateCheckRun(owner, repository, existing.id, update)
    : await client.createCheckRun(owner, repository, { ...update, headSha: context.pullRequest.mergeSha });
  if (!Number.isSafeInteger(check.id) || check.id < 1) throw new Error('GitHub returned invalid reconciled Check metadata');
  return { state: 'passed', summary: 'Existing Release publication reconciled', releaseUrl: status.release.html_url };
}
