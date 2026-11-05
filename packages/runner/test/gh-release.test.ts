import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ProductReleaseManifest } from '../src/release-artifacts.js';
import { ghReleaseFixture as fixture } from './gh-release-fixture.js';

const writes = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(args => args.includes('--method'));
it('recovers half-uploaded seven-file release and lost upload/body/publication responses using exact IDs', async () => {
  const f = await fixture(); f.put('app.exe', Buffer.from('app')); f.state.loseUpload = f.state.loseBody = f.state.losePublish = true;
  expect((await f.adapter.publish(f.target)).mode).toBe('verified');
  expect(f.remote.size).toBe(7); expect(writes(f).filter(args => args.includes('POST'))).toHaveLength(6);
  expect(writes(f).filter(args => args.includes('PATCH'))).toHaveLength(2);
  expect(f.downloads.filter(value => value.anonymous)).toHaveLength(7);
  expect(f.calls.some(args => args.includes('--clobber') || ['upload','edit','download'].includes(args[1]!))).toBe(false);
  expect(f.calls.find(args => args[0] === 'attestation')).toEqual(expect.arrayContaining(['--source-ref', (f.target.manifest as ProductReleaseManifest).buildRef,
    '--signer-workflow', 'fixture/product/.github/workflows/steward-release-publish.yml', '--signer-digest', f.target.manifest.sourceSha]));
});
it.each([[false,'marker'],[true,'marker'],[false,'notes'],[true,'notes']] as const)('adopts an existing draft without creating another release; partial=%s body=%s',async(partial,body)=>{
  const f=await fixture();if(partial)f.put('app.exe',Buffer.from('app'));
  const m=f.target.manifest,manifestDigest=createHash('sha256').update(await readFile(join(f.target.directory,'artifact-manifest.json'))).digest('hex');
  f.release.body=body==='notes'?await readFile(join(f.target.directory,'release-notes.md'),'utf8')
    :`<!-- steward-release:${createHash('sha256').update(JSON.stringify([m.repositoryId,m.unitId,m.tag,m.sourceSha,manifestDigest])).digest('hex')} -->`;
  const target=await f.adapter.ensureDraft({...f.target,releaseId:null});
  expect(target.releaseId).toBe(20);expect(writes(f)).toHaveLength(0);
  expect((await f.adapter.publish(target)).mode).toBe('verified');
  expect([...f.releases.keys()]).toEqual([20]);expect(f.remote.size).toBe(7);
  expect(writes(f).some(args=>args.includes('repos/fixture/product/releases'))).toBe(false);
});
it.each(['body','target'] as const)('rejects an unbound draft with conflicting %s before any write',async kind=>{
  const f=await fixture();f.release.body=await readFile(join(f.target.directory,'release-notes.md'),'utf8');
  if(kind==='body')f.release.body='unexpected manually edited draft';else f.release.target_commitish='f'.repeat(40);
  await expect(f.adapter.ensureDraft({...f.target,releaseId:null})).rejects.toThrow('draft contains unproven data');
  expect(writes(f)).toHaveLength(0);expect([...f.releases.keys()]).toEqual([20]);
});
it('published reentry is entirely read-only', async () => {
  const f = await fixture(); await f.preload(); Object.assign(f.release, { draft: false, immutable: true, body: await readFile(join(f.target.directory,'release-notes.md'),'utf8') });
  const target=await f.adapter.ensureDraft({...f.target,releaseId:null});
  await f.adapter.publish(target); expect(writes(f)).toHaveLength(0);
});
it('verifies every private formal asset with authorized reads and preserves the read-only path',async()=>{
  const f=await fixture();f.state.private=true;await f.preload();
  Object.assign(f.release,{draft:false,immutable:true,body:await readFile(join(f.target.directory,'release-notes.md'),'utf8')});
  await f.adapter.verify(f.target);
  expect(f.downloads).toHaveLength(7);expect(f.downloads.every(value=>value.anonymous===false)).toBe(true);expect(writes(f)).toHaveLength(0);
});
it.each(['run','attempt','repository','trigger'])('rejects a different attestation %s before writes', async kind => {
  const f = await fixture();
  if (kind === 'run') f.state.invocation = f.state.invocation.replace('/runs/10/', '/runs/11/');
  if (kind === 'attempt') f.state.invocation = f.state.invocation.replace('/attempts/2', '/attempts/1');
  if (kind === 'repository') f.state.certificateRepository = '2';
  if (kind === 'trigger') f.state.buildTrigger = 'push';
  await expect(f.adapter.publish(f.target)).rejects.toThrow('attestation run identity'); expect(writes(f)).toHaveLength(0);
});
it.each(['inflight','failed'])('does not create tags for %s product Run', async kind => {
  const f = await fixture(); if (kind === 'inflight') f.state.runStatus = 'in_progress'; else f.state.runConclusion = 'failure';
  await expect(f.adapter.ensureTag({ ...f.target, releaseId: null })).rejects.toThrow('completed product Run required'); expect(writes(f)).toHaveLength(0);
});
it.each(['bytes','source','extra','incomplete','download','creator'])('preserves conflicting %s and refuses publication', async kind => {
  const f = await fixture();
  if (kind === 'bytes') f.put('app.exe', Buffer.from('bad'));
  if (kind === 'source') f.state.source = 'f'.repeat(40);
  if (kind === 'extra') f.put('manual.txt', Buffer.from('human'));
  if (kind === 'incomplete') f.state.incomplete = true;
  if (kind === 'download') { await f.preload(); f.state.corruptDownload = true; }
  if (kind === 'creator') f.release.author.id = 99;
  await expect(f.adapter.publish(f.target)).rejects.toThrow(); expect(writes(f).some(args => args.includes('PATCH'))).toBe(false);
});
it('rechecks disabled repository before every mutation', async () => {
  const f = await fixture(); f.state.disableAfterUpload = true;
  await expect(f.adapter.publish(f.target)).rejects.toThrow('disabled'); expect(writes(f)).toHaveLength(1);
});
it.each(['body','immutable'])('reports published %s drift without modifying it', async kind => {
  const f = await fixture(); await f.preload(); f.release.draft = false; f.release.immutable = kind !== 'immutable';
  await expect(f.adapter.publish(f.target)).rejects.toThrow(); expect(writes(f)).toHaveLength(0);
});
it('creates late tag and draft and reconciles their lost responses', async () => {
  const f = await fixture(); f.state.tag = false; f.releases.clear(); f.state.loseTag = f.state.loseDraft = true;
  expect((await f.adapter.ensureDraft({ ...f.target, releaseId: null })).releaseId).toBe(20);
  expect(writes(f)).toHaveLength(2); expect(f.calls.findIndex(args => args[0] === 'attestation')).toBeLessThan(f.calls.findIndex(args => args.includes('--method')));
});
it('dereferences annotated tags without moving them', async () => {
  const f = await fixture(); f.state.annotated = true; await f.adapter.ensureTag(f.target); expect(writes(f)).toHaveLength(0);
});
it('converges only extra empty drafts carrying the exact same intent', async () => {
  const f = await fixture(); f.releases.clear(); await f.adapter.ensureDraft({ ...f.target, releaseId: null });
  f.releases.set(21, { ...f.release, id: 21 });
  expect((await f.adapter.ensureDraft({ ...f.target, releaseId: null })).releaseId).toBe(20); expect([...f.releases.keys()]).toEqual([20]);
  f.releases.set(22, { ...f.release, id: 22, body: 'human notes' });
  await expect(f.adapter.ensureDraft({ ...f.target, releaseId: null })).rejects.toThrow('unproven data'); expect(f.releases.has(22)).toBe(true);
});
it('retains an unknown zero-byte starter', async () => {
  const f = await fixture(); f.put('app.exe', Buffer.alloc(0), { state: 'starter', label: 'unknown' });
  await expect(f.adapter.publish(f.target)).rejects.toThrow('unproven starter'); expect(writes(f)).toHaveLength(0);
});
it('recovers only an exact owned starter after the original upload failed', async () => {
  const f = await fixture(); await f.adapter.publish(f.target);
  const original = f.remote.get('app.exe')!; Object.assign(f.release, { draft: true, immutable: false });
  original.bytes = Buffer.alloc(0); original.state = 'starter'; f.calls.length = 0;
  await f.adapter.publish(f.target); expect(writes(f).filter(args => args.includes('DELETE'))).toHaveLength(1);
});
