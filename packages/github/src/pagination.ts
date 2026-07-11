export const maxPullRequestPages = 30;
export const pullRequestPageSize = 100;

export interface PaginationOptions {
  maxPages?: number;
  pageSize?: number;
}

export interface LinkPage<T> {
  items: readonly T[];
  link?: string | null;
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  if (value > maximum) throw new RangeError(`${name} must not exceed ${maximum}`);
  return value;
}

export async function fetchPullRequestPages<T>(
  fetchPage: (page: number, pageSize: number) => readonly T[] | Promise<readonly T[]>,
  options: PaginationOptions = {},
): Promise<T[]> {
  const maxPages = boundedPositiveInteger(
    options.maxPages ?? maxPullRequestPages,
    maxPullRequestPages,
    'maxPages',
  );
  const pageSize = boundedPositiveInteger(
    options.pageSize ?? pullRequestPageSize,
    pullRequestPageSize,
    'pageSize',
  );
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const items = await fetchPage(page, pageSize);
    if (!Array.isArray(items)) throw new TypeError('GitHub page response must be an array');
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return all;
}

export function nextPageUrl(linkHeader: string | null | undefined): string | null {
  for (const part of String(linkHeader ?? '').split(',')) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/i);
    if (match?.[2]?.split(/\s+/).some((relation) => relation.toLowerCase() === 'next')) {
      return match[1] ?? null;
    }
  }
  return null;
}

export async function fetchGitHubLinkPages<T>(
  initialUrl: string,
  fetchPage: (url: string) => LinkPage<T> | Promise<LinkPage<T>>,
  options: Pick<PaginationOptions, 'maxPages'> = {},
): Promise<T[]> {
  const maximum = boundedPositiveInteger(
    options.maxPages ?? maxPullRequestPages,
    maxPullRequestPages,
    'maxPages',
  );
  const initial = new URL(initialUrl);
  const visited = new Set<string>();
  const all: T[] = [];
  let current: URL | null = initial;
  for (let page = 1; page <= maximum && current; page += 1) {
    const currentUrl = current.href;
    if (visited.has(currentUrl)) throw new Error('GitHub pagination link cycle detected');
    visited.add(currentUrl);
    const response = await fetchPage(currentUrl);
    if (!Array.isArray(response?.items)) throw new TypeError('GitHub page response items must be an array');
    all.push(...response.items);
    const next = nextPageUrl(response.link);
    if (!next) break;
    const resolved = new URL(next, current);
    if (resolved.origin !== initial.origin) {
      throw new Error('GitHub pagination next link changed origin');
    }
    current = resolved;
  }
  return all;
}
