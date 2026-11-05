import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { planContentBatches, resumeContentBatches, assembleUnitNotes, contentWireInput, type ContentSource, type ContentRuntime, type ContentCache, type ContentWork } from '../src/release-content.js';
import { splitContentText, validateContentResult, validateContentInput, type ContentInput, type ContentItem } from '../../core/src/release-content.js';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const input = (): ContentInput => ({ schemaVersion: 1, repositoryId: 1, candidateId: digest('candidate'), baseSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40),
  configDigest: digest('config'), sourceManifestDigest: digest('manifest'), units: [{ id: 'app', path: '.', version: '1.1.0', tag: 'v1.1.0' }],
  boundaries: [{ unitId: 'app', kind: 'full-tree', sha: null, reference: null }], batches: [] });
function source(n: number, stage: 'CONTEXT' | 'DIFF' = 'DIFF'): ContentSource {
  return { id: digest(`${n}`), unitId: 'app', path: `${n}.ts`, previousPath: null, status: 'A:after', oid: 'c'.repeat(40), mode: '100644', byteLength: 6,
    encoding: 'utf8', sha256: digest('示例'), start: 0, end: 6, text: '示例', stage };
}
const item = (sourceIds: string[]): ContentItem => ({ sourceIds, visibility: 'USER', section: 'changes', statementZh: '增加使用说明，适用于当前版本。', qualification: 'SOURCE_CONFIRMED' });
function runtime() {
  let time = Date.parse('2026-10-27T00:00:00Z'), calls = 0, editing = false;
  const saves: ContentWork[] = [], requests: string[] = [];
  const port: ContentRuntime = {
    now: () => new Date(time).toISOString(), editing: async () => editing, preflight: async () => 'READY',
    save: async (work, _cache) => { validateContentInput(work.input); saves.push(structuredClone(work)); },
    call: async text => {
      calls++; requests.push(text); const payload = JSON.parse(text);
      return { text: JSON.stringify({ paragraphs: [{ sourceIds: [payload.sources[0].id], section: 'changes', textZh: '增加使用说明，适用于当前版本。', qualification: 'SOURCE_CONFIRMED' }] }), model: 'offline-fixture', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { port, saves, requests, calls: () => calls, advance: (ms: number) => { time += ms; }, edit: () => { editing = true; } };
}

it('generates one direct draft with seven sections and reuses an input-digest cache', async () => {
  const work = await planContentBatches(input(), [source(1, 'CONTEXT'), source(2)]), cache = {}, r = runtime();
  expect(await resumeContentBatches(work, cache, r.port)).toEqual({status:'READY', calls:1});
  expect(r.requests.map(s => JSON.parse(s).stage)).toEqual(['DRAFT']);
  expect(work.input.batches[0]).not.toHaveProperty('parentId');
  expect(work.input.batches[0]).not.toHaveProperty('childIds');
  expect(r.saves.some(w => w.input.batches[0]?.attempts[0]?.status === 'SENT')).toBe(true);
  expect(assembleUnitNotes(work)[0]!.content.match(/^## /gm)).toHaveLength(7);
  const next = await planContentBatches({...input(), baseSha:'d'.repeat(40)}, [source(1,'CONTEXT'),source(2)]);
  expect(await resumeContentBatches(next, cache, r.port)).toEqual({status:'READY', calls:0});
});
it('requires Chinese closed output, known references and evidence for test claims without exhaustive source coverage', () => {
  const paragraph = {sourceIds:[source(1).id],section:'changes',textZh:'修复实际问题。',qualification:'SOURCE_CONFIRMED'};
  expect(validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph]}),[source(1).id,source(2).id])).toBeDefined();
  const command={...paragraph,textZh:'npm install @splrad/product'};
  expect(validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph,command]}),[source(1).id])).toBeDefined();
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[command]}),[source(1).id])).toThrow('CONTENT_STATEMENT_INVALID');
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph],command:'execute'}),[source(1).id])).toThrow('CONTENT_OUTPUT_SCHEMA');
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[{...paragraph,qualification:'TEST_CONFIRMED'}]}),[source(1).id])).toThrow('CONTENT_TEST_EVIDENCE_REQUIRED');
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph]}),[source(2).id])).toThrow('CONTENT_SOURCE_UNKNOWN');
});
it('preserves completed output on failure and does not automatically resend an unknown request', async () => {
  const work=await planContentBatches(input(),[source(1)]),cache={},r=runtime();
  r.port.call=async()=>{throw new Error('network response lost');};
  expect(await resumeContentBatches(work,cache,r.port)).toEqual({status:'FAILED',calls:1});
  expect(work.input.batches[0]?.attempts[0]?.status).toBe('UNKNOWN');
  expect(await resumeContentBatches(work,cache,r.port)).toEqual({status:'FAILED',calls:0});
  expect(()=>assembleUnitNotes(work)).toThrow('CONTENT_NOT_READY');
});
it('does not call the model while paused or lacking authorization', async()=>{
  const work=await planContentBatches(input(),[source(1)]),r=runtime();r.edit();
  expect(await resumeContentBatches(work,{},r.port)).toEqual({status:'EDITING',calls:0});
  const q=runtime();q.port.preflight=async()=> 'WAIT_AUTH';
  expect(await resumeContentBatches(work,{},q.port)).toEqual({status:'WAIT_AUTH',calls:0});
});
it('passes curated input above the retired 24 KiB threshold intact to the call boundary',async()=>{
  const text='中文'.repeat(20000),work=await planContentBatches(input(),[{...source(1),text}]),r=runtime();
  const call=r.port.call;r.port.call=async payload=>{expect(JSON.parse(payload).sources[0].text).toBe(text);return call(payload);};
  expect(await resumeContentBatches(work,{},r.port)).toEqual({status:'READY',calls:1});
});
it('retains archive byte splitting without requiring model byte coverage',()=>{
  const text='中文🙂\n'.repeat(1000),parts=splitContentText(text,101);
  expect(parts.map(p=>p.text).join('')).toBe(text);
  expect(parts[0]!.start).toBe(0);expect(parts.at(-1)!.end).toBe(Buffer.byteLength(text));
  expect(parts.every((p,i)=>i===0||p.start===parts[i-1]!.end)).toBe(true);
});
