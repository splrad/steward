import { channelFiles, type DeliveryUnit } from '../../core/src/delivery-config.js';
import { defaultBuildWorkflow } from '../../core/src/release-workflow.js';
import { releaseBodyMatches } from './release-body.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileDigest, verifyPublicationFiles, publicationManifestDigest, validateReleaseManifest, validateProductManifest, validateWorkflowManifest, type PublicationManifest } from './release-artifacts.js';
import { nativeEvidenceTransport } from './native-release-evidence.js';
import { isolatedGitHubEnvironment } from './build-environment.js';
import { assertReleaseAssetName } from '../../core/src/release-asset-name.js';
import type { EvidenceContext } from './native-release-evidence.js';

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
export interface ReleaseObject { id: number; tag_name: string; draft: boolean; immutable: boolean; body: string; html_url: string; upload_url: string; target_commitish: string; prerelease?: boolean }
interface Asset { id: number; name: string; size: number; digest: string | null; state: string; label?: string; uploader?: { id: number } }
export interface ReleaseTarget { delivery?: DeliveryUnit; publicBody?: string; official?: { prerelease: boolean }; manifest: PublicationManifest; releaseId: number; directory: string; appBotId: number }
export type ReleaseIntent = Omit<ReleaseTarget, 'releaseId'> & { releaseId: number | null };
export type ReleaseDownload = (repository: string, assetId: number, destination: string, anonymous: boolean) => Promise<void>;

export function releaseAssetNames({manifest,delivery}: Pick<ReleaseIntent,'manifest'|'delivery'>) {
  // A v4 manifest is sealed from the GitHub delivery job's archive only.
  if(manifest.schemaVersion===4)return manifest.artifacts.map(file=>file.path).sort();
  if(delivery)return channelFiles(delivery,'github-release',manifest.artifacts);
  return [...manifest.artifacts.map(asset=>asset.path),'sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS'].sort();
}

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

async function tagSource(json: (args:string[])=>Promise<any>, repository: string, tag: string, sourceSha: string) {
  const base = `repos/${repository}`; let ref;
  try { ref = await json(['api', `${base}/git/ref/tags/${encodeURIComponent(tag)}`]); }
  catch (error) {
    if (!absent(error)) throw error;
    const matches = await json(['api', `${base}/git/matching-refs/tags/${encodeURIComponent(tag)}`]);
    if (!Array.isArray(matches) || matches.some(item => item.ref === `refs/tags/${tag}`)) reject('tag absence unknown');
    return null;
  }
  if (ref.ref !== `refs/tags/${tag}`) reject('tag ref identity');
  let object = ref.object; const seen = new Set<string>();
  while (object?.type === 'tag') {
    if (!/^[a-f0-9]{40}$/.test(object.sha) || seen.has(object.sha) || seen.size >= 8) reject('tag chain');
    seen.add(object.sha);
    const annotated = await json(['api', `${base}/git/tags/${object.sha}`]);
    if (annotated.sha !== object.sha) reject('annotated tag identity');
    object = annotated.object;
  }
  if (object?.type !== 'commit' || object.sha !== sourceSha) reject('tag source changed');
  return object.sha;
}

