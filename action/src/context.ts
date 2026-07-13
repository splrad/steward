import { readFile } from 'node:fs/promises';
import { loadDefaultBranchManifest, type LoadedManifest } from '../../packages/manifest/src/index.js';
import {
  GitHubRepositoryClient,
  createGitHubRestTransport,
  type GitHubPullRequest,
} from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';

export interface GitHubEventPayload {
  action?: string;
  ref?: string;
  after?: string;
  deleted?: boolean;
  sender?: { login?: string };
  repository?: { id?: number; full_name?: string; default_branch?: string };
  pull_request?: {
    number?: number;
    merged?: boolean;
    merge_commit_sha?: string | null;
    head?: { sha?: string };
  };
  workflow_run?: {
    id?: number;
    name?: string;
    display_title?: string;
    path?: string;
    event?: string;
    status?: string;
    conclusion?: string | null;
    created_at?: string;
    html_url?: string;
    head_sha?: string;
    pull_requests?: { number?: number }[];
  };
  check_run?: { name?: string; head_sha?: string; pull_requests?: { number?: number }[] };
  client_payload?: {
    repository_id?: number;
    pr_number?: number;
    head_sha?: string;
    source_event?: string;
    action?: string;
    delivery_id?: string;
    [key: string]: unknown;
  };
}

export interface StewardRuntimeEnvironment {
  GITHUB_EVENT_NAME?: string;
  GITHUB_EVENT_PATH?: string;
  GITHUB_API_URL?: string;
  GITHUB_SERVER_URL?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_WORKSPACE?: string;
  RUNNER_TEMP?: string;
}

export interface StewardOperationContext {
  owner: string;
  repository: string;
  repositoryId: number;
  defaultBranch: string;
  eventName: string;
  event: GitHubEventPayload;
  pull: GitHubPullRequest;
  manifest: LoadedManifest;
  client: GitHubRepositoryClient;
  mutationClient?: GitHubRepositoryClient;
  detailsUrl?: string;
}

export class PullRequestStateMismatchError extends Error {
  constructor(
    readonly pullNumber: number,
    readonly expectedState: 'open' | 'closed',
    readonly actualState: string,
  ) {
    const article = expectedState === 'open' ? 'an' : 'a';
    super(
      `Steward operation only accepts ${article} ${expectedState} pull request; `
      + `pull request #${pullNumber} has state ${JSON.stringify(actualState)}`,
    );
    this.name = 'PullRequestStateMismatchError';
  }
}

