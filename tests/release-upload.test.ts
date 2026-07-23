import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_CLOUD_REST_API_VERSION,
  GITHUB_ENTERPRISE_REST_API_VERSION,
  uploadReleaseAsset,
} from '../packages/github/src/index.js';

describe('Release asset upload transport', () => {
  it('confines raw binary uploads to the trusted repository upload endpoint', async () => {
    const fetchMock = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      id: 9, name: 'asset.zip', state: 'uploaded', size: 3,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await expect(uploadReleaseAsset({
      token: 'token', apiBaseUrl: 'https://api.github.com/',
      uploadUrl: 'https://uploads.github.com/repos/splrad/steward/releases/7/assets{?name,label}',
      owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
      mediaType: 'application/zip', body: new Blob(['zip'], { type: 'application/zip' }),
      fetch: fetchMock as unknown as typeof fetch,
    })).resolves.toMatchObject({ id: 9, name: 'asset.zip' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://uploads.github.com/repos/splrad/steward/releases/7/assets?name=asset.zip');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/zip');
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe(GITHUB_CLOUD_REST_API_VERSION);
    expect(init?.body).toBeInstanceOf(Blob);
    expect(init?.redirect).toBe('manual');
  });

  it('keeps GHES uploads on the compatible REST version by default', async () => {
    const fetchMock = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      id: 9, name: 'asset.zip', state: 'uploaded', size: 3,
    }), { status: 201 }));
    await uploadReleaseAsset({
      token: 'token', apiBaseUrl: 'https://github.example/api/v3/',
      uploadUrl: 'https://github.example/api/uploads/repos/splrad/steward/releases/7/assets{?name,label}',
      owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
      mediaType: 'application/zip', body: new Blob(['zip']), fetch: fetchMock as unknown as typeof fetch,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://github.example/api/uploads/repos/splrad/steward/releases/7/assets?name=asset.zip',
    );
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe(GITHUB_ENTERPRISE_REST_API_VERSION);

    await uploadReleaseAsset({
      token: 'token', apiBaseUrl: 'https://github.example/api/v3/',
      uploadUrl: 'https://github.example/api/uploads/repos/splrad/steward/releases/7/assets{?name,label}',
      owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
      mediaType: 'application/zip', body: new Blob(['zip']), apiVersion: GITHUB_CLOUD_REST_API_VERSION,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [, upgradedInit] = fetchMock.mock.calls[1]!;
    expect(new Headers(upgradedInit?.headers).get('x-github-api-version')).toBe(GITHUB_CLOUD_REST_API_VERSION);
  });

  it('uses the matching GHEC upload host for the configured tenant', async () => {
    const fetchMock = vi.fn(async (_request: string | URL | Request, _init?: RequestInit) => (
      new Response(JSON.stringify({ id: 9 }), { status: 201 })
    ));
    await uploadReleaseAsset({
      token: 'token', apiBaseUrl: 'https://api.acme.ghe.com/',
      uploadUrl: 'https://uploads.acme.ghe.com/repos/splrad/steward/releases/7/assets{?name,label}',
      owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
      mediaType: 'application/zip', body: new Blob(['zip']), fetch: fetchMock as unknown as typeof fetch,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://uploads.acme.ghe.com/repos/splrad/steward/releases/7/assets?name=asset.zip',
    );
  });

  it('rejects an untrusted upload origin or repository path before sending bytes', async () => {
    const fetchMock = vi.fn();
    for (const uploadUrl of [
      'https://evil.example/repos/splrad/steward/releases/7/assets{?name,label}',
      'https://uploads.github.com/repos/splrad/other/releases/7/assets{?name,label}',
      'https://uploads.github.com/repos/splrad/steward/releases/8/assets{?name,label}',
      'https://uploads.github.com/extra/repos/splrad/steward/releases/7/assets{?name,label}',
    ]) {
      await expect(uploadReleaseAsset({
        token: 'token', apiBaseUrl: 'https://api.github.com/', uploadUrl,
        owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
        mediaType: 'application/zip', body: new Blob(['zip']), fetch: fetchMock,
      })).rejects.toThrow('trusted repository endpoint');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant GHEC and noncanonical GHES upload paths', async () => {
    const fetchMock = vi.fn();
    for (const [apiBaseUrl, uploadUrl] of [
      [
        'https://api.acme.ghe.com/',
        'https://uploads.other.ghe.com/repos/splrad/steward/releases/7/assets{?name,label}',
      ],
      [
        'https://github.example/api/v3/',
        'https://github.example/repos/splrad/steward/releases/7/assets{?name,label}',
      ],
      [
        'https://github.example/api/v3/',
        'https://github.example/extra/api/uploads/repos/splrad/steward/releases/7/assets{?name,label}',
      ],
    ] as const) {
      await expect(uploadReleaseAsset({
        token: 'token', apiBaseUrl, uploadUrl,
        owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
        mediaType: 'application/zip', body: new Blob(['zip']), fetch: fetchMock,
      })).rejects.toThrow('trusted repository endpoint');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
