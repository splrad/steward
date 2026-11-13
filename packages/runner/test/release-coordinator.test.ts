import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {coordinateReleaseWake,serviceReleaseWake,fetchState}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
it('reads Pages state only after validating both governance writers and an unbypassable integrity rule',async()=>{
  const repository={id:12,full_name:'test/product',default_branch:'main'},reads:string[]=[];
  let actors=[4243096,900],integrity:any[]=[],omitBypass=false;
  const fetcher=async(input:any,init:any)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname);reads.push(path);expect(init.method).toBe('GET');
    if(path.includes('/git/ref/'))return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
    const data=path.includes('/rules/branches/')?[
      {type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}
    ]:{id:path.endsWith('/1')?1:2,target:'branch',enforcement:'active',
      ...(omitBypass?{}:{bypass_actors:path.endsWith('/1')?actors.map(actor_id=>({actor_id,actor_type:'Integration',bypass_mode:'always'})):integrity}),
      rules:path.endsWith('/1')?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}]};
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  const read=(governanceAppId:any=900)=>fetchState('',repository,'fixture-token','steward/governance-state',{governanceAppId,fetcher});
  await expect(read()).rejects.toThrow('RELEASE_BOOTSTRAP_REQUIRED');
  expect(reads.at(-1)).toBe('/repos/test/product/git/ref/heads/steward/governance-state');
  reads.length=0;actors=[4243096];await expect(read()).rejects.toThrow('QUALITY_PROTECTION');
  actors=[4243096,900];integrity=[{actor_id:4243096}];await expect(read()).rejects.toThrow('QUALITY_INTEGRITY');
  integrity=[];omitBypass=true;await expect(read()).rejects.toThrow('QUALITY_PROTECTION');
  await expect(read(null)).rejects.toThrow('QUALITY_GOVERNANCE_ID_PENDING');
  expect(reads.some(path=>path.includes('/git/ref/'))).toBe(false);
});
const START=Date.parse('2026-10-27T00:00:00Z');
async function observeCandidate(candidate:any,maintenanceErrors:string[]=[],cycleUnknown=false) {
  const calls:string[]=[],snapshot={repository:{activeCycleId:null,candidate:{prNumber:9}},
    cycles:cycleUnknown?[{value:{id:'old',completedEvidencePath:'old.json',dispatches:[]}}]:[]};
  const original=structuredClone(candidate);
  const summary=await coordinateReleaseWake({discover:async()=>[{id:1},{id:2}],observe:async()=>({}),
    maintenance:async()=>({errorCodes:maintenanceErrors}),health:async()=>{},
    service:async(repo:any)=>{
      calls.push(`repository:${repo.id}`);
      if(repo.id===2)return {status:'WAIT',reason:'EDITING'};
      return serviceReleaseWake({},async()=>snapshot,async(command:string)=>{
        calls.push(command);return command==='candidate'?candidate:{status:'UNKNOWN',reason:'NATIVE_EVIDENCE_REQUIRED'};
      });
    }},()=>START);
  expect(candidate).toEqual(original);
  expect(calls.at(-1)).toBe('repository:2');
  if(!cycleUnknown)expect(calls).toEqual(['repository:1','candidate','repository:2']);
  return summary;
}
it.each([{status:'READY',prNumber:9},
  {status:'CONFLICT',reason:'HUMAN_EDIT_CONFLICT',conflict:{head:'human',generated:'bot',paths:['.release-notes/app.md']}}])(
  'counts a protected candidate as waiting without losing its result or blocking another repository: %j',async candidate=>{
    const summary=await observeCandidate(candidate);
    expect(summary.counts).toEqual({scanned:2,completed:0,waiting:2,failed:0,unknown:0});
    expect(summary.errorCodes).toEqual([]);expect(summary.scanCompletedAt).toBe(new Date(START).toISOString());
  });
it.each([{status:'CONFLICT',reason:'SOURCE_CHANGED'},{status:'CONFLICT'},
  {status:'UNKNOWN',reason:'HUMAN_EDIT_CONFLICT'},{status:'BLOCKED'}])(
  'keeps unresolved candidate evidence unknown while serving another repository: %j',async candidate=>{
    const summary=await observeCandidate(candidate);
    expect(summary.counts).toEqual({scanned:2,completed:0,waiting:1,failed:0,unknown:1});
    expect(summary.errorCodes).toEqual(['NATIVE_EVIDENCE_REQUIRED']);expect(summary.scanCompletedAt).toBeNull();
  });