function positiveInteger(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function resolvePullNumber(event: GitHubEventPayload, manual: string | undefined): number {
  const candidates = [
    event.pull_request?.number,
    event.workflow_run?.pull_requests?.[0]?.number,
    event.check_run?.pull_requests?.[0]?.number,
    event.client_payload?.pr_number,
    manual,
  ];
  for (const candidate of candidates) {
    const number = positiveInteger(candidate);
    if (number) return number;
  }
  throw new Error('Unable to resolve a pull request number from the trusted event or manual input');
}

export function resolveExpectedHead(event: GitHubEventPayload, manual: string | undefined): string {
  return String(
    event.pull_request?.head?.sha
      || event.client_payload?.head_sha
      || event.check_run?.head_sha
      || manual
      || '',
  ).trim().toLowerCase();
}

const trustedWorkflowEvents: Readonly<Record<string, readonly string[]>> = {
  '.github/workflows/pr-classification.yml': ['pull_request_target', 'workflow_dispatch'],
  '.github/workflows/dco-check.yml': ['pull_request_target', 'workflow_dispatch'],
  '.github/workflows/dco-advisory.yml': ['pull_request_target', 'workflow_dispatch'],
  '.github/workflows/pr-governance.yml': ['pull_request_target', 'workflow_dispatch'],
};

const reviewSignalActions: Readonly<Record<string, readonly string[]>> = {
  pull_request: ['review_requested', 'review_request_removed'],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  pull_request_review_comment: ['created', 'edited', 'deleted'],
  pull_request_review_thread: ['resolved', 'unresolved'],
};

export function trustedWorkflowRunContext(run: GitHubEventPayload['workflow_run']): {
  prNumber: number;
  headSha: string;
} | null {
  const path = String(run?.path ?? '').split('@')[0]?.replace(/\\/g, '/').toLowerCase() ?? '';
  if (path === '.github/workflows/pr-review-signal.yml') {
    const match = String(run?.display_title ?? '').match(
      /^PR Review Signal \x23([1-9][0-9]*) \/ ([a-f0-9]{40}) \/ ([a-z_]+) \/ ([a-z_]+)$/i,
    );
    if (!match || run?.event !== match[3] || !reviewSignalActions[String(match[3])]?.includes(String(match[4]))) return null;
    return { prNumber: Number(match[1]), headSha: String(match[2]).toLowerCase() };
  }
  if (!trustedWorkflowEvents[path]?.includes(String(run?.event ?? ''))) return null;
  const match = String(run?.display_title ?? run?.name ?? '').match(/\x23([1-9][0-9]*) \/ ([a-f0-9]{40})(?: \/|$)/i);
  return match ? { prNumber: Number(match[1]), headSha: String(match[2]).toLowerCase() } : null;
}

export function validateRepositoryDispatch(event: GitHubEventPayload, repositoryId: number): void {
  const payload = event.client_payload;
  const action = String(payload?.action ?? '');
  const sourceEvent = String(payload?.source_event ?? (
    ['resolved', 'unresolved'].includes(action) ? 'pull_request_review_thread' : ''
  ));
  if (!reviewSignalActions[sourceEvent]?.includes(action)) {
    throw new Error('Repository dispatch is not a supported review signal');
  }
  if (!String(payload?.delivery_id ?? '').trim()) throw new Error('Repository dispatch is missing a delivery ID');
  if (positiveInteger(payload?.repository_id) !== repositoryId) {
    throw new Error('Repository dispatch repository ID does not match current metadata');
  }
}

export function graphqlApiBase(restApiUrl: string): string {
  const url = new URL(restApiUrl);
  if (/\/api\/v3\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/v3\/?$/, '');
  else url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function readEvent(path: string): Promise<GitHubEventPayload> {
  if (!path.trim()) throw new Error('Steward operation requires an explicit event path');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read GitHub event payload: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GitHub event payload must be a JSON object');
  }
  return parsed as GitHubEventPayload;
}

export async function createOperationContext(input: {
  inputs: StewardActionInputs;
  environment: StewardRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
  pullState?: 'open' | 'closed';
}): Promise<StewardOperationContext> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('Steward operation requires an explicit GitHub token');
  const eventPath = input.inputs.eventPath?.trim() || input.environment.GITHUB_EVENT_PATH?.trim() || '';
  const event = await readEvent(eventPath);
  const eventName = input.environment.GITHUB_EVENT_NAME?.trim() || '';
  const trustedRun = eventName === 'workflow_run' ? trustedWorkflowRunContext(event.workflow_run) : null;
  if (eventName === 'workflow_run' && !trustedRun) throw new Error('Workflow run is not a trusted PR signal');
  const fullName = String(event.repository?.full_name ?? '').trim();
  const [owner, repository, extra] = fullName.split('/');
  if (!owner || !repository || extra) throw new Error('GitHub event payload has an invalid repository full name');
  const eventRepositoryId = positiveInteger(event.repository?.id ?? event.client_payload?.repository_id);
  if (!eventRepositoryId) throw new Error('GitHub event payload has an invalid repository ID');

  const restApiUrl = input.environment.GITHUB_API_URL?.trim() || 'https://api.github.com/';
  const transportOptions = input.fetch ? { fetch: input.fetch } : {};
  const createClient = (clientToken: string) => new GitHubRepositoryClient(
    createGitHubRestTransport({ token: clientToken, baseUrl: restApiUrl, ...transportOptions }),
    createGitHubRestTransport({ token: clientToken, baseUrl: graphqlApiBase(restApiUrl), ...transportOptions }),
  );
  const client = createClient(token);
  const mutationToken = input.inputs.mutationToken?.trim() ?? '';
  const mutationClient = mutationToken ? createClient(mutationToken) : undefined;
  const metadata = await client.getRepository(owner, repository);
  if (metadata.id !== eventRepositoryId || metadata.fullName.toLowerCase() !== fullName.toLowerCase()) {
    throw new Error('GitHub event repository does not match current repository metadata');
  }
  if (!metadata.defaultBranch) throw new Error('GitHub repository has no default branch');
  const manifest = await loadDefaultBranchManifest(client, owner, repository);
  const resolvedPullNumber = trustedRun?.prNumber ?? resolvePullNumber(event, input.inputs.prNumber);
  const pull = await client.getPullRequest(owner, repository, resolvedPullNumber);
  if (pull.number !== resolvedPullNumber) throw new Error('GitHub returned a different pull request number');
  const pullState = input.pullState ?? 'open';
  if (pull.state !== pullState) {
    throw new PullRequestStateMismatchError(pull.number, pullState, String(pull.state ?? 'unknown'));
  }
  if (pull.base.ref !== metadata.defaultBranch) throw new Error('Pull request does not target the current default branch');
  if (!/^[a-f0-9]{40}$/i.test(pull.head.sha)) throw new Error('GitHub returned an invalid pull request head SHA');
  if (pullState === 'closed') {
    const eventPull = event.pull_request;
    if (!eventPull || eventName !== 'pull_request_target' || event.action !== 'closed') {
      throw new Error('Closed pull request operations require a pull_request_target closed event');
    }
    if (eventPull.merged !== pull.merged) {
      throw new Error('Closed pull request event merged state does not match live metadata');
    }
    const eventMergeSha = String(eventPull.merge_commit_sha ?? '').toLowerCase();
    const liveMergeSha = String(pull.merge_commit_sha ?? '').toLowerCase();
    if (pull.merged && (!/^[a-f0-9]{40}$/.test(eventMergeSha) || eventMergeSha !== liveMergeSha)) {
      throw new Error('Closed pull request event merge commit does not match live metadata');
    }
  }
  const expectedHead = trustedRun?.headSha ?? resolveExpectedHead(event, input.inputs.headSha);
  if (eventName === 'repository_dispatch') {
    validateRepositoryDispatch(event, metadata.id);
  }
  if (expectedHead && !/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('Trusted event has an invalid expected head SHA');
  if (expectedHead && pull.head.sha.toLowerCase() !== expectedHead) {
    throw new Error('Pull request head does not match the trusted event or manual input');
  }
  const serverUrl = input.environment.GITHUB_SERVER_URL?.replace(/\/$/, '') || 'https://github.com';
  const runId = input.environment.GITHUB_RUN_ID?.trim();
  return {
    owner,
    repository,
    repositoryId: metadata.id,
    defaultBranch: metadata.defaultBranch,
    eventName,
    event,
    pull,
    manifest,
    client,
    ...(mutationClient ? { mutationClient } : {}),
    ...(runId ? { detailsUrl: `${serverUrl}/${fullName}/actions/runs/${runId}` } : {}),
  };
}
