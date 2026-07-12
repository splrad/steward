import { createHash } from 'node:crypto';
import { lstat, openAsBlob, realpath } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  parseReleaseAdapterContext,
  parseReleaseAssetsManifest,
  parseReleasePlan,
  stewardCheckExternalId,
} from '../../packages/core/src/index.js';
import { loadDefaultBranchManifest } from '../../packages/manifest/src/index.js';
import {
  GitHubApiError,
  GitHubRepositoryClient,
  createGitHubRestTransport,
  uploadReleaseAsset,
  type GitHubCheckRun,
} from '../../packages/github/src/index.js';
import type { StewardActionInputs } from './contracts.js';
import { graphqlApiBase, type StewardRuntimeEnvironment } from './context.js';
import { inventoryReleaseOutput } from './release-adapter.js';
import { readReleaseStatusWithClient } from './release-status.js';

const stat = promisify(lstat);
const resolveRealPath = promisify(realpath);

function json(value: string, name: string): unknown {
  try { return JSON.parse(value); } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function publishRelease(input: {
  inputs: StewardActionInputs;
  environment: StewardRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
}): Promise<{ state: 'passed' | 'ignored'; summary: string; releaseUrl?: string }> {
  const token = input.inputs.token?.trim() ?? '';
  if (!token) throw new Error('release-publish requires an explicit GitHub token');
  const context = parseReleaseAdapterContext(json(input.inputs.releaseContext ?? '', 'release-context'));
  const plan = parseReleasePlan(json(input.inputs.releasePlan ?? '', 'release-plan'));
  const rawAssets = json(input.inputs.releaseAssets ?? '', 'release-assets');
  const outputInput = input.inputs.releaseOutputDirectory?.trim() ?? '';
  if (!outputInput) throw new Error('release-publish requires release-output-directory');
  const [owner, repository] = context.repository.fullName.split('/') as [string, string];
  const apiBaseUrl = input.environment.GITHUB_API_URL?.trim() || 'https://api.github.com/';
  const transportOptions = input.fetch ? { fetch: input.fetch } : {};
  const client = new GitHubRepositoryClient(
    createGitHubRestTransport({ token, baseUrl: apiBaseUrl, ...transportOptions }),
    createGitHubRestTransport({ token, baseUrl: graphqlApiBase(apiBaseUrl), ...transportOptions }),
  );
  const metadata = await client.getRepository(owner, repository);
  if (metadata.id !== context.repository.id || metadata.fullName.toLowerCase() !== context.repository.fullName.toLowerCase()) {
    throw new Error('Release context repository does not match current repository metadata');
  }
  const manifest = await loadDefaultBranchManifest(client, owner, repository);
  if (!manifest.manifest.features.release) throw new Error('Release feature is disabled in the default-branch Manifest');
  const inputDigest = createHash('sha256').update(JSON.stringify({ context, plan, rawAssets }), 'utf8').digest('hex');
  const externalId = stewardCheckExternalId({
    repositoryId: metadata.id, prNumber: context.pullRequest.number, headSha: context.pullRequest.mergeSha,
    checkId: 'release', configDigest: manifest.configDigest, inputDigest,
  });
  const detailsUrl = input.environment.GITHUB_RUN_ID
    ? `${(input.environment.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')}/${metadata.fullName}/actions/runs/${input.environment.GITHUB_RUN_ID}`
    : undefined;
  const check = await client.createCheckRun(owner, repository, {
    name: 'Release', headSha: context.pullRequest.mergeSha, status: 'in_progress', externalId,
    ...(detailsUrl ? { detailsUrl } : {}), title: '正在发布', summary: `${plan.tagName} 资产正在验证和上传。`,
  });
  let createdReleaseId: number | undefined;
  let ownsTag = false;
  let published = false;
  let publishAttempted = false;
  const finish = async (update: Parameters<GitHubRepositoryClient['updateCheckRun']>[3]): Promise<GitHubCheckRun> => (
    await client.updateCheckRun(owner, repository, check.id, update)
  );
  try {
    const outputDirectory = await resolveRealPath(outputInput);
    if (!(await stat(outputDirectory)).isDirectory()) throw new Error('release-output-directory must be a directory');
    const inventory = await inventoryReleaseOutput(outputDirectory);
    const assets = parseReleaseAssetsManifest(rawAssets, inventory);
    const status = await readReleaseStatusWithClient(client, context, plan);
    if (status.decision.state === 'ignored') {
      await finish({ name: 'Release', status: 'completed', conclusion: 'success', externalId,
        ...(detailsUrl ? { detailsUrl } : {}), title: '发布已存在', summary: `${plan.tagName} 已指向当前 merge commit。` });
      return { state: 'ignored', summary: 'Release is already published', ...(status.release?.html_url ? { releaseUrl: status.release.html_url } : {}) };
    }
    const notes = await client.generateReleaseNotes(owner, repository, plan.tagName, context.pullRequest.mergeSha);
    if (typeof notes.body !== 'string') throw new Error('GitHub returned invalid generated Release notes');
    const tag = await client.createTagRef(owner, repository, plan.tagName, context.pullRequest.mergeSha);
    ownsTag = true;
    if (tag.ref !== `refs/tags/${plan.tagName}` || tag.object?.sha?.toLowerCase() !== context.pullRequest.mergeSha) {
      throw new Error('GitHub returned an invalid created tag reference');
    }
    const draft = await client.createDraftRelease({ owner, repository, tag: plan.tagName,
      targetCommitish: context.pullRequest.mergeSha, name: plan.releaseTitle, body: notes.body });
    if (Number.isSafeInteger(draft.id) && draft.id > 0) createdReleaseId = draft.id;
    if (!createdReleaseId || draft.tag_name !== plan.tagName
      || draft.draft !== true || !draft.upload_url) throw new Error('GitHub returned invalid draft Release metadata');
    for (const asset of assets.assets) {
      const file = inventory.find((candidate) => candidate.path === asset.path && candidate.type === 'file');
      if (!file?.sha256) throw new Error(`Validated Release asset inventory is missing: ${asset.path}`);
      const filePath = path.join(outputDirectory, ...asset.path.split('/'));
      const actualPath = await resolveRealPath(filePath);
      if (!actualPath.startsWith(`${outputDirectory}${path.sep}`)) throw new Error(`Release asset escaped output directory: ${asset.path}`);
      const uploaded = await uploadReleaseAsset({ token, apiBaseUrl, uploadUrl: draft.upload_url, owner, repository,
        releaseId: draft.id, name: asset.name, mediaType: asset.mediaType,
        body: await openAsBlob(actualPath, { type: asset.mediaType }), ...(input.fetch ? { fetch: input.fetch } : {}) });
      if (!Number.isSafeInteger(uploaded.id) || uploaded.name !== asset.name || uploaded.state !== 'uploaded'
        || uploaded.size !== file.size || (uploaded.digest && uploaded.digest !== `sha256:${file.sha256}`)) {
        throw new Error(`GitHub returned invalid uploaded asset metadata: ${asset.name}`);
      }
    }
    publishAttempted = true;
    const release = await client.publishRelease(owner, repository, draft.id);
    published = true;
    if (release.id !== draft.id || release.tag_name !== plan.tagName || release.draft !== false || !release.html_url) {
      throw new Error('GitHub returned invalid published Release metadata');
    }
    const verified = await readReleaseStatusWithClient(client, context, plan);
    if (verified.decision.reason !== 'already-published') throw new Error('Published Release did not converge to the expected state');
    await finish({ name: 'Release', status: 'completed', conclusion: 'success', externalId,
      ...(detailsUrl ? { detailsUrl } : {}), title: '发布成功', summary: `${plan.tagName} 已发布 ${assets.assets.length} 个资产。` });
    return { state: 'passed', summary: 'Release published', releaseUrl: release.html_url };
  } catch (error) {
    const cleanup: string[] = [];
    if (publishAttempted && !published) {
      try {
        const reconciled = await readReleaseStatusWithClient(client, context, plan);
        if (reconciled.decision.reason === 'already-published') {
          published = true;
          await finish({ name: 'Release', status: 'completed', conclusion: 'success', externalId,
            ...(detailsUrl ? { detailsUrl } : {}), title: '发布成功', summary: `${plan.tagName} 已在发布响应异常后重新确认。` });
          return { state: 'passed', summary: 'Release published and reconciled',
            ...(reconciled.release?.html_url ? { releaseUrl: reconciled.release.html_url } : {}) };
        }
      } catch { /* The state is not a complete publication; continue controlled rollback. */ }
    }
    if (!published && ownsTag && !createdReleaseId) {
      try {
        const candidates = (await client.listReleases(owner, repository))
          .filter((release) => release.tag_name === plan.tagName && release.draft === true);
        if (candidates.length === 1 && Number.isSafeInteger(candidates[0]?.id) && Number(candidates[0]?.id) > 0) {
          createdReleaseId = Number(candidates[0]!.id);
        }
      } catch (reason) { cleanup.push(`Draft discovery failed: ${String(reason)}`); }
    }
    if (!published && createdReleaseId) {
      try { await client.deleteRelease(owner, repository, createdReleaseId); } catch (reason) {
        if (!(reason instanceof GitHubApiError) || reason.status !== 404) cleanup.push(`Release cleanup failed: ${String(reason)}`);
      }
    }
    if (!published && ownsTag && !cleanup.length) {
      try {
        const [tag, releases] = await Promise.all([
          client.getTagRef(owner, repository, plan.tagName), client.listReleases(owner, repository),
        ]);
        if (tag.ref === `refs/tags/${plan.tagName}` && tag.object?.type === 'commit'
          && tag.object.sha?.toLowerCase() === context.pullRequest.mergeSha
          && !releases.some((release) => release.tag_name === plan.tagName)) {
          await client.deleteTagRef(owner, repository, plan.tagName);
        } else {
          cleanup.push('Tag cleanup skipped because the tag or Release state changed');
        }
      } catch (reason) {
        if (!(reason instanceof GitHubApiError) || reason.status !== 404) cleanup.push(`Tag cleanup failed: ${String(reason)}`);
      }
    }
    const message = `${error instanceof Error ? error.message : String(error)}${cleanup.length ? `; ${cleanup.join('; ')}` : ''}`;
    try { await finish({ name: 'Release', status: 'completed', conclusion: 'failure', externalId,
      ...(detailsUrl ? { detailsUrl } : {}), title: '发布失败', summary: message.slice(0, 60000) }); } catch (reason) {
      throw new Error(`${message}; final Check update failed: ${String(reason)}`);
    }
    throw new Error(message);
  }
}
