import { expect, it } from 'vitest';
import { prepareQualitySource, qualityBatchInput, reconcileQualitySources, renderQualitySummary, validateQualityOutput, decodeQualityCache,
  qualitySegmentKey, type QualitySource } from '../src/quality-language-summary.js';
import { decodeStateFile, stateRecordOwner } from '../src/release-observation.js';

const source:QualitySource={sourceCommentId:'review-comment:10',sourceCommit:'a'.repeat(40),sourceUrl:'https://github.com/test/repo/pull/1#discussion_r10',
  severity:'P1',bodyMarkdown:'Handle `src/foo.ts` before using API_KEY. Otherwise the caller fails.',updatedAt:'2026-10-28T00:00:00Z'};
const context={repositoryId:12,pullRequestNumber:1,head:'a'.repeat(40),configVersion:'v1',observedAt:'2026-10-28T01:00:00Z'};
const translation=(s:any)=>{const {bodyMarkdown,...fields}=s;return {...fields,problemZh:'处理调用失败的问题。',impactZh:'调用可能失败。',suggestionZh:'先验证输入。'};};

it('retains identifier order and handles long delimiter runs without retrying suffixes',()=>{
  const prepared=prepareQualitySource({...source,bodyMarkdown:'Check ``src/ERROR_CODE.ts`` and API_KEY before a//b/c and FOO-BAR. '+ '-'.repeat(4000)});
  expect(prepared.segments[0]!.originalIdentifiers).toEqual(['src/ERROR_CODE.ts','API_KEY','b/c','FOO-BAR']);
  const delimiters=prepareQualitySource({...source,bodyMarkdown:'Check '+ '`'.repeat(4000)+' remaining text.'});
  expect(delimiters.segments.flatMap(s=>s.originalIdentifiers)).toEqual([]);
});

