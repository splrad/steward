import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect } from 'vitest';
import { NativeGitHubRelease, type GhCommand, type ReleaseTarget, type ReleaseDownload } from '../src/gh-release.js';
import { sealProductArtifacts, type ProductReleaseManifest } from '../src/release-artifacts.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
export async function ghReleaseFixture(sourceShaOverride?:string) {
  const directory = await mkdtemp(join(tmpdir(), 'gh-release-')); roots.push(directory);
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  const sourceSha = sourceShaOverride ?? 'a'.repeat(40), cycleId = 'pr-2-' + sourceSha;
  const manifest: ProductReleaseManifest = { schemaVersion: 3, repositoryId: 1, fullName: 'fixture/product', cycleId, requestKey: 'e'.repeat(64),
    unitId: 'app', version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', sourceSha, controllerSha: 'b'.repeat(40), buildRef: 'refs/heads/steward/build/' + cycleId,
    deliverySha256: 'c'.repeat(64), templateSha256: 'd'.repeat(64), runId: 10, attempt: 2, toolLocks: { 'mise.lock': 'e'.repeat(64) },
    producers: [{ buildId: 'win', jobId: 11, attempt: 1, artifactId: 12 }],
    artifacts: ['app.exe','dll.zip','fonts.zip'].map((path, i) => ({ id: ['app','dll','fonts'][i]!, path, mediaType: 'application/octet-stream', size: 3, sha256: digest('app') })), evidence: [] };
  for (const asset of manifest.artifacts) await writeFile(join(directory, asset.path), 'app');
  await writeFile(join(directory, 'sbom.spdx.json'), JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] }));
  await writeFile(join(directory, 'release-notes.md'), `1.2.3\n${sourceSha}\n${manifest.controllerSha}\n`);
  const target: ReleaseTarget = { directory, releaseId: 20, appBotId: 42, manifest: await sealProductArtifacts(directory, manifest) };
  const remote = new Map<string, { bytes: Buffer; id: number; state: string; label: string; uploader: { id: number } }>(); const calls: string[][] = [];
  const release = { id: 20, author: { id: 42 }, tag_name: 'v1.2.3', target_commitish: sourceSha, draft: true, immutable: false, body: 'draft',
    html_url: 'https://github.com/fixture/product/releases/tag/v1.2.3', upload_url: 'https://uploads.github.com/repos/fixture/product/releases/20/assets{?name,label}' };
  const releases = new Map<number, typeof release>([[20, release]]);
  const state = { source: sourceSha, tag: true, annotated: false, loseUpload: false, losePublish: false, loseBody: false, loseDraft: false, loseTag: false,
    failUpload: false, incomplete: false, corruptDownload: false, disabled: false, private: false, disableAfterUpload: false, runStatus: 'completed', runConclusion: 'success',
    invocation: 'https://github.com/fixture/product/actions/runs/10/attempts/2', certificateRepository: '1', buildTrigger: 'workflow_dispatch' };
  let nextAsset = 100;
  const put = (name: string, bytes: Buffer, extra = {}) => remote.set(name, { bytes, id: nextAsset++, state: 'uploaded', label: '', uploader: { id: 42 }, ...extra });
  const gh: GhCommand = async args => {
    calls.push([...args]);
    if (args[0] === 'api') {
      const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
      const endpoint = args.find(arg => arg.startsWith('repos/') || arg.startsWith('https://uploads.'))!;
      const body = args.includes('--input') && !endpoint.startsWith('https:') ? JSON.parse(await readFile(args[args.indexOf('--input') + 1]!, 'utf8')) : null;
      if (method === 'GET') {
        if (endpoint === 'repos/fixture/product') return JSON.stringify({ id: 1, full_name: 'fixture/product', archived: false, disabled: state.disabled, private: state.private });
        if (endpoint.endsWith('/actions/runs/10')) return JSON.stringify({ id: 10, run_attempt: 2, repository: { id: 1 }, head_repository: { id: 1 }, head_sha: sourceSha,
          head_branch: manifest.buildRef.slice(11), path: '.github/workflows/steward-release-publish.yml', event: 'workflow_dispatch', actor: { id: 42 }, status: state.runStatus, conclusion: state.runConclusion });
        if (endpoint.endsWith('/git/ref/tags/v1.2.3')) {
          if (!state.tag) throw Object.assign(new Error('not found'), { status: 404 });
          return JSON.stringify({ ref: 'refs/tags/v1.2.3', object: { type: state.annotated ? 'tag' : 'commit', sha: state.annotated ? 'f'.repeat(40) : state.source } });
        }
        if (endpoint.includes('/git/tags/')) return JSON.stringify({ object: { type: 'commit', sha: state.source } });
        if (endpoint.includes('/git/matching-refs/')) return '[]';
        if (endpoint.endsWith('/releases?per_page=100')) return JSON.stringify([[...releases.values()]]);
        if (/\/releases\/\d+$/.test(endpoint)) {
          const value = releases.get(Number(endpoint.split('/').at(-1))); if (!value) throw Object.assign(new Error('not found'), { status: 404 });
          return JSON.stringify(value);
        }
        if (endpoint.endsWith('/assets?per_page=100')) return JSON.stringify(state.incomplete ? {} : [[...remote].map(([name, asset]) => ({ ...asset, bytes: undefined, name, size: asset.bytes.length, digest: null }))]);
      }
      if (method === 'POST' && endpoint.endsWith('/git/refs')) { state.tag = true; state.source = body.sha; if (state.loseTag) throw new Error('lost tag response'); return '{}'; }
      if (method === 'POST' && endpoint.endsWith('/releases')) {
        Object.assign(release, body); releases.set(20, release); if (state.loseDraft) throw new Error('lost draft response'); return JSON.stringify(release);
      }
      if (method === 'POST' && endpoint.startsWith('https://uploads.')) {
        if (state.failUpload) throw new Error('forbidden upload');
        const url = new URL(endpoint), name = url.searchParams.get('name')!;
        put(name, await readFile(args[args.indexOf('--input') + 1]!), { label: url.searchParams.get('label')! });
        if (state.disableAfterUpload) state.disabled = true;
        if (state.loseUpload) throw new Error('lost upload response'); return '{}';
      }
      if (method === 'PATCH') {
        // Match GitHub REST: omitting tag_name removes the draft's current tag association.
        release.tag_name = body.tag_name ?? 'untagged-fixture';
        expect(endpoint).toBe('repos/fixture/product/releases/20');
        if (body.body !== undefined) { release.body = body.body; if (state.loseBody) throw new Error('lost body response'); }
        if (body.draft === false) { expect(Object.keys(body)).toEqual(['tag_name', 'draft']); release.draft = false; release.immutable = true; if (state.losePublish) throw new Error('lost publish response'); }
        return '{}';
      }
      if (method === 'DELETE') {
        if (endpoint.includes('/releases/assets/')) { const id = Number(endpoint.split('/').at(-1)); for (const [name, asset] of remote) if (asset.id === id) remote.delete(name); }
        else releases.delete(Number(endpoint.split('/').at(-1)));
        return '';
      }
    }
    if (args[0] === 'attestation') return JSON.stringify([{ verificationResult: { signature: { certificate: {
      runInvocationURI: state.invocation, sourceRepositoryIdentifier: state.certificateRepository, buildTrigger: state.buildTrigger,
    } } } }]);
    if (args[1] === 'verify' || args[1] === 'verify-asset') return JSON.stringify({ fixture: true });
    throw new Error('unhandled fixture gh command: ' + JSON.stringify(args));
  };
  const downloads: { id: number; anonymous: boolean }[] = [];
  const download: ReleaseDownload = async (repository, id, destination, anonymous) => {
    expect(repository).toBe('fixture/product'); downloads.push({ id, anonymous });
    const asset = [...remote.values()].find(value => value.id === id)!;
    await writeFile(destination, state.corruptDownload ? Buffer.from('bad') : asset.bytes, { flag: 'wx' });
  };
  return { target, remote, state, release, releases, calls, downloads, put, gh, download, adapter: new NativeGitHubRelease(gh, download), preload: async () => {
    for (const name of await readdir(directory)) put(name, await readFile(join(directory, name)));
  } };
}
