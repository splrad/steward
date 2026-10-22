import { expect, it } from 'vitest';
import { ReleaseTestDb } from './release-test-db.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { ReleaseBuildStore } from '../src/release-build-store.js';
import { ReleaseGenerationStore } from '../src/release-generation-store.js';
import { newReleaseReceipt, canonicalReleaseJson } from '../../core/src/release-note-receipt.js';
import { generationPlan } from '../../core/src/release-production.js';
import { frozenFixture, notesFixture } from '../../core/test/release-receipt-fixture.js';

it('archives receipts and accepted build metadata atomically, revokes generation tickets and starts an unapproved revision', async () => {
 const db = new ReleaseTestDb(), receipts = new ReleaseReceiptStore(db.binding()), builds = new ReleaseBuildStore(db.binding()), generation = new ReleaseGenerationStore(db.binding());
 try {
  const f = frozenFixture(), now = Date.now(), nextPolicy = 'e'.repeat(40);
  const receipt = newReleaseReceipt(f, notesFixture);
  await receipts.prepare(receipt, new Date(now).toISOString());
  const request = { key: 'a'.repeat(64), mode: 'initial' as const, frozen: f, plans: [], sourceArtifactId: null };
  const original = await builds.prepare(request);
  const accepted = await builds.save(original, { ...original, status: 'accepted' });
  const plan = generationPlan(f.sourceDigest, f.policySha, ['old source']); await generation.prepare(f.repositoryId, f.targetTag, plan, now);
  const ticket = await generation.ticket(f.repositoryId, f.targetTag, now);
  const claim = await receipts.claim(f.repositoryId, f.targetTag, now);
  await receipts.migratePolicy(claim.receipt, claim.token, nextPolicy, now + 1);
  expect(await receipts.get(f.repositoryId, f.targetTag)).toBeNull();
  expect(await receipts.get(f.repositoryId, f.targetTag, 1)).toEqual(receipt);
  expect(await receipts.migratedReceipt(f.repositoryId, f.targetTag, nextPolicy)).toEqual(receipt);
  expect(await builds.get(request.key, f.repositoryId, f.targetTag)).toBeNull();
  const row = db.database.prepare('SELECT record_json,policy_archived FROM release_build_requests WHERE request_key=?').get(request.key)!;
  expect(row.record_json).toBe(canonicalReleaseJson(accepted)); expect(row.policy_archived).toBe(1);
  await expect(builds.save(accepted, { ...accepted, error: 'late' })).rejects.toThrow('BUILD_REQUEST_STALE');
  await expect(receipts.save(receipt, receipt, claim.token, now + 2)).rejects.toThrow('CLAIM_STALE');
  await expect(generation.authorize(f.repositoryId, f.targetTag, ticket, now + 2, f.policySha)).rejects.toThrow('GENERATION_AUTH');
  await generation.prepare(f.repositoryId, f.targetTag, generationPlan(f.sourceDigest, nextPolicy, ['new source']), now + 2);
  const next = newReleaseReceipt({ ...f, policySha: nextPolicy }, notesFixture, await receipts.nextRevision(f.repositoryId, f.targetTag));
  expect(next.revision).toBe(2); expect(next.approval).toBeNull(); expect(next.merge).toBeNull(); expect(next.pullNumber).toBeNull();
  await receipts.prepare(next, new Date(now + 2).toISOString());
  await builds.prepare({ ...request, key: 'b'.repeat(64), frozen: next.frozen });
 } finally { db.database.close(); }
});
it.each(['publishing', 'verified', 'operation', 'release'])('rejects policy migration after publication starts: %s', async mode => {
 const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
 try {
  const r = newReleaseReceipt(frozenFixture(), notesFixture);
  if (mode === 'operation') r.operation = { kind: 'create-release', key: 'intent', startedAt: new Date().toISOString() };
  else if (mode === 'release') r.releaseId = 1;
  else r.phase = mode as 'publishing' | 'verified';
  await store.prepare(r, new Date().toISOString()); const claim = await store.claim(r.frozen.repositoryId, r.frozen.targetTag, Date.now());
  await expect(store.migratePolicy(r, claim.token, 'e'.repeat(40), Date.now())).rejects.toThrow('POLICY_MIGRATION_STATE');
  expect(await store.get(r.frozen.repositoryId, r.frozen.targetTag)).toEqual(r);
 } finally { db.database.close(); }
});
it('rolls back the whole migration on storage failure and rejects an expired lease', async () => {
 const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
 try {
  const r = newReleaseReceipt(frozenFixture(), notesFixture); await store.prepare(r, new Date().toISOString());
  const claim = await store.claim(r.frozen.repositoryId, r.frozen.targetTag, 100);
  await expect(store.migratePolicy(r, claim.token, 'e'.repeat(40), 700000)).rejects.toThrow('POLICY_MIGRATION_STALE');
  db.database.exec("CREATE TRIGGER fail_archive BEFORE UPDATE OF current ON release_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
  await expect(store.migratePolicy(r, claim.token, 'e'.repeat(40), 101)).rejects.toThrow('injected');
  expect(await store.get(r.frozen.repositoryId, r.frozen.targetTag)).toEqual(r);
  expect(await store.migratedReceipt(r.frozen.repositoryId, r.frozen.targetTag, 'e'.repeat(40))).toBeNull();
 } finally { db.database.close(); }
});
it('a replayed migration cannot archive new builds or revoke new generation tickets', async () => {
 const db = new ReleaseTestDb(), receipts = new ReleaseReceiptStore(db.binding()), builds = new ReleaseBuildStore(db.binding()), generation = new ReleaseGenerationStore(db.binding());
 try {
  const f = frozenFixture(), now = Date.now(), policy = 'e'.repeat(40), r = newReleaseReceipt(f, notesFixture);
  await receipts.prepare(r, new Date(now).toISOString()); const claim = await receipts.claim(f.repositoryId, f.targetTag, now);
  await receipts.migratePolicy(r, claim.token, policy, now + 1);
  const next = await builds.prepare({key: 'b'.repeat(64), mode: 'initial', frozen: {...f, policySha: policy}, plans: [], sourceArtifactId: null});
  const plan = generationPlan(f.sourceDigest, policy, ['new']); await generation.prepare(f.repositoryId, f.targetTag, plan, now + 2);
  const ticket = await generation.ticket(f.repositoryId, f.targetTag, now + 2);
  await expect(receipts.migratePolicy(r, claim.token, policy, now + 3)).rejects.toThrow('POLICY_MIGRATION_STALE');
  expect(await builds.get(next.request.key, f.repositoryId, f.targetTag)).toEqual(next);
  await generation.authorize(f.repositoryId, f.targetTag, ticket, now + 3, policy);
 } finally { db.database.close(); }
});
it('limits explicit policy migrations to three without partially archiving the fourth candidate', async () => {
 const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
 try {
  const f = frozenFixture(); let r = newReleaseReceipt(f, notesFixture); const now = Date.now();
  await store.prepare(r, new Date(now).toISOString());
  for (const policy of ['d', 'e', 'f']) {
   const c = await store.claim(f.repositoryId, f.targetTag, now); await store.migratePolicy(r, c.token, policy.repeat(40), now);
   r = newReleaseReceipt({...f, policySha: policy.repeat(40)}, notesFixture, await store.nextRevision(f.repositoryId, f.targetTag)); await store.prepare(r, new Date(now).toISOString());
  }
  const c = await store.claim(f.repositoryId, f.targetTag, now);
  await expect(store.migratePolicy(r, c.token, 'a'.repeat(40), now)).rejects.toThrow('POLICY_MIGRATION_STALE');
  expect(await store.get(f.repositoryId, f.targetTag)).toEqual(r);
  expect(db.database.prepare('SELECT COUNT(*) AS count FROM release_policy_migrations').get()!.count).toBe(3);
 } finally { db.database.close(); }
});
it('retargets unfinished migrations with bounded history and fences concurrent losers and current receipts',async()=>{
 const db=new ReleaseTestDb(),store=new ReleaseReceiptStore(db.binding()),builds=new ReleaseBuildStore(db.binding());
 try{
 const f=frozenFixture(),r=newReleaseReceipt(f,notesFixture),now=Date.now();await store.prepare(r,'now');const c=await store.claim(f.repositoryId,f.targetTag,now);await store.migratePolicy(r,c.token,'d'.repeat(40),now);
 const results=await Promise.allSettled(['e','f'].map(p=>store.resumePolicy(f.repositoryId,f.targetTag,p.repeat(40))));expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 const policy=String(db.database.prepare('SELECT policy_sha FROM release_policy_retargets').get()!.policy_sha);
 const b=await builds.prepare({key:'b'.repeat(64),mode:'initial',frozen:{...f,policySha:policy},plans:[],sourceArtifactId:null});
 await store.resumePolicy(f.repositoryId,f.targetTag,policy);expect(await builds.get(b.request.key,f.repositoryId,f.targetTag)).toEqual(b);
 await store.resumePolicy(f.repositoryId,f.targetTag,'a'.repeat(40));await store.resumePolicy(f.repositoryId,f.targetTag,'b'.repeat(40));
 await expect(store.resumePolicy(f.repositoryId,f.targetTag,'1'.repeat(40))).rejects.toThrow('POLICY_MIGRATION_BUDGET');
 await store.prepare(newReleaseReceipt({...f,policySha:'b'.repeat(40)},notesFixture,2),'now');
 await expect(store.resumePolicy(f.repositoryId,f.targetTag,'2'.repeat(40))).rejects.toThrow('POLICY_MIGRATION_NOT_FOUND');
 expect(db.database.prepare('SELECT COUNT(*) AS n FROM release_policy_retargets').get()!.n).toBe(3);
 }finally{db.database.close();}
});
