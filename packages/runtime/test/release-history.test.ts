import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ReleaseHistoryReader } from '../src/release-history.js';
import { ReleaseTestDb } from './release-test-db.js';
it('exports all retained revisions and budget state with SELECT only', async () => {
  const db = new ReleaseTestDb();
  try {
    for (const revision of [1, 2]) db.database.prepare('INSERT INTO release_receipts(repository_id,target_tag,revision,version,current,record_json,updated_at) VALUES(?,?,?,?,?,?,?)').run(9001, 'v1.2.3', revision, revision, revision === 2 ? 1 : 0, JSON.stringify({ historical: revision }), 'fixture');
    db.database.prepare('INSERT INTO release_generation(repository_id,target_tag,plan_digest,record_json,restart_count,ticket_digest) VALUES(?,?,?,?,?,?)').run(9001, 'v1.2.3', 'a'.repeat(64), '{"calls":15,"limit":18,"runs":2,"status":"stopped"}', 2, 'private-ticket-digest');
    const sql: string[] = [], binding = db.binding();
    const reader = new ReleaseHistoryReader({ prepare(query: string) { expect(query.startsWith('SELECT ')).toBe(true); sql.push(query); return binding.prepare(query); } } as D1Database);
    const before = db.database.prepare('SELECT total_changes() AS n').get();
    const exported = await reader.exportCandidate(9001, 'v1.2.3');
    expect(exported.tables.receipts).toHaveLength(2);
    expect(exported.tables.generation).toMatchObject([{ restart_count: 2, record_json: '{"calls":15,"limit":18,"runs":2,"status":"stopped"}' }]);
    expect(JSON.stringify(exported)).not.toContain('private-ticket-digest');
    expect((await reader.exportCandidate(9002, 'v1.2.3')).tables.receipts).toEqual([]);
    expect(db.database.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(sql).toHaveLength(18);
  } finally { db.database.close(); }
});
it.each(['valid', 'corrupt', 'missing', 'wrong-repository'])('reads historical evidence without resetting it: %s', async kind => {
  const db = new ReleaseTestDb();
  try {
    const bytes = Buffer.from('历史输入与结果'), digest = createHash('sha256').update(bytes).digest('hex');
    db.database.prepare('INSERT INTO release_evidence_chunks VALUES(?,?,?,?,?)').run(9001, digest, 0, kind === 'missing' ? 2 : 1, (kind === 'corrupt' ? Buffer.from('wrong') : bytes).toString('base64'));
    const reader = new ReleaseHistoryReader(db.binding());
    const result = reader.readObject(kind === 'wrong-repository' ? 9002 : 9001, digest);
    if (kind === 'valid') expect(await result).toEqual(bytes); else await expect(result).rejects.toThrow('RELEASE_HISTORY');
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM release_evidence_chunks').get()).toEqual({ n: 1 });
  } finally { db.database.close(); }
});
