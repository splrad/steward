import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileDigest, verifySealedArtifacts, validateReleaseManifest, type ReleaseManifest } from './release-artifacts.js';

export type GhCommand = (args: readonly string[]) => Promise<string>;
export type RulesRead = (repository: string, ruleId?: number) => Promise<string>;
/** Only the control plane's verified repository and numeric rule ID reach this adapter. */
export const nativeRulesRead: RulesRead = async (repository, ruleId) => {
  if (!/^splrad\/(?:steward|LayerScape|\.github)$/.test(repository)
    || ruleId !== undefined && (!Number.isSafeInteger(ruleId) || ruleId < 1)) throw new Error('RULES_READ: target');
  if (!process.env.RULES_READ_TOKEN || process.env.RULES_READ_REPOSITORY !== repository) throw new Error('RULES_READ: scoped credential unavailable');
  const { RULES_READ_TOKEN, POLICY_READ_TOKEN: _policy, GH_TOKEN: _target, GITHUB_TOKEN: _github, ...environment } = process.env;
  const args = ruleId === undefined
    ? ['api', '--paginate', '--slurp', `repos/${repository}/rulesets?includes_parents=true&per_page=100`]
    : ['api', `repos/${repository}/rulesets/${ruleId}`];
  return (await promisify(execFile)('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...environment, GH_TOKEN: RULES_READ_TOKEN, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } })).stdout;
};
export const nativeGhCommand: GhCommand = async args => (await promisify(execFile)('gh', [...args], {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  env: { ...process.env, RULES_READ_TOKEN: undefined, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    ...(args[0] === 'api' && args.some(arg => /^repos\/splrad\/steward(?:$|\/commits\/main$|\/compare\/|\/contents\/config\/(?:repositories|release\/(?:defaults|bootstrap))\.json\?ref=)/.test(arg)) && process.env.POLICY_READ_TOKEN ? { GH_TOKEN: process.env.POLICY_READ_TOKEN } : {}) },
})).stdout;
export interface ReleaseObject { id: number; tag_name: string; draft: boolean; immutable: boolean; body: string; html_url: string }
interface Asset { id: number; name: string; size: number; digest: string | null; state: string }
export interface ReleaseTarget { manifest: ReleaseManifest; releaseId: number; directory: string }
function reject(reason: string): never { throw new Error(`GH_RELEASE: ${reason}`); }

/** gh owns transport, authentication and signature verification. This adapter never creates a release. */
export class NativeGitHubRelease {
  constructor(private readonly gh: GhCommand = nativeGhCommand) {}
  private async json(args: string[]): Promise<any> { return JSON.parse(await this.gh(args)); }
  async read(target: ReleaseTarget): Promise<ReleaseObject> {
    const { manifest: m, releaseId } = target;
    validateReleaseManifest(m);
    if (!Number.isSafeInteger(releaseId) || releaseId < 1) reject('invalid release ID');
    const repository = await this.json(['api', `repos/${m.fullName}`]);
    if (repository.id !== m.repositoryId || repository.full_name !== m.fullName) reject('repository identity');
    const release = await this.json(['api', `repos/${m.fullName}/releases/${releaseId}`]);
    if (release.author?.id !== 301115370) reject('untrusted release creator');
    if (release.id !== releaseId || release.tag_name !== m.tag || typeof release.draft !== 'boolean') reject('release identity');
    const commit = await this.json(['api', `repos/${m.fullName}/commits/${encodeURIComponent(m.tag)}`]);
    if (commit.sha !== m.sourceSha) reject('tag source changed');
    return release;
  }
  private async assets(target: ReleaseTarget): Promise<Asset[]> {
    const pages = await this.json(['api', '--paginate', '--slurp', `repos/${target.manifest.fullName}/releases/${target.releaseId}/assets?per_page=100`]);
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) reject('incomplete asset pages');
    const assets: Asset[] = pages.flat();
    if (assets.some(asset => !Number.isSafeInteger(asset.id) || asset.id < 1 || typeof asset.name !== 'string'
      || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.state !== 'uploaded')
      || new Set(assets.map(asset => asset.id)).size !== assets.length
      || new Set(assets.map(asset => asset.name)).size !== assets.length) reject('ambiguous asset inventory');
    return assets;
  }
  private async compareAsset(target: ReleaseTarget, asset: Asset) {
    const expected = await fileDigest(target.directory, asset.name);
    if (expected.size !== asset.size || asset.digest && asset.digest !== `sha256:${expected.sha256}`) reject('same-name different bytes');
    const directory = await mkdtemp(join(tmpdir(), 'steward-release-readback-'));
    try {
      await this.gh(['release', 'download', target.manifest.tag, '--repo', target.manifest.fullName,
        '--pattern', asset.name, '--dir', directory]);
      const actual = await fileDigest(directory, asset.name);
      if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) reject('downloaded bytes mismatch');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private names(target: ReleaseTarget) {
    return [...target.manifest.artifacts.map(asset => asset.path), 'sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'].sort();
  }
  private async verifyAttestation(target: ReleaseTarget, file: string) {
  const attestation = await this.json(['attestation', 'verify', file, '--repo', target.manifest.fullName,
    '--signer-workflow', 'splrad/steward/.github/workflows/product-release.yml', '--signer-digest', target.manifest.policySha,
    '--source-digest', target.manifest.sourceSha, '--source-ref', `refs/tags/${target.manifest.tag}`, '--deny-self-hosted-runners', '--format', 'json']);
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
  async verify(target: ReleaseTarget) {
    await verifySealedArtifacts(target.directory, target.manifest);
    const release = await this.read(target);
    if (release.draft || release.immutable !== true) reject('release not immutable and published');
    if (release.body !== await readFile(join(target.directory, 'release-notes.md'), 'utf8')) reject('published body drift');
    const assets = await this.assets(target);
    if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(this.names(target))) reject('published asset set');
    const nativeEvidence: unknown[] = [];
    nativeEvidence.push(await this.json(['release', 'verify', target.manifest.tag, '--repo', target.manifest.fullName, '--format', 'json']));
    for (const asset of assets) {
      await this.compareAsset(target, asset);
      const file = resolve(target.directory, asset.name);
      nativeEvidence.push(await this.json(['release', 'verify-asset', target.manifest.tag, file, '--repo', target.manifest.fullName, '--format', 'json']));
      nativeEvidence.push(await this.verifyAttestation(target, file));
    }
    await this.read(target);
    return { releaseId: release.id, url: release.html_url, mode: 'verified' as const, nativeEvidence };
  }
  async publish(target: ReleaseTarget, assertCurrentWriteAuthority: () => Promise<void>) {
    await verifySealedArtifacts(target.directory, target.manifest);
    if (!(await this.read(target)).draft) return this.verify(target);
    const names = this.names(target);
    for (const name of names) await this.verifyAttestation(target, resolve(target.directory, name));
    const guard = async () => {
      await assertCurrentWriteAuthority();
      if (!(await this.read(target)).draft) reject('draft changed before write');
      await verifySealedArtifacts(target.directory, target.manifest);
    };
    for (const name of names) {
      const assets = await this.assets(target);
      if (assets.some(asset => !names.includes(asset.name))) reject('unexpected draft asset');
      let asset = assets.find(asset => asset.name === name);
      if (!asset) {
        await guard();
        let uploadError: unknown;
        try { await this.gh(['release', 'upload', target.manifest.tag, resolve(target.directory, name), '--repo', target.manifest.fullName]); }
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
      try { await this.gh(['release', 'edit', target.manifest.tag, '--repo', target.manifest.fullName, '--notes-file', resolve(target.directory, 'release-notes.md')]); }
      catch (error) { editError = error; }
      if ((await this.read(target)).body !== notes) { if (editError) throw editError; reject('body edit not observed'); }
    }
    await guard();
    let publishError: unknown;
    try { await this.gh(['release', 'edit', target.manifest.tag, '--repo', target.manifest.fullName, '--draft=false']); }
    catch (error) { publishError = error; }
    if ((await this.read(target)).draft) { if (publishError) throw publishError; reject('publication not observed'); }
    return this.verify(target);
  }
}
