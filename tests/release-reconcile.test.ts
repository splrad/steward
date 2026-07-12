import { describe, expect, it, vi } from 'vitest';
import { reconcilePublishedRelease } from '../action/src/release-reconcile.js';

const mergeSha = '0123456789012345678901234567890123456789';
const context = JSON.stringify({ contractVersion: 1,
  repository: { id: 1296725030, fullName: 'splrad/steward-sandbox' },
  pullRequest: { number: 14, mergeSha } });
const plan = JSON.stringify({ contractVersion: 1, displayVersion: '0.1.0', buildId: '0.1.0+0123456',
  tagName: 'sandbox-v0.1.0', releaseTitle: 'Steward Sandbox v0.1.0' });
const manifest = {
  schemaVersion: 1,
  automation: { githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
    maintainers: { source: 'users', logins: ['core'] }, language: 'zh-CN' },
  features: { prAutomation: false, classification: false, dcoAdvisory: false, governance: false,
    copilotReview: false, release: true, webhookRelay: false },
  release: { triggerPaths: ['release/version.json'], runner: 'ubuntu-latest',
    adapterCommand: ['node', '.github/steward/release.mjs'] },
};

describe('Release publication reconciliation', () => {
  it('creates one stable success Check and updates the same Check on repeated recovery', async () => {
    const checks: Record<string, unknown>[] = [];
    const requests: { method: string; path: string }[] = [];
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(request));
      const method = init?.method ?? 'GET';
      requests.push({ method, path: url.pathname });
      if (url.pathname === '/repos/splrad/steward-sandbox') return new Response(JSON.stringify({
        id: 1296725030, full_name: 'splrad/steward-sandbox', default_branch: 'main',
      }));
      if (url.pathname.endsWith('/contents/.github/steward.json')) return new Response(JSON.stringify({
        type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64'), sha: 'blob',
      }));
      if (url.pathname.endsWith('/git/ref/tags/sandbox-v0.1.0')) return new Response(JSON.stringify({
        ref: 'refs/tags/sandbox-v0.1.0', object: { type: 'commit', sha: mergeSha },
      }));
      if (url.pathname.endsWith('/commits/sandbox-v0.1.0')) return new Response(JSON.stringify({ sha: mergeSha }));
      if (url.pathname.endsWith('/releases')) return new Response(JSON.stringify([{
        id: 7, tag_name: 'sandbox-v0.1.0', draft: false, html_url: 'https://github.com/release',
      }]));
      if (url.pathname.endsWith(`/commits/${mergeSha}/check-runs`)) {
        return new Response(JSON.stringify({ check_runs: checks }));
      }
      if (url.pathname.endsWith('/check-runs') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const created = { id: 21, name: body.name, status: body.status, conclusion: body.conclusion,
          external_id: body.external_id, app: { slug: 'splrad-steward' } };
        checks.push(created);
        return new Response(JSON.stringify(created));
      }
      if (url.pathname.endsWith('/check-runs/21') && method === 'PATCH') {
        return new Response(JSON.stringify({ ...checks[0], id: 21 }));
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    const execute = () => reconcilePublishedRelease({
      inputs: { operation: 'release-reconcile', token: 'token', releaseContext: context, releasePlan: plan },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_RUN_ID: '42' },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(execute()).resolves.toEqual({ state: 'passed', summary: 'Existing Release publication reconciled',
      releaseUrl: 'https://github.com/release' });
    await expect(execute()).resolves.toMatchObject({ state: 'passed' });
    expect(requests.filter((request) => request.method === 'POST' && request.path.endsWith('/check-runs'))).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/check-runs/21'))).toHaveLength(1);
  });
});
