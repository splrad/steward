import { readFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { githubHeaders } from '../../github/src/api-version.js';
import { candidatePaths, candidateProjection, canonicalReleaseJson, newReleaseReceipt, receiptDigest, releaseAssert, type FrozenRelease, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { assertBuildSourcePath } from './build-manifest.js';
import { validateReleaseSource, validateReleaseEvidence } from '../../core/src/release-bundle.js';
import { GitHubClient, uploadReleaseAsset } from '../../github/src/index.js';
import { optionalReleaseRead } from '../../github/src/release-candidate.js';

export function refreshingReleaseToken(issue: () => Promise<string>, now = Date.now): () => Promise<string> {
  let token: string | undefined, refreshAt = 0, pending: Promise<string> | undefined;
  return async () => {
    if (token && now() < refreshAt) return token;
    if (!pending) pending = issue().then(value => { token = value; refreshAt = now() + 45 * 60_000; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
}

export class ReleaseReceiptClient {
  constructor(private readonly base: string, private readonly token: string, readonly repositoryId: number, readonly tag: string, private readonly transport: typeof fetch = fetch) {
    const url = new URL(base); releaseAssert(url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'RUNTIME_URL');
    releaseAssert(/^v\d+\.\d+\.\d+$/.test(tag), 'TAG');
  }
  async request<T>(action = '', body?: unknown, suffix?: string): Promise<T> {
    const response = await this.transport(`${this.base.replace(/\/$/, '')}/internal/releases/${this.repositoryId}/${suffix ?? this.tag + (action ? '/' + action : '')}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const bytes = await response.text(); releaseAssert(Buffer.byteLength(bytes) <= 1024 * 1024, 'RUNTIME_RESPONSE');
    if (!response.ok) throw new Error(`release-runtime-${response.status}:${bytes.slice(0, 200)}`);
    return JSON.parse(bytes) as T;
  }
  async putObject(bytes: Uint8Array): Promise<string> {
    const digest = receiptDigest(bytes), chunkSize = 48 * 1024, total = Math.ceil(bytes.length / chunkSize);
    releaseAssert(total > 0 && total <= 2048, 'OBJECT_LIMIT');
    for (let part = 0; part < total; part++) await this.request('', { total, bytesBase64: Buffer.from(bytes.subarray(part * chunkSize, (part + 1) * chunkSize)).toString('base64') }, `objects/${digest}/${part}`);
    return digest;
  }
}
export interface LifecycleSession {
  receipt: ReleaseReceipt;
  act(action: string, fields?: Record<string, unknown>): Promise<ReleaseReceipt>;
}
export async function writeCandidateReviewCheck(gh: GitHubClient, receipt: ReleaseReceipt, appId: number): Promise<void> {
  releaseAssert(receipt.pullNumber && receipt.headSha, 'PR_UNBOUND');
  const [owner, repo] = receipt.frozen.fullName.split('/') as [string, string];
  const name = 'Release Candidate Review', external_id = `release:${receipt.candidateId}:${receipt.revision}:${receipt.headSha}`;
  const matching = (await gh.listAllCheckRuns(owner, repo, receipt.headSha, 'all')).filter((c: any) => c.name === name && c.app?.id === appId && c.head_sha === receipt.headSha && c.external_id === external_id);
  releaseAssert(matching.length <= 1, 'CHECK_AMBIGUOUS');
  const approved = ['approved', 'merged', 'publishing', 'verified'].includes(receipt.phase) && !receipt.paused;
  const notesUrl = `https://github.com/${receipt.frozen.fullName}/blob/${receipt.headSha}/${candidatePaths(receipt)[1]}`;
  const body = { name, external_id, status: 'completed', conclusion: approved ? 'success' : 'action_required',
    output: { title: approved ? '发布说明内容已批准' : '发布说明等待维护者处理', summary: [
      `状态：${receipt.phase}${receipt.error ? `；${receipt.error}` : ''}`, `[查看并编辑候选正文](${notesUrl})`,
      `产品提交：${receipt.frozen.productTargetSha}`, `候选 head：${receipt.headSha}`, `冻结来源摘要：${receipt.frozen.sourceDigest}`,
      '批准绑定当前提交及正文；正式发布还需真人手动合并。',
    ].join('\n\n'), ...(!approved ? { annotations: [{ path: candidatePaths(receipt)[1], start_line: 1, end_line: 1, annotation_level: 'notice', message: receipt.error ?? '请核对内容并批准当前提交。' }] } : {}) } };
  if (matching[0]) await gh.updateCheckRun(owner, repo, matching[0].id, body);
  else await gh.createCheckRun(owner, repo, { ...body, head_sha: receipt.headSha });
}
export async function withReleaseClaim<T>(receipts: ReleaseReceiptClient, operation: (session: LifecycleSession) => Promise<T>): Promise<T> {
  const claim = await receipts.request<{ token: string; receipt: ReleaseReceipt }>('claim', {});
  const session: LifecycleSession = { receipt: claim.receipt, async act(action, fields = {}) {
    session.receipt = await receipts.request<ReleaseReceipt>(action, { ...fields, token: claim.token, version: session.receipt.version }); return session.receipt;
  } };
  try { return await operation(session); }
  catch (error) { try { await session.act('record-error'); } catch { /* Preserve the original error and durable operation intent. */ } throw error; }
  finally { try { await receipts.request('release-claim', { token: claim.token }); } catch { /* The bounded lease expires; preserve operation outcome. */ } }
}
/** Dedicated candidate creation only; no ordinary push or product code is executed here. */
export async function createReleaseCandidate(gh: GitHubClient, session: LifecycleSession): Promise<ReleaseReceipt> {
  let r = session.receipt;
  if (r.pullNumber) return r;
  releaseAssert(!r.paused && r.phase === 'prepared', 'CANDIDATE_STATE');
  const [owner, repo] = r.frozen.fullName.split('/') as [string, string];
  if (!r.initialCommitSha) {
    const paths = candidatePaths(r);
    const entries = await Promise.all([canonicalReleaseJson(candidateProjection(r)), r.draftNotes].map(async (content, index) => ({ path: paths[index], mode: '100644', type: 'blob', sha: (await gh.createBlob(owner, repo, content)).sha })));
    const tree = await gh.createTree(owner, repo, { base_tree: r.candidateBase?.tree ?? r.frozen.productTree, tree: entries });
    const commit = await gh.createCommit(owner, repo, { message: `docs(release): prepare ${r.frozen.targetTag}`, tree: tree.sha, parents: [r.candidateBase?.sha ?? r.frozen.productTargetSha] });
    r = await session.act('candidate-commit', { sha: commit.sha });
  }
  const reference = await optionalReleaseRead(() => gh.getRef(owner, repo, `heads/${r.branch}`));
  if (reference) releaseAssert(reference.object?.sha === r.initialCommitSha, 'BRANCH_OCCUPIED');
  else {
    try { await gh.createRef(owner, repo, `refs/heads/${r.branch}`, r.initialCommitSha!); }
    catch (error) { const actual = await optionalReleaseRead(() => gh.getRef(owner, repo, `heads/${r.branch}`)); if (actual?.object?.sha !== r.initialCommitSha) throw error; }
  }
  const lookup = async () => {
    const matches = (await gh.listAllPullRequests(owner, repo)).filter((p: any) => p.head?.ref === r.branch && p.head?.repo?.id === r.frozen.repositoryId);
    releaseAssert(matches.length <= 1, 'PR_OCCUPIED'); return matches[0] ?? null;
  };
  let pull = await lookup();
  if (!pull) {
    try { pull = await gh.createPullRequest(owner, repo, { head: r.branch, base: r.frozen.defaultBranch, title: `docs(release): ${r.frozen.targetTag} 发布说明`,
        body: `请直接编辑候选 Markdown，核对升级操作、用户变化及贡献者。对当前提交批准后，由真人手动合并。批准本身不会发布。\n\n候选：${r.candidateId} / revision ${r.revision}\n\n请同时确认仓库作者 ID（${r.frozen.authorIds.join(", ")}）及贡献者展示集合；确认内容后再批准当前提交。${r.rebuildRequestKey ? '\n\n本修订的重建资产发生变化，请重新核对以下 SHA-256 并批准当前提交；旧修订的批准不适用。\n\n' + r.frozen.assets.map(a => `- ${a.name} (${a.size} bytes): ${a.sha256}`).join('\n') : ''}`, draft: false }); }
    catch (error) { pull = await lookup(); if (!pull) throw error; }
  }
  return session.act('bind', { pullNumber: pull.number });
}
export async function prepareReleaseCandidate(input: { gh: GitHubClient; receipts: ReleaseReceiptClient; frozen: FrozenRelease; source: Uint8Array; evidence: Uint8Array; notes: string; assetDirectory: string }): Promise<ReleaseReceipt> {
  const { frozen: f } = input;
  newReleaseReceipt(f, input.notes);
  const source = validateReleaseSource(input.source, f);
  validateReleaseEvidence(input.evidence, f, source);
  await verifyReleaseAssetFiles(f, input.assetDirectory);
  await input.receipts.putObject(input.source); await input.receipts.putObject(input.evidence);
  await input.receipts.request('prepare', { frozen: f, draftNotes: input.notes });
  return withReleaseClaim(input.receipts, session => createReleaseCandidate(input.gh, session));
}
export async function verifyReleaseAssetFiles(f: FrozenRelease, directory: string): Promise<void> {
  if (!f.assets.length) return;
  releaseAssert(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(f.assets.map(a => a.name).sort()), 'ASSET_DIRECTORY');
  for (const asset of f.assets) {
    const path = await assertBuildSourcePath(directory, asset.name), stat = await lstat(path);
    releaseAssert(stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.size, 'ASSET_FILE');
    const bytes = await readFile(path); releaseAssert(bytes.length === asset.size && receiptDigest(bytes) === asset.sha256, 'ASSET_BYTES');
  }
}
/** Expired build artifacts cannot block readback of an already published release. */
export async function recoverReleaseAssets(gh: GitHubClient, session: LifecycleSession, verifyDownloads: (receipt: ReleaseReceipt) => Promise<void>): Promise<ReleaseReceipt> {
  const r = session.receipt;
  if (!r.paused && r.releaseId) {
    const [owner, repo] = r.frozen.fullName.split('/') as [string, string];
    const release = await gh.request<any>('GET', `/repos/${owner}/${repo}/releases/${r.releaseId}`);
    if (release.draft === false) {
      await verifyDownloads(r);
      return session.act('verify', { downloaded: r.frozen.assets.map(a => a.sha256) });
    }
  }
  return session.act('ensure-assets', { unavailable: true });
}

/** Publication consumes only the server-sealed exact bytes and the previously frozen asset set. */
export async function publishReleaseCandidate(input: { gh: GitHubClient; session: LifecycleSession; assetDirectory: string; upload: (release: any, asset: FrozenRelease['assets'][number]) => Promise<unknown>; verifyDownloads: (receipt: ReleaseReceipt) => Promise<void> }): Promise<ReleaseReceipt> {
  const { gh, session } = input;
  let r = session.receipt;
  const [owner, repo] = r.frozen.fullName.split('/') as [string, string];
  const find = () => optionalReleaseRead(() => gh.getReleaseByTag(owner, repo, r.frozen.targetTag));
  let release = r.releaseId ? await gh.request<any>('GET', `/repos/${owner}/${repo}/releases/${r.releaseId}`) : await find();
  if (r.phase === 'verified' || (r.releaseId && release?.draft === false)) { await input.verifyDownloads(r); return session.act('verify', { downloaded: r.frozen.assets.map(a => a.sha256) }); }
  await verifyReleaseAssetFiles(r.frozen, input.assetDirectory);
  await session.act('permit');
  if (!r.releaseId) {
    if (release) {
      releaseAssert(r.operation?.kind === 'create-release', 'EXTERNAL_RELEASE');
    } else {
      releaseAssert(!r.operation, 'CREATION_OUTCOME_UNKNOWN');
      const existingTag = await optionalReleaseRead(() => gh.getGitRef(owner, repo, `tags/${r.frozen.targetTag}`));
      releaseAssert(!existingTag, 'TAG_OCCUPIED');
      r = await session.act('operation', { kind: 'create-release' });
      await session.act('permit');
      try { release = await gh.createRelease(owner, repo, { tag_name: r.frozen.targetTag, target_commitish: r.frozen.productTargetSha,
        name: `${r.frozen.title} [${r.operation!.key}]`, body: r.approvedNotes, draft: true, prerelease: false, make_latest: 'true' }); }
      catch (error) { release = await find(); if (!release) throw error; }
    }
    r = await session.act('record-release');
  }
  r = await session.act('record-assets');
  for (const asset of r.frozen.assets) {
    if (r.assetIds[asset.name]) continue;
    r = await session.act('operation', { kind: 'upload-asset' });
    await session.act('permit');
    // If a response is lost, the next run records the remote asset before deciding to upload.
    await input.upload(release, asset);
    r = await session.act('record-assets');
  }
  await session.act('operation', { kind: 'publish' });
  await session.act('permit');
  await gh.updateRelease(owner, repo, r.releaseId!, { name: r.frozen.title, draft: false, prerelease: false, make_latest: 'true' });
  await input.verifyDownloads(r);
  return session.act('verify', { downloaded: r.frozen.assets.map(a => a.sha256) });
}
export async function verifyReleaseDownloads(receipt: ReleaseReceipt, token: string | (() => Promise<string>), transport: typeof fetch = fetch, beforeAsset: () => Promise<unknown> = async () => {}): Promise<void> {
  for (const asset of receipt.frozen.assets) {
    await beforeAsset();
    const credential = typeof token === 'string' ? token : await token();
    const signal = AbortSignal.timeout(releaseAssetTransferTimeout(asset.size));
    const id = receipt.assetIds[asset.name]; releaseAssert(id, 'DOWNLOAD_ID');
    let url = `https://api.github.com/repos/${receipt.frozen.fullName}/releases/assets/${id}`;
    let response: Response | undefined;
    for (let hop = 0; hop < 5; hop++) {
      const parsed = new URL(url);
      releaseAssert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !parsed.hash &&
        (hop === 0 ? parsed.hostname === 'api.github.com' : ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)), 'DOWNLOAD_URL');
      response = await transport(url, { redirect: 'manual', signal, headers: hop === 0 ? { ...githubHeaders(credential, receipt.frozen.policySha), Accept: 'application/octet-stream' } : {} });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location'); releaseAssert(location, 'DOWNLOAD_REDIRECT'); url = new URL(location, url).href;
      await response.body?.cancel();
    }
    releaseAssert(response?.ok && response.body, 'DOWNLOAD_RESPONSE');
    const reader = response.body.getReader(), hash = createHash('sha256'); let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; releaseAssert(size <= asset.size, 'DOWNLOAD_SIZE'); hash.update(chunk.value); }
    } finally { await reader.cancel(); }
    releaseAssert(size === asset.size && hash.digest('hex') === asset.sha256, 'DOWNLOAD_DIGEST');
  }
}
export function releaseAssetTransferTimeout(size: number): number {
  releaseAssert(Number.isSafeInteger(size) && size > 0 && size <= 1024 ** 3, 'ASSET_SIZE');
  return 60_000 + Math.ceil(size / (4 * 1024 ** 2)) * 1000;
}
export function releasePublishTimeoutMinutes(assets: FrozenRelease['assets']): number {
  const total = assets.reduce((sum, a) => sum + a.size, 0);
  releaseAssert(assets.length <= 128 && total <= 4 * 1024 ** 3, 'ASSET_SIZE');
  // Initial artifact download, per-file upload/readback, and setup/finalization.
  const milliseconds = 20 * 60_000 + Math.ceil(total / (4 * 1024 ** 2)) * 1000
    + 2 * assets.reduce((sum, a) => sum + releaseAssetTransferTimeout(a.size), 0);
  return Math.ceil(milliseconds / 60_000);
}
export function releaseUploader(token: string | (() => Promise<string>), policySha: string, directory: string) {
  return async (release: any, asset: FrozenRelease['assets'][number]) => {
    const base = String(release.upload_url).split('{')[0]!, url = new URL(base);
    releaseAssert(url.origin === 'https://uploads.github.com' && /^\/repos\/[^/]+\/[^/]+\/releases\/\d+\/assets$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash, 'UPLOAD_URL');
    return uploadReleaseAsset({ token: typeof token === 'string' ? token : await token(), policySha, uploadUrl: release.upload_url, filePath: join(directory, asset.name), fileName: asset.name, expectedSha256: asset.sha256, transport: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(releaseAssetTransferTimeout(asset.size)) }) });
  };
}
