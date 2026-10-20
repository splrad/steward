import { releaseAssert, releaseDigest, releaseSha } from '../../core/src/release-note-receipt.js';
import { ReleaseGenerationGraphStore, type GraphLease } from './release-generation-graph-store.js';

/** Ticket-only model API: no issuance, source mutation, or arbitrary object reads. */
export async function handleGenerationGraphTicket(
  request: Request, db: D1Database, repositoryId: number, tag: string, policySha: string,
  now: () => number = Date.now,
): Promise<unknown> {
  releaseAssert(request.method === 'POST', 'METHOD');
  releaseAssert(releaseSha(policySha), 'POLICY_STALE');
  const text = await request.text();
  releaseAssert(Buffer.byteLength(text) <= 512 * 1024, 'REQUEST_LIMIT');
  const body = JSON.parse(text);
  releaseAssert(body && typeof body === 'object' && !Array.isArray(body)
    && releaseDigest(body.graphDigest), 'GENERATION_REQUEST');
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  releaseAssert(/^release-generation-graph\.[a-f0-9]{64}$/.test(token), 'GENERATION_AUTH');
  const lease: GraphLease = { repositoryId, tag, graphDigest: body.graphDigest, policySha, token, now };
  const store = new ReleaseGenerationGraphStore(db);
  // Authenticate even unknown actions; never expose another graph's state.
  await store.authenticate(lease);
  if (body.action === 'status') return store.status(lease);
  if (body.action === 'source') return store.sourcePart(lease, body.part);
  if (body.action === 'result') return { output: await store.result(lease) };
  if (body.action === 'yield') { await store.yield(lease); return { yielded: true }; }
  releaseAssert(typeof body.nodeId === 'string' && body.nodeId.length <= 64, 'GENERATION_NODE');
  if (body.action === 'reserve') return store.reserve(lease, body.nodeId);
  releaseAssert(['complete', 'diagnostic'].includes(body.action)
    && typeof body.reservation === 'string' && /^[a-f0-9]{48}$/.test(body.reservation)
    && typeof body.output === 'string', 'GENERATION_REQUEST');
  await store.finish(lease, body.nodeId, body.reservation, body.output, body.action === 'diagnostic');
  return { stored: true };
}
