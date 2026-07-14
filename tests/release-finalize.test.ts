import { describe, expect, it, vi } from 'vitest';
import { finalizeReleaseFailure } from '../action/src/release-finalize.js';

describe('Release workflow failure finalizer', () => {
  it('writes a failure Check only after revalidating trusted merged-PR facts', async () => {
    const requests: { path: string; method: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(request)).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, method, ...(body === undefined ? {} : { body }) });
      if (path === '/repos/splrad/steward') return new Response(JSON.stringify({
        id: 1296724484, full_name: 'splrad/steward', default_branch: 'main',
      }));
      if (path.endsWith('/pulls/7')) return new Response(JSON.stringify({ number: 7, state: 'closed', merged: true,
        base: { ref: 'main' }, head: { sha: 'c'.repeat(40) } }));
      if (path === '/graphql') return new Response(JSON.stringify({ data: { repository: { pullRequest: {
        state: 'MERGED', merged: true, mergeCommit: { oid: 'e'.repeat(40) },
      } } } }));
      if (path.endsWith('/check-runs')) return new Response(JSON.stringify({ id: 12 }));
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    await expect(finalizeReleaseFailure({
      inputs: { operation: 'release-finalize', token: 'token',
        eventPath: 'tests/fixtures/action-release-event.json', releaseFailureSummary: 'Release preflight failed.' },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'pull_request_target' },
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow('Release preflight failed.');
    expect(requests.at(-1)).toMatchObject({ path: '/repos/splrad/steward/check-runs', method: 'POST',
      body: { name: 'Release', head_sha: 'e'.repeat(40), status: 'completed', conclusion: 'failure' } });
  });

  it('rejects mismatched trusted-event merge facts before writing a Check', async () => {
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      if (path === '/repos/splrad/steward') return new Response(JSON.stringify({
        id: 1296724484, full_name: 'splrad/steward', default_branch: 'main',
      }));
      if (path.endsWith('/pulls/7')) return new Response(JSON.stringify({ number: 7, state: 'closed', merged: true,
        base: { ref: 'main' }, head: { sha: 'c'.repeat(40) } }));
      if (path === '/graphql') return new Response(JSON.stringify({ data: { repository: { pullRequest: {
        state: 'MERGED', merged: true, mergeCommit: { oid: 'f'.repeat(40) },
      } } } }));
      return new Response(JSON.stringify({ id: 12 }));
    });
    await expect(finalizeReleaseFailure({
      inputs: { operation: 'release-finalize', token: 'token', eventPath: 'tests/fixtures/action-release-event.json' },
      environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_EVENT_NAME: 'pull_request' },
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow('merge facts do not match');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
