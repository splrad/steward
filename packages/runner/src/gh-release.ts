import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileDigest, verifySealedArtifacts, validateReleaseManifest, validateProductManifest, type ReleaseManifest, type ProductReleaseManifest } from './release-artifacts.js';
import { nativeEvidenceTransport } from './native-release-evidence.js';
import { isolatedGitHubEnvironment } from './build-environment.js';

export type GhCommand = (args: readonly string[]) => Promise<string>;
export type RulesRead = (repository: string, ruleId?: number) => Promise<string>;
/** Only the control plane's verified repository and numeric rule ID reach this adapter. */
export const nativeRulesRead: RulesRead = async (repository, ruleId) => {
  if (!/^splrad\/(?:steward|LayerScape|\.github)$/.test(repository)
    || ruleId !== undefined && (!Number.isSafeInteger(ruleId) || ruleId < 1)) throw new Error('RULES_READ: target');
  if (!process.env.RULES_READ_TOKEN || process.env.RULES_READ_REPOSITORY !== repository) throw new Error('RULES_READ: scoped credential unavailable');
  const args = ruleId === undefined
    ? ['api', '--paginate', '--slurp', `repos/${repository}/rulesets?includes_parents=true&per_page=100`]
    : ['api', `repos/${repository}/rulesets/${ruleId}`];
  return nativeGhCommand(args, process.env.RULES_READ_TOKEN);
};
/** The caller selects one credential. API paths never select or upgrade credentials. */
export async function nativeGhCommand(args: readonly string[], token: string | undefined = process.env.GH_TOKEN): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'steward-gh-'));
  try {
    const env = isolatedGitHubEnvironment(process.env, home, token);
    return (await promisify(execFile)('gh', [...args], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env,
    })).stdout;
  } finally { await rm(home, { recursive: true, force: true }); }
}
export interface ReleaseObject { id: number; tag_name: string; draft: boolean; immutable: boolean; body: string; html_url: string; upload_url: string; target_commitish: string }
interface Asset { id: number; name: string; size: number; digest: string | null; state: string; label?: string; uploader?: { id: number } }
export interface ReleaseTarget { manifest: ReleaseManifest | ProductReleaseManifest; releaseId: number; directory: string; appBotId: number }
export type ReleaseIntent = Omit<ReleaseTarget, 'releaseId'> & { releaseId: number | null };
export type ReleaseDownload = (repository: string, assetId: number, destination: string, anonymous: boolean) => Promise<void>;
export async function releaseReadIsAnonymous(gh:GhCommand,repository:string,repositoryId:number):Promise<boolean> {
  const value=JSON.parse(await gh(['api',`repos/${repository}`]));
  if(value.id!==repositoryId||value.full_name!==repository||value.archived!==false||value.disabled!==false||typeof value.private!=='boolean')
    reject('repository visibility');
  return value.private===false;
}
export function nativeReleaseDownload(token: string | undefined): ReleaseDownload {
  return async (repository, id, destination, anonymous) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(id) || id < 1) reject('download identity');
    const response = await nativeEvidenceTransport(anonymous ? undefined : token).request('GET', `/repos/${repository}/releases/assets/${id}`, 2 * 1024 ** 3 - 1);
    if (response.status !== 200) reject(`download HTTP ${response.status}`);
    await writeFile(destination, response.bytes, { flag: 'wx' });
  };
}
const absent = (error: unknown) => (error as { status?: number }).status === 404 || /\(HTTP 404\)/.test(String((error as { stderr?: string }).stderr));
function reject(reason: string): never { throw new Error(`GH_RELEASE: ${reason}`); }

