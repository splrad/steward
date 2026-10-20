import { expect, it } from 'vitest';
import { generationGraphLimits as limits, generationSourceBatches, planGenerationGraph, planGenerationGraphReferences, readyGenerationNodes, generationGraphDigest } from '../src/release-generation-graph.js';
import { createHash } from 'node:crypto';
import { receiptDigest } from '../src/release-note-receipt.js';

const plan = (inputs: string[]) => planGenerationGraph('a'.repeat(64), 'b'.repeat(40), limits.sourceBytes, inputs);
it('checks maximum-size graph readiness in linear node visits and still rejects unknown results',()=>{
  const graph=plan(Array(limits.leaves).fill('x'));
  const completed=new Set(graph.nodes.map(node=>node.id));
  let visits=0;
  graph.nodes=graph.nodes.map(node=>new Proxy(node,{get(target,key,receiver){if(key==='id')visits++;return Reflect.get(target,key,receiver);}}));
  expect(readyGenerationNodes(graph,completed)).toEqual([]);
  expect(visits).toBeLessThanOrEqual(graph.nodes.length*3);
  completed.add('unknown');
  expect(()=>readyGenerationNodes(graph,completed)).toThrow('GENERATION_NODE');
});
it('retains a source at the 32 MiB boundary with a compact reference graph', () => {
  const graph = plan(Array.from({ length: 512 }, () => 'x'.repeat(64 * 1024)));
  expect(graph.nodes.filter(n => n.kind === 'source')).toHaveLength(512);
  expect(JSON.stringify(graph).length).toBeLessThan(128 * 1024);
  expect(graph.nodes.every(n => n.children.length <= 8)).toBe(true);
  expect(graph.maxCalls).toBe(1170);
  expect(graph.maxRuns).toBe(20);
});
it('streams a real 32 MiB serialized source with worst-case control escaping without retaining all batches', () => {
  const raw = Buffer.alloc(23 * 1024 * 1024);
  const source = { padding: '', objects: [{ encoding: 'utf8', rawBase64: raw.toString('base64') }] };
  source.padding = 'p'.repeat(limits.sourceBytes - Buffer.byteLength(JSON.stringify(source)) - 1);
  const size = Buffer.byteLength(JSON.stringify(source)) + 1;
  expect(size).toBe(limits.sourceBytes);
  const restored = createHash('sha256'), references: { digest: string; bytes: number }[] = [];
  const retained = generationSourceBatches(source, batch => {
    const bytes = Buffer.byteLength(batch);
    expect(bytes).toBeLessThanOrEqual(limits.inputBytes);
    references.push({ digest: receiptDigest(batch), bytes });
    for (const unit of JSON.parse(batch)) if (unit.section === 'object:0:text') restored.update(unit.text);
  });
  expect(retained).toEqual([]);
  expect(restored.digest('hex')).toBe(receiptDigest(raw));
  const graph = planGenerationGraphReferences('a'.repeat(64), 'b'.repeat(40), size, references);
  expect(graph.nodes.length).toBeGreaterThan(1000);
  expect(graph.maxCalls).toBeLessThanOrEqual(9362);
}, 30000);
it('bounds maximum calls and per-run execution without dropping source positions', () => {
  const graph = plan(Array.from({ length: limits.leaves }, () => 'same text'));
  expect(graph.nodes).toHaveLength(4681);
  expect(graph.maxCalls).toBe(9362);
  expect(graph.maxRuns).toBe(157);
  expect(new Set(graph.nodes.map(n => n.id)).size).toBe(graph.nodes.length);
  expect(limits.callsPerRun * limits.callTimeoutMs).toBeLessThan(limits.runTimeoutMs);
});
it('resumes only unfinished nodes and waits for all reduction dependencies', () => {
  const graph = plan(['one', 'two']);
  expect(readyGenerationNodes(graph, new Set()).map(n => n.id)).toEqual(['source:0', 'source:1']);
  expect(readyGenerationNodes(graph, new Set(['source:0'])).map(n => n.id)).toEqual(['source:1']);
  expect(readyGenerationNodes(graph, new Set(['source:0', 'source:1'])).map(n => n.id)).toEqual([graph.root]);
  expect(readyGenerationNodes(graph, new Set(graph.nodes.map(n => n.id)))).toEqual([]);
  expect(() => readyGenerationNodes(graph, new Set(['unknown']))).toThrow();
});
it('binds order, content and policy in the plan digest', () => {
  expect(generationGraphDigest(plan(['a', 'b']))).not.toBe(generationGraphDigest(plan(['b', 'a'])));
  expect(generationGraphDigest(plan(['a']))).not.toBe(generationGraphDigest(plan(['c'])));
  const graph = plan(['a']);
  expect(generationGraphDigest(graph)).not.toBe(generationGraphDigest({ ...graph, policySha: 'c'.repeat(40) }));
});
it('rejects limits explicitly rather than truncating', () => {
  expect(() => plan([])).toThrow();
  expect(() => plan(['x'.repeat(limits.inputBytes + 1)])).toThrow();
  expect(() => plan(Array(limits.leaves + 1).fill('x'))).toThrow();
  expect(() => planGenerationGraph('a'.repeat(64), 'b'.repeat(40), limits.sourceBytes + 1, ['x'])).toThrow();
});
it('segments large metadata and escaped Unicode text without loss', () => {
  const metadata = { paths: Array.from({length: 20000}, (_, i) => `path-${i}`) };
  const text = '\0😀"\\\n'.repeat(40000);
  const batches = generationSourceBatches({ ...metadata, objects: [{ oid: 'abc', encoding: 'utf8', rawBase64: Buffer.from(text).toString('base64') }] });
  expect(batches.every(b => Buffer.byteLength(b) <= limits.inputBytes)).toBe(true);
  const units = batches.flatMap(b => JSON.parse(b));
  const restore = (section: string) => units.filter(u => u.section === section).map(u => u.text).join('');
  expect(JSON.parse(restore('metadata'))).toEqual(metadata);
  expect(restore('object:0:text')).toBe(text);
  expect(plan(batches).nodes.length).toBeGreaterThan(8);
});
