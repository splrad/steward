import { canonicalReleaseJson, receiptDigest, releaseAssert, validateFrozenRelease, type FrozenRelease } from '../../core/src/release-note-receipt.js';
import { generationGraphDigest, generationSourceBatches, planGenerationGraphReferences } from '../../core/src/release-generation-graph.js';
import { validateReleaseSource } from '../../core/src/release-bundle.js';
import { ReleaseBuildStore } from './release-build-store.js';
import { ReleaseReceiptStore } from './release-note-receipts.js';
import { ReleaseGenerationGraphStore } from './release-generation-graph-store.js';

/** Called only after App authentication and repository/capability authorization. */
export async function issueGenerationGraph(
  db: D1Database, repositoryId: number, tag: string, policySha: string,
  body: { action: string; frozen?: FrozenRelease; offset?: number; graphDigest?: string },
  now = Date.now(),
): Promise<unknown> {
  const expected = await acceptedReleaseSeed(db, repositoryId, tag, policySha);
  const frozen = body.frozen ?? expected;
  validateFrozenRelease(frozen);
  releaseAssert(frozen.repositoryId === repositoryId && frozen.targetTag === tag && frozen.policySha === policySha, 'GENERATION_SEED_IDENTITY');
  releaseAssert(canonicalReleaseJson(frozen) === canonicalReleaseJson(expected), 'GENERATION_SEED_BINDING');
  if (body.action === 'seed') return { frozen };
  const bytes = await new ReleaseReceiptStore(db).readObject(repositoryId, frozen.sourceDigest);
  const source = validateReleaseSource(bytes, frozen);
  const offset = body.offset ?? 0;
  releaseAssert(Number.isSafeInteger(offset) && offset >= 0, 'GENERATION_PREPARE_OFFSET');
  const inputs: (string | undefined)[] = [], references: { digest: string; bytes: number }[] = [];
  generationSourceBatches(source, (batch, index) => {
    references.push({ digest: receiptDigest(batch), bytes: Buffer.byteLength(batch) });
    if (body.action === 'prepare' && index >= offset && index < offset + 16) inputs[index] = batch;
  });
  const graph = planGenerationGraphReferences(frozen.sourceDigest, policySha, bytes.byteLength, references);
  const id = { repositoryId, tag, graphDigest: generationGraphDigest(graph) };
  const store = new ReleaseGenerationGraphStore(db);
  if (body.action === 'prepare') return store.prepareVerifiedPage(repositoryId, tag, graph, inputs, offset);
  if (body.action === 'continue') {
    releaseAssert(body.graphDigest === id.graphDigest, 'GENERATION_GRAPH_BINDING');
    await store.continuation(id, policySha, now);
    return { continue: true, graphDigest: id.graphDigest };
  }
  releaseAssert(body.action === 'ticket' && body.graphDigest === id.graphDigest, 'GENERATION_GRAPH_BINDING');
  return { frozen, graphDigest: id.graphDigest, token: await store.ticket(id, policySha, now) };
}

/** Reconstruct the immutable input from the independently inspected initial seed. */
export async function acceptedReleaseSeed(db: D1Database, repositoryId: number, tag: string, policySha: string): Promise<FrozenRelease> {
  const accepted = await new ReleaseBuildStore(db).acceptedSeed(repositoryId, tag);
  releaseAssert(accepted && ((accepted.status === 'accepted' && accepted.artifact && accepted.resultManifests)
    || (accepted.status === 'seeded' && accepted.seedArtifact && accepted.artifact === null
      && accepted.request.plans.length === 0 && accepted.request.frozen.assets.length === 0
      && accepted.request.frozen.build === null)), 'GENERATION_SEED_NOT_ACCEPTED');
  const manifests = accepted.resultManifests ?? [];
  const expected: FrozenRelease = { ...accepted.request.frozen, build: accepted.artifact, manifests,
    assets: manifests.flatMap(m => m.artifacts.map(a => {
      releaseAssert(a.kind === 'file', 'GENERATION_SEED_ASSET');
      return { name: a.file, size: a.size, sha256: a.sha256 };
    })) };
  validateFrozenRelease(expected);
  releaseAssert(expected.repositoryId === repositoryId && expected.targetTag === tag && expected.policySha === policySha, 'GENERATION_SEED_IDENTITY');
  return expected;
}
