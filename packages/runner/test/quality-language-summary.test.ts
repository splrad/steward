import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { collectQualitySources, publishQualityCheck, serviceQualityPullRequest, translateQualitySources, qualityPages, type QualityContext, type QualityIO } from '../src/quality-language-summary.js';
import { reconcileQualitySources, renderQualitySummary, type QualityCache, type QualitySource } from '../../core/src/quality-language-summary.js';
import { decodeStateFile } from '../../core/src/release-observation.js';

const context:QualityContext={repository:'test/product',repositoryId:12,pullRequestNumber:1,head:'a'.repeat(40),appId:4243096,configVersion:'quality-v1'};
const identities=[{kind:'review-comment' as const,id:50,login:'quality[bot]'},{kind:'review' as const,id:50,login:'quality[bot]'},{kind:'annotation' as const,id:60,login:'quality'}];
const clock=()=>Date.parse('2026-10-28T00:00:00Z');
const source=(id:number,body='The input fails.') : QualitySource=>({sourceCommentId:`review-comment:${id}`,sourceCommit:context.head,
  sourceUrl:`https://github.com/test/product/pull/1#discussion_r${id}`,severity:'P1',bodyMarkdown:body,updatedAt:new Date(clock()).toISOString()});
const translate=(s:any)=>{const {bodyMarkdown,...fields}=s;return {...fields,problemZh:'输入处理失败。',impactZh:'可能中断调用。',suggestionZh:'先验证输入。'};};
function fixture() {
  const requests:string[]=[],writes:any[]=[],saves:QualityCache[]=[],files:any[]=[];
  let comments:any[]=[source(1),source(2),source(3,'这是中文发现，请验证 `src/a.ts`。')].map((s,i)=>({id:i+1,user:{id:50,login:'quality[bot]'},pull_request_url:'https://api.github.com/repos/test/product/pulls/1',
    body:s.bodyMarkdown,original_commit_id:context.head,html_url:s.sourceUrl,updated_at:s.updatedAt}));
  let checks:any[]=[],annotations:any[]=[],calls=0,failRead=false,loseWrite=false,head=context.head;
  const io:QualityIO={async get(path){requests.push(path);if(failRead)throw Error('private raw error');const url=new URL(path,'https://api.github.com');let value:any;
    if(url.pathname.endsWith('/pulls/1'))value={number:1,state:'open',base:{repo:{id:12}},head:{sha:head}};
    else if(url.pathname.endsWith('/comments'))value=comments;
    else if(url.pathname.endsWith('/reviews'))value=[];
    else if(url.pathname.endsWith('/annotations'))value=annotations;
    else if(url.pathname.endsWith('/check-runs'))value={total_count:checks.length,check_runs:checks};else throw Error(path);
    return {value:structuredClone(value),headers:new Headers()};},async writeCheck(body,id){writes.push({body,id});const value={id:id??101,app:{id:context.appId},...body};
      checks=checks.filter(c=>c.id!==value.id).concat(value);if(loseWrite)throw Error('lost');return value;}};
  const store={async save(cache:QualityCache,markdown?:any){saves.push(decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(cache)),12) as QualityCache);if(markdown)files.push(markdown);return {commit:'c'.repeat(40)};}};
  const client={async preflight(){return {status:'READY' as const};},async call(segments:any[]){calls++;return {items:segments.map(translate),model:'fixture',usage:null};}};
  return {io,store,client,requests,writes,saves,files,get calls(){return calls;},get comments(){return comments;},set comments(v){comments=v;},get checks(){return checks;},set checks(v){checks=v;},
    set annotations(v:any[]){annotations=v;},set head(v:string){head=v;},set failRead(v:boolean){failRead=v;},set loseWrite(v:boolean){loseWrite=v;}};
}