it('does not let a ready candidate clear independent maintenance or cycle evidence failures',async()=>{
  const maintenance=await observeCandidate({status:'READY'},['MAINTENANCE_EVIDENCE_REQUIRED']);
  expect(maintenance.counts.waiting).toBe(2);expect(maintenance.counts.unknown).toBe(0);
  expect(maintenance.errorCodes).toEqual(['MAINTENANCE_EVIDENCE_REQUIRED']);expect(maintenance.scanCompletedAt).toBeNull();
  const cycle=await observeCandidate({status:'READY'},[],true);
  expect(cycle.counts.unknown).toBe(1);expect(cycle.errorCodes).toEqual(['NATIVE_EVIDENCE_REQUIRED']);
  expect(cycle.scanCompletedAt).toBeNull();
});
it('services the least recently served repositories first, isolates failures and emits only aggregate health',async()=>{
  const calls:number[]=[],health:any[]=[];
  const summary=await coordinateReleaseWake({discover:async()=>[{id:1,full_name:'private/secret'},{id:2},{id:3}],
    observe:async(repo:any)=>({lastServedAt:new Date(START+repo.id*60_000).toISOString(),nextCheckAt:null}),
    service:async(repo:any)=>{calls.push(repo.id);if(repo.id===2)throw new Error('private/secret credential-shaped failure');return {status:'WAIT'};},health:async(value:any)=>health.push(value)},()=>START+10*60_000);
  expect(calls).toEqual([1,2,3]);expect(summary.counts).toEqual({scanned:3,completed:0,waiting:2,failed:1,unknown:0});
  expect(summary.scanCompletedAt).toBeNull();expect(JSON.stringify(health)).not.toMatch(/private|secret|credential/);expect(summary.errorCodes).toEqual(['RELEASE_NATIVE_UNAVAILABLE']);
});
it('stops claiming repositories at forty minutes and does not refresh scanCompletedAt',async()=>{
  let now=START;const claims:number[]=[];
  const result=await coordinateReleaseWake({discover:async()=>[{id:1},{id:2},{id:3}],observe:async(repo:any)=>{claims.push(repo.id);now+=20*60_000;return {lastServedAt:null,nextCheckAt:null};},service:async()=>{throw new Error('must not claim');},health:async()=>{}},()=>now);
  expect(claims).toEqual([1,2]);expect(result.scanCompletedAt).toBeNull();expect(result.errorCodes).toContain('CLAIM_WINDOW_CLOSED');
});
it('honors nextCheckAt without polling or invoking a business entry',async()=>{
  let calls=0;const result=await coordinateReleaseWake({discover:async()=>[{id:1}],observe:async()=>({nextCheckAt:new Date(START+60_000).toISOString()}),service:async()=>{calls++;},health:async()=>{}},()=>START);
  expect(calls).toBe(0);expect(result.counts.waiting).toBe(1);expect(result.scanCompletedAt).toBe(new Date(START).toISOString());
});
it('services Pages independently of absent release state or a future channel wait, isolating private errors',async()=>{
  const calls:number[]=[];
  const result=await coordinateReleaseWake({discover:async()=>[{id:1},{id:2},{id:3}],pages:async(r:any)=>{calls.push(r.id);if(r.id===2)throw Error('private/name');return {status:'WAIT'};},
    observe:async(r:any)=>{if(r.id===1)throw Error('RELEASE_BOOTSTRAP_REQUIRED');return {nextCheckAt:new Date(START+60000).toISOString()};},
    service:async()=>{throw Error('must wait');},health:async()=>{}},()=>START);
  expect(calls).toEqual([1,2,3]);expect(result.errorCodes).toContain('PAGES_UNAVAILABLE');expect(JSON.stringify(result)).not.toContain('private/name');expect(result.counts.waiting).toBe(2);
});
it('invokes the fixed entry sequence and recovers only native canonical Run IDs',async()=>{
  const calls:string[]=[],snapshot={repository:{activeCycleId:'cycle'},cycles:[{value:{id:'cycle',dispatches:[{canonicalRunId:100},{canonicalRunId:null}]}}]};
  const result=await serviceReleaseWake({},async()=>snapshot,async(command:string,input:any)=>{calls.push(command+(command==='rerun'?':'+input.runId:''));return {status:'WAIT',reason:'PREREQUISITE_REQUIRED',publishInvoked:false};});
  expect(calls).toEqual(['candidate','dispatch-build','publish','dispatch-channel','observe-channel','rerun:100']);expect(result.status).toBe('WAIT');
});
it('ends a repository wake after the single publish invocation',async()=>{
  const calls:string[]=[],snapshot={repository:{activeCycleId:'cycle'},cycles:[{value:{id:'cycle',dispatches:[]}}]};
  const result=await serviceReleaseWake({},async()=>snapshot,async(command:string)=>{calls.push(command);return {status:'WAIT',publishInvoked:command==='publish'};});
  expect(calls).toEqual(['candidate','dispatch-build','publish']);expect(result.publishInvoked).toBe(true);
});
it('retains private recovery age scheduling from the canonical rerun entry',async()=>{
  const snapshot={repository:{activeCycleId:'cycle'},cycles:[{value:{id:'cycle',dispatches:[{canonicalRunId:100}]}}]},nextCheckAt='2026-11-26T00:00:00.001Z';
  const result=await serviceReleaseWake({},async()=>snapshot,async(command:string)=>command==='rerun'
    ?{status:'UNKNOWN',reason:'PRIVATE_RETRY_LIMIT_UNPROVEN',nextCheckAt}:{status:'WAIT',publishInvoked:false});
  expect(result).toMatchObject({status:'UNKNOWN',nextCheckAt});
});
it('keeps health failure separate from successful business service and never repeats that service',async()=>{
  let calls=0;await expect(coordinateReleaseWake({discover:async()=>[{id:1}],observe:async()=>({nextCheckAt:null}),service:async()=>{calls++;return {status:'COMPLETE'};},health:async()=>{throw new Error('health unavailable');}},()=>START)).rejects.toThrow('health unavailable');expect(calls).toBe(1);
});
it('continues a new wake with previously unserved repositories after the forty-minute cutoff',async()=>{
  let now=START;const calls:number[]=[],served=new Map<number,string>();
  const ports={discover:async()=>[{id:1},{id:2},{id:3}],observe:async(repo:any)=>({lastServedAt:served.get(repo.id)??null,nextCheckAt:null}),
    service:async(repo:any)=>{calls.push(repo.id);served.set(repo.id,new Date(now).toISOString());now+=20*60_000;return {status:'WAIT'};},health:async()=>{}};
  const first=await coordinateReleaseWake(ports,()=>now);expect(calls).toEqual([1,2]);expect(first.scanCompletedAt).toBeNull();
  now+=60_000;await coordinateReleaseWake(ports,()=>now);expect(calls.slice(2)).toEqual([3,1]);
});
it('isolates inaccessible, archived and disabled repositories without changing their state or exposing their names',async()=>{
  const observed:number[]=[],serviced:number[]=[];
  const result=await coordinateReleaseWake({discover:async()=>[{id:1,full_name:'private/denied'},{id:2,archived:true},{id:3,disabled:true},{id:4}],
    observe:async(repo:any)=>{observed.push(repo.id);if(repo.id===1)throw new Error('403 private/denied');return {};},
    service:async(repo:any)=>{serviced.push(repo.id);return {status:'WAIT'};},health:async()=>{}},()=>START);
  expect(observed).toEqual([1,4]);expect(serviced).toEqual([4]);expect(result.counts.unknown).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/private|denied|403/);expect(result.scanCompletedAt).toBeNull();
});

