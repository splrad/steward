import { createHash } from 'node:crypto';
import { parseReleaseAdapterContext, stewardCheckExternalId } from '../../packages/core/src/index.js';
import { GitHubRepositoryClient, createGitHubRestTransport } from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';
import { graphqlApiBase, readEvent, resolvePullNumber, type StewardRuntimeEnvironment } from './context.js';

function positive(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export async function finalizeReleaseFailure(input: {
  inputs: StewardActionInputs; environment: StewardRuntimeEnvironment; fetch?: typeof globalThis.fetch;
}): Promise<never> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('release-finalize requires an explicit GitHub token');
  const api = input.environment.GITHUB_API_URL?.trim() || 'https://api.github.com/';
  const options = input.fetch ? { fetch: input.fetch } : {};
  const client = new GitHubRepositoryClient(
    createGitHubRestTransport({ token, baseUrl: api, ...options }),
    createGitHubRestTransport({ token, baseUrl: graphqlApiBase(api), ...options }),
  );
  let context;
  const supplied = input.inputs.releaseContext?.trim();
  if (supplied) context = parseReleaseAdapterContext(JSON.parse(supplied));
  else {
    const event = await readEvent(input.inputs.eventPath?.trim() || input.environment.GITHUB_EVENT_PATH?.trim() || '');
    const eventName = input.environment.GITHUB_EVENT_NAME?.trim() || '';
    if (!['pull_request', 'workflow_dispatch'].includes(eventName)) throw new Error('release-finalize rejected an untrusted event');
    const fullName = String(event.repository?.full_name ?? '').trim();
    const [owner, repository, extra] = fullName.split('/');
    if (!owner || !repository || extra || !positive(event.repository?.id)) throw new Error('release-finalize event repository is invalid');
    const metadata = await client.getRepository(owner, repository);
    if (metadata.id !== positive(event.repository?.id) || metadata.fullName.toLowerCase() !== fullName.toLowerCase()
      || !metadata.defaultBranch) throw new Error('release-finalize repository identity does not match');
    const number = resolvePullNumber(event, input.inputs.prNumber);
    const pull = await client.getPullRequest(owner, repository, number);
    const mergeSha = String(pull.merge_commit_sha ?? '').toLowerCase();
    if (pull.number !== number || pull.state !== 'closed' || pull.merged !== true
      || pull.base.ref !== metadata.defaultBranch || !/^[a-f0-9]{40}$/.test(mergeSha)) {
      throw new Error('release-finalize requires a trusted merged default-branch pull request');
    }
    if (eventName === 'pull_request' && (event.action !== 'closed' || event.pull_request?.merged !== true
      || positive(event.pull_request?.number) !== number
      || String(event.pull_request?.merge_commit_sha ?? '').toLowerCase() !== mergeSha)) {
      throw new Error('release-finalize merge facts do not match the trusted event');
    }
    context = parseReleaseAdapterContext({ contractVersion: 1,
      repository: { id: metadata.id, fullName: metadata.fullName }, pullRequest: { number, mergeSha } });
  }
  const [owner, repository] = context.repository.fullName.split('/') as [string, string];
  const metadata = await client.getRepository(owner, repository);
  if (metadata.id !== context.repository.id || metadata.fullName.toLowerCase() !== context.repository.fullName.toLowerCase()) {
    throw new Error('release-finalize context repository does not match current metadata');
  }
  const summary = input.inputs.releaseFailureSummary?.trim() || 'Release workflow failed before publication completed.';
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  await client.createCheckRun(owner, repository, {
    name: 'Release', headSha: context.pullRequest.mergeSha, status: 'completed', conclusion: 'failure',
    externalId: stewardCheckExternalId({ repositoryId: metadata.id, prNumber: context.pullRequest.number,
      headSha: context.pullRequest.mergeSha, checkId: 'release-finalizer',
      configDigest: digest('release-finalizer-without-manifest-v1'), inputDigest: digest(summary) }),
    title: '发布流程失败', summary: summary.slice(0, 60000),
  });
  throw new Error(summary);
}
