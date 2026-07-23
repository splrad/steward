import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  inspectAppInstallation,
  runAppInstallationPreflight,
  type AppInstallationOptions,
} from '../packages/cli/src/app-installation.js';
import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../packages/github/src/index.js';
import { parseInitSpec } from '../packages/cli/src/init.js';

const rawSpec = JSON.parse(await readFile(
  new URL('./fixtures/cli/init-minimal.json', import.meta.url),
  'utf8',
)) as unknown;
const manifest = parseInitSpec(rawSpec).manifest;
const installation = {
  id: 145952003,
  app_id: 4243096,
  app_slug: 'splrad-steward',
  client_id: 'Iv23liuSr0qd4WLJdZhH',
  repository_selection: 'selected',
  suspended_at: null,
  html_url: 'https://github.com/organizations/splrad/settings/installations/145952003',
  account: { login: 'splrad', type: 'Organization' },
  permissions: {
    checks: 'write', contents: 'read', pull_requests: 'write', metadata: 'read',
  },
};

function setup(overrides: Partial<Record<string, unknown>> = {}): { transport: GitHubTransport; requests: GitHubRequest[] } {
  const requests: GitHubRequest[] = [];
  const handler = (request: GitHubRequest): unknown => {
    if (request.path in overrides) {
      const value = overrides[request.path];
      if (value instanceof Error) throw value;
      return value;
    }
    if (request.path === '/repos/splrad/example') {
      return { id: 7, full_name: 'splrad/example', owner: { login: 'splrad', type: 'Organization' } };
    }
    if (request.path === '/orgs/splrad/installations') return { installations: [installation] };
    if (request.path === '/user/installations/145952003/repositories') {
      return { repositories: [{ id: 7, full_name: 'splrad/example' }] };
    }
    throw new Error(`Unexpected request: ${request.path}`);
  };
  return {
    requests,
    transport: { async request<T>(request: GitHubRequest) { requests.push(request); return handler(request) as T; } },
  };
}

function options(overrides: Partial<AppInstallationOptions> = {}): AppInstallationOptions {
  return {
    owner: 'splrad', repository: 'example', repositoryId: 7,
    ownerLogin: 'splrad', ownerType: 'Organization', manifest,
    ...overrides,
  };
}