it('preserves nested and top-level code/log bytes while splitting prose by code point',()=>{
  const code='```text\r\nTOKEN /path/test\r\n```',prepared=prepareQualitySource({...source,bodyMarkdown:'English finding.\n\n'+code+'\n\n'+('Check emoji 🧪. '.repeat(1500))+'\n\n> ```js\n> hello();\n> ```'});
  expect(prepared.preservedBlocks[0]).toBe(code);expect(prepared.preservedBlocks).toHaveLength(2);
  expect(prepared.segments.length).toBeGreaterThan(2);
  expect(prepared.segments.map(s=>s.bodyMarkdown).join('')).not.toContain('TOKEN');
  for(const [index,segment] of prepared.segments.entries()){expect(segment.segmentIndex).toBe(index);expect(segment.bodyMarkdown).not.toContain('\ufffd');qualityBatchInput([segment]);}
});
it('Chinese prose with English identifiers uses no segments; mixed English paragraphs remain visible',()=>{
  expect(prepareQualitySource({...source,bodyMarkdown:'请先检查 `src/foo.ts`。\n\n```log\nERROR 500\n```'}).segments).toEqual([]);
  expect(prepareQualitySource({...source,bodyMarkdown:'检查输入。\n\nThis loses data.'}).segments.length).toBeGreaterThan(0);
  expect(prepareQualitySource({...source,bodyMarkdown:'The value `错误` is never checked before use.'}).chinese).toBe(false);
  expect(prepareQualitySource({...source,bodyMarkdown:'The 中文 value is never checked before use.'}).chinese).toBe(false);
});
it.each(['sourceCommentId','sourceCommit','sourceUrl','severity','originalIdentifiers','segmentIndex','extra','problemZh'])('rejects changed or fabricated output %s',field=>{
  const segment=prepareQualitySource(source).segments[0]!,item:any=translation(segment);
  item[field]=field==='originalIdentifiers'?[]:field==='segmentIndex'?99:field==='problemZh'?'English only':'fake';
  expect(()=>validateQualityOutput({items:[item]},[segment])).toThrow(/QUALITY_OUTPUT/);
});
it('requires exactly one output per input and closed fields',()=>{
  const segment=prepareQualitySource(source).segments[0]!,item=translation(segment);
  expect(validateQualityOutput({items:[item]},[segment])).toEqual([item]);
  expect(()=>validateQualityOutput({items:[item,item]},[segment])).toThrow(/COVERAGE/);
  expect(()=>validateQualityOutput({items:[],status:'success'},[segment])).toThrow(/SCHEMA/);
});
it('binds cache to source bytes, version and native identity while keeping prior heads',async()=>{
  let cache=await reconcileQualitySources(null,context,[source]);const key=cache.heads[context.head]!.keys[0]!;
  cache.entries[key]!.result=translation(cache.entries[key]!.segment);
  expect((await reconcileQualitySources(cache,context,[source])).entries[key]!.result).not.toBeNull();
  expect(renderQualitySummary(cache).markdown).toContain('src/foo.ts\nAPI_KEY');
  cache=await reconcileQualitySources(cache,{...context,head:'b'.repeat(40)},[source]);expect(Object.keys(cache.heads)).toHaveLength(2);
  const changed=await reconcileQualitySources(cache,context,[{...source,bodyMarkdown:source.bodyMarkdown+' changed'}]);
  expect(changed.heads[context.head]!.keys).not.toEqual([key]);
  expect(await qualitySegmentKey({...cache.entries[key]!.segment,severity:'P2'},'v1')).not.toBe(key);
  const removed=await reconcileQualitySources(cache,context,[]);expect(renderQualitySummary(removed).total).toBe(0);expect(removed.entries[key]).toBeDefined();
  expect(decodeQualityCache(cache,12,1)).toEqual(cache);expect(()=>decodeQualityCache(cache,13,1)).toThrow(/IDENTITY|SCHEMA/);
});
it('retains original finding until every segment succeeds and keeps original commit visible',async()=>{
  const input={...source,bodyMarkdown:'English first. '.repeat(500)+'\n\nEnglish second.\n\n```log\nEXACT $text\n```'};
  const cache=await reconcileQualitySources(null,context,[input]);const keys=cache.heads[context.head]!.keys;
  cache.entries[keys[0]!]!.result=translation(cache.entries[keys[0]!]!.segment);
  expect(renderQualitySummary(cache)).toMatchObject({total:1,complete:0,pending:1});expect(renderQualitySummary(cache).markdown).toContain(input.bodyMarkdown);
  for(const key of keys)cache.entries[key]!.result=translation(cache.entries[key]!.segment);
  const final=renderQualitySummary(cache);expect(final.complete).toBe(1);expect(final.markdown).toContain('```log\nEXACT $text\n```');expect(final.markdown).toContain(source.sourceCommit);
});
it('strict quality schema joins the existing governance writer, preserving raw code line endings',async()=>{
  const bodyMarkdown='Check `src/foo.ts`.\r\n\r\n```text\r\n\tEXACT log\r\n```\r\n\r\nThe input fails. 🧪';
  const cache=await reconcileQualitySources(null,context,[{...source,bodyMarkdown}]);
  for(const entry of Object.values(cache.entries))entry.result={...translation(entry.segment),problemZh:'输入处理失败。\n请保留原始日志。'};
  expect(decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(cache)),12)).toEqual(cache);
  expect(decodeStateFile('steward/governance-state',`quality/1/${context.head}.md`,Buffer.from('```\r\ncode\r\n```'),12)).toBe('```\r\ncode\r\n```');
  expect(()=>decodeStateFile('steward/governance-state','quality/2.json',Buffer.from(JSON.stringify(cache)),12)).toThrow();
  expect(()=>stateRecordOwner('steward/release-state','quality/1.json')).toThrow();
  expect(()=>decodeQualityCache({...cache,commands:['do anything']},12,1)).toThrow(/SCHEMA/);
});
it.each(['configVersion','severity','sourceUrl','model'])('quality text handling keeps %s metadata strict',async field=>{
  const cache=await reconcileQualitySources(null,context,[source]),entry=Object.values(cache.entries)[0]!;
  if(field==='configVersion')cache.configVersion+='\n';
  else if(field==='severity')cache.heads[context.head]!.sources[0]!.severity+='\n';
  else if(field==='sourceUrl')entry.segment.sourceUrl+='\n';
  else entry.attempts.push({startedAt:context.observedAt,status:'UNKNOWN',model:'model\nname',usage:null});
  expect(()=>decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(cache)),12)).toThrow('RN_BUILD_INVALID');
});
it.each(['duplicate','utf8','bom','size','surrogate','nonfinite'])('quality text handling rejects malformed %s JSON',async kind=>{
  const cache=await reconcileQualitySources(null,context,[source]);let text=JSON.stringify(cache);
  if(kind==='duplicate')text=text.replace('"bodyMarkdown":','"bodyMarkdown":"first","bodyMarkdown":');
  if(kind==='bom')text='\ufeff'+text;
  if(kind==='size')text+=' '.repeat(512*1024);
  if(kind==='surrogate'){cache.heads[context.head]!.sources[0]!.bodyMarkdown='bad\ud800';text=JSON.stringify(cache);}
  if(kind==='nonfinite')text=text.replace('"cursor":0','"cursor":1e999');
  const bytes=kind==='utf8'?Buffer.from([0xff]):Buffer.from(text);
  const error=kind==='utf8'?TypeError:kind==='bom'?'RELEASE_OBSERVATION: state UTF-8 LF':kind==='size'?'RELEASE_OBSERVATION: state file bound':'RN_BUILD_INVALID';
  expect(()=>decodeStateFile('steward/governance-state','quality/1.json',bytes,12)).toThrow(error);
});
