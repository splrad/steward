import { describe, expect, it, vi } from 'vitest';
import type { StewardManifest } from '../packages/manifest/src/index.js';
import { automatePullRequest } from '../action/src/automation.js';

function automationManifest(enabled = true): StewardManifest {
  return {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'users', logins: ['core'] },
      language: 'zh-CN',
    },
    features: {
      prAutomation: enabled,
      classification: false,
      dcoAdvisory: false,
      governance: false,
      copilotReview: false,
      release: false,
      webhookRelay: false,
    },
  };
}

function response(payload: unknown, status = 200): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(options: {
  manifestEnabled?: boolean;
  liveHead?: string;
  openPull?: boolean;
  createRace?: boolean;
} = {}) {
  const mutations: Array<{ method: string; path: string; body: unknown }> = [];
  const manifest = automationManifest(options.manifestEnabled ?? true);
  const headSha = options.liveHead ?? 'c'.repeat(40);
  const existingPull = {
    number: 8,
    state: 'open',
    title: 'old title',
    body: '<!-- workflow:auto-summary:start -->\nold\n<!-- workflow:auto-summary:end -->',
    base: { ref: 'main' },
    head: { ref: 'feature/automation', sha: headSha },
  };
  let pullReads = 0;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(request));
    const path = decodeURIComponent(url.pathname);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') mutations.push({ method, path, body });
    if (path === '/repos/splrad/steward') {
      return response({ id: 1296724484, full_name: 'splrad/steward', default_branch: 'main' });
    }
    if (path === '/repos/splrad/steward/contents/.github/steward.json') {
      return response({
        type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64'), sha: 'manifest',
      });
    }
    if (path === '/repos/splrad/steward/git/ref/heads/feature/automation') {
      return response({ ref: 'refs/heads/feature/automation', object: { type: 'commit', sha: headSha } });
    }
    if (path === '/repos/splrad/steward/compare/main...feature/automation') {
      return response({
        status: 'ahead', ahead_by: 1, total_commits: 1,
        commits: [{
          sha: 'c'.repeat(40), author: { login: 'external-dev' },
          commit: { message: 'feat: 共享 PR 自动化', author: { name: 'External Dev', email: 'dev@example.test' } },
        }],
        files: [{ filename: 'src/index.ts', status: 'modified', additions: 4, deletions: 1 }],
      });
    }
    if (path === '/repos/splrad/steward/pulls' && method === 'GET') {
      pullReads += 1;
      return response(options.openPull || (options.createRace && pullReads > 1) ? [existingPull] : []);
    }
    if (path === '/repos/splrad/steward/contents/.github/pull_request_template.md') {
      return response({
        type: 'file', encoding: 'base64',
        content: Buffer.from('## 审查\n\n<!-- workflow:auto-summary:start -->等待<!-- workflow:auto-summary:end -->').toString('base64'),
      });
    }
    if (path === '/repos/splrad/steward/pulls' && method === 'POST') {
      if (options.createRace) return response({ message: 'A pull request already exists' }, 422);
      return response({ number: 9, state: 'open', ...body, head: { ref: 'feature/automation', sha: headSha }, base: { ref: 'main' } }, 201);
    }
    if (path === '/repos/splrad/steward/pulls/8' && method === 'PATCH') {
      return response({ ...existingPull, ...body });
    }
    if (path === '/repos/splrad/steward/issues/8/comments') {
      return response([
        { id: 10, user: { login: 'splrad-steward[bot]' }, body: '<!-- workflow:pr-created-notice -->\nold' },
        { id: 11, user: { login: 'external' }, body: '<!-- workflow:pr-created-notice -->\nkeep' },
      ]);
    }
    if (path === '/repos/splrad/steward/issues/9/comments' && method === 'POST') return response({ id: 12, body }, 201);
    if (path === '/repos/splrad/steward/issues/comments/10' && method === 'PATCH') return response({ id: 10, body });
    return response({ message: 'Not Found' }, 404);
  });
  return { fetcher, mutations };
}

const inputs = {
  operation: 'automation',
  token: 'token',
  eventPath: 'tests/fixtures/action-automation-push-event.json',
  sourceBranch: 'feature/automation',
  headSha: 'c'.repeat(40),
};
const environment = { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'push' };

