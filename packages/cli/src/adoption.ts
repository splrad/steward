export interface AdoptionProfile {
  schemaVersion: 1;
  id: string;
  source: { repository: string; commit: string };
  replace: ReadonlyMap<string, string>;
  remove: ReadonlyMap<string, string>;
}

type JsonObject = Record<string, unknown>;

const profileIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown properties: ${unknown.join(', ')}`);
}

function repositoryPath(value: string, label: string): string {
  const parts = value.split('/');
  if (!value || value.startsWith('/') || value.endsWith('/') || value.includes('\\')
    || value.includes(':') || /[\u0000-\u001f]/.test(value)
    || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe POSIX repository-relative path`);
  }
  return value;
}

function digestMap(value: unknown, label: string): Map<string, string> {
  const input = object(value, label);
  const result = new Map<string, string>();
  for (const [rawPath, rawDigest] of Object.entries(input)) {
    const filePath = repositoryPath(rawPath, `${label} path`);
    const fileDigest = String(rawDigest ?? '');
    if (!digestPattern.test(fileDigest)) throw new Error(`${label}.${filePath} must be a lowercase SHA-256 digest`);
    result.set(filePath, fileDigest);
  }
  return result;
}

export function parseAdoptionProfile(value: unknown, requestedId: string): AdoptionProfile {
  const input = object(value, 'adoption profile');
  exactKeys(input, ['schemaVersion', 'id', 'source', 'replace', 'remove'], 'adoption profile');
  if (input.schemaVersion !== 1) throw new Error('adoption profile schemaVersion must be 1');
  const id = String(input.id ?? '');
  if (!profileIdPattern.test(id) || id !== requestedId) throw new Error('adoption profile id does not match the requested profile');

  const source = object(input.source, 'adoption profile source');
  exactKeys(source, ['repository', 'commit'], 'adoption profile source');
  const repository = String(source.repository ?? '');
  const commit = String(source.commit ?? '').toLowerCase();
  if (!repositoryPattern.test(repository)) throw new Error('adoption profile source.repository must be OWNER/REPOSITORY');
  if (!shaPattern.test(commit)) throw new Error('adoption profile source.commit must be a complete 40-character commit SHA');

  const replace = digestMap(input.replace, 'adoption profile replace');
  const remove = digestMap(input.remove, 'adoption profile remove');
  const overlap = [...replace.keys()].filter((filePath) => remove.has(filePath));
  if (overlap.length) throw new Error(`adoption profile paths cannot be both replaced and removed: ${overlap.join(', ')}`);
  if (!replace.size && !remove.size) throw new Error('adoption profile must contain at least one exact-digest operation');
  return { schemaVersion: 1, id, source: { repository, commit }, replace, remove };
}
