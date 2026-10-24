import { createHash } from 'node:crypto';

const limits = { bytes: 32 * 1024 * 1024, chunks: 2048, chunkBytes: 48 * 1024 };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`RELEASE_HISTORY: ${message}`); }
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const selections = {
  receipts: 'SELECT revision,version,current,record_json,updated_at FROM release_receipts WHERE repository_id=? AND target_tag=? ORDER BY revision',
  builds: 'SELECT request_key,record_json,version,policy_archived FROM release_build_requests WHERE repository_id=? AND target_tag=? ORDER BY request_key',
  generation: 'SELECT plan_digest,record_json,version,restart_count FROM release_generation WHERE repository_id=? AND target_tag=?',
  generationHistory: 'SELECT plan_digest,record_json,version FROM release_generation_history WHERE repository_id=? AND target_tag=? ORDER BY plan_digest',
  graphs: 'SELECT graph_digest,policy_sha,source_digest,root_node,node_count,max_runs,ready,runs,run_calls,version FROM release_generation_graphs WHERE repository_id=? AND target_tag=? ORDER BY graph_digest',
  nodes: 'SELECT graph_digest,node_id,input_digest,children_json,attempts,output_digest,diagnostic_digest FROM release_generation_nodes WHERE repository_id=? AND target_tag=? ORDER BY graph_digest,node_id',
  plans: 'SELECT source_digest,policy_sha,graph_digest FROM release_generation_plans WHERE repository_id=? AND target_tag=? ORDER BY source_digest,policy_sha',
  policyMigrations: 'SELECT revision,policy_sha,receipt_json FROM release_policy_migrations WHERE repository_id=? AND target_tag=? ORDER BY revision',
  policyRetargets: 'SELECT revision,ordinal,policy_sha FROM release_policy_retargets WHERE repository_id=? AND target_tag=? ORDER BY revision,ordinal',
} as const;

/** Historical storage has no claim, retry, dispatch or mutation methods. SQL
 * migrations and original JSON bytes remain available for independent export. */
export class ReleaseHistoryReader {
  constructor(private readonly db: D1Database) {}
  async exportCandidate(repositoryId: number, tag: string) {
    assert(positive(repositoryId) && typeof tag === 'string' && tag.length > 0 && tag.length <= 256 && !/[\x00-\x1f]/.test(tag), 'candidate identity');
    const tables: Record<string, unknown[]> = {};
    for (const [name, sql] of Object.entries(selections)) {
      const result = await this.db.prepare(sql).bind(repositoryId, tag).all();
      assert(result.success && Array.isArray(result.results), 'incomplete history query'); tables[name] = result.results;
    }
    return { repositoryId, tag, mode: 'historical-read-only' as const, tables };
  }
  async readObject(repositoryId: number, digest: string): Promise<Buffer> {
    assert(positive(repositoryId) && /^[a-f0-9]{64}$/.test(digest), 'object identity');
    const first = await this.db.prepare('SELECT total FROM release_evidence_chunks WHERE repository_id=? AND digest=? AND part=0').bind(repositoryId, digest).first<{ total: number }>();
    assert(first && positive(first.total) && first.total <= limits.chunks, 'object missing');
    const chunks: Buffer[] = [], hash = createHash('sha256'); let size = 0;
    for (let start = 0; start < first.total; start += 64) {
      const end = Math.min(start + 64, first.total);
      const rows = await this.db.prepare('SELECT part,total,bytes_base64 FROM release_evidence_chunks WHERE repository_id=? AND digest=? AND part>=? AND part<? ORDER BY part').bind(repositoryId, digest, start, end).all<{ part: number; total: number; bytes_base64: string }>();
      assert(rows.success && rows.results.length === end - start, 'object incomplete');
      for (const [offset, row] of rows.results.entries()) {
        assert(row.part === start + offset && row.total === first.total, 'object sequence');
        const bytes = Buffer.from(row.bytes_base64, 'base64'); size += bytes.length;
        assert(bytes.length > 0 && bytes.length <= limits.chunkBytes && bytes.toString('base64') === row.bytes_base64 && size <= limits.bytes, 'object size or encoding');
        hash.update(bytes); chunks.push(bytes);
      }
    }
    assert(hash.digest('hex') === digest, 'object digest'); return Buffer.concat(chunks);
  }
}
