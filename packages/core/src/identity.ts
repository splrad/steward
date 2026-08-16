export interface GitHubActor {
  id: number;
  login: string;
  type: string;
  name?: string | null;
  email?: string | null;
}

export interface Contributor {
  id: number;
  login: string;
  name?: string;
  email?: string;
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

export function normalizeContributor(actor: GitHubActor): Contributor | null {
  if (!isHumanActor(actor)) return null;
  const contributor: Contributor = { id: actor.id, login: actor.login };
  const name = actor.name?.trim();
  const email = actor.email?.trim();
  if (name) contributor.name = name;
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) contributor.email = email;
  return contributor;
}
