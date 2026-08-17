export interface GitHubActor {
  id: number;
  login: string;
  type: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

export interface Contributor {
  id: number;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function isBotActor(actor: Pick<GitHubActor, 'login' | 'type'>): boolean {
  const login = actor.login.trim().toLowerCase();
  return actor.type.toLowerCase() === 'bot'
    || login.endsWith('[bot]')
    || login === 'github-actions'
    || login === 'dependabot';
}

export function isHumanActor(actor: GitHubActor): boolean {
  return Number.isSafeInteger(actor.id)
    && actor.id > 0
    && loginPattern.test(actor.login)
    && actor.type.toLowerCase() === 'user'
    && !isBotActor(actor);
}

function isContributorEmail(value: string): boolean {
  if (value.length > 254) return false;
  for (const character of value) if (character.trim() === '') return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const dot = value.lastIndexOf('.');
  return dot > at + 1 && dot < value.length - 1;
}

function normalizeContributorName(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  if (!sanitized) return undefined;
  return [...sanitized].slice(0, 80).join('').trimEnd() || undefined;
}

export function normalizeContributor(actor: GitHubActor): Contributor | null {
  if (!isHumanActor(actor)) return null;
  const contributor: Contributor = { id: actor.id, login: actor.login };
  const name = normalizeContributorName(actor.name);
  const email = actor.email?.trim();
  const avatarUrl = actor.avatarUrl?.trim();
  if (name) contributor.name = name;
  if (email && isContributorEmail(email)) contributor.email = email;
  if (avatarUrl) contributor.avatarUrl = avatarUrl;
  return contributor;
}
