import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleWebhook, refreshWorkflowContractChecks, ValidationCoordinator, type Env } from '../src/index.js';
import { legacyValidationRetired } from '../src/validation-retirement.js';
import { GitHubClient, dispatchWorkflow } from '../../github/src/index.js';
import { PullRequestBodyWriteIntentStore } from '../src/pr-body-write-intents.js';

vi.mock('../../github/src/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../github/src/index.js')>(),
  createInstallationToken: vi.fn(async () => 'test-token'),
  dispatchWorkflow: vi.fn(async () => undefined),
}));
vi.mock('../src/workflow-evaluator.js', () => ({
  evaluatorSha: () => 'b'.repeat(40),
  trustedContractAuthorities: vi.fn(async () => ({ repositories: {} })),
}));

const targets = [
  [1187527897, 'splrad/LayerScape', 'main'],
  [1296724484, 'splrad/steward', 'main'],
  [1296725317, 'splrad/.github', 'main'],
  [1440689456, 'splrad/steward-e08-controller', 'e08-channel-trunk'],
  [1440689534, 'splrad/steward-e08-product', 'main'],
  [1440689606, 'splrad/steward-e08-bootstrap', 'main'],
  [1447987054, 'splrad/steward-settings', 'main'],
  [1448797077, 'splrad/steward-e10-lifecycle-20261107', 'main'],
] as const;
const repositories = targets.map(([id, full_name, default_branch]) => ({ id, full_name, default_branch, owner: { id: 302208797 }, private: false }));
const env = (): Env => ({
  LEGACY_RELEASE_RETIRED: 'true', LEGACY_VALIDATION_RETIRED: 'true',
  ORGANIZATION_ID: '302208797', ORGANIZATION_LOGIN: 'splrad', APP_ID: '4243096', INSTALLATION_ID: '145952003',
  STEWARDSHIP_REPOSITORY: 'splrad/steward', POLICY_SHA: 'a'.repeat(40), WORKFLOW_EVALUATOR_SHA: 'b'.repeat(40),
  STEWARD_APP_PRIVATE_KEY: 'mocked', STEWARD_WEBHOOK_SECRET: 'test-secret',
});
const pull = (branch = 'main', id = 1296724484) => ({ number: 7, state: 'open', base: { ref: branch, repo: { id } }, head: { sha: 'c'.repeat(40), ref: 'feature', repo: { id } } });
const repositoryFor = (owner: string, name: string) => repositories.find(r => r.full_name === `${owner}/${name}`)!;
const request = (event: string, payload: object) => {
  const body = JSON.stringify({ organization: { id: 302208797 }, installation: { id: 145952003 }, ...payload });
  return new Request('https://runtime.test/github/webhook', { method: 'POST', body, headers: {
    'x-github-event': event, 'x-github-delivery': 'fixture',
    'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`,
  } });
};
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
  vi.spyOn(GitHubClient.prototype, 'getRepositoryById').mockImplementation(async id => repositories.find(r => r.id === id) ?? { id, full_name: 'splrad/unknown', default_branch: 'main', owner: { id: 302208797 } });
  vi.spyOn(GitHubClient.prototype, 'listOpenPullRequests').mockImplementation(async (owner, name) => {
    const r = repositoryFor(owner, name); return r ? [pull(r.default_branch, r.id)] : [];
  });
  vi.spyOn(GitHubClient.prototype, 'listInstallationRepositories').mockResolvedValue(repositories);
  vi.spyOn(GitHubClient.prototype, 'getPullRequest').mockImplementation(async (owner, name) => {
    const r = repositoryFor(owner, name); return pull(r.default_branch, r.id);
  });
  vi.spyOn(GitHubClient.prototype, 'listAllCheckRuns').mockResolvedValue([]);
  vi.spyOn(GitHubClient.prototype, 'createCheckRun').mockResolvedValue({});
  vi.spyOn(GitHubClient.prototype, 'updateCheckRun').mockResolvedValue({});
  vi.spyOn(GitHubClient.prototype, 'listPullsForCommit').mockImplementation(async (owner, name) => {
    const r = repositoryFor(owner, name); return [pull(r.default_branch, r.id)];
  });
  vi.spyOn(GitHubClient.prototype, 'getWorkflowRun').mockImplementation(async (owner, name) => {
    const repository = repositoryFor(owner, name);
    return { id: 10, workflow_id: 20, run_attempt: 1, repository, head_repository: repository,
      name: 'SPLRAD Steward / PR Validation', path: '.github/workflows/pr-validation.yml', event: 'pull_request',
      status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40), head_branch: 'feature', pull_requests: [{ number: 7 }],
      workflow_url: `https://api.github.com/repos/${owner}/${name}/actions/required_workflows/20`, html_url: 'https://github.com/example' };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const noGateWrites = () => {
  expect(GitHubClient.prototype.createCheckRun).not.toHaveBeenCalled();
  expect(GitHubClient.prototype.updateCheckRun).not.toHaveBeenCalled();
};

describe('exact legacy Gate consumer retirement', () => {
  it.each(repositories)('blocks queued DO producers for $full_name/$default_branch', async repository => {
    const coordinator = new ValidationCoordinator({} as DurableObjectState, env());
    for (const operation of ['pending', 'run', 'refresh']) {
      const response = await coordinator.fetch(new Request('https://validation.internal/', { method: 'POST', body: JSON.stringify({
        operation, repository, repositoryId: repository.id, pullNumber: 7, pull: pull(repository.default_branch, repository.id), workflowRunId: 10,
      }) }));
      expect(response.status).toBe(200);
    }
    noGateWrites();
    expect(GitHubClient.prototype.getWorkflowRun).toHaveBeenCalled();
    expect(GitHubClient.prototype.listAllCheckRuns).not.toHaveBeenCalled();
  });

  it.each(['opened', 'synchronize', 'reopened', 'edited'])('keeps classification while retiring PR %s Gate with evaluator absent', async action => {
    const repository = repositories[1]!;
    expect((await handleWebhook(request('pull_request', { action, repository, pull_request: pull() }), { ...env(), WORKFLOW_EVALUATOR_SHA: undefined })).status).toBe(202);
    expect(dispatchWorkflow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workflow: 'pr-classification.yml' }));
    noGateWrites();
  });

  it.each(['submitted', 'edited', 'dismissed'])('retires review %s refresh', async action => {
    expect((await handleWebhook(request('pull_request_review', { action, repository: repositories[1], pull_request: pull() }), env())).status).toBe(202);
    noGateWrites();
  });
  it.each(['requested', 'in_progress', 'completed'])('retires workflow_run %s producer', async action => {
    expect((await handleWebhook(request('workflow_run', { action, repository: repositories[1], workflow_run: { id: 10 } }), env())).status).toBe(204);
    noGateWrites();
    expect(GitHubClient.prototype.getWorkflowRun).toHaveBeenCalled();
  });

  it('keeps scheduled recovery running without known-default Gate writes', async () => {
    const environment = env();
    environment.ISSUE_SNAPSHOTS = {} as D1Database;
    vi.spyOn(PullRequestBodyWriteIntentStore.prototype, 'retireUnsupportedAutomation').mockResolvedValue(0);
    vi.spyOn(PullRequestBodyWriteIntentStore.prototype, 'blockExpired').mockResolvedValue(0);
    vi.spyOn(PullRequestBodyWriteIntentStore.prototype, 'listRecoverable').mockResolvedValue([]);
    vi.spyOn(PullRequestBodyWriteIntentStore.prototype, 'listPendingRedrives').mockResolvedValue([{
      regionKind: 'managed-pr', repositoryId: 1296724484, pullRequestNumber: 7, writeId: 'intent',
      redrive: { workflow: 'onboard-repository.yml', inputs: { deliveryId: 'old', policySha: 'old' } },
    } as any]);
    vi.spyOn(PullRequestBodyWriteIntentStore.prototype, 'claimRedrive').mockResolvedValue(true);
    const coordinator = new ValidationCoordinator({} as DurableObjectState, environment);
    environment.VALIDATION_COORDINATOR = { idFromName: (id: string) => id, get: () => ({ fetch: (url: string, init: RequestInit) => coordinator.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;
    await worker.scheduled({ scheduledTime: 0 } as ScheduledController, environment);
    noGateWrites();
    expect(GitHubClient.prototype.listInstallationRepositories).toHaveBeenCalled();
    expect(dispatchWorkflow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workflow: 'onboard-repository.yml', inputs: { deliveryId: 'body-write-recovery:intent', policySha: environment.POLICY_SHA },
    }));
  });

  it('preserves unknown repositories, changed defaults, other branches and absent switch', async () => {
    const repository = repositories[1]!;
    for (const retained of [
      { ...repository, id: 987654321 }, { ...repository, full_name: 'splrad/renamed' }, { ...repository, default_branch: 'next' },
    ]) expect(legacyValidationRetired(env(), retained, retained.default_branch)).toBe(false);
    expect(legacyValidationRetired(env(), repository, 'release')).toBe(false);
    expect(legacyValidationRetired({}, repository, 'main')).toBe(false);
    expect(legacyValidationRetired({ LEGACY_VALIDATION_RETIRED: 'false' }, repository, 'main')).toBe(false);
    const coordinator = new ValidationCoordinator({} as DurableObjectState, env());
    const unknown = { ...repository, id: 987654321 };
    await coordinator.fetch(new Request('https://validation.internal/', { method: 'POST', body: JSON.stringify({ operation: 'pending', repository: unknown, pull: pull() }) }));
    expect(GitHubClient.prototype.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({ name: 'PR Validation Gate' }));
  });

  it('retains refresh for a changed default and preserves the release barrier', async () => {
    vi.mocked(GitHubClient.prototype.getRepositoryById).mockResolvedValue({ ...repositories[1]!, default_branch: 'next' });
    await refreshWorkflowContractChecks(env(), repositories[1]!.id);
    expect(GitHubClient.prototype.listOpenPullRequests).toHaveBeenCalledWith('splrad', 'steward', 'next');
    const response = await worker.fetch(new Request('https://runtime.test/internal/releases/1187527897/v1.2.3/permit'), env());
    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['other-base', 'missing-base', 'missing-event-repository', 'conflicting-live-base', 'missing-live-repository'])('keeps historical pending behavior for %s', async kind => {
    const repository = repositories[1]!;
    const incoming: any = pull(kind === 'other-base' ? 'release' : 'main');
    if (kind === 'missing-base') delete incoming.base;
    if (kind === 'missing-event-repository') delete incoming.base.repo;
    const current: any = pull(kind === 'conflicting-live-base' ? 'release' : 'main');
    if (kind === 'missing-live-repository') delete current.base.repo;
    vi.mocked(GitHubClient.prototype.getPullRequest).mockResolvedValue(current);
    const coordinator = new ValidationCoordinator({} as DurableObjectState, env());
    await coordinator.fetch(new Request('https://validation.internal/', { method: 'POST', body: JSON.stringify({ operation: 'pending', repository, pull: incoming }) }));
    expect(GitHubClient.prototype.createCheckRun).toHaveBeenCalledWith('splrad', 'steward', expect.objectContaining({ name: 'PR Validation Gate' }));
  });
});