it('prepares the next candidate and services both a new release and an old pending distribution',async()=>{
  const calls:string[]=[],snapshot={repository:{activeCycleId:'new'},cycles:[
    {value:{id:'old',completedEvidencePath:'evidence/completion/old.json',dispatches:[{canonicalRunId:100}]}},
    {value:{id:'new',completedEvidencePath:null,dispatches:[]}}],domainRecords:[]};
  await serviceReleaseWake({},async()=>snapshot,async(command:string,input:any)=>{
    calls.push(`${command}:${input.cycleId}`);return {status:'WAIT',publishInvoked:false};
  });
  expect(calls).toEqual(['candidate:new','dispatch-channel:old','observe-channel:old','rerun:old','dispatch-build:new','publish:new','dispatch-channel:new','observe-channel:new']);
});

it('refreshes archived rerun state before another rerun or the next cycle dispatch',async()=>{
  let remoteHead=0,localHead=-1,refreshes=0;
  const calls:string[]=[],snapshot={repository:{activeCycleId:'new'},cycles:[
    {value:{id:'old',completedEvidencePath:'old-completion',dispatches:[{canonicalRunId:100},{canonicalRunId:101}]}},
    {value:{id:'new',completedEvidencePath:null,dispatches:[]}}],domainRecords:[]};
  await serviceReleaseWake({},async()=>{refreshes++;localHead=remoteHead;return structuredClone(snapshot);},async(command:string,input:any)=>{
    calls.push(`${command}:${input.cycleId}`);
    if(command==='rerun'||command==='dispatch-build')expect(localHead).toBe(remoteHead);
    if(command==='rerun')remoteHead++;
    return {status:'WAIT',publishInvoked:false};
  });
  expect(calls).toEqual(['candidate:new','dispatch-channel:old','observe-channel:old','rerun:old','rerun:old',
    'dispatch-build:new','publish:new','dispatch-channel:new','observe-channel:new']);
  expect(localHead).toBe(2);expect(refreshes).toBe(11);
});

