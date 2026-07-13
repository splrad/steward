import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(() => 'version'),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
}));

const { run, STEWARD_VERSION } = await import('../action/src/main.js');

const encodedManifest = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  automation: {
    githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
    maintainers: { source: 'users', logins: ['core'] },
    language: 'zh-CN',
  },
  features: {
    prAutomation: false,
    classification: false,
    dcoAdvisory: false,
    governance: false,
    copilotReview: false,
    release: false,
    webhookRelay: false,
  },
})).toString('base64');

const closedPullRequestFetch = vi.fn(async (request: string | URL | Request) => {
  const path = new URL(String(request)).pathname;
  if (path === '/repos/splrad/steward') {
    return new Response(JSON.stringify({ id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' }));
  }
  if (path === '/repos/splrad/steward/contents/.github/steward.json') {
    return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: encodedManifest, sha: 'blob' }));
  }
  if (path === '/repos/splrad/steward/pulls/7') {
    return new Response(JSON.stringify({
      number: 7,
      state: 'closed',
      base: { ref: 'main', sha: 'b'.repeat(40) },
      head: { ref: 'dependabot/stale', sha: 'c'.repeat(40) },
    }));
  }
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
});

describe('Steward Action bootstrap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports its bundled version', async () => {
    const core = await import('@actions/core');
    await run({ operation: 'version' });
    expect(core.setOutput).toHaveBeenCalledWith('steward-version', STEWARD_VERSION);
  });

  it('rejects operations that are not implemented', async () => {
    await expect(run({ operation: 'governance' })).rejects.toThrow('Unsupported Steward operation: governance');
  });

  it('requires a separate mutation token before a human review operation loads context', async () => {
    await expect(run({ operation: 'governance-request-copilot', token: 'platform-token' }))
      .rejects.toThrow('requires an explicit mutation token');
  });

  it('requires an isolated runner temporary directory for Release adapter execution', async () => {
    await expect(run({
      operation: 'release-adapter',
      releaseWorkspace: process.cwd(),
      releaseAdapterCommand: '[]',
      releaseContext: '{}',
    }, {})).rejects.toThrow('requires RUNNER_TEMP');
  });

  it.each([
    ['pull_request_target', 'tests/fixtures/action-event.json'],
    ['workflow_run', 'tests/fixtures/action-workflow-run-event.json'],
  ])('ignores a stale %s signal after its pull request closes', async (eventName, eventPath) => {
    const core = await import('@actions/core');
    await run(
      { operation: 'classification', token: 'platform-token', eventPath },
      { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: eventName },
      closedPullRequestFetch as unknown as typeof fetch,
    );
    expect(core.setOutput).toHaveBeenCalledWith('state', 'ignored');
    expect(core.setOutput).toHaveBeenCalledWith('operation-result', expect.stringContaining('pull-request-closed'));
  });

  it('still rejects a manual dispatch targeting a closed pull request', async () => {
    await expect(run(
      {
        operation: 'classification',
        token: 'platform-token',
        eventPath: 'tests/fixtures/action-event.json',
      },
      { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'workflow_dispatch' },
      closedPullRequestFetch as unknown as typeof fetch,
    )).rejects.toThrow('only accepts an open pull request');
  });
});