it('IC09: two English findings translate once, Chinese makes zero calls; edit only one and rebuild on deletion',async()=>{
  const f=fixture(),budget=()=>({remaining:10,deadline:clock()+1080000});
  let result=await serviceQualityPullRequest(context,identities,null,f.io,f.store,f.client,budget(),clock);
  expect(result).toMatchObject({complete:3,pending:0});expect(f.calls).toBe(1);expect(f.writes).toHaveLength(1);
  const first=structuredClone(f.saves.at(-1)!);
  await serviceQualityPullRequest(context,identities,first,f.io,f.store,f.client,budget(),clock);expect(f.calls).toBe(1);expect(f.writes).toHaveLength(1);
  f.comments[0].body+=' Edited.';await serviceQualityPullRequest(context,identities,f.saves.at(-1)!,f.io,f.store,f.client,budget(),clock);
  expect(f.calls).toBe(2);expect(Object.values(f.saves.at(-1)!.entries).filter(e=>e.attempts.length)).toHaveLength(3);
  f.comments=f.comments.slice(1);result=await serviceQualityPullRequest(context,identities,f.saves.at(-1)!,f.io,f.store,f.client,budget(),clock);
  expect(result.total).toBe(2);expect(f.calls).toBe(2);expect(result.markdown).not.toContain('review-comment:1');
  expect(f.writes.every(w=>w.body.conclusion==='neutral')).toBe(true);
});
it('source failure keeps the previous complete set and never changes a Check',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]);
  const before=structuredClone(cache);f.failRead=true;
  await expect(serviceQualityPullRequest(context,identities,cache,f.io,f.store,f.client,{remaining:10,deadline:clock()+1080000},clock)).rejects.toThrow();
  expect(cache).toEqual(before);expect(f.saves).toHaveLength(0);expect(f.writes).toHaveLength(0);expect(f.calls).toBe(0);
});
it.each(['same-name','wrong-pr','wrong-commit','wrong-url','missing-time'])('rejects untrusted or incomplete native finding: %s',kind=>{
  const f=fixture();if(kind==='same-name')f.comments[0].user.id=51;if(kind==='wrong-pr')f.comments[0].pull_request_url+='0';
  if(kind==='wrong-commit')f.comments[0].original_commit_id='fake';if(kind==='wrong-url')f.comments[0].html_url='https://github.com/foreign/repo/pull/1';
  if(kind==='missing-time')delete f.comments[0].updated_at;
  return expect(serviceQualityPullRequest(context,identities,null,f.io,f.store,f.client,{remaining:10,deadline:clock()+1080000},clock)).rejects.toThrow(/QUALITY_/);
});
it('native annotations bind App/check/PR/head, preserve original severity and never infer fork association',async()=>{
  const f=fixture();f.comments=[];f.checks=[{id:20,app:{id:60,slug:'quality'},head_sha:context.head,pull_requests:[{number:1,base:{repo:{id:12}}}],
    output:{annotations_count:1},html_url:'https://github.com/test/product/runs/20',completed_at:new Date(clock()).toISOString()}];
  f.annotations=[{message:'This fails.',path:'src/a.ts',start_line:1,end_line:2,annotation_level:'failure',raw_details:'EXACT LOG ~~~'}];
  const found=await collectQualitySources(context,identities,f.io);expect(found).toHaveLength(1);expect(found[0]!.sourceCommentId).toMatch(/^annotation:20:0:[a-f0-9]{64}$/);
  expect(found[0]!.severity).toBe('failure');expect(found[0]!.bodyMarkdown).toContain('~~~~text\nEXACT LOG ~~~\n~~~~');
  f.checks[0].pull_requests=[];expect(await collectQualitySources(context,identities,f.io)).toEqual([]);
  f.checks[0].app.id=61;await expect(collectQualitySources(context,identities,f.io)).rejects.toThrow('SOURCE_ID_CHANGED');
});
it('pagination retains complete data, rejects cross-origin links and interrupted later pages',async()=>{
  let calls=0;const io:any={get:async()=>{calls++;return {value:[{id:calls}],headers:new Headers(calls===1?{link:'<https://api.github.com/repos/a/b/comments?per_page=100&page=2>; rel="next"'}:{})};}};
  expect(await qualityPages(io,'/repos/a/b/comments')).toHaveLength(2);
  io.get=async()=>({value:[],headers:new Headers({link:'<https://evil.invalid/repo>; rel="next"'})});await expect(qualityPages(io,'/repos/a/b/comments')).rejects.toThrow('PAGINATION');
  calls=0;io.get=async()=>{if(calls++)throw Error('unread');return {value:[],headers:new Headers({link:'<https://api.github.com/repos/a/b/comments?per_page=100&page=2>; rel="next"'})};};
  await expect(qualityPages(io,'/repos/a/b/comments')).rejects.toThrow('unread');
});
it('same-name third-party Checks are untouched and lost write responses reconcile to one native object',async()=>{
  const f=fixture();f.loseWrite=true;f.checks=[{id:90,app:{id:999},name:'SPLRAD Quality 中文说明',head_sha:context.head,external_id:'other'}];
  await serviceQualityPullRequest(context,identities,null,f.io,f.store,f.client,{remaining:10,deadline:clock()+1080000},clock);
  expect(f.checks).toHaveLength(2);expect(f.writes[0].id).toBeNull();expect(f.saves.at(-1)!.heads[context.head]!.checkId).toBe(101);
  expect(f.requests.some(p=>p.includes('/issues/'))).toBe(false);
});
it('long summaries are complete in the product governance branch and linked by exact saved commit',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1,'中文原文。'.repeat(4500))]);
  await publishQualityCheck(context,cache,f.io,f.store);
  expect(f.files[0].content).toContain('中文原文。'.repeat(4500));expect(f.files[0].path).toBe(`quality/1/${context.head}.md`);
  expect(Buffer.byteLength(f.writes[0].body.output.summary)).toBeLessThan(48*1024);
  expect(f.writes[0].body.output.summary).toContain(`/blob/${'c'.repeat(40)}/quality/1/${context.head}.md`);
});
it('durable attempts bound malformed/unknown calls to three with one/five minute delays and Retry-After',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]);let now=clock(),calls=0;
  const client={...f.client,async call(){calls++;throw Object.assign(Error('RESPONSE_UNKNOWN'),{retryAfterMs:calls===1?120000:0});}};
  const run=()=>translateQualitySources(cache,client,f.store,{remaining:10,deadline:now+1080000},()=>now);
  await run();expect(calls).toBe(1);expect(f.saves[0]!.entries[Object.keys(cache.entries)[0]!]!.attempts[0]!.status).toBe('UNKNOWN');
  now+=60000;await run();expect(calls).toBe(1);now+=60000;await run();expect(calls).toBe(2);
  now+=299999;await run();expect(calls).toBe(2);now++;await run();expect(calls).toBe(3);
  now+=1000000;await run();expect(calls).toBe(3);expect(renderQualitySummary(cache).pending).toBe(1);
  const repaired=await reconcileQualitySources(cache,{...context,configVersion:'quality-v2',observedAt:new Date(now).toISOString()},[source(1)]);
  await translateQualitySources(repaired,f.client,f.store,{remaining:10,deadline:now+1080000},()=>now);expect(renderQualitySummary(repaired).complete).toBe(1);
});
it('WAIT_AUTH makes no model call; quota recovery resumes unchanged source',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]);
  await translateQualitySources(cache,{...f.client,preflight:async()=>({status:'WAIT_AUTH'})},f.store,{remaining:10,deadline:clock()+1080000},clock);
  expect(f.calls).toBe(0);expect(Object.values(cache.entries)[0]!.attempts).toEqual([]);
  await translateQualitySources(cache,f.client,f.store,{remaining:10,deadline:clock()+1080000},()=>clock()+61000);expect(f.calls).toBe(1);
});
it('deadline and shared ten-batch allowance stop new claims and retain every unprocessed source',async()=>{
  const sources=Array.from({length:12},(_,i)=>source(i+1,'x'.repeat(6000))),f=fixture();
  const cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},sources),budget={remaining:1,deadline:clock()+1080000};
  await translateQualitySources(cache,f.client,f.store,budget,clock);expect(f.calls).toBe(1);expect(renderQualitySummary(cache).pending).toBeGreaterThan(0);
  await translateQualitySources(cache,f.client,f.store,{remaining:10,deadline:clock()},clock);expect(f.calls).toBe(1);
  expect(cache.heads[context.head]!.sources).toHaveLength(12);
});
it('an intent persistence failure prevents the model call',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]);
  await expect(translateQualitySources(cache,f.client,{save:async()=>{throw Error('write failed');}},{remaining:10,deadline:clock()+1080000},clock)).rejects.toThrow();expect(f.calls).toBe(0);
});
it('claims at most ten findings per PR per wake and resumes the remaining findings from the durable cursor',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},Array.from({length:12},(_,i)=>source(i+1)));
  await translateQualitySources(cache,f.client,f.store,{remaining:10,deadline:clock()+1080000},clock);
  expect(renderQualitySummary(cache)).toMatchObject({total:12,complete:10,pending:2});expect(f.calls).toBe(1);
  await translateQualitySources(cache,f.client,f.store,{remaining:10,deadline:clock()+1080000},clock);
  expect(renderQualitySummary(cache).complete).toBe(12);expect(f.calls).toBe(2);
});
it('workflow uses one Environment, reviewed SHA, scheduled observer and credential-free install',async()=>{
  const workflow=YAML.parse(await readFile('.github/workflows/quality-language-summary.yml','utf8'));
  expect(workflow.on.schedule[0].cron).toBe('8-58/10 * * * *');expect(workflow.concurrency).toEqual({group:'steward-quality-language','cancel-in-progress':false});
  const job=workflow.jobs['quality-summary'];expect(job['timeout-minutes']).toBe(20);expect(job.environment.name).toBe('steward-release-notes');
  expect(job.steps[0].with.ref).toBe('${{ github.workflow_sha }}');expect(job.steps[2].env).toBeUndefined();
  expect(job.steps[3].env.STEWARD_COPILOT_TOKEN).toBe('${{ github.token }}');
});
it('wake sorts by durable observation, shares the ten batch limit, and emits no repository identifiers',async()=>{
  const {qualityWake}=await import(pathToFileURL(resolve('scripts/quality-language-summary.mjs')).href);
  const serviced:any[]=[];const result=await qualityWake({discover:async()=>[{id:1,full_name:'private/secret'},{id:2,full_name:'private/another'}],
    inventory:async(r:any)=>[{pr:1,observedAt:r.id===1?'2026-10-01T00:00:00Z':null}],service:async(item:any,budget:any)=>{serviced.push(item.repository.id);budget.remaining--;return {complete:1,pending:0};}},clock);
  expect(serviced).toEqual([2,1]);expect(result).toEqual({repositories:2,pullRequests:2,complete:2,pending:0,failed:0,batches:2});
  expect(JSON.stringify(result)).not.toContain('private');
});
it('native wire permits only own neutral Check output, uses no third-party mutation and validates governance integrity',async()=>{
  const {qualityNativeIO,assertQualityProtection}=await import(pathToFileURL(resolve('scripts/quality-language-summary.mjs')).href);
  const calls:any[]=[],transport=async(url:any,init:any)=>{calls.push({url:String(url),method:init.method,body:init.body});return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
  const io=qualityNativeIO('test/product','fixture-token',transport);
  const body={name:'SPLRAD Quality 中文说明',head_sha:context.head,external_id:'splrad-quality:12:1:'+context.head,status:'completed',conclusion:'neutral',output:{title:'SPLRAD Quality 中文说明',summary:'中文说明'}};
  await io.writeCheck(body,null);await io.writeCheck(body,42);
  expect(calls.map(c=>[c.method,c.url])).toEqual([['POST','https://api.github.com/repos/test/product/check-runs'],['PATCH','https://api.github.com/repos/test/product/check-runs/42']]);
  expect(JSON.parse(calls[1].body)).not.toHaveProperty('head_sha');
  await expect(io.writeCheck({...body,conclusion:'success'},42)).rejects.toThrow('CHECK_WRITE');
  await expect(io.writeCheck({...body,output:{...body.output,annotations:[]}},42)).rejects.toThrow('CHECK_OUTPUT');
  await expect(io.get('/repos/foreign/product/pulls/1')).rejects.toThrow('READ_PATH');
  await io.get('/repos/test/product');
  expect(calls.at(-1).url).toBe('https://api.github.com/repos/test/product');
  await expect(io.get('/repos/test/product-other')).rejects.toThrow('READ_PATH');
  const rules=[{type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}];
  let integrityBypass:any[]=[];
  const protection={get:async(path:string)=>({headers:new Headers(),value:path.includes('/rules/branches/')?rules:
    {id:path.endsWith('/1')?1:2,target:'branch',enforcement:'active',bypass_actors:path.endsWith('/1')?[4243096,900].map(actor_id=>({actor_id,actor_type:'Integration',bypass_mode:'always'})):integrityBypass,
      rules:path.endsWith('/1')?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}]}})};
  await assertQualityProtection(protection,'test/product',900);integrityBypass=[{actor_id:4243096}];
  await expect(assertQualityProtection(protection,'test/product',900)).rejects.toThrow('INTEGRITY');
});

