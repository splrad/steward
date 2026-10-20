import { it, expect } from 'vitest';
import { ReleaseTestDb } from './release-test-db.js';
import { ReleaseGenerationGraphStore } from '../src/release-generation-graph-store.js';
import { planGenerationGraph, generationGraphLimits } from '../../core/src/release-generation-graph.js';
import { generationPlan } from '../../core/src/release-production.js';
import { ReleaseGenerationStore } from '../src/release-generation-store.js';
const policySha = 'b'.repeat(40);
const output = JSON.stringify({ userNotes: { upgrade: [], changes: [{ category: '修复', text: '修复输出。' }] },
  reviewEvidence: { internalChanges: ['内部调整。'], unknowns: [] } });
async function fixture(inputs = ['one', 'two']) {
  const db = new ReleaseTestDb(), store = new ReleaseGenerationGraphStore(db.binding());
  const graph = planGenerationGraph('a'.repeat(64), policySha, 100, inputs);
  const id = await store.prepare(9001, 'v1.2.3', 100, graph, inputs);
  let now = 1000;
  const token = await store.ticket(id, policySha, now);
  return { db, store, graph, id, lease: { ...id, policySha, token, now: () => now }, advance: () => { now += 241 * 60000; } };
}
it('persists completion, restricts reductions to complete children, and resumes without repeating leaves', async () => {
  const f = await fixture();
  try {
    await expect(f.store.reserve(f.lease, f.graph.root)).rejects.toThrow('GENERATION_DEPENDENCY');
    const first = await f.store.reserve(f.lease, 'source:0');
    expect(first.input).toBe('one');
    await f.store.finish(f.lease, 'source:0', first.reservation, output);
    const reloaded = new ReleaseGenerationGraphStore(f.db.binding());
    expect((await reloaded.status(f.lease)).ready).toEqual(['source:1']);
    const second = await reloaded.reserve(f.lease, 'source:1');
    await reloaded.finish(f.lease, 'source:1', second.reservation, output);
    const root = await reloaded.reserve(f.lease, f.graph.root);
    expect(JSON.parse(root.input).batches).toHaveLength(2);
    await reloaded.finish(f.lease, f.graph.root, root.reservation, output);
    expect((await reloaded.status(f.lease)).complete).toBe(true);
    expect(JSON.parse(await reloaded.result(f.lease))).toEqual(JSON.parse(output));
    await expect(reloaded.reserve(f.lease, 'source:0')).rejects.toThrow('GENERATION_NODE_BUSY');
  } finally { f.db.database.close(); }
});
it('fences expired/replaced tickets and preserves the two-attempt cap across runs', async () => {
  const f = await fixture(['one']);
  try {
    const first = await f.store.reserve(f.lease, 'source:0');
    f.advance();
    await expect(f.store.finish(f.lease, 'source:0', first.reservation, output)).rejects.toThrow('GENERATION_AUTH');
    const token = await f.store.ticket(f.id, policySha, f.lease.now()), lease = { ...f.lease, token };
    const second = await f.store.reserve(lease, 'source:0');
    await expect(f.store.finish(lease, 'source:0', first.reservation, output)).rejects.toThrow('GENERATION_STALE');
    await f.store.finish(lease, 'source:0', second.reservation, 'bad output', true);
    await expect(f.store.reserve(lease, 'source:0')).rejects.toThrow('GENERATION_NODE_BUSY');
  } finally { f.db.database.close(); }
});
it('allows only one concurrent reservation and does not mutate an uncharged node', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([f.store.reserve(f.lease, 'source:0'), f.store.reserve(f.lease, 'source:1')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rows = f.db.database.prepare('SELECT SUM(attempts) AS attempts FROM release_generation_nodes').get()!;
    expect(rows.attempts).toBe(1);
    expect((await f.store.status(f.lease)).callsRemaining).toBe(generationGraphLimits.callsPerRun - 1);
  } finally { f.db.database.close(); }
});
it('denies foreign repository, graph, policy and arbitrary node access', async () => {
  const f = await fixture();
  try {
    for (const change of [{ repositoryId: 9002 }, { graphDigest: 'c'.repeat(64) }, { policySha: 'c'.repeat(40) }, { token: 'fake' }]) {
      await expect(f.store.status({ ...f.lease, ...change })).rejects.toThrow('GENERATION_AUTH');
    }
    await expect(f.store.reserve(f.lease, 'other-object')).rejects.toThrow();
    await expect(f.store.ticket(f.id, policySha, f.lease.now())).rejects.toThrow('GENERATION_TICKET_BUSY');
  } finally { f.db.database.close(); }
});
it('prepares bounded resumable pages and refuses tickets until every node is present', async () => {
  const db = new ReleaseTestDb(), store = new ReleaseGenerationGraphStore(db.binding());
  try {
    const inputs = Array.from({ length: 40 }, (_, n) => `input ${n}`);
    const graph = planGenerationGraph('a'.repeat(64), policySha, 1000, inputs);
    const first = await store.prepare(9001, 'v1.2.3', 1000, graph, inputs);
    expect(first.nextOffset).toBe(16); expect(first.ready).toBe(false);
    expect(db.database.prepare('SELECT COUNT(*) AS count FROM release_generation_nodes').get()!.count).toBe(16);
    await expect(store.ticket(first, policySha, 1000)).rejects.toThrow('GENERATION_TICKET_BUSY');
    const replay = await store.prepare(9001, 'v1.2.3', 1000, graph, inputs);
    expect(replay).toEqual(first);
    let page = replay;
    while (page.nextOffset < graph.nodes.length) page = await store.prepare(9001, 'v1.2.3', 1000, graph, inputs, page.nextOffset);
    expect(page.ready).toBe(true);
    expect(await store.ticket(page, policySha, 1000)).toMatch(/^release-generation-graph\./);
    await expect(store.prepare(9001, 'v1.2.3', 1000, graph, inputs, -1)).rejects.toThrow('GENERATION_PREPARE_OFFSET');
  } finally { db.database.close(); }
});
it('supplies persisted format diagnostics to the retry and fences yielded tickets', async () => {
  const f = await fixture(['one']);
  try {
    const first = await f.store.reserve(f.lease, 'source:0');
    await f.store.finish(f.lease, 'source:0', first.reservation, 'malformed JSON', true);
    const retry = await f.store.reserve(f.lease, 'source:0');
    expect(retry.diagnostic).toBe('malformed JSON');
    await f.store.finish(f.lease, 'source:0', retry.reservation, output);
    await f.store.yield(f.lease);
    await expect(f.store.result(f.lease)).rejects.toThrow('GENERATION_AUTH');
    const token = await f.store.ticket(f.id, policySha, f.lease.now());
    expect((await f.store.status({ ...f.lease, token })).complete).toBe(true);
  } finally { f.db.database.close(); }
});
it('preserves final-output capacity while keeping intermediate summaries bounded', async () => {
  const f = await fixture();
  try {
    const large = JSON.stringify({ userNotes: { upgrade: [], changes: Array.from({ length: 20 },
      () => ({ category: '修复', text: '修复'.repeat(100) + '。' })) },
      reviewEvidence: { internalChanges: [], unknowns: [] } });
    expect(Buffer.byteLength(large)).toBeGreaterThan(8192);
    const first = await f.store.reserve(f.lease, 'source:0');
    expect(first.outputBytes).toBe(8192);
    await expect(f.store.finish(f.lease, 'source:0', first.reservation, large)).rejects.toThrow('GENERATION_BATCH_OUTPUT');
    await f.store.finish(f.lease, 'source:0', first.reservation, output);
    const second = await f.store.reserve(f.lease, 'source:1');
    await f.store.finish(f.lease, 'source:1', second.reservation, output);
    const root = await f.store.reserve(f.lease, f.graph.root);
    expect(root.outputBytes).toBe(65536);
    await f.store.finish(f.lease, f.graph.root, root.reservation, large);
    expect(JSON.parse(await f.store.result(f.lease))).toEqual(JSON.parse(large));
  } finally { f.db.database.close(); }
});
it('revokes a legacy inline-ledger ticket without deleting its historical plan', async () => {
  const db = new ReleaseTestDb();
  try {
    const legacy = new ReleaseGenerationStore(db.binding());
    const plan = generationPlan('a'.repeat(64), policySha, ['old input']);
    await legacy.prepare(9001, 'v1.2.3', plan);
    const oldToken = await legacy.ticket(9001, 'v1.2.3', 1000);
    const graph = planGenerationGraph('a'.repeat(64), policySha, 100, ['old input']);
    const store = new ReleaseGenerationGraphStore(db.binding());
    const id = await store.prepare(9001, 'v1.2.3', 100, graph, ['old input']);
    await store.ticket(id, policySha, 1001);
    await expect(legacy.authorize(9001, 'v1.2.3', oldToken, 1002, policySha)).rejects.toThrow();
    expect((await legacy.read(9001, 'v1.2.3'))?.ledger.plan).toEqual(plan);
  } finally { db.database.close(); }
});
it('can recover an already completed root after the execution-run budget is exhausted', async () => {
  const f = await fixture(['one']);
  try {
    const reserved = await f.store.reserve(f.lease, 'source:0');
    await f.store.finish(f.lease, 'source:0', reserved.reservation, output);
    await f.store.yield(f.lease);
    f.db.database.prepare('UPDATE release_generation_graphs SET runs=max_runs').run();
    const token = await f.store.ticket(f.id, policySha, f.lease.now());
    expect(await f.store.status({ ...f.lease, token })).toMatchObject({ complete: true, runsRemaining: 0 });
    expect(JSON.parse(await f.store.result({ ...f.lease, token }))).toEqual(JSON.parse(output));
    await expect(f.store.reserve({ ...f.lease, token }, 'source:0')).rejects.toThrow('GENERATION_NODE_BUSY');
  } finally { f.db.database.close(); }
});
it('rejects unreserved output before storing any new object', async () => {
  const f = await fixture(['one']);
  try {
    const count = () => f.db.database.prepare('SELECT COUNT(*) AS n FROM release_evidence_chunks').get();
    const before = count();
    await expect(f.store.finish(f.lease, 'source:0', 'invalid', output)).rejects.toThrow('GENERATION_STALE');
    await expect(f.store.finish(f.lease, 'missing', 'invalid', output)).rejects.toThrow('GENERATION_STALE');
    expect(count()).toEqual(before);
  } finally { f.db.database.close(); }
});
