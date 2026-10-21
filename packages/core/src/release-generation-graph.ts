import { canonicalReleaseJson, receiptDigest, releaseAssert, releaseDigest, releaseSha } from './release-note-receipt.js';

/** Durable generation protocol. Text and results live in digest-addressed objects. */
export const generationGraphLimits = {
  prepareNodes: 2,
  sourceBytes: 32 * 1024 * 1024,
  inputBytes: 96 * 1024,
  outputBytes: 8 * 1024,
  rootOutputBytes: 64 * 1024,
  leaves: 4096,
  fanIn: 8,
  attemptsPerNode: 2,
  callTimeoutMs: 180000,
  callsPerRun: 60,
  runTimeoutMs: 210 * 60000,
} as const;

export interface GenerationNode {
  id: string;
  kind: 'source' | 'reduce';
  inputDigest: string | null;
  children: string[];
}
export interface GenerationGraph {
  schemaVersion: 2;
  sourceDigest: string;
  policySha: string;
  nodes: GenerationNode[];
  root: string;
  maxCalls: number;
  maxRuns: number;
}

/** Lossless text segments, including large metadata; no oversized metadata singleton. */
export function generationSourceBatches(source: { objects: { encoding: string; rawBase64: string; [key: string]: unknown }[]; [key: string]: unknown },
  consume?: (batch: string, index: number) => void): string[] {
  const { objects, ...metadata } = source;
  releaseAssert(Array.isArray(objects), 'GENERATION_SOURCE');
  const batches: string[] = [];
  let batchCount = 0;
  const emit = (batch: string) => {
    releaseAssert(batchCount < generationGraphLimits.leaves, 'GENERATION_BATCH_LIMIT');
    if (consume) consume(batch, batchCount); else batches.push(batch);
    batchCount++;
  };
  let units: unknown[] = [];
  const append = (unit: unknown) => {
    const single = canonicalReleaseJson([unit]);
    releaseAssert(Buffer.byteLength(single) <= generationGraphLimits.inputBytes, 'GENERATION_UNIT_LIMIT');
    if (units.length && Buffer.byteLength(canonicalReleaseJson([...units, unit])) > generationGraphLimits.inputBytes) {
      emit(canonicalReleaseJson(units)); units = [];
    }
    units.push(unit);
  };
  const segment = (section: string, text: string | Iterable<string>) => {
    let part = 0, chunk = '';
    // 8000 code points allow even fully JSON-escaped control text plus envelope.
    let count = 0;
    for (const piece of typeof text === 'string' ? [text] : text) {
      for (const point of piece) {
        chunk += point; count++;
        if (count === 8000) { append({ section, part: part++, text: chunk, final: false }); chunk = ''; count = 0; }
      }
    }
    append({ section, part, text: chunk, final: true });
  };
  segment('metadata', canonicalReleaseJson(metadata));
  objects.forEach((object, index) => {
    const { rawBase64, ...identity } = object;
    segment(`object:${index}:identity`, canonicalReleaseJson(identity));
    if (object.encoding === 'binary') {
      append({ section: `object:${index}:binary`, unknown: 'Binary semantics require independent evidence.' });
    } else {
      function* decodedText() {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        // Base64 boundaries are multiples of four; UTF-8 state spans byte chunks.
        for (let offset = 0; offset < rawBase64.length; offset += 48 * 1024) {
          const encoded = rawBase64.slice(offset, offset + 48 * 1024);
          releaseAssert(offset + encoded.length === rawBase64.length || !encoded.includes('='), 'GENERATION_SOURCE');
          const bytes = Buffer.from(encoded, 'base64');
          releaseAssert(bytes.toString('base64') === encoded, 'GENERATION_SOURCE');
          yield decoder.decode(bytes, { stream: true });
        }
        yield decoder.decode();
      }
      segment(`object:${index}:text`, decodedText());
    }
  });
  if (units.length) emit(canonicalReleaseJson(units));
  return batches;
}

/**
 * The caller supplies all deterministic, lossless source batches. This function
 * neither truncates oversized input nor calls a provider. Validate before build.
 */
export function planGenerationGraph(sourceDigest: string, policySha: string, sourceBytes: number, inputs: readonly string[]): GenerationGraph {
  return planGenerationGraphReferences(sourceDigest, policySha, sourceBytes, inputs.map(input => {
    releaseAssert(typeof input === 'string', 'GENERATION_INPUT');
    return { digest: receiptDigest(input), bytes: Buffer.byteLength(input) };
  }));
}
export function planGenerationGraphReferences(sourceDigest: string, policySha: string, sourceBytes: number,
  inputs: readonly { digest: string; bytes: number }[]): GenerationGraph {
  const l = generationGraphLimits;
  releaseAssert(releaseDigest(sourceDigest) && releaseSha(policySha)
    && Number.isSafeInteger(sourceBytes) && sourceBytes > 0 && sourceBytes <= l.sourceBytes, 'GENERATION_SOURCE_LIMIT');
  releaseAssert(inputs.length > 0 && inputs.length <= l.leaves, 'GENERATION_BATCH_LIMIT');
  const nodes: GenerationNode[] = [];
  let layer = inputs.map((input, index) => {
    releaseAssert(releaseDigest(input.digest) && Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= l.inputBytes, 'GENERATION_INPUT');
    // Include position: identical text at different source positions is not omitted.
    const node: GenerationNode = { id: `source:${index}`, kind: 'source', inputDigest: input.digest, children: [] };
    nodes.push(node); return node.id;
  });
  let depth = 0;
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += l.fanIn) {
      const node: GenerationNode = { id: `reduce:${depth}:${i / l.fanIn}`, kind: 'reduce', inputDigest: null, children: layer.slice(i, i + l.fanIn) };
      nodes.push(node); next.push(node.id);
    }
    layer = next; depth++;
  }
  const maxCalls = nodes.length * l.attemptsPerNode;
  return { schemaVersion: 2, sourceDigest, policySha, nodes, root: layer[0]!, maxCalls,
    maxRuns: Math.ceil(maxCalls / l.callsPerRun) };
}

export function generationGraphDigest(graph: GenerationGraph): string {
  return receiptDigest(canonicalReleaseJson(graph));
}

export function preflightGenerationSource(sourceDigest: string, policySha: string, sourceBytes: number,
  source: Parameters<typeof generationSourceBatches>[0]): GenerationGraph {
  const references: { digest: string; bytes: number }[] = [];
  generationSourceBatches(source, batch => references.push({ digest: receiptDigest(batch), bytes: Buffer.byteLength(batch) }));
  return planGenerationGraphReferences(sourceDigest, policySha, sourceBytes, references);
}

/** Readiness is defined by persisted results, never by a prior runner's exit code. */
export function readyGenerationNodes(graph: GenerationGraph, completed: ReadonlySet<string>): GenerationNode[] {
  const ids = new Set(graph.nodes.map(node => node.id));
  releaseAssert([...completed].every(id => ids.has(id)), 'GENERATION_NODE');
  return graph.nodes.filter(node => !completed.has(node.id) && node.children.every(id => completed.has(id)));
}