it.each(['WAIT_AUTH','WAIT_QUOTA'])('restores persisted input after repeated explicit %s refusals without exhausting generation attempts',async(reason)=>{
  const f=fixture();let cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]),now=clock(),calls=0;
  const client={...f.client,async call(){calls++;throw Object.assign(Error(reason),{retryAfterMs:120000});}};
  const run=async(c:any=client)=>{
    await translateQualitySources(cache,c,f.store,{remaining:10,deadline:now+1080000},()=>now);
    cache=decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(f.saves.at(-1)!)),12) as QualityCache;
  };
  for(let i=0;i<4;i++) {await run();expect(calls).toBe(i+1);await run();expect(calls).toBe(i+1);now+=600000;}
  await run(f.client);expect(renderQualitySummary(cache).complete).toBe(1);expect(f.calls).toBe(1);
  expect(Object.values(cache.entries)[0]!.attempts.map(a=>a.status)).toEqual([reason,'COMPLETE']);
  const refused=new Set(f.saves.flatMap(s=>Object.values(s.entries).flatMap(e=>e.attempts.filter(a=>a.status===reason).map(a=>a.startedAt))));
  expect(refused.size).toBe(4);expect(f.saves.every(s=>Object.values(s.entries).every(e=>e.attempts.length<=2))).toBe(true);
  await run(f.client);expect(f.calls).toBe(1);
});
it('observes the current bounded unknown-response policy after durable serialization',async()=>{
  const f=fixture();let cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]),now=clock(),calls=0;
  const client={...f.client,async call(){calls++;throw Error('RESPONSE_UNKNOWN');}};
  for(let i=0;i<4;i++) {
    await translateQualitySources(cache,client,f.store,{remaining:10,deadline:now+1080000},()=>now);
    cache=decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(f.saves.at(-1)!)),12) as QualityCache;
    now+=600000;
  }
  expect(calls).toBe(3);expect(renderQualitySummary(cache).pending).toBe(1);
});

