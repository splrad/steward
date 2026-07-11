export type GitHubHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface GitHubRequest {
  method?: GitHubHttpMethod;
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  body?: unknown;
}

export interface GitHubTransport {
  request<T>(request: GitHubRequest): Promise<T>;
}

export interface GitHubRestTransportOptions {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: GitHubHttpMethod;
  readonly path: string;

  constructor(input: { status: number; method: GitHubHttpMethod; path: string; message: string }) {
    super(`GitHub API ${input.method} ${input.path} failed (${input.status}): ${input.message}`);
    this.name = 'GitHubApiError';
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
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
  const base = apiBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  const userAgent = options.userAgent?.trim() || 'splrad-steward';

  return {
    async request<T>(request: GitHubRequest): Promise<T> {
      const method = request.method ?? 'GET';
      const url = requestUrl(base, request);
      const headers = new Headers({
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': userAgent,
        'x-github-api-version': '2022-11-28',
      });
      const init: RequestInit = { method, headers, redirect: 'error' };
      if (request.body !== undefined) {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(request.body);
      }
      const response = await fetcher(url, init);
      if (!response.ok) {
        throw new GitHubApiError({
          status: response.status,
          method,
          path: request.path,
          message: await responseMessage(response),
        });
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (!text.trim()) return undefined as T;
      return JSON.parse(text) as T;
    },
  };
}
