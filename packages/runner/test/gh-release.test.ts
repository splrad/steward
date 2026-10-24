import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { NativeGitHubRelease, type GhCommand, type ReleaseTarget } from '../src/gh-release.js';
import { sealReleaseArtifacts, type ReleaseManifest } from '../src/release-artifacts.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gh-release-')); roots.push(directory);
  const manifest: ReleaseManifest = { schemaVersion: 2, repositoryId: 1, fullName: 'fixture/product', unitId: 'app', version: '1.2.3', packageVersion: '1.2.3', tag: 'v1.2.3', sourceSha: 'a'.repeat(40), policySha: 'b'.repeat(40), descriptorSha256: 'c'.repeat(64), templateSha256: 'd'.repeat(64), runId: 10, attempt: 2, toolLocks: { 'mise.lock': 'e'.repeat(64) }, producers: [{ buildId: 'win', jobId: 11, attempt: 1, artifactId: 12 }], artifacts: [{ id: 'app', path: 'app.exe', kind: 'executable', mediaType: 'application/octet-stream', platform: 'windows', architecture: 'x64', size: 3, sha256: createHash('sha256').update('app').digest('hex') }], evidence: [] };
  await writeFile(join(directory, 'app.exe'), 'app');
  await writeFile(join(directory, 'sbom.spdx.json'), JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] }));
  await writeFile(join(directory, 'release-notes.md'), `1.2.3\n${manifest.sourceSha}\n${manifest.policySha}\n`);
  const target: ReleaseTarget = { directory, releaseId: 20, manifest: await sealReleaseArtifacts(directory, manifest) };
  const remote = new Map<string, Buffer>(); const calls: string[][] = [];
  const state = { id: 20, tag_name: 'v1.2.3', draft: true, immutable: false, body: 'native RP draft', html_url: 'https://github.com/fixture/product/releases/tag/v1.2.3', source: manifest.sourceSha,
    loseUpload: false, losePublish: false, loseBody: false, failUpload: false, incomplete: false, corruptDownload: false,
    invocation: 'https://github.com/fixture/product/actions/runs/10/attempts/2', certificateRepository: '1', buildTrigger: 'workflow_dispatch' };
  const gh: GhCommand = async args => {
    calls.push([...args]);
    if (args[0] === 'api') {
      const endpoint = args.at(-1)!;
      if (endpoint === 'repos/fixture/product') return JSON.stringify({ id: 1, full_name: 'fixture/product' });
      if (endpoint.endsWith('/releases/20')) return JSON.stringify(state);
      if (endpoint.endsWith('/commits/v1.2.3')) return JSON.stringify({ sha: state.source });
      if (endpoint.endsWith('/assets?per_page=100')) return JSON.stringify(state.incomplete ? {} : [[...remote].map(([name, bytes], i) => ({ id: i + 1, name, size: bytes.length, digest: null, state: 'uploaded' }))]);
    }
    if (args[0] === 'attestation') return JSON.stringify([{ verificationResult: { signature: { certificate: {
      runInvocationURI: state.invocation, sourceRepositoryIdentifier: state.certificateRepository, buildTrigger: state.buildTrigger,
    } } } }]);
    if (args[1] === 'verify' || args[1] === 'verify-asset') return JSON.stringify({ fixture: true });
    if (args[1] === 'upload') {
      if (state.failUpload) throw new Error('fixture forbidden upload');
      remote.set(basename(args[3]!), await readFile(args[3]!));
      if (state.loseUpload) throw new Error('fixture lost upload response');
      return '';
    }
    if (args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1]!, path = args[args.indexOf('--dir') + 1]!;
      await writeFile(join(path, name), state.corruptDownload ? Buffer.from('bad') : remote.get(name)!); return '';
    }
    if (args.includes('--notes-file')) {
      state.body = await readFile(args.at(-1)!, 'utf8');
      if (state.loseBody) throw new Error('fixture lost body response'); return '';
    }
    if (args.includes('--draft=false')) {
      state.draft = false; state.immutable = true;
      if (state.losePublish) throw new Error('fixture lost publish response'); return '';
    }
    throw new Error('unhandled fixture gh command: ' + JSON.stringify(args));
  };
  return { target, remote, state, calls, adapter: new NativeGitHubRelease(gh), preload: async () => {
    for (const name of await readdir(directory)) remote.set(name, await readFile(join(directory, name)));
  } };
}
it('recovers partial uploads and lost responses against the same ID, then verifies native attestations', async () => {
  const f = await fixture(); f.remote.set('app.exe', Buffer.from('app'));
  f.state.loseUpload = f.state.loseBody = f.state.losePublish = true;
  let gates = 0;
  expect((await f.adapter.publish(f.target, async () => { gates++; })).mode).toBe('verified');
  expect(gates).toBe(6); // four absent files, body and publication
  expect(f.calls.filter(args => args[1] === 'upload')).toHaveLength(4);
  expect(f.calls.filter(args => args.includes('--draft=false'))).toHaveLength(1);
  expect(f.calls.some(args => args.includes('--clobber') || args[1] === 'create' || args[1] === 'delete')).toBe(false);
  const attest = f.calls.find(args => args[0] === 'attestation')!;
  expect(attest).toEqual(expect.arrayContaining(['--source-digest', f.target.manifest.sourceSha, '--signer-digest', f.target.manifest.policySha, '--deny-self-hosted-runners']));
});
it('uses verify-only for published releases without consulting write authority', async () => {
  const f = await fixture(); await f.preload(); f.state.draft = false; f.state.immutable = true;
  f.state.body = await readFile(join(f.target.directory, 'release-notes.md'), 'utf8');
  await f.adapter.publish(f.target, async () => { throw new Error('disabled'); });
  expect(f.calls.some(args => ['upload', 'edit'].includes(args[1]!))).toBe(false);
});
it('rejects a foreign run attestation before the first draft upload', async () => {
  const f = await fixture(); f.state.invocation = f.state.invocation.replace('/runs/10/', '/runs/11/');
  let writes = 0;
  await expect(f.adapter.publish(f.target, async () => { writes++; })).rejects.toThrow('attestation run identity');
  expect(writes).toBe(0);
  expect(f.calls.some(args => ['edit', 'upload'].includes(args[1]!))).toBe(false);
});
it.each(['run', 'attempt', 'repository', 'trigger'])('rejects a native attestation from a different %s', async kind => {
  const f = await fixture(); await f.preload(); f.state.draft = false; f.state.immutable = true;
  f.state.body = await readFile(join(f.target.directory, 'release-notes.md'), 'utf8');
  if (kind === 'run') f.state.invocation = f.state.invocation.replace('/runs/10/', '/runs/11/');
  if (kind === 'attempt') f.state.invocation = f.state.invocation.replace('/attempts/2', '/attempts/1');
  if (kind === 'repository') f.state.certificateRepository = '2';
  if (kind === 'trigger') f.state.buildTrigger = 'pull_request';
  await expect(f.adapter.verify(f.target)).rejects.toThrow('attestation run identity');
  expect(f.calls.some(args => ['edit', 'upload'].includes(args[1]!))).toBe(false);
});
it.each(['different-bytes', 'extra', 'tag', 'pause', 'incomplete', 'denied-upload', 'download'])('blocks %s without publication', async kind => {
  const f = await fixture();
  if (kind === 'different-bytes') f.remote.set('app.exe', Buffer.from('bad'));
  if (kind === 'extra') f.remote.set('extra.exe', Buffer.from('extra'));
  if (kind === 'tag') f.state.source = 'c'.repeat(40);
  if (kind === 'incomplete') f.state.incomplete = true;
  if (kind === 'denied-upload') f.state.failUpload = true;
  if (kind === 'download') { await f.preload(); f.state.corruptDownload = true; }
  await expect(f.adapter.publish(f.target, async () => { if (kind === 'pause') throw new Error('revoked policy'); })).rejects.toThrow();
  expect(f.calls.some(args => args.includes('--draft=false'))).toBe(false);
});
it('detects a pause after successful upload before the next write', async () => {
  const f = await fixture(); let checks = 0;
  await expect(f.adapter.publish(f.target, async () => { if (++checks > 1) throw new Error('paused'); })).rejects.toThrow('paused');
  expect(f.calls.filter(args => args[1] === 'upload')).toHaveLength(1);
});
it.each(['body', 'immutable'])('reports published %s drift without modifying it', async kind => {
  const f = await fixture(); await f.preload(); f.state.draft = false; f.state.immutable = kind !== 'immutable';
  await expect(f.adapter.publish(f.target, async () => {})).rejects.toThrow();
  expect(f.calls.some(args => ['edit', 'upload'].includes(args[1]!))).toBe(false);
});