it('honors an old cycle read backoff while preparing and building the next registered candidate',async()=>{
  const calls:string[]=[],snapshot={repository:{activeCycleId:'new'},cycles:[{value:{id:'old'}},{value:{id:'new',dispatches:[]}}],
    domainRecords:[{path:'evidence/reads/old.json',value:{cycleId:'old',observedAt:new Date(START).toISOString(),nextCheckAt:new Date(START+60_000).toISOString()}}]};
  await serviceReleaseWake({},async()=>snapshot,async(command:string,input:any)=>{calls.push(`${command}:${input.cycleId}`);return {status:'WAIT',publishInvoked:false};},()=>START);
  expect(calls).toContain('candidate:new');expect(calls).toContain('dispatch-build:new');expect(calls.some(value=>value.endsWith(':old'))).toBe(false);
});


it.each([{status:'WAIT',reason:'EDITING'}, {status:'WAIT',reason:'CONTENT_WAIT_AUTH'},
  {status:'CONFLICT',reason:'HUMAN_EDIT_CONFLICT'}, {status:'READY',prNumber:9},
  {status:'WAIT',reason:'UNCHANGED'}])('retains candidate result with already completed cycles: %j', async candidate => {
  const source={repositoryId:1,cycleId:'pr-9-'+'b'.repeat(40),sourceSha:'b'.repeat(40),deliveryConfigSha:'c'.repeat(40),
    units:[{id:'app',version:'1.0.0',tag:'v1.0.0',releaseId:7,authorId:42,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{path:'app.zip',size:12,sha256:'d'.repeat(64)}]}],requiredChannels:[]};
  const {id,...unit}=source.units[0]!;
  const observation={source:structuredClone(source),sourceComplete:true,observedAt:new Date(START).toISOString(),releasesComplete:true,channelsComplete:true,
    releases:[{...unit,unitId:id,sourceSha:source.sourceSha,draft:false,immutable:true,evidenceDigest:'e'.repeat(64)}],
    channels:[],consumptions:[],inFlightWaveKeys:[],unknownWriteKeys:[]};
  const snapshot={repository:{activeCycleId:null,candidate:candidate.reason==='UNCHANGED'?null:{prNumber:9}},
    cycles:[{value:{id:source.cycleId,completedEvidencePath:'evidence/completion/old.json',dispatches:[]}}],
    domainRecords:[{path:'evidence/completion/old.json',value:{source,observation}}]};
  const calls:string[]=[];
  const result=await serviceReleaseWake({},async()=>snapshot,async(command:string)=>{calls.push(command);return candidate;});
  expect(calls).toEqual(['candidate']);
  expect(result).toEqual(candidate.reason==='UNCHANGED'?{status:'COMPLETE',reason:'REGISTERED_RELEASES_VERIFIED'}:candidate);
});
