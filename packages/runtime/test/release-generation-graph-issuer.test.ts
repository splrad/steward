import { it, expect, vi } from 'vitest';
import { frozenFixture } from '../../core/test/release-receipt-fixture.js';
import { canonicalReleaseJson } from '../../core/src/release-note-receipt.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { ReleaseTestDb } from './release-test-db.js';
import { issueGenerationGraph } from '../src/release-generation-graph-issuer.js';
import { ReleaseGenerationGraphStore } from '../src/release-generation-graph-store.js';
vi.mock('../../core/src/release-bundle.js', () => ({
  validateReleaseSource: vi.fn(() => ({ objects: [], changes: [], commits: [] })),
}));

it('binds issuance to the exact accepted initial seed and resumes only yielded unfinished graphs', async () => {
  const db = new ReleaseTestDb(), base = frozenFixture();
  const build = { runId: 10, artifactId: 20, artifactName: 'release-build-result-1', headSha: base.policySha };
  const frozen = { ...base, build };
  try {
    const call = (body: any) => issueGenerationGraph(db.binding(), 9001, base.targetTag, base.policySha, { frozen, ...body }, 1000);
    await expect(call({ action: 'prepare' })).rejects.toThrow('GENERATION_SEED_NOT_ACCEPTED');
    const state = { request: { mode: 'initial', frozen: base }, status: 'accepted', artifact: build, resultManifests: [] };
    db.database.prepare('INSERT INTO release_build_requests(request_key,repository_id,target_tag,record_json) VALUES(?,?,?,?)')
      .run('fixture', 9001, base.targetTag, canonicalReleaseJson(state));
    await new ReleaseReceiptStore(db.binding()).putChunk(9001, base.sourceDigest, 0, 1, Buffer.from('source').toString('base64'));
    await expect(call({ action: 'prepare', frozen: { ...frozen, title: 'Changed' } })).rejects.toThrow('GENERATION_SEED_BINDING');
    await expect(call({ action: 'prepare', frozen: { ...frozen, policySha: 'd'.repeat(40), build: { ...build, headSha: 'd'.repeat(40) } } })).rejects.toThrow('GENERATION_SEED_IDENTITY');
    const page = await call({ action: 'prepare' }) as { graphDigest: string; ready: boolean };
    expect(page.ready).toBe(true);
    await expect(call({ action: 'ticket', graphDigest: 'e'.repeat(64) })).rejects.toThrow('GENERATION_GRAPH_BINDING');
    const grant = await call({ action: 'ticket', graphDigest: page.graphDigest }) as { token: string };
    await expect(call({ action: 'continue', graphDigest: page.graphDigest })).rejects.toThrow('GENERATION_CONTINUATION');
    const store = new ReleaseGenerationGraphStore(db.binding());
    await store.yield({ repositoryId: 9001, tag: base.targetTag, graphDigest: page.graphDigest, policySha: base.policySha, token: grant.token, now: () => 1001 });
    expect(await call({ action: 'continue', graphDigest: page.graphDigest })).toEqual({ continue: true, graphDigest: page.graphDigest });
    db.database.prepare('UPDATE release_build_requests SET policy_archived=1').run();
    await expect(call({ action: 'ticket', graphDigest: page.graphDigest })).rejects.toThrow('GENERATION_SEED_NOT_ACCEPTED');
  } finally { db.database.close(); }
});