/** Exact native IDs and frozen bytes are re-read before writes. */
export class NativeGitHubRelease {
  constructor(private readonly gh: GhCommand = nativeGhCommand, private readonly download: ReleaseDownload = nativeReleaseDownload(process.env.GH_TOKEN)) {}
  private async json(args: string[]): Promise<any> { return JSON.parse(await this.gh(args)); }
  private async mutate(method: string, path: string, body: object) {
    const home = await mkdtemp(join(tmpdir(), 'steward-release-request-'));
    try { const file = join(home, 'request.json'); await writeFile(file, JSON.stringify(body));
      return await this.gh(['api', '--method', method, path, '--input', file]);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
  private async repository(target: ReleaseIntent) {
    const m = target.manifest;
    if (m.schemaVersion === 3) validateProductManifest(m); else validateReleaseManifest(m);
    if (!Number.isSafeInteger(target.appBotId) || target.appBotId < 1) reject('App identity');
    const repository = await this.json(['api', `repos/${m.fullName}`]);
    if (repository.id !== m.repositoryId || repository.full_name !== m.fullName || repository.archived !== false || repository.disabled !== false
      || typeof repository.private !== 'boolean') reject('repository identity or disabled');
    return repository;
  }
  private async tagSource(target: ReleaseIntent): Promise<string | null> {
    const m = target.manifest, base = `repos/${m.fullName}`; let ref;
    try { ref = await this.json(['api', `${base}/git/ref/tags/${encodeURIComponent(m.tag)}`]); }
    catch (error) {
      if (!absent(error)) throw error;
      const matches = await this.json(['api', `${base}/git/matching-refs/tags/${encodeURIComponent(m.tag)}`]);
      if (!Array.isArray(matches) || matches.some(item => item.ref === `refs/tags/${m.tag}`)) reject('tag absence unknown');
      return null;
    }
    if (ref.ref !== `refs/tags/${m.tag}`) reject('tag ref identity');
    let object = ref.object; const seen = new Set<string>();
    while (object?.type === 'tag') {
      if (!/^[a-f0-9]{40}$/.test(object.sha) || seen.has(object.sha) || seen.size >= 8) reject('tag chain');
      seen.add(object.sha); object = (await this.json(['api', `${base}/git/tags/${object.sha}`])).object;
    }
    if (object?.type !== 'commit' || object.sha !== m.sourceSha) reject('tag source changed');
    return object.sha;
  }
  async ensureTag(target: ReleaseIntent) {
    await this.freezeProof(target); await this.repository(target);
    if (await this.tagSource(target)) return;
    let failure;
    try { await this.mutate('POST', `repos/${target.manifest.fullName}/git/refs`, { ref: `refs/tags/${target.manifest.tag}`, sha: target.manifest.sourceSha }); }
    catch (error) { failure = error; }
    if (!await this.tagSource(target)) { if (failure) throw failure; reject('tag not observed'); }
  }
  private async intentMarker(target: ReleaseIntent) {
    const m = target.manifest, digest = (await fileDigest(target.directory, 'artifact-manifest.json')).sha256;
    return `<!-- steward-release:${createHash('sha256').update(JSON.stringify([m.repositoryId, m.unitId, m.tag, m.sourceSha, digest])).digest('hex')} -->`;
  }
  private async list(path: string): Promise<any[]> {
    const pages = await this.json(['api', '--paginate', '--slurp', path + '?per_page=100']);
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) reject('incomplete native pages');
    const values = pages.flat();
    if (values.some(value => !Number.isSafeInteger(value.id) || value.id < 1) || new Set(values.map(value => value.id)).size !== values.length) reject('ambiguous native IDs');
    return values;
  }
  async ensureDraft(target: ReleaseIntent): Promise<ReleaseTarget> {
    await this.ensureTag(target);
    if (target.releaseId !== null) { const bound = { ...target, releaseId: target.releaseId }; await this.read(bound); return bound; }
    const m = target.manifest, endpoint = `repos/${m.fullName}/releases`, marker = await this.intentMarker(target);
    let releases = (await this.list(endpoint)).filter(value => value.tag_name === m.tag);
    if (!releases.length) {
      let failure;
      try { await this.mutate('POST', endpoint, { tag_name: m.tag, target_commitish: m.sourceSha, name: m.tag, body: marker, draft: true, prerelease: m.version.includes('-') }); }
      catch (error) { failure = error; }
      releases = (await this.list(endpoint)).filter(value => value.tag_name === m.tag);
      if (!releases.length) { if (failure) throw failure; reject('draft not observed'); }
    }
    releases.sort((a, b) => a.id - b.id);
    for (const release of releases) {
      const actual = await this.read({ ...target, releaseId: release.id });
      if (actual.draft && (actual.target_commitish !== m.sourceSha
        || actual.body !== marker && actual.body !== await readFile(join(target.directory, 'release-notes.md'), 'utf8'))) reject('draft contains unproven data');
    }
    if (releases.length > 1) {
      for (const release of releases) if (!release.draft || release.body !== marker || release.target_commitish !== m.sourceSha
        || (await this.assets({ ...target, releaseId: release.id })).length) reject('duplicate release contains unproven data');
      for (const release of releases.slice(1)) {
        const duplicate = { ...target, releaseId: release.id };
        if ((await this.read(duplicate)).body !== marker || (await this.assets(duplicate)).length) reject('duplicate changed');
        try { await this.gh(['api', '--method', 'DELETE', `${endpoint}/${release.id}`]); } catch { /* Same-ID inventory decides. */ }
        if ((await this.list(endpoint)).some(value => value.id === release.id)) reject('duplicate removal unknown');
      }
    }
    return { ...target, releaseId: releases[0].id };
  }
  async read(target: ReleaseTarget): Promise<ReleaseObject> {
    const { manifest: m, releaseId } = target;
    await this.repository(target);
    if (!Number.isSafeInteger(releaseId) || releaseId < 1) reject('invalid release ID');
    const release = await this.json(['api', `repos/${m.fullName}/releases/${releaseId}`]);
    if (release.author?.id !== target.appBotId) reject('untrusted release creator');
    if (release.id !== releaseId || release.tag_name !== m.tag || typeof release.draft !== 'boolean') reject('release identity');
    if (!await this.tagSource(target)) reject('tag missing');
    return { id: release.id, tag_name: release.tag_name, draft: release.draft, immutable: release.immutable,
      body: release.body, html_url: release.html_url, upload_url: release.upload_url, target_commitish: release.target_commitish };
  }
  async assets(target: ReleaseTarget): Promise<Asset[]> {
    const pages = await this.json(['api', '--paginate', '--slurp', `repos/${target.manifest.fullName}/releases/${target.releaseId}/assets?per_page=100`]);
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) reject('incomplete asset pages');
    const assets: Asset[] = pages.flat();
    if (assets.some(asset => !Number.isSafeInteger(asset.id) || asset.id < 1 || typeof asset.name !== 'string'
      || !Number.isSafeInteger(asset.size) || asset.size < 0 || !['uploaded', 'starter'].includes(asset.state))
      || new Set(assets.map(asset => asset.id)).size !== assets.length
      || new Set(assets.map(asset => asset.name.toLowerCase())).size !== assets.length) reject('ambiguous asset inventory');
    return assets.map(({id,name,size,digest,state,label,uploader})=>({id,name,size,digest,state,...(label===undefined?{}:{label}),...(uploader===undefined?{}:{uploader:{id:uploader.id}})}));
  }
  async compareAsset(target: ReleaseTarget, asset: Asset, anonymous = false) {
    const expected = await fileDigest(target.directory, asset.name);
    if (asset.state !== 'uploaded' || expected.size !== asset.size || asset.digest && asset.digest !== `sha256:${expected.sha256}`) reject('same-name different bytes');
    const directory = await mkdtemp(join(tmpdir(), 'steward-release-readback-'));
    try {
      await this.download(target.manifest.fullName, asset.id, join(directory, asset.name), anonymous);
      const actual = await fileDigest(directory, asset.name);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) reject('downloaded bytes mismatch');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  names(target: ReleaseIntent) {
    return [...target.manifest.artifacts.map(asset => asset.path), 'sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'].sort();
  }
  async verifyAttestation(target: ReleaseIntent, file: string) {
  const m = target.manifest;
  const attestation = await this.json(['attestation', 'verify', file, '--repo', target.manifest.fullName,
    '--signer-workflow', m.schemaVersion === 3 ? `${m.fullName}/.github/workflows/steward-release-publish.yml` : 'splrad/steward/.github/workflows/product-release.yml',
    '--signer-digest', m.schemaVersion === 3 ? m.sourceSha : m.policySha,
    '--source-digest', m.sourceSha, '--source-ref', m.schemaVersion === 3 ? m.buildRef : `refs/tags/${m.tag}`, '--deny-self-hosted-runners', '--format', 'json']);
  if (!Array.isArray(attestation) || !attestation.length) reject('missing native attestation result');
  const invocation = `https://github.com/${target.manifest.fullName}/actions/runs/${target.manifest.runId}/attempts/`;
  if (!attestation.some(result => {
    const certificate = result?.verificationResult?.signature?.certificate;
    const uri = certificate?.runInvocationURI;
    if (typeof uri !== 'string' || !uri.startsWith(invocation)) return false;
    const attempt = uri.slice(invocation.length);
    return /^[1-9][0-9]*$/.test(attempt) && Number.isSafeInteger(Number(attempt)) && Number(attempt) >= target.manifest.attempt
      && certificate.sourceRepositoryIdentifier === String(target.manifest.repositoryId) && certificate.buildTrigger === 'workflow_dispatch';
  })) reject('attestation run identity');
    return attestation;
  }
  async freezeProof(target: ReleaseIntent) {
    if (target.manifest.schemaVersion !== 3) reject('historical manifest is read-only');
    const m = target.manifest;
    await verifySealedArtifacts(target.directory, m);
    const run = await this.json(['api', `repos/${m.fullName}/actions/runs/${m.runId}`]);
    if (run.id !== m.runId || run.repository?.id !== m.repositoryId || run.head_repository?.id !== m.repositoryId
      || run.head_sha !== m.sourceSha || run.head_branch !== m.buildRef.slice('refs/heads/'.length)
      || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/steward-release-publish.yml'
      || run.actor?.id !== target.appBotId || run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt < m.attempt) reject('completed product Run required');
    for (const name of this.names(target)) await this.verifyAttestation(target, resolve(target.directory, name));
    return run;
  }
  async verify(target: ReleaseTarget) {
    await verifySealedArtifacts(target.directory, target.manifest);
    const release = await this.read(target);
    if (release.draft || release.immutable !== true) reject('release not immutable and published');
    if (release.body !== await readFile(join(target.directory, 'release-notes.md'), 'utf8')) reject('published body drift');
    const assets = await this.assets(target);
    if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(this.names(target))) reject('published asset set');
    const nativeEvidence: unknown[] = [];
    const anonymous = (await this.repository(target)).private === false;
    nativeEvidence.push(await this.json(['release', 'verify', target.manifest.tag, '--repo', target.manifest.fullName, '--format', 'json']));
    for (const asset of assets) {
      await this.compareAsset(target, asset, anonymous);
      const file = resolve(target.directory, asset.name);
      nativeEvidence.push(await this.json(['release', 'verify-asset', target.manifest.tag, file, '--repo', target.manifest.fullName, '--format', 'json']));
      nativeEvidence.push(await this.verifyAttestation(target, file));
    }
    if (JSON.stringify(await this.read(target)) !== JSON.stringify(release) || JSON.stringify(await this.assets(target)) !== JSON.stringify(assets)) reject('published object changed during read');
    return { releaseId: release.id, url: release.html_url, mode: 'verified' as const, nativeEvidence };
  }
  async publish(target: ReleaseTarget) {
    await verifySealedArtifacts(target.directory, target.manifest);
    if (!(await this.read(target)).draft) return this.verify(target);
    const names = this.names(target);
    await this.freezeProof(target);
    for (const asset of await this.assets(target)) {
      if (!names.includes(asset.name)) reject('unexpected draft asset');
      if (asset.state === 'starter') {
        const expected = await fileDigest(target.directory, asset.name);
        if (asset.size !== 0 || asset.label !== `${await this.intentMarker(target)}:${expected.sha256}` || asset.uploader?.id !== target.appBotId) reject('unproven starter asset');
      } else await this.compareAsset(target, asset);
    }
    const guard = async () => {
      await this.repository(target);
      if (!(await this.read(target)).draft) reject('draft changed before write');
      await verifySealedArtifacts(target.directory, target.manifest);
    };
    for (const name of names) {
      const assets = await this.assets(target);
      if (assets.some(asset => !names.includes(asset.name))) reject('unexpected draft asset');
      let asset = assets.find(asset => asset.name === name);
      const expected = await fileDigest(target.directory, name), label = `${await this.intentMarker(target)}:${expected.sha256}`;
      if (asset?.state === 'starter') {
        if (asset.size !== 0 || asset.label !== label || asset.uploader?.id !== target.appBotId) reject('unproven starter asset');
        await guard(); const oldId = asset.id;
        try { await this.gh(['api', '--method', 'DELETE', `repos/${target.manifest.fullName}/releases/assets/${oldId}`]); } catch { /* Exact-ID inventory decides. */ }
        const current = await this.assets(target);
        if (current.some(value => value.id === oldId)) reject('starter removal unknown');
        asset = current.find(value => value.name === name);
      }
      if (!asset) {
        await guard();
        const upload = (await this.read(target)).upload_url?.replace(/\{.*\}$/, '');
        if (upload !== `https://uploads.github.com/repos/${target.manifest.fullName}/releases/${target.releaseId}/assets`) reject('upload URL identity');
        let uploadError: unknown;
        try { await this.gh(['api', '--method', 'POST', `${upload}?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label)}`,
          '-H', 'Content-Type: application/octet-stream', '--input', resolve(target.directory, name)]); }
        catch (error) { uploadError = error; }
        // A lost response is resolved by observing the same object, never by blind retransmission.
        await this.read(target);
        asset = (await this.assets(target)).find(asset => asset.name === name);
        if (!asset) { if (uploadError) throw uploadError; reject('upload not observed'); }
      }
      await this.compareAsset(target, asset);
    }
    const assets = await this.assets(target);
    if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(names)) reject('draft asset set');
    for (const asset of assets) await this.compareAsset(target, asset);
    const notes = await readFile(join(target.directory, 'release-notes.md'), 'utf8');
    if ((await this.read(target)).body !== notes) {
      await guard();
      let editError: unknown;
      try { await this.mutate('PATCH', `repos/${target.manifest.fullName}/releases/${target.releaseId}`, { tag_name: target.manifest.tag, body: notes }); }
      catch (error) { editError = error; }
      if ((await this.read(target)).body !== notes) { if (editError) throw editError; reject('body edit not observed'); }
    }
    await guard();
    let publishError: unknown;
    try { await this.mutate('PATCH', `repos/${target.manifest.fullName}/releases/${target.releaseId}`, { tag_name: target.manifest.tag, draft: false }); }
    catch (error) { publishError = error; }
    if ((await this.read(target)).draft) { if (publishError) throw publishError; reject('publication not observed'); }
    return this.verify(target);
  }
}