describe('GitHub App init preflight', () => {
  it('accepts a selected installation only when the target repository is present', async () => {
    const current = setup();
    const report = await runAppInstallationPreflight(current.transport, {
      owner: 'splrad', repository: 'example', manifest,
    });
    expect(report).toMatchObject({ status: 'installed', reason: 'installed', installationId: 145952003, appId: 4243096 });
    expect(current.requests.map((request) => request.path)).toEqual([
      '/repos/splrad/example',
      '/orgs/splrad/installations',
      '/user/installations/145952003/repositories',
    ]);
    expect(current.requests.every((request) => !request.method || request.method === 'GET')).toBe(true);
  });

  it('falls back to user installations for an App user token and filters the target account', async () => {
    const organizationPath = '/orgs/splrad/installations';
    const current = setup({
      [organizationPath]: new GitHubApiError({ status: 403, method: 'GET', path: organizationPath, message: 'Forbidden' }),
      '/user/installations': { installations: [
        { ...installation, id: 1, account: { login: 'another-org', type: 'Organization' } },
        installation,
      ] },
    });
    const report = await inspectAppInstallation(current.transport, options());
    expect(report).toMatchObject({ status: 'installed', installationId: 145952003, appId: 4243096 });
    expect(current.requests.map((request) => request.path)).toEqual([
      '/orgs/splrad/installations',
      '/user/installations',
      '/user/installations/145952003/repositories',
    ]);
  });

  it('does not accept another account installation from the App user fallback', async () => {
    const organizationPath = '/orgs/splrad/installations';
    const current = setup({
      [organizationPath]: new GitHubApiError({ status: 403, method: 'GET', path: organizationPath, message: 'Forbidden' }),
      '/user/installations': { installations: [
        { ...installation, account: { login: 'another-org', type: 'Organization' } },
      ] },
    });
    expect(await inspectAppInstallation(current.transport, options())).toMatchObject({
      status: 'action-required', reason: 'account-installation-missing',
    });
  });

  it('stops at the existing installation configuration URL when the repository is not selected', async () => {
    const current = setup({ '/user/installations/145952003/repositories': { repositories: [] } });
    const report = await inspectAppInstallation(current.transport, options());
    expect(report).toMatchObject({
      status: 'action-required', reason: 'repository-not-selected',
      actionUrl: installation.html_url,
    });
  });

  it('uses the new-install URL only when the account has no matching installation', async () => {
    const current = setup({ '/orgs/splrad/installations': { installations: [] } });
    const report = await inspectAppInstallation(current.transport, options());
    expect(report).toMatchObject({
      status: 'action-required', reason: 'account-installation-missing',
      actionUrl: 'https://github.com/apps/splrad-steward/installations/new',
    });
  });

  it('stops for suspended and under-permissioned installations', async () => {
    const suspended = setup({
      '/orgs/splrad/installations': { installations: [{ ...installation, suspended_at: '2026-07-12T00:00:00Z' }] },
    });
    expect(await inspectAppInstallation(suspended.transport, options()))
      .toMatchObject({ status: 'action-required', reason: 'installation-suspended', actionUrl: installation.html_url });

    const relayManifest = structuredClone(manifest);
    relayManifest.features.webhookRelay = true;
    const insufficient = setup();
    expect(await inspectAppInstallation(insufficient.transport, options({ manifest: relayManifest })))
      .toMatchObject({ status: 'action-required', reason: 'permissions-missing', missingPermissions: ['contents:write'] });
  });

  it.each([
    ['missing', (() => {
      const value: Record<string, unknown> = { ...installation };
      delete value.suspended_at;
      return value;
    })()],
    ['undefined', { ...installation, suspended_at: undefined }],
    ['empty string', { ...installation, suspended_at: '' }],
    ['number', { ...installation, suspended_at: 0 }],
    ['boolean', { ...installation, suspended_at: false }],
    ['object', { ...installation, suspended_at: {} }],
  ])('treats an unverifiable suspended_at value (%s) as unknown', async (_label, candidate) => {
    const current = setup({ '/orgs/splrad/installations': { installations: [candidate] } });
    const report = await inspectAppInstallation(current.transport, options());

    expect(report).toMatchObject({ status: 'unknown', reason: 'verification-unavailable' });
    expect(report.summary).toContain('安装暂停状态不可验证');
    expect(current.requests.map((request) => request.path)).toEqual(['/orgs/splrad/installations']);
  });

  it('does not confuse unverifiable selected scope with a missing installation', async () => {
    const path = '/user/installations/145952003/repositories';
    const current = setup({
      [path]: new GitHubApiError({ status: 403, method: 'GET', path, message: 'Requires read:user' }),
    });
    const report = await inspectAppInstallation(current.transport, options());
    expect(report).toMatchObject({ status: 'unknown', reason: 'verification-unavailable' });
    expect(report.summary).toContain('只接受 GitHub App user access token');
    expect(report.actionUrl).toBeUndefined();
  });

  it('reports the required token type when neither organization nor user installations are readable', async () => {
    const organizationPath = '/orgs/splrad/installations';
    const userPath = '/user/installations';
    const current = setup({
      [organizationPath]: new GitHubApiError({ status: 403, method: 'GET', path: organizationPath, message: 'Forbidden' }),
      [userPath]: new GitHubApiError({ status: 403, method: 'GET', path: userPath, message: 'Forbidden' }),
    });
    const report = await inspectAppInstallation(current.transport, options());
    expect(report).toMatchObject({ status: 'unknown', reason: 'verification-unavailable' });
    expect(report.summary).toContain('selected installation 必须使用 GitHub App user access token');
  });

  it('supports all-repository and personal-account installations without false repository probes', async () => {
    const all = setup({
      '/orgs/splrad/installations': { installations: [{ ...installation, repository_selection: 'all' }] },
    });
    expect(await inspectAppInstallation(all.transport, options())).toMatchObject({ status: 'installed' });
    expect(all.requests.map((request) => request.path)).toEqual(['/orgs/splrad/installations']);

    const personal = setup({
      '/user/installations': { installations: [
        { ...installation, id: 1, account: { login: 'someone-else', type: 'Organization' } },
        { ...installation, account: { login: 'splrad', type: 'User' } },
      ] },
    });
    expect(await inspectAppInstallation(personal.transport, options({ ownerLogin: 'splrad', ownerType: 'User' })))
      .toMatchObject({ status: 'installed' });
    expect(personal.requests[0]?.path).toBe('/user/installations');
  });
});
