import { gitHubEnterpriseCloudTenant, resolveGitHubRestApiVersion } from './api-version.js';

export type GitHubHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GitHubRequest {
  method?: GitHubHttpMethod;
  path: string;
  accept?: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  body?: unknown;
}

export interface GitHubTransport {
  readonly restApiVersion?: string;
  readonly restApiBaseUrl?: string;
  request<T>(request: GitHubRequest): Promise<T>;
}

export interface GitHubRestTransportOptions {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: GitHubHttpMethod;
  readonly path: string;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;

  constructor(input: {
    status: number;
    method: GitHubHttpMethod;
    path: string;
    message: string;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
    requestId?: string;
  }) {
    super(`GitHub API ${input.method} ${input.path} failed (${input.status}): ${input.message}`);
    this.name = 'GitHubApiError';
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.rateLimited = input.rateLimited ?? false;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
    if (input.requestId) this.requestId = input.requestId;
  }
}

export class GitHubTransportError extends Error {
  readonly method: GitHubHttpMethod;
  readonly path: string;
  readonly reason: 'network' | 'redirect' | 'invalid-response';
  readonly retryable: boolean;

  constructor(input: {
    method: GitHubHttpMethod;
    path: string;
    reason: 'network' | 'redirect' | 'invalid-response';
    retryable: boolean;
  }) {
    super(`GitHub transport ${input.method} ${input.path} failed: ${input.reason}`);
    this.name = 'GitHubTransportError';
    this.method = input.method;
    this.path = input.path;
    this.reason = input.reason;
    this.retryable = input.retryable;
  }
}

function apiBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? 'https://api.github.com/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub API base URL must be an HTTPS URL without credentials, query, or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export interface GitHubEndpointConfiguration {
  readonly restApiBaseUrl: string;
  readonly webOrigin: string;
  readonly releaseUploadOrigin: string;
  readonly releaseUploadPathPrefix: '/repos' | '/api/uploads/repos';
}

export function resolveGitHubEndpointConfiguration(value?: string | URL): GitHubEndpointConfiguration {
  const base = apiBaseUrl(value === undefined ? undefined : String(value));
  const cloud = base.hostname.toLowerCase() === 'api.github.com';
  const ghecTenant = gitHubEnterpriseCloudTenant(base);
  if ((cloud || ghecTenant) && (base.port || base.pathname !== '/')) {
    throw new Error('GitHub Cloud API base URL must use the official HTTPS origin and root path');
  }
  if (cloud) {
    return {
      restApiBaseUrl: base.href,
      webOrigin: 'https://github.com',
      releaseUploadOrigin: 'https://uploads.github.com',
      releaseUploadPathPrefix: '/repos',
    };
  }
  if (ghecTenant) {
    return {
      restApiBaseUrl: base.href,
      webOrigin: `https://${ghecTenant}.ghe.com`,
      releaseUploadOrigin: `https://uploads.${ghecTenant}.ghe.com`,
      releaseUploadPathPrefix: '/repos',
    };
  }
  return {
    restApiBaseUrl: base.href,
    webOrigin: base.origin,
    releaseUploadOrigin: base.origin,
    releaseUploadPathPrefix: '/api/uploads/repos',
  };
}

function requestUrl(base: URL, request: GitHubRequest): URL {
  if (!request.path.startsWith('/') || request.path.startsWith('//')) {
    throw new Error('GitHub API request path must be a root-relative path');
  }
  if (request.path.includes('?') || request.path.includes('#')) {
    throw new Error('GitHub API request path must not contain a query or fragment');
  }
  for (const rawSegment of request.path.slice(1).split('/')) {
    if (!rawSegment || rawSegment.includes('\\')) {
      throw new Error('GitHub API request path contains an unsafe path segment');
    }
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      throw new Error('GitHub API request path contains invalid percent encoding');
    }
    const decodedParts = decodedSegment.split('/');
    if (decodedSegment.includes('\\')
      || decodedParts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('GitHub API request path contains an unsafe path segment');
    }
  }
  const url = new URL(request.path.slice(1), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error('GitHub API request path escaped the configured API base URL');
  }
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  return url;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { message?: unknown };
    const message = String(payload?.message ?? '').trim();
    if (message) return message;
  } catch {
    // GitHub error responses are normally JSON; status text is the safe fallback.
  }
  return response.statusText || 'request failed';
}

export function createGitHubRestTransport(options: GitHubRestTransportOptions): GitHubTransport {
  const token = options.token.trim();
  if (!token) throw new Error('GitHub API token is required');
  const endpoints = resolveGitHubEndpointConfiguration(options.baseUrl);
  const base = new URL(endpoints.restApiBaseUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  const userAgent = options.userAgent?.trim() || 'splrad-steward';
  const restApiVersion = resolveGitHubRestApiVersion(base, options.apiVersion);

  return {
    restApiVersion,
    restApiBaseUrl: endpoints.restApiBaseUrl,
    async request<T>(request: GitHubRequest): Promise<T> {
      const method = request.method ?? 'GET';
      let url = requestUrl(base, request);
      const headers = new Headers({
        accept: request.accept?.trim() || 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': userAgent,
        'x-github-api-version': restApiVersion,
      });
      const init: RequestInit = { method, headers, redirect: 'manual' };
      if (request.body !== undefined) {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(request.body);
      }
      let response: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        try {
          response = await fetcher(url, init);
        } catch {
          throw new GitHubTransportError({ method, path: request.path, reason: 'network', retryable: true });
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (method !== 'GET' || redirectCount === 5) {
          throw new GitHubTransportError({ method, path: request.path, reason: 'redirect', retryable: false });
        }
        const location = response.headers.get('location');
        if (!location) {
          throw new GitHubTransportError({ method, path: request.path, reason: 'redirect', retryable: false });
        }
        const redirected = new URL(location, url);
        if (redirected.origin !== base.origin || !redirected.pathname.startsWith(base.pathname)
          || redirected.username || redirected.password) {
          throw new GitHubTransportError({ method, path: request.path, reason: 'redirect', retryable: false });
        }
        url = redirected;
      }
      if (!response) {
        throw new GitHubTransportError({ method, path: request.path, reason: 'network', retryable: true });
      }
      if (!response.ok) {
        const message = await responseMessage(response);
        const retryAfterHeader = response.headers.get('retry-after')?.trim();
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        const rateLimited = response.status === 429 || (response.status === 403 && (
          response.headers.get('x-ratelimit-remaining') === '0'
          || response.headers.has('retry-after')
          || /rate limit/i.test(message)
        ));
        throw new GitHubApiError({
          status: response.status,
          method,
          path: request.path,
          message,
          rateLimited,
          ...(retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0
            ? { retryAfterSeconds: retryAfter }
            : {}),
          ...(response.headers.get('x-github-request-id')
            ? { requestId: response.headers.get('x-github-request-id')! }
            : {}),
        });
      }
      if (response.status === 204) return undefined as T;
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new GitHubTransportError({ method, path: request.path, reason: 'network', retryable: true });
      }
      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new GitHubTransportError({ method, path: request.path, reason: 'invalid-response', retryable: false });
      }
    },
  };
}
