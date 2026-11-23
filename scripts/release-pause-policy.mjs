import { parseReleasePauses, releasePausesPath } from './release-pauses.mjs';
import { readProtectedSettings, withStewardSettings } from './steward-settings-read.mjs';

const unavailable = 'RELEASE_PAUSE_POLICY_UNAVAILABLE';
const positiveId = id => Number.isSafeInteger(id) && id > 0;

export async function readReleasePauses(api) {
  try {
    return await readProtectedSettings(api, async ({ entry, readFile }) =>
      parseReleasePauses(await readFile(releasePausesPath, await entry(releasePausesPath))), unavailable);
  } catch {
    throw Error(unavailable);
  }
}

export async function releaseIsPaused(app, repositoryId, readPauses = readReleasePauses) {
  if (!positiveId(repositoryId)) throw Error(unavailable);
  const { value: pausedIds } = await withStewardSettings(app, readPauses, unavailable);
  return pausedIds.includes(repositoryId);
}

export async function assertReleaseUnpaused(app, repositoryId, readPauses) {
  if (await releaseIsPaused(app, repositoryId, readPauses)) throw Error('RELEASE_REPOSITORY_PAUSED');
}
