export const GITHUB_CLOUD_REST_API_VERSION = '2026-03-10';
export const GITHUB_ENTERPRISE_REST_API_VERSION = '2022-11-28';

const apiVersionPattern = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeGitHubRestApiVersion(value: string): string {
  const version = value.trim();
  const date = new Date(`${version}T00:00:00.000Z`);
  if (!apiVersionPattern.test(version)
    || Number.isNaN(date.valueOf())
    || date.toISOString().slice(0, 10) !== version) {
    throw new Error('GitHub REST API version must be a valid YYYY-MM-DD date');
  }
  return version;
}

export function gitHubEnterpriseCloudTenant(baseUrl: string | URL): string | null {
  const hostname = (baseUrl instanceof URL ? baseUrl : new URL(baseUrl)).hostname.toLowerCase();
  const match = /^api\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ghe\.com$/.exec(hostname);
  return match?.[1] ?? null;
}

export function defaultGitHubRestApiVersion(baseUrl: string | URL): string {
  const hostname = (baseUrl instanceof URL ? baseUrl : new URL(baseUrl)).hostname.toLowerCase();
  return hostname === 'api.github.com' || gitHubEnterpriseCloudTenant(baseUrl) !== null
    ? GITHUB_CLOUD_REST_API_VERSION
    : GITHUB_ENTERPRISE_REST_API_VERSION;
}

export function resolveGitHubRestApiVersion(baseUrl: string | URL, requestedVersion?: string): string {
  return normalizeGitHubRestApiVersion(requestedVersion ?? defaultGitHubRestApiVersion(baseUrl));
}

export function workflowDispatchReturnsRunDetails(version: string | undefined): boolean {
  if (!version) return false;
  try {
    return normalizeGitHubRestApiVersion(version) >= GITHUB_CLOUD_REST_API_VERSION;
  } catch {
    return false;
  }
}