/** Verify an already published official Release from the protected receipt and public download bytes. */
export async function verifyOfficialPublicationProof(context: EvidenceContext, unitId: string,
  gh: GhCommand = nativeGhCommand, download: ReleaseDownload = nativeReleaseDownload(process.env.GH_TOKEN)) {
  const unit = context.cycle.units.find(item=>item.id===unitId);
  if (!context.cycle.officialRelease || !unit?.releaseId || !unit.assets.length || !unit.githubDelivery)
    reject('official published receipt required');
  const repository = context.repository, releaseId = unit.releaseId;
  const json = async (args: string[]) => JSON.parse(await gh(args));
  const verifyTag = async () => {
    if (!await tagSource(json,repository,unit.tag,context.cycle.sourceSha)) reject('tag missing');
  };
  const inventory = async (): Promise<Asset[]> => {
    const pages = await json(['api', '--paginate', '--slurp', `repos/${repository}/releases/${releaseId}/assets?per_page=100`]);
    if (!Array.isArray(pages) || !pages.length || pages.some(page=>!Array.isArray(page))) reject('official published asset pages');
    const assets: Asset[] = pages.flat();
    if (assets.length!==unit.assets.length || new Set(assets.map(asset=>asset.id)).size!==assets.length
      || new Set(assets.map(asset=>asset.name)).size!==assets.length
      || assets.some(asset=>!Number.isSafeInteger(asset.id)||asset.id<1||asset.state!=='uploaded')) reject('official published asset inventory');
    return assets.map(({id,name,size,digest,state})=>({id,name,size,digest,state})).sort((first,second)=>first.id-second.id);
  };
  const initial = await inventory();
  await verifyTag();
  const anonymous = await releaseReadIsAnonymous(gh, repository, context.repositoryId);
  const nativeEvidence = [await json(['release','verify',unit.tag,'--repo',repository,'--format','json'])];
  const directory = await mkdtemp(join(tmpdir(),'steward-official-proof-'));
  try {
    for (const asset of initial) {
      assertReleaseAssetName(asset.name);
      const expected = unit.assets.find(item=>item.path===asset.name);
      if (!expected || expected.size!==asset.size || asset.digest && asset.digest!==`sha256:${expected.sha256}`)
        reject('official published asset identity');
      const path = join(directory,asset.name);
      await download(repository,asset.id,path,anonymous);
      const actual = await fileDigest(directory,asset.name);
      if (actual.size!==expected.size || actual.sha256!==expected.sha256) reject('official published bytes');
      nativeEvidence.push(await json(['release','verify-asset',unit.tag,path,'--repo',repository,'--format','json']));
    }
    if (JSON.stringify(initial)!==JSON.stringify(await inventory())) reject('official published assets changed during proof');
    await verifyTag();
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
  return nativeEvidence;
}

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
    if(m.schemaVersion===4)validateWorkflowManifest(m);
    else if(m.schemaVersion===3)validateProductManifest(m);
    else validateReleaseManifest(m);
    if (!Number.isSafeInteger(target.appBotId) || target.appBotId < 1) reject('App identity');
    const repository = await this.json(['api', `repos/${m.fullName}`]);
    if (repository.id !== m.repositoryId || repository.full_name !== m.fullName || repository.archived !== false || repository.disabled !== false
      || typeof repository.private !== 'boolean') reject('repository identity or disabled');
    return repository;
  }
  private async uploadIntent(target: ReleaseTarget) {
    const m = target.manifest, digest = await publicationManifestDigest(target.directory,m);
    return `steward-upload:${createHash('sha256').update(JSON.stringify([m.repositoryId, m.unitId, m.tag, m.sourceSha, digest, target.releaseId])).digest('hex')}`;
  }
  private async list(path: string): Promise<any[]> {
    const pages = await this.json(['api', '--paginate', '--slurp', path + '?per_page=100']);
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) reject('incomplete native pages');
    const values = pages.flat();
    if (values.some(value => !Number.isSafeInteger(value.id) || value.id < 1) || new Set(values.map(value => value.id)).size !== values.length) reject('ambiguous native IDs');
    return values;
  }
  /** Claim only the official, unique Release. The stored ID fences subsequent recovery. */
  async claimOfficialDraft(target: ReleaseIntent): Promise<ReleaseTarget> {
    if (!target.official || !target.publicBody?.trim()) reject('approved official body required');
    await this.repository(target);
    const releases = (await this.list(`repos/${target.manifest.fullName}/releases`)).filter(value => value.tag_name === target.manifest.tag);
    if (releases.length !== 1 || target.releaseId !== null && target.releaseId !== releases[0].id)
      reject('official release inventory changed');
    const bound = { ...target, releaseId: releases[0].id };
    const release = await this.read(bound);
    if (release.draft) this.assertOfficialDraft(bound, release);
    else if (target.releaseId === null) reject('unbound official release already public');
    return bound;
  }
  private assertOfficialDraft(target: ReleaseTarget, release: ReleaseObject) {
    if (!target.official || !release.draft || release.immutable !== false || release.target_commitish !== target.manifest.sourceSha
      || release.prerelease !== target.official.prerelease || release.body !== target.publicBody) reject('official draft differs from approval');
  }
  async read(target: ReleaseTarget): Promise<ReleaseObject> {
    const { manifest: m, releaseId } = target;
    await this.repository(target);
    if (!Number.isSafeInteger(releaseId) || releaseId < 1) reject('invalid release ID');
    const release = await this.json(['api', `repos/${m.fullName}/releases/${releaseId}`]);
    if (release.author?.id !== target.appBotId) reject('untrusted release creator');
    if (release.id !== releaseId || release.tag_name !== m.tag || typeof release.draft !== 'boolean') reject('release identity');
    if (!await tagSource(args=>this.json(args),m.fullName,m.tag,m.sourceSha)) reject('tag missing');
    return { id: release.id, tag_name: release.tag_name, draft: release.draft, immutable: release.immutable,
      body: release.body, html_url: release.html_url, upload_url: release.upload_url, target_commitish: release.target_commitish,
      ...(typeof release.prerelease === 'boolean' ? { prerelease: release.prerelease } : {}) };
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
    return releaseAssetNames(target);
  }
  private notes(target: ReleaseIntent) {
    return target.publicBody ?? readFile(join(target.directory,'release-notes.md'),'utf8');
  }
  async verifyAttestation(target: ReleaseIntent, file: string) {
  const m = target.manifest;
  const attestation = await this.json(['attestation', 'verify', file, '--repo', target.manifest.fullName,
    '--signer-workflow', m.schemaVersion !== 2 ? `${m.fullName}/${m.buildWorkflow ?? defaultBuildWorkflow}` : 'splrad/steward/.github/workflows/product-release.yml',
    '--signer-digest', m.schemaVersion !== 2 ? m.sourceSha : m.policySha,
    '--source-digest', m.sourceSha, '--source-ref', m.schemaVersion !== 2 ? m.buildRef : `refs/tags/${m.tag}`, '--deny-self-hosted-runners', '--format', 'json']);
  if (!Array.isArray(attestation) || !attestation.length) reject('missing native attestation result');
  const invocation = `https://github.com/${target.manifest.fullName}/actions/runs/${target.manifest.runId}/attempts/`;
  if (!attestation.some(result => {
    const certificate = result?.verificationResult?.signature?.certificate;
    const uri = certificate?.runInvocationURI;
    if (typeof uri !== 'string' || !uri.startsWith(invocation)) return false;
    const attempt = uri.slice(invocation.length);
    return /^[1-9][0-9]*$/.test(attempt) && Number.isSafeInteger(Number(attempt))
      && (m.schemaVersion===4?Number(attempt)===m.delivery.attempt:Number(attempt)>=m.attempt)
      && certificate.sourceRepositoryIdentifier === String(m.repositoryId) && certificate.buildTrigger === 'workflow_dispatch';
  })) reject('attestation run identity');
    return attestation;
  }
  async freezeProof(target: ReleaseIntent) {
    if (target.manifest.schemaVersion === 2) reject('historical manifest is read-only');
    const m = target.manifest;
    await verifyPublicationFiles(target.directory, m);
    const runPath = 'repos/'+m.fullName+'/actions/runs/'+m.runId;
    const run = await this.json(['api', m.schemaVersion===4?runPath+'/attempts/'+m.attempt:runPath]);
    if (run.id !== m.runId || run.repository?.id !== m.repositoryId || run.head_repository?.id !== m.repositoryId
      || run.head_sha !== m.sourceSha || run.head_branch !== m.buildRef.slice('refs/heads/'.length)
      || run.event !== 'workflow_dispatch' || run.path !== (m.buildWorkflow ?? defaultBuildWorkflow)
      || m.schemaVersion===4&&run.workflow_id!==m.workflowId
      || run.actor?.id !== target.appBotId || run.status !== 'completed' || run.conclusion !== 'success'
      || (m.schemaVersion===4?run.run_attempt!==m.attempt:run.run_attempt<m.attempt)) reject('completed product Run required');
    if(m.schemaVersion!==4||m.attested)
      for (const name of this.names(target)) await this.verifyAttestation(target, resolve(target.directory, name));
    return run;
  }
  async verify(target: ReleaseTarget) {
    await verifyPublicationFiles(target.directory, target.manifest);
    const release = await this.read(target);
    if (release.draft || release.immutable !== true) reject('release not immutable and published');
    const m = target.manifest;
    if (!await releaseBodyMatches({ repository: m.fullName, repositoryId: m.repositoryId, releaseId: release.id, sourceSha: m.sourceSha,
      tag: release.tag_name, frozenDigest: createHash('sha256').update(await this.notes(target)).digest('hex') }, release.body,
      path => this.json(['api', `repos/${m.fullName}${path ? '/' + path : ''}`]))) reject('published body drift');
    const assets = await this.assets(target);
    if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(this.names(target))) reject('published asset set');
    const nativeEvidence: unknown[] = [];
    const anonymous = (await this.repository(target)).private === false;
    nativeEvidence.push(await this.json(['release', 'verify', target.manifest.tag, '--repo', target.manifest.fullName, '--format', 'json']));
    for (const asset of assets) {
      await this.compareAsset(target, asset, anonymous);
      const file = resolve(target.directory, asset.name);
      nativeEvidence.push(await this.json(['release', 'verify-asset', target.manifest.tag, file, '--repo', target.manifest.fullName, '--format', 'json']));
      if(m.schemaVersion!==4||m.attested)nativeEvidence.push(await this.verifyAttestation(target, file));
    }
    if (JSON.stringify(await this.read(target)) !== JSON.stringify(release) || JSON.stringify(await this.assets(target)) !== JSON.stringify(assets)) reject('published object changed during read');
    return { releaseId: release.id, url: release.html_url, mode: 'verified' as const, nativeEvidence };
  }
  async uploadDraft(target: ReleaseTarget, retained: readonly {assetId:number;name:string}[],
    recordAsset: (asset:{assetId:number;name:string})=>Promise<void>,admit:()=>Promise<void>=async()=>{}) {
    if (!this.names(target).length) reject('GitHub channel disabled');
    await verifyPublicationFiles(target.directory, target.manifest);
    await this.claimOfficialDraft(target);
    const names = this.names(target);
    await this.freezeProof(target);
    const uploadIntent = await this.uploadIntent(target);
    for (const asset of await this.assets(target)) {
      if (!names.includes(asset.name)) reject('unexpected draft asset');
      if (asset.state === 'starter') {
        const expected = await fileDigest(target.directory, asset.name);
        if (asset.size !== 0 || asset.label !== `${uploadIntent}:${expected.sha256}` || asset.uploader?.id !== target.appBotId) reject('unproven starter asset');
      } else await this.compareAsset(target, asset);
    }
    const guard = async () => {
      await admit();
      await verifyPublicationFiles(target.directory, target.manifest);
      await this.claimOfficialDraft(target);
      const draft = await this.read(target);
      this.assertOfficialDraft(target, draft);
      return draft;
    };
    for (const name of names) {
      const assets = await this.assets(target);
      if (assets.some(asset => !names.includes(asset.name))) reject('unexpected draft asset');
      let asset = assets.find(asset => asset.name === name);
      const expected = await fileDigest(target.directory, name), label = `${uploadIntent}:${expected.sha256}`;
      const saved=retained.find(receipt=>receipt.name===name);
      if(saved&&(asset?.id!==saved.assetId||asset.state!=='uploaded')) reject('retained draft asset ID changed');
      if (asset?.state === 'starter') {
        if (asset.size !== 0 || asset.label !== label || asset.uploader?.id !== target.appBotId) reject('unproven starter asset');
        await guard(); const oldId = asset.id;
        try { await this.gh(['api', '--method', 'DELETE', `repos/${target.manifest.fullName}/releases/assets/${oldId}`]); } catch { /* Exact-ID inventory decides. */ }
        const current = await this.assets(target);
        if (current.some(value => value.id === oldId)) reject('starter removal unknown');
        asset = current.find(value => value.name === name);
      }
      if (!asset) {
        const currentDraft = await guard();
        const upload = currentDraft.upload_url?.replace(/\{.*\}$/, '');
        if (upload !== `https://uploads.github.com/repos/${target.manifest.fullName}/releases/${target.releaseId}/assets`) reject('upload URL identity');
        let uploadError: unknown, uploaded: Asset|undefined;
        try { uploaded = await this.json(['api', '--method', 'POST', `${upload}?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label)}`,
          '-H', 'Content-Type: application/octet-stream', '--input', resolve(target.directory, name)]); }
        catch (error) { uploadError = error; }
        // A lost response is resolved by observing the same object, never by blind retransmission.
        await this.read(target);
        asset = (await this.assets(target)).find(asset => asset.name === name);
        if (!asset) { if (uploadError) throw uploadError; reject('upload not observed'); }
        if(uploaded && (uploaded.id!==asset.id||uploaded.name!==asset.name||uploaded.state!=='uploaded'
          || uploaded.size!==expected.size || uploaded.digest && uploaded.digest!==`sha256:${expected.sha256}`)) reject('upload response identity');
      }
      if(!saved) await recordAsset({assetId:asset.id,name});
      await this.compareAsset(target, asset);
      if (asset.label !== name) {
        if ((asset.label && asset.label !== label) || asset.uploader?.id !== target.appBotId) reject('unproven draft label');
        await guard();
        let failure;
        try { await this.mutate('PATCH', `repos/${target.manifest.fullName}/releases/assets/${asset.id}`, { name, label: name }); }
        catch (error) { failure = error; }
        const observed = (await this.assets(target)).find(item => item.id === asset.id);
        if (observed?.name !== name || observed.label !== name) {
          if (failure) throw failure;
          reject('asset label edit not observed');
        }
      }
    }
    const assets = await this.assets(target);
    if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(names)) reject('draft asset set');
    for (const asset of assets) {
      if (asset.label !== asset.name) reject('unexpected public asset label');
      await this.compareAsset(target, asset);
    }
    await guard();
    if (JSON.stringify(await this.assets(target)) !== JSON.stringify(assets)) reject('draft assets changed during upload');
    const release=await this.read(target);
    this.assertOfficialDraft(target,release);
    return {releaseId:release.id,url:release.html_url,assets:assets.map(({id,name})=>({assetId:id,name}))};
  }
}
