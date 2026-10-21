import { it, expect } from 'vitest';
import { ReleaseTestDb } from './release-test-db.js';
import { ReleaseGenerationGraphStore } from '../src/release-generation-graph-store.js';
import { handleGenerationGraphTicket } from '../src/release-generation-graph-api.js';
import { planGenerationGraph } from '../../core/src/release-generation-graph.js';
import { runGenerationGraph } from '../../runner/src/release-generation-graph.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { receiptDigest } from '../../core/src/release-note-receipt.js';

it('limits a graph ticket to its own nodes and refuses preparation or ticket issuance', async () => {
  const db = new ReleaseTestDb(), store = new ReleaseGenerationGraphStore(db.binding()), policy = 'b'.repeat(40);
  try {
    const graph = planGenerationGraph('a'.repeat(64), policy, 10, ['input']);
    const id = await store.prepare(9001, 'v1.2.3', 10, graph, ['input']);
    const token = await store.ticket(id, policy, 1000);
    const call = (body: unknown, repo = 9001, auth = token) => handleGenerationGraphTicket(new Request('https://example.test/', {
      method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ graphDigest: id.graphDigest, ...body as object }),
    }), db.binding(), repo, 'v1.2.3', policy, () => 1001);
    expect(await call({ action: 'status' })).toMatchObject({ complete: false, ready: ['source:0'] });
    for (const action of ['prepare', 'ticket', 'objects']) {
      await expect(call({ action, nodeId: 'source:0' })).rejects.toThrow('GENERATION_REQUEST');
    }
    await expect(call({ action: 'status' }, 9002)).rejects.toThrow('GENERATION_AUTH');
    await expect(call({ action: 'status', graphDigest: 'c'.repeat(64) })).rejects.toThrow('GENERATION_AUTH');
    await expect(call({ action: 'reserve', nodeId: 'arbitrary-object-digest' })).rejects.toThrow();
    const reservation = await call({ action: 'reserve', nodeId: 'source:0' }) as { reservation: string };
    expect(reservation.reservation).toMatch(/^[a-f0-9]{48}$/);
    await expect(call({ action: 'complete', nodeId: 'source:0', reservation: 'd'.repeat(48), output: '{}' })).rejects.toThrow();
    await call({ action: 'yield' });
    await expect(call({ action: 'status' })).rejects.toThrow('GENERATION_AUTH');
  } finally { db.database.close(); }
});
it('exposes only the immutable source of the authenticated graph, never a caller-selected digest', async () => {
  const db = new ReleaseTestDb(), policy = 'b'.repeat(40), source = 'bound source';
  try {
    const objects = new ReleaseReceiptStore(db.binding());
    await objects.putChunk(9001, receiptDigest(source), 0, 1, Buffer.from(source).toString('base64'));
    await objects.putChunk(9001, receiptDigest('other'), 0, 1, Buffer.from('other').toString('base64'));
    const store = new ReleaseGenerationGraphStore(db.binding());
    const graph = planGenerationGraph(receiptDigest(source), policy, source.length, [source]);
    const id = await store.prepare(9001, 'v1.2.3', source.length, graph, [source]);
    const token = await store.ticket(id, policy, 1000);
    const call = (part: number) => handleGenerationGraphTicket(new Request('https://example.test/', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'source', graphDigest: id.graphDigest, part, digest: receiptDigest('other') }),
    }), db.binding(), 9001, 'v1.2.3', policy, () => 1001);
    expect(await call(0)).toEqual({ total: 1, bytes_base64: Buffer.from(source).toString('base64') });
    await expect(call(-1)).rejects.toThrow('GENERATION_SOURCE_PART');
    await expect(call(1)).rejects.toThrow('GENERATION_SOURCE_MISSING');
  } finally { db.database.close(); }
});

it('runs persisted leaves and hierarchical reductions through the ticket API, including format repair', async () => {
  const db = new ReleaseTestDb(), store = new ReleaseGenerationGraphStore(db.binding()), policy = 'b'.repeat(40);
  try {
    const inputs = Array.from({ length: 9 }, (_, i) => `input-${i}`);
    const graph = planGenerationGraph('a'.repeat(64), policy, 100, inputs);
    const id = await store.prepare(9001, 'v1.2.3', 100, graph, inputs);
    const token = await store.ticket(id, policy, 1000);
    const client = { async request<T>(_action: string, body: unknown): Promise<T> {
      return await handleGenerationGraphTicket(new Request('https://example.test/', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body as object, graphDigest: id.graphDigest }),
      }), db.binding(), 9001, 'v1.2.3', policy, () => 1001) as T;
    } };
    const output = JSON.stringify({ userNotes: { upgrade: [], changes: [{ category: '修复', text: '输出。' }] },
      reviewEvidence: { internalChanges: [], unknowns: [] } });
    const seen: Array<{ input: string; diagnostic?: string }> = [];
    const result = await runGenerationGraph(client, async (input, diagnostic) => {
      seen.push({ input, diagnostic });
      return seen.length === 1 ? '' : output;
    }, () => 1001);
    expect(result.complete).toBe(true);
    expect(seen).toHaveLength(graph.nodes.length + 1);
    expect(seen[1]!.diagnostic).toBe('provider returned empty output');
    expect(seen.filter(s => s.input.startsWith('input-'))).toHaveLength(10);
    const repeated = await runGenerationGraph(client, async () => { throw new Error('must reuse completed root'); }, () => 1001);
    expect(repeated).toEqual(result);
  } finally { db.database.close(); }
});