it('retains the three-generation bound after refusal history and rejects a fourth unknown attempt',async()=>{
  const f=fixture();let cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]),now=clock(),calls=0;
  let reason='WAIT_QUOTA';const client={...f.client,async call(){calls++;throw Error(reason);}};
  for(let i=0;i<7;i++) {
    if(i===2)reason='RESPONSE_UNKNOWN';
    await translateQualitySources(cache,client,f.store,{remaining:10,deadline:now+1080000},()=>now);
    cache=decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(f.saves.at(-1)!)),12) as QualityCache;
    now+=600000;
  }
  expect(calls).toBe(5);expect(Object.values(cache.entries)[0]!.attempts).toHaveLength(4);
  const entry=Object.values(cache.entries)[0]!;entry.attempts.push({...entry.attempts.at(-1)!,status:'UNKNOWN'});
  expect(()=>decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(cache)),12)).toThrow('CACHE_SCHEMA');
});

it('rejects null attempt records with the closed cache error',async()=>{
  const cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]);
  (Object.values(cache.entries)[0]!.attempts as unknown[]).push(null);
  expect(()=>decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(cache)),12)).toThrow('CACHE_SCHEMA');
});

it('never removes refusal history before its durable save succeeds',async()=>{
  const f=fixture(),cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]);let saves=0;
  const entry=Object.values(cache.entries)[0]!;entry.attempts.push({startedAt:new Date(clock()-60000).toISOString(),status:'WAIT_AUTH',model:null,usage:null});
  const store={save:async(c:QualityCache)=>{if(++saves===2)throw Error('durable save failed');return f.store.save(c);}};
  const client={...f.client,call:async()=>{throw Error('WAIT_QUOTA');}};
  await expect(translateQualitySources(cache,client,store,{remaining:1,deadline:clock()+1080000},clock)).rejects.toThrow('durable save failed');
  expect(entry.attempts.map(a=>a.status)).toEqual(['WAIT_AUTH','WAIT_QUOTA']);
  expect(f.saves[0]!.entries[entry.key]!.attempts.map(a=>a.status)).toEqual(['WAIT_AUTH','UNKNOWN']);
});

it('migrates three durable legacy refusals before consuming all three possible-generation attempts',async()=>{
  const f=fixture();let cache=await reconcileQualitySources(null,{...context,observedAt:new Date(clock()).toISOString()},[source(1)]),now=clock(),calls=0;
  Object.values(cache.entries)[0]!.attempts=[0,1,2].map(i=>({startedAt:new Date(now-i*60000).toISOString(),status:'WAIT_AUTH' as const,model:null,usage:null}));
  const client={...f.client,call:async()=>{calls++;throw Error('RESPONSE_UNKNOWN');}};
  for(let i=0;i<4;i++){
    await translateQualitySources(cache,client,f.store,{remaining:1,deadline:now+1080000},()=>now);
    cache=decodeStateFile('steward/governance-state','quality/1.json',Buffer.from(JSON.stringify(f.saves.at(-1)!)),12) as QualityCache;now+=600000;
  }
  expect(calls).toBe(3);expect(Object.values(f.saves[0]!.entries)[0]!.attempts).toHaveLength(3);
  expect(Object.values(cache.entries)[0]!.attempts.map(a=>a.status)).toEqual(['WAIT_AUTH','FAILED','FAILED','FAILED']);
});
