import { createHash, randomUUID } from 'node:crypto';
import { canonicalReleaseJson, receiptDigest, releaseAssert, releaseDigest, positiveId, type ReleaseReceipt } from '../../core/src/release-note-receipt.js';

export const releaseObjectLimits = { objectBytes: 32 * 1024 * 1024, chunkBytes: 48 * 1024, maxChunks: 2048, recordBytes: 512 * 1024 } as const;
export class ReleaseReceiptStore {
  constructor(private readonly db: D1Database) {}
  async nextRevision(repositoryId: number, tag: string): Promise<number> {
    const row = await this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM release_receipts WHERE repository_id=? AND target_tag=?').bind(repositoryId, tag).first<{ revision: number }>();
    return row!.revision;
  }
  async migratedReceipt(repositoryId: number, tag: string, policySha: string): Promise<ReleaseReceipt | null> {
    const row = await this.db.prepare('SELECT receipt_json FROM release_policy_migrations WHERE repository_id=? AND target_tag=? AND policy_sha=? ORDER BY revision DESC LIMIT 1').bind(repositoryId, tag, policySha).first<{ receipt_json: string }>();
    return row ? JSON.parse(row.receipt_json) : null;
  }
  async migratePolicy(previous: ReleaseReceipt, token: string, policySha: string, now: number): Promise<void> {
    releaseAssert(previous.frozen.policySha !== policySha && /^[a-f0-9]{40}$/.test(policySha)
      && !previous.releaseId && !previous.operation && !['publishing', 'verified'].includes(previous.phase), 'POLICY_MIGRATION_STATE');
    const repo = previous.frozen.repositoryId, tag = previous.frozen.targetTag;
    // Only the holder of the current lease may create the marker. Every subsequent
    // write in this transaction depends on that marker and exact receipt version.
    const marker = 'EXISTS(SELECT 1 FROM release_policy_migrations m JOIN release_receipts r ON r.repository_id=m.repository_id AND r.target_tag=m.target_tag AND r.revision=m.revision WHERE m.repository_id=? AND m.target_tag=? AND m.revision=? AND m.policy_sha=? AND m.receipt_json=? AND r.current=1 AND r.version=? AND r.lease_token=? AND r.lease_until>?)';
    const identity = [repo, tag, previous.revision, policySha, canonicalReleaseJson(previous), previous.version, token, now];
    const results = await this.db.batch([
      this.db.prepare('INSERT INTO release_policy_migrations SELECT repository_id,target_tag,revision,?,record_json,? FROM release_receipts WHERE repository_id=? AND target_tag=? AND revision=? AND current=1 AND version=? AND lease_token=? AND lease_until>? AND (SELECT COUNT(*) FROM release_policy_migrations WHERE repository_id=? AND target_tag=?)<3')
        .bind(policySha, new Date(now).toISOString(), repo, tag, previous.revision, previous.version, token, now, repo, tag),
      this.db.prepare(`UPDATE release_build_requests SET policy_archived=1 WHERE repository_id=? AND target_tag=? AND ${marker}`).bind(repo, tag, ...identity),
      this.db.prepare(`UPDATE release_generation SET ticket_digest=NULL,ticket_until=0,version=version+1 WHERE repository_id=? AND target_tag=? AND ${marker}`).bind(repo, tag, ...identity),
      this.db.prepare(`UPDATE release_receipts SET current=0 WHERE repository_id=? AND target_tag=? AND revision=? AND current=1 AND version=? AND lease_token=? AND lease_until>? AND ${marker}`)
        .bind(repo, tag, previous.revision, previous.version, token, now, ...identity),
    ]);
    releaseAssert(results[0]!.meta.changes === 1 && results[3]!.meta.changes === 1, 'POLICY_MIGRATION_STALE');
  }
  async findByPull(repositoryId: number, pullNumber: number): Promise<ReleaseReceipt | null> {
    const row = await this.db.prepare("SELECT target_tag FROM release_receipts WHERE repository_id=? AND current=1 AND json_extract(record_json,'$.pullNumber')=?")
      .bind(repositoryId, pullNumber).first<{ target_tag: string }>();
    return row ? this.get(repositoryId, row.target_tag) : null;
  }
  async takeRecoveryBatch(now: number): Promise<ReleaseReceipt[]> {
    const rows = await this.db.prepare("SELECT repository_id,target_tag,version FROM release_receipts WHERE current=1 AND lease_until<=? AND dispatch_after<=? AND ((json_extract(record_json,'$.paused')=0 AND (json_extract(record_json,'$.phase') IN ('awaiting-review','approved','merged','publishing') OR json_extract(record_json,'$.phase')='prepared')) OR (json_extract(record_json,'$.paused')=1 AND json_extract(record_json,'$.error')='rebuild-changed-review-required' AND json_extract(record_json,'$.rebuildRequestKey') IS NOT NULL)) ORDER BY updated_at LIMIT 20")
      .bind(now, now).all<{ repository_id: number; target_tag: string; version: number }>();
    const result: ReleaseReceipt[] = [];
    for (const row of rows.results) {
      const changed = await this.db.prepare('UPDATE release_receipts SET dispatch_after=? WHERE repository_id=? AND target_tag=? AND current=1 AND version=? AND dispatch_after<=?')
        .bind(now + 15 * 60_000, row.repository_id, row.target_tag, row.version, now).run();
      if (changed.meta.changes === 1) result.push((await this.get(row.repository_id, row.target_tag))!);
    }
    return result;
  }
  async get(repositoryId: number, tag: string, revision?: number): Promise<ReleaseReceipt | null> {
    const row = await this.db.prepare(`SELECT record_json, version FROM release_receipts WHERE repository_id=? AND target_tag=? AND ${revision === undefined ? 'current=1' : 'revision=?'}`)
      .bind(repositoryId, tag, ...(revision === undefined ? [] : [revision])).first<{ record_json: string; version: number }>();
    if (!row) return null;
    const r = JSON.parse(row.record_json) as ReleaseReceipt;
    releaseAssert(r.frozen.repositoryId === repositoryId && r.frozen.targetTag === tag && r.version === row.version && r.frozenDigest === receiptDigest(canonicalReleaseJson(r.frozen)), 'CORRUPT');
    return r;
  }
  async prepare(receipt: ReleaseReceipt, now: string): Promise<ReleaseReceipt> {
    releaseAssert(Buffer.byteLength(canonicalReleaseJson(receipt)) <= releaseObjectLimits.recordBytes, 'RECORD_LIMIT');
    await this.db.prepare('INSERT OR IGNORE INTO release_receipts(repository_id,target_tag,revision,version,record_json,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(receipt.frozen.repositoryId, receipt.frozen.targetTag, receipt.revision, receipt.version, canonicalReleaseJson(receipt), now).run();
    const current = await this.get(receipt.frozen.repositoryId, receipt.frozen.targetTag);
    releaseAssert(current && current.frozenDigest === receipt.frozenDigest && current.revision === receipt.revision && current.draftNotes === receipt.draftNotes, 'VERSION_OCCUPIED');
    return current;
  }
  async claim(repositoryId: number, tag: string, now: number): Promise<{ token: string; receipt: ReleaseReceipt }> {
    const token = randomUUID();
    const changed = await this.db.prepare('UPDATE release_receipts SET lease_token=?,lease_until=? WHERE repository_id=? AND target_tag=? AND current=1 AND lease_until<=?')
      .bind(token, now + 10 * 60_000, repositoryId, tag, now).run();
    releaseAssert(changed.meta.changes === 1, 'CLAIM_BUSY');
    return { token, receipt: (await this.get(repositoryId, tag))! };
  }
  async assertClaim(repositoryId: number, tag: string, token: string, version: number, now: number): Promise<ReleaseReceipt> {
    const row = await this.db.prepare('UPDATE release_receipts SET lease_until=? WHERE repository_id=? AND target_tag=? AND current=1 AND lease_token=? AND lease_until>? AND version=? RETURNING version')
      .bind(now + 10 * 60_000, repositoryId, tag, token, now, version).first<{ version: number }>();
    releaseAssert(row?.version === version, 'CLAIM_STALE');
    return (await this.get(repositoryId, tag))!;
  }
  async save(previous: ReleaseReceipt, next: ReleaseReceipt, token: string, now: number): Promise<ReleaseReceipt> {
    releaseAssert(previous.candidateId === next.candidateId && previous.revision === next.revision && previous.frozenDigest === next.frozenDigest
      && canonicalReleaseJson(previous.frozen) === canonicalReleaseJson(next.frozen) && previous.draftNotes === next.draftNotes, 'IMMUTABLE');
    const saved = { ...next, version: previous.version + 1 };
    const bytes = canonicalReleaseJson(saved);
    releaseAssert(Buffer.byteLength(bytes) <= releaseObjectLimits.recordBytes, 'RECORD_LIMIT');
    const result = await this.db.prepare('UPDATE release_receipts SET record_json=?,version=?,updated_at=? WHERE repository_id=? AND target_tag=? AND revision=? AND current=1 AND version=? AND lease_token=? AND lease_until>?')
      .bind(bytes, saved.version, new Date(now).toISOString(), previous.frozen.repositoryId, previous.frozen.targetTag, previous.revision, previous.version, token, now).run();
    releaseAssert(result.meta.changes === 1, 'CLAIM_STALE');
    return saved;
  }
  async release(repositoryId: number, tag: string, token: string): Promise<void> {
    await this.db.prepare('UPDATE release_receipts SET lease_token=NULL,lease_until=0 WHERE repository_id=? AND target_tag=? AND current=1 AND lease_token=?').bind(repositoryId, tag, token).run();
  }
  async revise(previous: ReleaseReceipt, next: ReleaseReceipt, token: string, now: number): Promise<ReleaseReceipt> {
    releaseAssert(previous.paused && !previous.releaseId && !previous.operation && previous.phase !== 'verified'
      && next.candidateId === previous.candidateId && next.revision === previous.revision + 1 && next.version === 0 && next.phase === 'prepared', 'REVISION_STATE');
    const bytes = canonicalReleaseJson(next); releaseAssert(Buffer.byteLength(bytes) <= releaseObjectLimits.recordBytes, 'RECORD_LIMIT');
    const identity = [previous.frozen.repositoryId, previous.frozen.targetTag, previous.revision, previous.version, token, now];
    const results = await this.db.batch([
      this.db.prepare('UPDATE release_receipts SET current=0 WHERE repository_id=? AND target_tag=? AND revision=? AND version=? AND lease_token=? AND lease_until>? AND current=1').bind(...identity),
      this.db.prepare('INSERT INTO release_receipts(repository_id,target_tag,revision,version,record_json,updated_at) SELECT repository_id,target_tag,?,0,?,? FROM release_receipts WHERE repository_id=? AND target_tag=? AND revision=? AND version=? AND lease_token=? AND lease_until>? AND current=0')
        .bind(next.revision, bytes, new Date(now).toISOString(), ...identity),
    ]);
    releaseAssert(results.every(result => result.meta.changes === 1), 'CLAIM_STALE');
    return next;
  }
  async readObject(repositoryId: number, digest: string): Promise<Uint8Array> {
    releaseAssert(releaseDigest(digest), 'OBJECT_ID');
    const first = await this.getChunk(repositoryId, digest, 0);
    releaseAssert(first && positiveId(first.total) && first.total <= releaseObjectLimits.maxChunks, 'OBJECT_MISSING');
    const chunks: Buffer[] = []; let size = 0; const hash = createHash('sha256');
    for (let start = 0; start < first.total; start += 64) {
      const end = Math.min(start + 64, first.total);
      const rows = await this.db.prepare('SELECT part,total,bytes_base64 FROM release_evidence_chunks WHERE repository_id=? AND digest=? AND part>=? AND part<? ORDER BY part').bind(repositoryId, digest, start, end).all<{part: number; total: number; bytes_base64: string}>();
      releaseAssert(rows.results.length === end - start, 'OBJECT_INCOMPLETE');
      for (const [offset, row] of rows.results.entries()) {
        releaseAssert(row.part === start + offset && row.total === first.total, 'OBJECT_INCOMPLETE');
        const bytes = Buffer.from(row.bytes_base64, 'base64'); size += bytes.length;
        releaseAssert(bytes.length > 0 && bytes.length <= releaseObjectLimits.chunkBytes && bytes.toString('base64') === row.bytes_base64 && size <= releaseObjectLimits.objectBytes, 'OBJECT_READ_LIMIT');
        hash.update(bytes); chunks.push(bytes);
      }
    }
    releaseAssert(hash.digest('hex') === digest, 'OBJECT_DIGEST'); return Buffer.concat(chunks);
  }
  async putChunk(repositoryId: number, digest: string, part: number, total: number, encoded: string): Promise<void> {
    releaseAssert(positiveId(repositoryId) && releaseDigest(digest) && positiveId(total) && total <= releaseObjectLimits.maxChunks && Number.isInteger(part) && part >= 0 && part < total, 'OBJECT_ID');
    const bytes = Buffer.from(encoded, 'base64');
    releaseAssert(bytes.length > 0 && bytes.length <= releaseObjectLimits.chunkBytes && bytes.toString('base64') === encoded, 'OBJECT_CHUNK');
    // Keep the cumulative decoded size check in the insert so concurrent chunks cannot exceed the cap.
    await this.db.prepare("INSERT OR IGNORE INTO release_evidence_chunks SELECT ?,?,?,?,? WHERE COALESCE((SELECT SUM(length(CAST(bytes_base64 AS BLOB))/4*3 - CASE WHEN substr(bytes_base64,-2)='==' THEN 2 WHEN substr(bytes_base64,-1)='=' THEN 1 ELSE 0 END) FROM release_evidence_chunks WHERE repository_id=? AND digest=?),0)+?<=?")
      .bind(repositoryId, digest, part, total, encoded, repositoryId, digest, bytes.length, releaseObjectLimits.objectBytes).run();
    const row = await this.getChunk(repositoryId, digest, part);
    releaseAssert(row, 'OBJECT_WRITE_LIMIT');
    releaseAssert(row?.total === total && row.bytes_base64 === encoded, 'OBJECT_CONFLICT');
  }
  getChunk(repositoryId: number, digest: string, part: number) {
    return this.db.prepare('SELECT total,bytes_base64 FROM release_evidence_chunks WHERE repository_id=? AND digest=? AND part=?').bind(repositoryId, digest, part).first<{ total: number; bytes_base64: string }>();
  }
  async verifyObject(repositoryId: number, digest: string): Promise<number> {
    return (await this.readObject(repositoryId, digest)).byteLength;
  }
}
