import { assertPersonalizationConfiguration } from '../../core/src/release-personalization.js';
import { releaseProfiles } from '../../../config/release-profiles.js';
import { GitHubClient, createInstallationToken, dispatchWorkflow } from '../../github/src/index.js';
import { canonicalReleaseJson, receiptDigest, releaseAssert, validateFrozenRelease, type FrozenRelease } from '../../core/src/release-note-receipt.js';
import { makeReleaseBuildRequest, releaseToolchainDigest } from '../../core/src/release-build-request.js';
import { currentReleaseBuild, rebindReleaseBuild } from '../../core/src/release-rebuild.js';
import { validateReleaseSource } from '../../core/src/release-bundle.js';
import { ReleaseBuildStore } from './release-build-store.js';
import { ReleaseReceiptStore } from './release-note-receipts.js';
import { type BodyWriteRuntimeEnv } from './pr-body-api.js';
import { releaseTree, readCandidateBlob, optionalReleaseRead } from '../../github/src/release-candidate.js';
import { assertIncreasingReleaseVersion } from '../../github/src/release-candidate.js';
import { matchBuildFiles } from '../../core/src/build-manifest.js';

export async function centralBuildClient(env: BodyWriteRuntimeEnv, write = false): Promise<GitHubClient> {
  const token = await createInstallationToken({ appId: env.APP_ID, privateKey: env.STEWARD_APP_PRIVATE_KEY!, installationId: Number(env.INSTALLATION_ID), repositoryId: 1296724484, permissions: { actions: write ? 'write' : 'read', contents: 'read', metadata: 'read' }, policySha: env.POLICY_SHA });
  return new GitHubClient(token, 'https://api.github.com', fetch, env.POLICY_SHA);
}
export async function dispatchReleaseBuild(env: BodyWriteRuntimeEnv, repositoryId: number, tag: string, key: string): Promise<void> {
  await dispatchWorkflow(await centralBuildClient(env, true), { owner: 'splrad', repo: 'steward', workflow: 'release-build.yml', policySha: env.POLICY_SHA!,
    inputs: { repositoryId: String(repositoryId), targetTag: tag, requestKey: key } });
}
export async function handleReleaseBuildAction(env: BodyWriteRuntimeEnv, gh: GitHubClient, repository: any, configuration: any, tag: string, body: any): Promise<unknown> {
  const repositoryId = repository.id, store = new ReleaseBuildStore(env.ISSUE_SNAPSHOTS!), receipts = new ReleaseReceiptStore(env.ISSUE_SNAPSHOTS!);
  releaseAssert(configuration.delivery.githubRelease.enabled && ['pending', 'active'].includes(configuration.delivery.githubRelease.state), 'CAPABILITY');
  if (body.action === 'find') return store.find(repositoryId, tag, body.runId, body.attempt);
  if (body.action === 'prepare') {
    const f = body.frozen as FrozenRelease;
    validateFrozenRelease(f);
    assertPersonalizationConfiguration(f, configuration, releaseProfiles);
    releaseAssert(f.repositoryId === repositoryId && f.fullName === repository.full_name && f.defaultBranch === repository.default_branch && f.targetTag === tag && f.policySha === env.POLICY_SHA
      && f.build === null && f.assets.length === 0 && f.toolchainDigest === releaseToolchainDigest && !await receipts.get(repositoryId, tag), 'BUILD_PREPARE_IDENTITY');
    const [owner, repo] = f.fullName.split('/') as [string, string];
    releaseAssert(!await optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, tag))
      && !await optionalReleaseRead(() => gh.getGitRef(owner, repo, `tags/${tag}`)), 'VERSION_OCCUPIED');
    await assertIncreasingReleaseVersion(gh, owner, repo, tag);
    const head = await gh.getGitRef(owner, repo, `heads/${f.defaultBranch}`);
    releaseAssert(head.object.sha === f.productTargetSha, 'BUILD_TARGET_STALE');
    const tree = await releaseTree(gh, owner, repo, f.productTargetSha);
    releaseAssert(tree.object.tree.sha === f.productTree && await readCandidateBlob(gh, owner, repo, tree, 'VERSION') === f.targetTag.slice(1) + '\n', 'VERSION_BINDING');
    validateReleaseSource(await receipts.readObject(repositoryId, f.sourceDigest), f);
    return store.prepare(await makeReleaseBuildRequest(f, configuration, 'initial', null));
  }
  const state = await store.get(body.key, repositoryId, tag);
  releaseAssert(state && state.request.frozen.policySha === env.POLICY_SHA, 'BUILD_REQUEST');
  if (body.action === 'get') return state;
  const central = await centralBuildClient(env);
  const run = await central.request<any>('GET', `/repos/splrad/steward/actions/runs/${body.runId}`);
  releaseAssert(run.repository?.id === 1296724484 && run.id === body.runId && run.run_attempt === body.attempt && run.event === 'workflow_dispatch'
    && run.head_sha === env.POLICY_SHA && run.path === '.github/workflows/release-build.yml', 'BUILD_RUN_PROVENANCE');
  if (body.action === 'begin') {
    if (state.request.mode === 'rebuild') {
      const receipt = await receipts.get(repositoryId, tag);
      releaseAssert(receipt && !receipt.paused && receipt.frozenDigest === receiptDigest(canonicalReleaseJson(state.request.frozen))
        && currentReleaseBuild(receipt)?.artifactId === state.request.sourceArtifactId, 'BUILD_REQUEST_STALE');
    }
    releaseAssert(run.status === 'in_progress', 'BUILD_RUN_PROVENANCE');
    return store.begin(state, body.runId, body.attempt);
  }
  const last = state.attempts.at(-1);
  releaseAssert(last && last.runId === body.runId && last.attempt === body.attempt && run.status === 'completed', 'BUILD_RUN_PROVENANCE');
  if (body.action === 'fail') {
    releaseAssert(run.conclusion !== 'success' && state.status !== 'accepted', 'BUILD_RUN_PROVENANCE');
    return store.save(state, { ...state, status: 'failed', error: 'build-run-failed' });
  }
  if (body.action === 'reject') {
    releaseAssert(state.status !== 'accepted' && run.conclusion === 'success', 'BUILD_RUN_PROVENANCE');
    if (state.request.mode === 'rebuild') {
      const claim = await receipts.claim(repositoryId, tag, Date.now());
      try {
        releaseAssert(claim.receipt.frozenDigest === receiptDigest(canonicalReleaseJson(state.request.frozen)), 'BUILD_REQUEST_STALE');
        await receipts.save(claim.receipt, { ...claim.receipt, paused: true, error: claim.receipt.error ?? 'rebuild-verification-failed' }, claim.token, Date.now());
      }
      finally { await receipts.release(repositoryId, tag, claim.token); }
    }
    return store.save(state, { ...state, status: 'failed', error: state.error ?? 'build-verification-failed' });
  }
  releaseAssert(body.action === 'finish' && run.conclusion === 'success' && body.toolchainDigest === releaseToolchainDigest, 'BUILD_FINISH');
  const artifact = await central.request<any>('GET', `/repos/splrad/steward/actions/artifacts/${body.artifactId}`);
  releaseAssert(artifact.id === body.artifactId && artifact.name === `release-build-result-${body.attempt}` && artifact.expired === false
    && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === env.POLICY_SHA, 'BUILD_PROVENANCE');
  const build = { runId: run.id, artifactId: artifact.id, artifactName: artifact.name, headSha: run.head_sha };
  const frozen = { ...state.request.frozen, build, manifests: body.manifests, assets: body.manifests.flatMap((m: any) => m.artifacts.map((a: any) => ({ name: a.file, size: a.size, sha256: a.sha256 }))) };
  validateFrozenRelease(frozen);
  const expected = await makeReleaseBuildRequest(state.request.frozen, configuration, state.request.mode, state.request.sourceArtifactId);
  releaseAssert(expected.key === state.request.key && body.manifests.length === expected.plans.length
    && expected.plans.every(p => body.manifests.some((m: any) => m.buildId === p.buildId && m.inputsSha256 === p.inputsSha256)), 'BUILD_INPUTS');
  for (const p of expected.plans) {
    const manifest = body.manifests.find((m: any) => m.buildId === p.buildId);
    const files = matchBuildFiles(p, manifest.artifacts.map((a: any) => a.file));
    releaseAssert(files.every(e => manifest.artifacts.some((a: any) => a.id === e.id && a.file === e.file && a.mediaType === e.mediaType)), 'BUILD_OUTPUTS');
  }
  if (state.status === 'accepted') { releaseAssert(canonicalReleaseJson(state.artifact) === canonicalReleaseJson(build), 'BUILD_ACCEPTED'); return state; }
  if (state.request.mode === 'rebuild') {
    const claim = await receipts.claim(repositoryId, tag, Date.now());
    try {
      releaseAssert(claim.receipt.frozenDigest === receiptDigest(canonicalReleaseJson(state.request.frozen)), 'BUILD_REQUEST_STALE');
      try {
        const next = rebindReleaseBuild(claim.receipt, build, body.manifests, body.toolchainDigest, new Date().toISOString());
        await receipts.save(claim.receipt, next, claim.token, Date.now());
      } catch (error) {
        if (error instanceof Error && error.message.includes('REBUILD_CHANGED_REVIEW_REQUIRED')) {
          await store.save(state, { ...state, status: 'failed', error: 'rebuild-changed-review-required', artifact: build, resultManifests: body.manifests });
          await receipts.save(claim.receipt, { ...claim.receipt, paused: true, error: 'rebuild-changed-review-required', rebuildRequestKey: state.request.key }, claim.token, Date.now());
        }
        throw error;
      }
    } finally { await receipts.release(repositoryId, tag, claim.token); }
  }
  return store.save(state, { ...state, status: 'accepted', artifact: build, error: null, resultManifests: body.manifests });
}
