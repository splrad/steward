const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export interface IdentityOptions {
  botLogins?: readonly unknown[];
}

export interface ContributorIdentityInput extends IdentityOptions {
  body: unknown;
  prAuthor?: unknown;
}

export interface EffectiveAuthorInput extends ContributorIdentityInput {
  actor?: unknown;
  fallback?: string;
}

function rawLogin(value: unknown): string {
  return String(value ?? '').trim().replace(/^@+/, '');
}

function loginKey(value: unknown): string {
  return rawLogin(value).toLowerCase();
}

export function normalizeGitHubLogin(value: unknown): string {
  const login = rawLogin(value);
  return githubLoginPattern.test(login) ? login : '';
}

export function isBotLogin(value: unknown, botLogins: readonly unknown[] = []): boolean {
  const raw = loginKey(value);
  if (!raw || raw === 'unknown' || raw.endsWith('[bot]')) return true;
  const login = normalizeGitHubLogin(value).toLowerCase();
  if (!login || login === 'github-actions' || login === 'dependabot') return true;
  return botLogins.some((candidate) => loginKey(candidate) === raw);
}

export function uniqueHumanLogins(
  values: readonly unknown[],
  options: IdentityOptions = {},
): string[] {
  const bots = options.botLogins ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const login = normalizeGitHubLogin(value);
    const key = login.toLowerCase();
    if (!key || isBotLogin(value, bots) || seen.has(key)) continue;
    seen.add(key);
    result.push(login);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function workflowMetadataValue(body: unknown, name: string): string {
  const pattern = new RegExp(`<!--\\s*${escapeRegExp(name)}:([^>]*)-->`, 'i');
  return String(body ?? '').match(pattern)?.[1]?.trim() ?? '';
}

export function sourceActorFromBody(body: unknown): string {
  return normalizeGitHubLogin(workflowMetadataValue(body, 'workflow:source-actor'));
}

export function contributorLoginsFromBody(
  body: unknown,
  options: IdentityOptions = {},
): string[] {
  return uniqueHumanLogins(
    workflowMetadataValue(body, 'workflow:source-contributors').split(/[,\s]+/).filter(Boolean),
    options,
  );
}

export function realContributorLoginsFromBody(input: ContributorIdentityInput): string[] {
  return uniqueHumanLogins([
    ...contributorLoginsFromBody(input.body, input),
    sourceActorFromBody(input.body),
    input.prAuthor,
  ], input);
}

export function effectiveAuthorFromBody(input: EffectiveAuthorInput): string {
  const candidates = [
    sourceActorFromBody(input.body),
    ...contributorLoginsFromBody(input.body, input),
    normalizeGitHubLogin(input.prAuthor),
    normalizeGitHubLogin(input.actor),
  ];
  return candidates.find((login) => login && !isBotLogin(login, input.botLogins))
    ?? input.fallback
    ?? 'unknown';
}

export function formatMentions(
  values: readonly unknown[],
  options: IdentityOptions & { emptyText?: string; separator?: string } = {},
): string {
  const mentions = uniqueHumanLogins(values, options).map((login) => `@${login}`);
  return mentions.length > 0 ? mentions.join(options.separator ?? ' ') : (options.emptyText ?? '');
}
