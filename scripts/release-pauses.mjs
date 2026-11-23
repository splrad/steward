import { decodeBuildJson } from '../packages/runner/dist/index.js';

export const releasePausesPath = 'release-pauses.json';

export function parseReleasePauses(bytes) {
  try {
    const ids = decodeBuildJson(bytes);
    if (Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id > 0)
        && new Set(ids).size === ids.length) return ids;
  } catch {
    // Keep policy contents out of error output.
  }
  throw Error('RELEASE_PAUSES_INVALID');
}
