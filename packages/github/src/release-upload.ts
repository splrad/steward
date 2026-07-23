import type { GitHubReleaseAsset } from './client.js';
import { resolveGitHubRestApiVersion } from './api-version.js';
import { GitHubApiError, resolveGitHubEndpointConfiguration } from './transport.js';

export async function uploadReleaseAsset(input: {
  token: string;
  apiBaseUrl: string;
  uploadUrl: string;
  owner: string;
  repository: string;
  releaseId: number;
  name: string;
  mediaType: string;
  body: Blob;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<GitHubReleaseAsset> {
  const token = input.token.trim();
  if (!token) throw new Error('GitHub API token is required');
  const endpoints = resolveGitHubEndpointConfiguration(input.apiBaseUrl);
  const templateSuffix = '{?name,label}';
  if (!input.uploadUrl.endsWith(templateSuffix)) throw new Error('GitHub returned an invalid Release upload URL template');
  const url = new URL(input.uploadUrl.slice(0, -templateSuffix.length));
  const expectedPath = `${endpoints.releaseUploadPathPrefix}/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/releases/${input.releaseId}/assets`;
  if (url.protocol !== 'https:' || url.origin !== endpoints.releaseUploadOrigin || url.username || url.password
    || url.search || url.hash || url.pathname.toLowerCase() !== expectedPath.toLowerCase()) {
    throw new Error('GitHub Release upload URL escaped the trusted repository endpoint');
  }
  url.searchParams.set('name', input.name);
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    // Manual redirect handling is supported by both Node and Workers. The
    // response.ok gate below rejects every 3xx without forwarding asset bytes.
    method: 'POST', redirect: 'manual', body: input.body,
    headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'content-type': input.mediaType, 'user-agent': 'splrad-steward',
      'x-github-api-version': resolveGitHubRestApiVersion(input.apiBaseUrl, input.apiVersion),
    },
  });
  if (!response.ok) {
    let message = response.statusText || 'request failed';
    try { message = String((await response.json() as { message?: string }).message || message); } catch { /* safe fallback */ }
    throw new GitHubApiError({ status: response.status, method: 'POST', path: url.pathname, message });
  }
  return await response.json() as GitHubReleaseAsset;
}
