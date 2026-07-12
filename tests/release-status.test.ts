import { describe, expect, it, vi } from 'vitest';
import { readReleaseStatus } from '../action/src/release-status.js';

const mergeSha = '0123456789012345678901234567890123456789';
const context = JSON.stringify({
  contractVersion: 1,
  repository: { id: 1296725030, fullName: 'splrad/steward-sandbox' },
  pullRequest: { number: 14, mergeSha },
});
const plan = JSON.stringify({
  contractVersion: 1,
  displayVersion: '1.2.3',
  buildId: '1.2.3+0123456',
  tagName: 'v1.2.3',
  releaseTitle: 'Fixture v1.2.3',
});

describe('Release publication status', () => {
  it('does not mistake a same-named branch for a tag and plans the build when publication is absent', async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      paths.push(path);
      if (path === '/repos/splrad/steward-sandbox') {
        return new Response(JSON.stringify({
          id: 1296725030, full_name: 'splrad/steward-sandbox', default_branch: 'main',
        }));
      }
      if (path.endsWith('/git/ref/tags/v1.2.3')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (path.endsWith('/releases')) return new Response(JSON.stringify([]));
      if (path.endsWith('/commits/v1.2.3')) return new Response(JSON.stringify({ sha: mergeSha }));
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    await expect(readReleaseStatus({
      inputs: { operation: 'release-status', token: 'token', releaseContext: context, releasePlan: plan },
      environment: { GITHUB_API_URL: 'https://api.github.com/' },
      fetch: fetchMock as unknown as typeof fetch,
    })).resolves.toMatchObject({ decision: { state: 'planned', reason: 'release-available' } });
    expect(paths).not.toContain('/repos/splrad/steward-sandbox/commits/v1.2.3');
  });

  it('skips an existing published Release only when its real tag resolves to the merge commit', async () => {
    let resolvedSha = mergeSha;
    let releaseExists = true;
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      if (path === '/repos/splrad/steward-sandbox') {
        return new Response(JSON.stringify({
          id: 1296725030, full_name: 'splrad/steward-sandbox', default_branch: 'main',
        }));
      }
      if (path.endsWith('/git/ref/tags/v1.2.3')) {
        return new Response(JSON.stringify({
          ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: resolvedSha },
        }));
      }
      if (path.endsWith('/commits/v1.2.3')) return new Response(JSON.stringify({ sha: resolvedSha }));
      if (path.endsWith('/releases')) {
        return releaseExists
          ? new Response(JSON.stringify([{ id: 7, tag_name: 'v1.2.3', draft: false }]))
          : new Response(JSON.stringify([]));
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    const status = () => readReleaseStatus({
      inputs: { operation: 'release-status', token: 'token', releaseContext: context, releasePlan: plan },
      environment: { GITHUB_API_URL: 'https://api.github.com/' },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(status()).resolves.toMatchObject({
      decision: { state: 'ignored', reason: 'already-published' },
      release: { id: 7, tag_name: 'v1.2.3' },
    });
    resolvedSha = 'f'.repeat(40);
    await expect(status()).rejects.toThrow('does not target the merged pull request commit');
    resolvedSha = mergeSha;
    releaseExists = false;
    await expect(status()).rejects.toThrow('incomplete existing tag/Release pair');
  });

  it('detects an unpublished draft even when no tag ref exists', async () => {
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const path = new URL(String(request)).pathname;
      if (path === '/repos/splrad/steward-sandbox') {
        return new Response(JSON.stringify({
          id: 1296725030, full_name: 'splrad/steward-sandbox', default_branch: 'main',
        }));
      }
      if (path.endsWith('/git/ref/tags/v1.2.3')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (path.endsWith('/releases')) {
        return new Response(JSON.stringify([{ id: 8, tag_name: 'v1.2.3', draft: true }]));
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    await expect(readReleaseStatus({
      inputs: { operation: 'release-status', token: 'token', releaseContext: context, releasePlan: plan },
      environment: { GITHUB_API_URL: 'https://api.github.com/' },
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow('incomplete existing tag/Release pair');
  });
});
