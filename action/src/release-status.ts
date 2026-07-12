import {
  evaluateReleasePublication,
  parseReleaseAdapterContext,
  parseReleasePlan,
  type ReleasePublicationDecision,
  type ReleaseAdapterContext,
  type ReleasePlan,
} from '../../packages/core/src/index.js';
import {
  GitHubApiError,
  GitHubRepositoryClient,
  createGitHubRestTransport,
  type GitHubRelease,
} from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';
import { graphqlApiBase, type StewardRuntimeEnvironment } from './context.js';

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be valid JSON: ${detail}`);
  }
}

async function missingAsUndefined<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
}

export async function readReleaseStatus(input: {
  inputs: StewardActionInputs;
  environment: StewardRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
}): Promise<{ decision: ReleasePublicationDecision; release?: GitHubRelease }> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('release-status requires an explicit GitHub token');
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
  return await readReleaseStatusWithClient(client, context, plan);
}

export async function readReleaseStatusWithClient(
  client: GitHubRepositoryClient,
  context: ReleaseAdapterContext,
  plan: ReleasePlan,
  expectedReleaseId?: number,
): Promise<{ decision: ReleasePublicationDecision; release?: GitHubRelease }> {
  const [owner, repository] = context.repository.fullName.split('/') as [string, string];
  if (expectedReleaseId !== undefined && (!Number.isSafeInteger(expectedReleaseId) || expectedReleaseId < 1)) {
    throw new Error('Expected Release ID must be a positive integer');
  }
  const [tagRef, releaseResult] = await Promise.all([
    missingAsUndefined(client.getTagRef(owner, repository, plan.tagName)),
    expectedReleaseId === undefined
      ? client.listReleases(owner, repository)
      : client.getRelease(owner, repository, expectedReleaseId),
  ]);
  if (tagRef && (tagRef.ref !== `refs/tags/${plan.tagName}`
    || !['commit', 'tag'].includes(String(tagRef.object?.type ?? ''))
    || !/^[a-f0-9]{40}$/i.test(String(tagRef.object?.sha ?? '')))) {
    throw new Error('GitHub returned invalid tag reference metadata');
  }
  const commit = tagRef ? await client.getCommit(owner, repository, plan.tagName) : undefined;
  let release: GitHubRelease | undefined;
  if (Array.isArray(releaseResult)) {
    const matchingReleases = releaseResult.filter((candidate) => candidate.tag_name === plan.tagName);
    if (matchingReleases.length > 1) throw new Error('GitHub returned multiple Releases for the planned tag');
    [release] = matchingReleases;
  } else {
    release = releaseResult;
    if (release.id !== expectedReleaseId) throw new Error('GitHub returned a different Release ID');
  }
  const commitSha = commit ? String(commit.sha ?? '').trim().toLowerCase() : undefined;
  if (commit && !/^[a-f0-9]{40}$/.test(commitSha ?? '')) {
    throw new Error('GitHub returned an invalid tag commit SHA');
  }
  if (release && (!Number.isSafeInteger(release.id) || release.id < 1
    || !String(release.tag_name ?? '').trim() || typeof release.draft !== 'boolean')) {
    throw new Error('GitHub returned invalid Release metadata');
  }
  return {
    decision: evaluateReleasePublication({
      mergeSha: context.pullRequest.mergeSha,
      tagName: plan.tagName,
      ...(commitSha ? { tagCommitSha: commitSha } : {}),
      ...(release ? { release: {
        id: release.id,
        tagName: String(release.tag_name),
        draft: release.draft === true,
      } } : {}),
    }),
    ...(release ? { release } : {}),
  };
}
