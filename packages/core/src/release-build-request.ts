import { type BuildPlan, type BuildManifest, planBuild } from './build-manifest.js';
import { canonicalReleaseJson, receiptDigest, releaseAssert, type FrozenRelease } from './release-note-receipt.js';
export const releaseToolchain = { node: '24.14.1', dotnet: '10.0.402', powershell: '7.6.6', runner: 'windows-2025', linuxRunner: 'ubuntu-24.04', npm: '11.11.0', docker: '29.8.2', buildx: '0.37.2' } as const;
export const releaseToolchainDigest = receiptDigest(canonicalReleaseJson(releaseToolchain));
export interface ReleaseBuildRequest {
  key: string; mode: 'initial' | 'rebuild'; frozen: FrozenRelease; plans: BuildPlan[]; sourceArtifactId: number | null;
}
export interface ReleaseBuildState {
  request: ReleaseBuildRequest; version: number; status: 'requested' | 'running' | 'accepted' | 'failed' | 'superseded';
  restartCount?: number; supersededBy?: string;
  attempts: { runId: number; attempt: number }[]; artifact: NonNullable<FrozenRelease['build']> | null; error: string | null;
  resultManifests?: BuildManifest[];
}
export async function makeReleaseBuildRequest(frozen: FrozenRelease, configuration: any, mode: 'initial' | 'rebuild', sourceArtifactId: number | null): Promise<ReleaseBuildRequest> {
  const plans: BuildPlan[] = [];
  for (const buildId of configuration.delivery.githubRelease.builds) {
    const unit = configuration.builds[buildId];
    const plan = await planBuild({ repositoryId: frozen.repositoryId, fullName: frozen.fullName, buildId, profile: unit.profile, targetSha: frozen.productTargetSha, policySha: frozen.policySha, version: frozen.targetTag.slice(1) }, unit);
    // OCI images have their own digest contract and cannot become GitHub file assets.
    releaseAssert(plan.profile !== 'oci-image-v1', 'BUILD_EXECUTOR');
    releaseAssert(plan.outputs.every(output => output.kind === 'file' && typeof output.match === 'string' && !/[\\/]/.test(output.match) && !output.match.includes('**')), 'BUILD_RELEASE_PATH');
    plans.push(plan);
  }
  releaseAssert(plans.length === 1, 'BUILD_SET');
  const identity = { mode, frozen, plans, sourceArtifactId };
  return { ...identity, key: receiptDigest(canonicalReleaseJson(identity)) };
}
