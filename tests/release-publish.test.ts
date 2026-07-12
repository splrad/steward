import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishRelease } from '../action/src/release-publish.js';

const roots: string[] = [];
const mergeSha = '0123456789012345678901234567890123456789';
const context = JSON.stringify({ contractVersion: 1,
  repository: { id: 1296725030, fullName: 'splrad/steward-sandbox' },
  pullRequest: { number: 14, mergeSha } });
const plan = JSON.stringify({ contractVersion: 1, displayVersion: '1.2.3', buildId: '1.2.3+0123456',
  tagName: 'v1.2.3', releaseTitle: 'Fixture v1.2.3' });
const manifest = {
  schemaVersion: 1,
  automation: { githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
    maintainers: { source: 'users', logins: ['core'] }, language: 'zh-CN' },
  features: { prAutomation: false, classification: false, dcoAdvisory: false, governance: false,
    copilotReview: false, release: true, webhookRelay: false },
  release: { triggerPaths: ['release/version.txt'], runner: 'ubuntu-latest', adapterCommand: ['node', 'release.mjs'] },
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(
  uploadFails = false,
  alreadyPublished = false,
  publishResponseFails = false,
  publishedListLag = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'steward-publish-'));
  roots.push(root);
  const output = path.join(root, 'output');
  await mkdir(output);
  const bytes = Buffer.from('asset');
  await writeFile(path.join(output, 'asset.zip'), bytes);
  const assets = JSON.stringify({ contractVersion: 1, assets: [{ path: 'asset.zip', name: 'asset.zip',
    mediaType: 'application/zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] });
  let tag = alreadyPublished;
  let draft: boolean | undefined = alreadyPublished ? false : undefined;
  const requests: { method: string; path: string }[] = [];
  const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(request));
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    if (url.origin === 'https://uploads.github.com') {
      if (uploadFails) return new Response(JSON.stringify({ message: 'upstream failed' }), { status: 502 });
      return new Response(JSON.stringify({ id: 9, name: 'asset.zip', state: 'uploaded', size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }), { status: 201 });
    }
    if (url.pathname === '/repos/splrad/steward-sandbox') return new Response(JSON.stringify({
      id: 1296725030, full_name: 'splrad/steward-sandbox', default_branch: 'main',
    }));
    if (url.pathname.endsWith('/contents/.github/steward.json')) return new Response(JSON.stringify({
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64'), sha: 'blob',
    }));
    if (url.pathname.endsWith('/check-runs') && method === 'POST') return new Response(JSON.stringify({ id: 11 }));
    if (url.pathname.endsWith('/check-runs/11')) return new Response(JSON.stringify({ id: 11 }));
    if (url.pathname.endsWith('/git/ref/tags/v1.2.3')) {
      return tag ? new Response(JSON.stringify({ ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: mergeSha } }))
        : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    if (url.pathname.endsWith('/commits/v1.2.3')) return new Response(JSON.stringify({ sha: mergeSha }));
    if (url.pathname.endsWith('/releases/generate-notes')) return new Response(JSON.stringify({ name: 'generated', body: 'notes' }));
    if (url.pathname.endsWith('/git/refs') && method === 'POST') { tag = true; return new Response(JSON.stringify({
      ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: mergeSha },
    }), { status: 201 }); }
    if (url.pathname.endsWith('/releases') && method === 'GET') return new Response(JSON.stringify(
      draft === undefined || (publishedListLag && draft === false)
        ? []
        : [{ id: 7, tag_name: 'v1.2.3', draft, html_url: 'https://github.com/release' }],
    ));
    if (url.pathname.endsWith('/releases') && method === 'POST') { draft = true; return new Response(JSON.stringify({
      id: 7, tag_name: 'v1.2.3', draft: true,
      upload_url: 'https://uploads.github.com/repos/splrad/steward-sandbox/releases/7/assets{?name,label}',
    }), { status: 201 }); }
    if (url.pathname.endsWith('/releases/7') && method === 'GET') return draft === undefined
      ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      : new Response(JSON.stringify({ id: 7, tag_name: 'v1.2.3', draft, html_url: 'https://github.com/release' }));
    if (url.pathname.endsWith('/releases/7') && method === 'PATCH') { draft = false;
      return publishResponseFails ? new Response(JSON.stringify({ message: 'upstream failed' }), { status: 502 })
        : new Response(JSON.stringify({ id: 7, tag_name: 'v1.2.3', draft: false, html_url: 'https://github.com/release' })); }
    if (url.pathname.endsWith('/releases/7') && method === 'DELETE') { draft = undefined; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/git/refs/tags/v1.2.3') && method === 'DELETE') { tag = false; return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  });
  return { output, assets, requests, fetchMock, state: () => ({ tag, draft }) };
}

describe('Release publication transaction', () => {
  it('creates tag and draft, uploads validated assets, publishes, verifies, and completes the Check', async () => {
    const f = await fixture(false, false, false, true);
    await expect(publishRelease({ inputs: { operation: 'release-publish', token: 'token', releaseContext: context,
      releasePlan: plan, releaseAssets: f.assets, releaseOutputDirectory: f.output },
    environment: { GITHUB_API_URL: 'https://api.github.com/', GITHUB_RUN_ID: '42' }, fetch: f.fetchMock as unknown as typeof fetch }))
      .resolves.toEqual({ state: 'passed', summary: 'Release published', releaseUrl: 'https://github.com/release' });
    expect(f.state()).toEqual({ tag: true, draft: false });
    expect(f.requests.some((request) => request.path.endsWith('/assets'))).toBe(true);
    expect(f.requests).toContainEqual({ method: 'GET', path: '/repos/splrad/steward-sandbox/releases/7' });
  });

  it('removes only the transaction-owned draft and tag when asset upload fails, then fails the Check', async () => {
    const f = await fixture(true);
    await expect(publishRelease({ inputs: { operation: 'release-publish', token: 'token', releaseContext: context,
      releasePlan: plan, releaseAssets: f.assets, releaseOutputDirectory: f.output },
    environment: { GITHUB_API_URL: 'https://api.github.com/' }, fetch: f.fetchMock as unknown as typeof fetch }))
      .rejects.toThrow('upstream failed');
    expect(f.state()).toEqual({ tag: false, draft: undefined });
    expect(f.requests).toEqual(expect.arrayContaining([
      { method: 'DELETE', path: '/repos/splrad/steward-sandbox/releases/7' },
      { method: 'DELETE', path: '/repos/splrad/steward-sandbox/git/refs/tags/v1.2.3' },
    ]));
  });

  it('exits idempotently when the mutation-time recheck finds the same published Release', async () => {
    const f = await fixture(false, true);
    await expect(publishRelease({ inputs: { operation: 'release-publish', token: 'token', releaseContext: context,
      releasePlan: plan, releaseAssets: f.assets, releaseOutputDirectory: f.output },
    environment: { GITHUB_API_URL: 'https://api.github.com/' }, fetch: f.fetchMock as unknown as typeof fetch }))
      .resolves.toEqual({ state: 'ignored', summary: 'Release is already published', releaseUrl: 'https://github.com/release' });
    expect(f.requests.some((request) => request.method === 'POST' && request.path.endsWith('/git/refs'))).toBe(false);
    expect(f.requests.some((request) => request.path.endsWith('/assets'))).toBe(false);
  });

  it('reconciles a lost publish response before considering destructive rollback', async () => {
    const f = await fixture(false, false, true);
    await expect(publishRelease({ inputs: { operation: 'release-publish', token: 'token', releaseContext: context,
      releasePlan: plan, releaseAssets: f.assets, releaseOutputDirectory: f.output },
    environment: { GITHUB_API_URL: 'https://api.github.com/' }, fetch: f.fetchMock as unknown as typeof fetch }))
      .resolves.toEqual({ state: 'passed', summary: 'Release published and reconciled', releaseUrl: 'https://github.com/release' });
    expect(f.state()).toEqual({ tag: true, draft: false });
    expect(f.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });
});