describe('PR Automation Action operation', () => {
  it('creates one PR and one App-owned notification without checking out consumer code', async () => {
    const fixture = harness();
    const result = await automatePullRequest({ inputs, environment, fetch: fixture.fetcher });
    expect(result).toMatchObject({
      state: 'passed', details: { pullNumber: 9, pullAction: 'create', noticeAction: 'create' },
    });
    expect(fixture.mutations.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /repos/splrad/steward/pulls',
      'POST /repos/splrad/steward/issues/9/comments',
    ]);
    expect(fixture.mutations[0]?.body).toMatchObject({
      head: 'feature/automation', base: 'main', title: 'feat: 共享 PR 自动化',
    });
    expect(JSON.stringify(fixture.mutations)).toContain('workflow:source-actor:external-dev');
    expect(JSON.stringify(fixture.mutations)).toContain('PR 链接：#9');
  });

  it('updates a managed PR and only its App-owned notification', async () => {
    const fixture = harness({ openPull: true });
    const result = await automatePullRequest({ inputs, environment, fetch: fixture.fetcher });
    expect(result).toMatchObject({
      state: 'passed', details: { pullNumber: 8, pullAction: 'update', noticeAction: 'update' },
    });
    expect(fixture.mutations.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'PATCH /repos/splrad/steward/pulls/8',
      'PATCH /repos/splrad/steward/issues/comments/10',
    ]);
    expect(JSON.stringify(fixture.mutations)).not.toContain('issues/comments/11');
  });

  it('reconciles only a confirmed concurrent PR creation race', async () => {
    const fixture = harness({ createRace: true });
    const result = await automatePullRequest({ inputs, environment, fetch: fixture.fetcher });
    expect(result).toMatchObject({
      state: 'passed', details: { pullNumber: 8, pullAction: 'concurrent-create', noticeAction: 'none' },
    });
    expect(fixture.mutations.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /repos/splrad/steward/pulls',
      'PATCH /repos/splrad/steward/pulls/8',
    ]);
  });

  it('sends no mutations when default-branch Manifest disables Automation', async () => {
    const fixture = harness({ manifestEnabled: false });
    const result = await automatePullRequest({ inputs, environment, fetch: fixture.fetcher });
    expect(result).toMatchObject({ state: 'ignored' });
    expect(fixture.mutations).toEqual([]);
  });

  it('fails closed before mutation when live branch evidence differs from the push', async () => {
    const fixture = harness({ liveHead: 'd'.repeat(40) });
    await expect(automatePullRequest({ inputs, environment, fetch: fixture.fetcher }))
      .rejects.toThrow('live branch ref does not match');
    expect(fixture.mutations).toEqual([]);
  });

  it('recognizes bracketed GitHub bot logins and ignores them without branch or PR reads', async () => {
    const fixture = harness();
    const result = await automatePullRequest({
      inputs: {
        ...inputs,
        eventPath: 'tests/fixtures/action-automation-bot-push-event.json',
        sourceBranch: 'dependabot/npm_and_yarn/example',
        headSha: 'd'.repeat(40),
      },
      environment,
      fetch: fixture.fetcher,
    });
    expect(result).toMatchObject({ state: 'ignored', summary: 'Bot actor push ignored' });
    expect(fixture.mutations).toEqual([]);
    const paths = fixture.fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(paths.some((path) => path.includes('/git/ref/heads/'))).toBe(false);
    expect(paths.some((path) => path.includes('/compare/'))).toBe(false);
    expect(paths.some((path) => path.endsWith('/pulls'))).toBe(false);
  });

  it('rejects non-push and mismatched source identities before GitHub reads', async () => {
    const fixture = harness();
    await expect(automatePullRequest({ inputs, environment: { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' }, fetch: fixture.fetcher }))
      .rejects.toThrow('only accepts a push event');
    await expect(automatePullRequest({ inputs: { ...inputs, sourceBranch: 'other' }, environment, fetch: fixture.fetcher }))
      .rejects.toThrow('source branch does not match');
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
});
