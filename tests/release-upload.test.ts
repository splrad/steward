import { describe, expect, it, vi } from 'vitest';
import { uploadReleaseAsset } from '../packages/github/src/index.js';

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
    expect(init?.body).toBeInstanceOf(Blob);
  });

  it('rejects an untrusted upload origin or repository path before sending bytes', async () => {
    const fetchMock = vi.fn();
    for (const uploadUrl of [
      'https://evil.example/repos/splrad/steward/releases/7/assets{?name,label}',
      'https://uploads.github.com/repos/splrad/other/releases/7/assets{?name,label}',
      'https://uploads.github.com/repos/splrad/steward/releases/8/assets{?name,label}',
    ]) {
      await expect(uploadReleaseAsset({
        token: 'token', apiBaseUrl: 'https://api.github.com/', uploadUrl,
        owner: 'splrad', repository: 'steward', releaseId: 7, name: 'asset.zip',
        mediaType: 'application/zip', body: new Blob(['zip']), fetch: fetchMock,
      })).rejects.toThrow('trusted repository endpoint');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
