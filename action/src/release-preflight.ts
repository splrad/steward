import { loadDefaultBranchManifest } from '../../packages/manifest/src/index.js';
import {
  evaluateReleaseTrigger,
  parseReleaseAdapterContext,
  type ReleaseAdapterContext,
  type ReleaseTriggerDecision,
} from '../../packages/core/src/index.js';
import { GitHubRepositoryClient, createGitHubRestTransport } from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';
import {
  graphqlApiBase,
  readEvent,
  resolvePullNumber,
  type StewardRuntimeEnvironment,
} from './context.js';

export interface ReleasePreflightResult {
  state: 'passed' | 'ignored';
  summary: string;
  decision: ReleaseTriggerDecision;
  context?: ReleaseAdapterContext;
  runner?: string;
  adapterCommand?: string[];
}

function positiveInteger(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function commitSha(value: unknown, name: string): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${name} must be a 40-character commit SHA`);
  return sha;
}

export async function createReleasePreflight(input: {
  inputs: StewardActionInputs;
  environment: StewardRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
}): Promise<ReleasePreflightResult> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('release-preflight requires an explicit GitHub token');
  const eventPath = input.inputs.eventPath?.trim() || input.environment.GITHUB_EVENT_PATH?.trim() || '';
  const event = await readEvent(eventPath);
  const eventName = input.environment.GITHUB_EVENT_NAME?.trim() || '';
  const pullRequestEvent = eventName === 'pull_request' || eventName === 'pull_request_target';
  if (!pullRequestEvent && eventName !== 'workflow_dispatch') {
    throw new Error('release-preflight accepts only pull_request, pull_request_target, or workflow_dispatch events');
  }
  const fullName = String(event.repository?.full_name ?? '').trim();
  const [owner, repository, extra] = fullName.split('/');
  if (!owner || !repository || extra) throw new Error('GitHub event payload has an invalid repository full name');
  const eventRepositoryId = positiveInteger(event.repository?.id);
  if (!eventRepositoryId) throw new Error('GitHub event payload has an invalid repository ID');

  const restApiUrl = input.environment.GITHUB_API_URL?.trim() || 'https://api.github.com/';
  const transportOptions = input.fetch ? { fetch: input.fetch } : {};
  const client = new GitHubRepositoryClient(
    createGitHubRestTransport({ token, baseUrl: restApiUrl, ...transportOptions }),
    createGitHubRestTransport({ token, baseUrl: graphqlApiBase(restApiUrl), ...transportOptions }),
  );
  const metadata = await client.getRepository(owner, repository);
  if (metadata.id !== eventRepositoryId || metadata.fullName.toLowerCase() !== fullName.toLowerCase()) {
    throw new Error('GitHub event repository does not match current repository metadata');
  }
  if (!metadata.defaultBranch) throw new Error('GitHub repository has no default branch');
  const manifest = await loadDefaultBranchManifest(client, owner, repository);
  if (!manifest.manifest.features.release) {
    return {
      state: 'ignored',
      summary: 'Release feature is disabled',
      decision: { state: 'ignored', reason: 'feature-disabled', matchedPaths: [] },
    };
  }
  const configuration = manifest.manifest.release;
  if (!configuration) throw new Error('Release feature requires default-branch Manifest configuration');

  const pullNumber = resolvePullNumber(event, input.inputs.prNumber);
  const pull = await client.getPullRequest(owner, repository, pullNumber);
  if (pull.number !== pullNumber) throw new Error('GitHub returned a different pull request number');
  if (pull.state !== 'closed' || pull.merged !== true) throw new Error('release-preflight requires a merged pull request');
  if (pull.base.ref !== metadata.defaultBranch) throw new Error('Merged pull request does not target the current default branch');
  const mergeSha = commitSha(pull.merge_commit_sha, 'GitHub pull request merge SHA');

  if (pullRequestEvent) {
    if (event.action !== 'closed' || event.pull_request?.merged !== true) {
      throw new Error('release-preflight pull request event must describe a merged close');
    }
    if (positiveInteger(event.pull_request?.number) !== pullNumber) {
      throw new Error('Trusted event pull request number does not match live pull request');
    }
    const eventMergeSha = commitSha(event.pull_request?.merge_commit_sha, 'Trusted event merge SHA');
    if (eventMergeSha !== mergeSha) throw new Error('Live pull request merge SHA does not match trusted event');
  }

  const files = await client.listPullRequestFiles(owner, repository, pullNumber);
  const changedFiles = files.map((file) => String(file.filename ?? '').trim());
  if (changedFiles.some((file) => !file)) throw new Error('GitHub returned a pull request file without a valid filename');
  const decision = evaluateReleaseTrigger({
    enabled: true,
    triggerPaths: configuration.triggerPaths,
    changedFiles,
  });
  if (decision.state === 'ignored') {
    return { state: 'ignored', summary: 'Release trigger paths did not match', decision };
  }
  const context = parseReleaseAdapterContext({
    contractVersion: 1,
    repository: { id: metadata.id, fullName: metadata.fullName },
    pullRequest: { number: pullNumber, mergeSha },
  });
  return {
    state: 'passed',
    summary: 'Merged pull request is eligible for Release adapter execution',
    decision,
    context,
    runner: configuration.runner,
    adapterCommand: [...configuration.adapterCommand],
  };
}
