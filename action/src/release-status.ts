import {
  evaluateReleasePublication,
  parseReleaseAdapterContext,
  parseReleasePlan,
  type ReleasePublicationDecision,
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
  const [tagRef, releases] = await Promise.all([
    missingAsUndefined(client.getTagRef(owner, repository, plan.tagName)),
    client.listReleases(owner, repository),
  ]);
  if (tagRef && (tagRef.ref !== `refs/tags/${plan.tagName}`
    || !['commit', 'tag'].includes(String(tagRef.object?.type ?? ''))
    || !/^[a-f0-9]{40}$/i.test(String(tagRef.object?.sha ?? '')))) {
    throw new Error('GitHub returned invalid tag reference metadata');
  }
  const commit = tagRef ? await client.getCommit(owner, repository, plan.tagName) : undefined;
  const matchingReleases = releases.filter((release) => release.tag_name === plan.tagName);
  if (matchingReleases.length > 1) throw new Error('GitHub returned multiple Releases for the planned tag');
  const release = matchingReleases[0];
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
