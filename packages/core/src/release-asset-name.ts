import { releaseAssert } from './release-note-receipt.js';
export function assertReleaseAssetName(value: string, pattern = false): void {
  const name = pattern ? value.replaceAll('*', 'a').replaceAll('?', 'a') : value;
  releaseAssert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)
    && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'BUILD_RELEASE_PATH');
}
