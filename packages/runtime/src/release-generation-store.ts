import { randomBytes } from 'node:crypto';
import { canonicalReleaseJson, receiptDigest, releaseAssert } from '../../core/src/release-note-receipt.js';
import { generationPlan, generationPlanDigest, parseGeneratedRelease, reserveGenerationCall, type GenerationLedger, type GenerationPlan } from '../../core/src/release-production.js';
import { ReleaseReceiptStore } from './release-note-receipts.js';

export class ReleaseGenerationStore {
  constructor(private readonly db: D1Database) {}
  async ticket(repositoryId: number, tag: string, now: number, expectedDigest?: string): Promise<string> {
    const current = await this.read(repositoryId, tag);
    releaseAssert(current, 'GENERATION_NOT_FOUND');
    releaseAssert(expectedDigest === undefined || expectedDigest === generationPlanDigest(current.ledger.plan), 'GENERATION_STALE');
    // Cover the frozen execution budget plus a bounded queue/setup allowance.
    const lifetimeMs = Math.max(60 * 60_000, current.ledger.plan.jobTimeoutMs + 30 * 60_000);
    const token = 'release-generation.' + randomBytes(32).toString('hex');
    const result = await this.db.prepare('UPDATE release_generation SET ticket_digest=?,ticket_until=? WHERE repository_id=? AND target_tag=? AND version=? AND (ticket_digest IS NULL OR ticket_until<=?)')
      .bind(receiptDigest(token), now + lifetimeMs, repositoryId, tag, current.version, now).run();
    releaseAssert(result.meta.changes === 1, 'GENERATION_TICKET_BUSY'); return token;
  }
  async authorize(repositoryId: number, tag: string, token: string, now: number, policySha: string): Promise<void> {
    const row = await this.db.prepare('SELECT record_json FROM release_generation WHERE repository_id=? AND target_tag=? AND ticket_digest=? AND ticket_until>?')
      .bind(repositoryId, tag, receiptDigest(token), now).first<{ record_json: string }>();
    releaseAssert(row && (JSON.parse(row.record_json) as GenerationLedger).plan.policySha === policySha, 'GENERATION_AUTH');
  }
  async read(repositoryId: number, tag: string): Promise<{ version: number; ledger: GenerationLedger } | null> {
    const row = await this.db.prepare('SELECT version,record_json FROM release_generation WHERE repository_id=? AND target_tag=?').bind(repositoryId, tag).first<{ version: number; record_json: string }>();
    return row ? { version: row.version, ledger: JSON.parse(row.record_json) } : null;
  }
  async prepare(repositoryId: number, tag: string, plan: GenerationPlan, now = Date.now()) {
    const expected = generationPlan(plan.sourceDigest, plan.policySha, plan.inputs);
    releaseAssert(canonicalReleaseJson(expected) === canonicalReleaseJson(plan) && Buffer.byteLength(canonicalReleaseJson(plan)) <= 256 * 1024, 'GENERATION_PLAN');
    await this.db.prepare('INSERT OR IGNORE INTO release_generation(repository_id,target_tag,plan_digest,record_json) VALUES(?,?,?,?)')
      .bind(repositoryId, tag, generationPlanDigest(plan), canonicalReleaseJson({ plan, calls: [] })).run();
    const current = (await this.read(repositoryId, tag))!;
    if (generationPlanDigest(current.ledger.plan) === generationPlanDigest(plan)) return current;
    releaseAssert(current.ledger.plan.sourceDigest !== plan.sourceDigest || current.ledger.plan.policySha !== plan.policySha, 'GENERATION_OCCUPIED');
    const digest = generationPlanDigest(plan);
    await this.db.batch([
      this.db.prepare('INSERT INTO release_generation_history(repository_id,target_tag,plan_digest,version,record_json) SELECT repository_id,target_tag,plan_digest,version,record_json FROM release_generation WHERE repository_id=? AND target_tag=? AND version=? AND restart_count<3 AND NOT EXISTS(SELECT 1 FROM release_receipts WHERE repository_id=? AND target_tag=?) AND NOT EXISTS(SELECT 1 FROM release_generation_history WHERE repository_id=? AND target_tag=? AND plan_digest=?) AND (ticket_digest IS NULL OR ticket_until<=?)')
        .bind(repositoryId, tag, current.version, repositoryId, tag, repositoryId, tag, digest, now),
      this.db.prepare('UPDATE release_generation SET plan_digest=?,record_json=?,version=version+1,restart_count=restart_count+1,ticket_digest=NULL,ticket_until=0 WHERE repository_id=? AND target_tag=? AND version=? AND EXISTS(SELECT 1 FROM release_generation_history h WHERE h.repository_id=release_generation.repository_id AND h.target_tag=release_generation.target_tag AND h.plan_digest=release_generation.plan_digest AND h.version=release_generation.version) AND (ticket_digest IS NULL OR ticket_until<=?)')
        .bind(digest, canonicalReleaseJson({ plan, calls: [] }), repositoryId, tag, current.version, now),
    ]);
    const next = (await this.read(repositoryId, tag))!;
    releaseAssert(generationPlanDigest(next.ledger.plan) === digest, 'GENERATION_OCCUPIED'); return next;
  }
  async mutate(repositoryId: number, tag: string, version: number, action: 'reserve' | 'complete' | 'diagnostic', input: string, index?: number, inputDigest?: string) {
    const current = await this.read(repositoryId, tag);
    releaseAssert(current && current.version === version, 'GENERATION_STALE');
    let ledger = current.ledger;
    if (action === 'reserve') ledger = reserveGenerationCall(ledger, input);
    else {
      releaseAssert(Number.isInteger(index) && index! >= 0 && index! < ledger.calls.length, 'GENERATION_CALL');
      releaseAssert(typeof inputDigest === 'string' && inputDigest === ledger.calls[index!]!.inputDigest, 'GENERATION_INPUT_BINDING');
      releaseAssert(Buffer.byteLength(input) <= 64 * 1024, 'GENERATION_LIMIT');
      const normalized = action === 'complete' ? canonicalReleaseJson(parseGeneratedRelease(Buffer.from(input))) : null;
      const call = ledger.calls[index!]!;
      releaseAssert(call.output === null || call.output === normalized, 'GENERATION_OUTPUT_IMMUTABLE');
      const bytes = Buffer.from(input), rawDigest = receiptDigest(bytes), chunkSize = 48 * 1024, total = Math.ceil(bytes.length / chunkSize);
      releaseAssert(call.rawDigest === undefined || call.rawDigest === rawDigest, 'GENERATION_OUTPUT_IMMUTABLE');
      const objects = new ReleaseReceiptStore(this.db);
      for (let part = 0; part < total; part++) await objects.putChunk(repositoryId, rawDigest, part, total, bytes.subarray(part * chunkSize, (part + 1) * chunkSize).toString('base64'));
      ledger = structuredClone(ledger);
      ledger.calls[index!]!.rawDigest = rawDigest;
      if (action === 'complete') ledger.calls[index!]!.output = normalized;
      else ledger.calls[index!]!.diagnostic = input.slice(0, 1024);
    }
    const bytes = canonicalReleaseJson(ledger); releaseAssert(Buffer.byteLength(bytes) <= 512 * 1024, 'GENERATION_LIMIT');
    const changed = await this.db.prepare('UPDATE release_generation SET record_json=?,version=version+1 WHERE repository_id=? AND target_tag=? AND version=?')
      .bind(bytes, repositoryId, tag, version).run();
    releaseAssert(changed.meta.changes === 1, 'GENERATION_STALE'); return { version: version + 1, ledger };
  }
}
