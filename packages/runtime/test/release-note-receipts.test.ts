import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { newReleaseReceipt, receiptDigest } from '../../core/src/release-note-receipt.js';
import { receiptFixture, frozenFixture, notesFixture } from '../../core/test/release-receipt-fixture.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { ReleaseTestDb } from './release-test-db.js';

describe('D1 durable release receipts', () => {
  it('persists across restart; exact repeat resumes and different input cannot occupy a version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-receipt-')), path = join(dir, 'receipt.sqlite');
    let db = new ReleaseTestDb(path);
    try {
      const r = receiptFixture(); await new ReleaseReceiptStore(db.binding()).prepare(r, 'now'); db.database.close();
      db = new ReleaseTestDb(path); const store = new ReleaseReceiptStore(db.binding());
      expect(await store.get(9001, 'v1.2.3')).toEqual(r);
      expect(await store.prepare(r, 'later')).toEqual(r);
      await expect(store.prepare(newReleaseReceipt({ ...frozenFixture(), title: 'different' }, notesFixture.replace('Neutral 1.2.3', 'different')), 'later')).rejects.toThrow('VERSION_OCCUPIED');
      expect(await store.get(9002, 'v1.2.3')).toBeNull();
    } finally { db.database.close(); rmSync(dir, { recursive: true }); }
  });
  it('only one concurrent claimant can CAS; stale workers cannot save or release successor leases', async () => {
    const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
    await store.prepare(receiptFixture(), 'now');
    const claims = await Promise.allSettled([store.claim(9001, 'v1.2.3', 1000), store.claim(9001, 'v1.2.3', 1000)]);
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const first = claims.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof store.claim>>>;
    const a = first.value;
    const saved = await store.save(a.receipt, { ...a.receipt, paused: true }, a.token, 1001);
    await expect(store.save(a.receipt, a.receipt, a.token, 1002)).rejects.toThrow('CLAIM_STALE');
    await expect(store.assertClaim(9001, 'v1.2.3', a.token, saved.version, 601001)).rejects.toThrow('CLAIM_STALE');
    const b = await store.claim(9001, 'v1.2.3', 601001);
    await store.release(9001, 'v1.2.3', a.token);
    expect(await store.assertClaim(9001, 'v1.2.3', b.token, saved.version, 601002)).toEqual(saved);
    await expect(store.save(saved, { ...saved, frozen: { ...saved.frozen, title: 'tampered' } }, b.token, 601003)).rejects.toThrow('IMMUTABLE');
    db.database.close();
  });
  it('revision atomically retains old evidence and requires paused unpublished state', async () => {
    const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
    await store.prepare(receiptFixture(), 'now'); const a = await store.claim(9001, 'v1.2.3', 1000);
    const next = newReleaseReceipt(frozenFixture(), notesFixture, 2);
    await expect(store.revise(a.receipt, next, a.token, 1001)).rejects.toThrow('REVISION_STATE');
    const paused = await store.save(a.receipt, { ...a.receipt, paused: true }, a.token, 1001);
    await expect(store.revise(paused, next, 'wrong', 1002)).rejects.toThrow('CLAIM_STALE');
    expect((await store.get(9001, 'v1.2.3'))?.revision).toBe(1);
    await store.revise(paused, next, a.token, 1002);
    expect((await store.get(9001, 'v1.2.3'))?.revision).toBe(2);
    expect(await store.get(9001, 'v1.2.3', 1)).toEqual(paused);
    db.database.close();
  });
  it('source chunks are bounded, immutable, digest verified and repository isolated', async () => {
    const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
    const bytes = Buffer.from('firstsecond'), digest = receiptDigest(bytes);
    await store.putChunk(9001, digest, 0, 2, Buffer.from('first').toString('base64'));
    await expect(store.verifyObject(9001, digest)).rejects.toThrow('OBJECT_INCOMPLETE');
    await store.putChunk(9001, digest, 1, 2, Buffer.from('second').toString('base64'));
    expect(Buffer.from(await store.readObject(9001, digest))).toEqual(bytes);
    await expect(store.verifyObject(9002, digest)).rejects.toThrow('OBJECT_MISSING');
    await expect(store.putChunk(9001, digest, 0, 2, Buffer.from('other').toString('base64'))).rejects.toThrow('OBJECT_CONFLICT');
    await expect(store.putChunk(9001, digest, 0, 2049, 'YQ==')).rejects.toThrow('OBJECT_ID');
    await expect(store.putChunk(9001, digest, 0, 1, Buffer.alloc(49153).toString('base64'))).rejects.toThrow('OBJECT_CHUNK');
    const corrupt = receiptDigest('different'); await store.putChunk(9001, corrupt, 0, 1, bytes.toString('base64'));
    await expect(store.verifyObject(9001, corrupt)).rejects.toThrow('OBJECT_DIGEST'); db.database.close();
  });
  it('recovery only takes unpaused merged/publishing receipts with no active lease, at a bounded cadence', async () => {
    const db = new ReleaseTestDb(), store = new ReleaseReceiptStore(db.binding());
    await store.prepare(receiptFixture(), 'now'); expect(await store.takeRecoveryBatch(1)).toHaveLength(1);
    expect(await store.takeRecoveryBatch(2)).toEqual([]);
    const a = await store.claim(9001, 'v1.2.3', 1000);
    await store.save(a.receipt, { ...a.receipt, phase: 'merged', pullNumber: 17 }, a.token, 1001);
    expect(await store.takeRecoveryBatch(1002)).toEqual([]); await store.release(9001, 'v1.2.3', a.token);
    expect(await store.takeRecoveryBatch(900002)).toHaveLength(1); expect(await store.takeRecoveryBatch(900003)).toHaveLength(0);
    expect(await store.takeRecoveryBatch(1800003)).toHaveLength(1); db.database.close();
  });
});
