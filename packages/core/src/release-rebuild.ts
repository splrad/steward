import { canonicalBuildManifest, type BuildManifest } from './build-manifest.js';
import { canonicalReleaseJson, releaseAssert, validateFrozenRelease, type FrozenRelease, type ReleaseReceipt } from './release-note-receipt.js';

export function currentReleaseBuild(receipt: ReleaseReceipt): FrozenRelease['build'] {
  return receipt.rebuiltAssets?.at(-1)?.build ?? receipt.frozen.build;
}
export function rebindReleaseBuild(receipt: ReleaseReceipt, build: NonNullable<FrozenRelease['build']>, manifests: BuildManifest[], toolchainDigest: string, recordedAt: string): ReleaseReceipt {
  releaseAssert(!receipt.paused && receipt.phase !== 'verified' && receipt.frozen.build && receipt.frozen.toolchainDigest === toolchainDigest && toolchainDigest, 'REBUILD_STATE');
  validateFrozenRelease({ ...receipt.frozen, build });
  const canonical = (values: BuildManifest[]) => canonicalReleaseJson(values.map(canonicalBuildManifest).sort());
  releaseAssert(canonical(manifests) === canonical(receipt.frozen.manifests), 'REBUILD_CHANGED_REVIEW_REQUIRED');
  const current = currentReleaseBuild(receipt);
  if (canonicalReleaseJson(current) === canonicalReleaseJson(build)) return receipt;
  releaseAssert(build.artifactId !== current?.artifactId && (receipt.rebuiltAssets?.length ?? 0) < 32, 'REBUILD_IDENTITY');
  return { ...receipt, rebuiltAssets: [...receipt.rebuiltAssets ?? [], { build, toolchainDigest, recordedAt }] };
}
