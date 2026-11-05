import { expect, it } from 'vitest';
import { dispatchNativeRun, prepareBuildDispatch, verifyExecutionSource, type DispatchStore } from '../src/release-run.js';
import { nativeEvidenceTransport, nativeRunFact, type EvidenceTransport } from '../src/native-release-evidence.js';
import { decodeNativeDispatchObservation, type NativeDispatchObservation } from '../../core/src/native-evidence.js';
import { parseNativeInvocation, nativeCommands } from '../src/native-release-cli.js';
import { evidenceFixture, START, S } from './native-evidence-fixture.js';
const time=(minutes:number)=>new Date(Date.parse(START)+minutes*60_000).toISOString();
function fixture() {
  const f=evidenceFixture(),context=structuredClone(f.context);context.cycle.dispatches=[];
  context.cycle.dispatches.push(prepareBuildDispatch(context,10,START));
  let cycle=structuredClone(context.cycle),observations:NativeDispatchObservation[]=[],lose=false,storeStatus='APPLIED',runs:any[]=[],postStatus=200;
  const calls:{method:string;path:string;body:object|undefined}[]=[];
  const run=(id=100)=>({...f.runs.get(1),id,display_title:`Build ${cycle.dispatches[0]!.operationKey}`});
  const io:EvidenceTransport={async request(method,path,_limit,body){
    calls.push({method,path,body});
    if(method==='POST'){if(lose)throw new Error('lost');return f.response({workflow_run_id:100,run_url:'https://api.github.com/repos/example/product/actions/runs/100',html_url:'https://github.com/example/product/actions/runs/100'},postStatus);}
    if(path.endsWith('/actions/workflows/10'))return f.response({id:10,path:'.github/workflows/steward-release-publish.yml',state:'active'});
    if(path.includes('/git/ref/heads/'))return f.response({ref:`refs/heads/${cycle.dispatches[0]!.ref}`,object:{type:'commit',sha:S}});
    if(path.includes('/actions/workflows/10/runs?'))return f.response({total_count:runs.length,workflow_runs:runs});
    const id=/\/actions\/runs\/(\d+)$/.exec(path);if(id)return f.response(runs.find(run=>run.id===Number(id[1]))??run(Number(id[1])));
    return f.io.request(method,path);
  }};
  const store:DispatchStore={async save(next,files){if(storeStatus==='APPLIED'){cycle=structuredClone(next);for(const file of files)observations.push(decodeNativeDispatchObservation(Buffer.from(file.content)));}return {status:storeStatus,head:storeStatus==='APPLIED'?'d'.repeat(40):null};}};
  const execute=(minutes=0,transport=io)=>dispatchNativeRun({...context,cycle},cycle.dispatches[0]!.requestKey,store,{complete:true,observations},transport,time(minutes));
  return {f,context,io,store,calls,run,execute,get cycle(){return cycle;},get observations(){return observations;},setRuns:(value:any[])=>runs=value,setLost:(value=true)=>lose=value,setStore:(value:string)=>storeStatus=value,setStatus:(value:number)=>postStatus=value};
}
it('binds the actual 200 response only after durable intent, response archive and native source verification',async()=>{
  const f=fixture(),order:string[]=[],save=f.store.save;
  f.store.save=async(cycle,files)=>{order.push(JSON.parse(files[0]!.content).kind+(cycle.dispatches[0]!.canonicalRunId?':bound':''));return save(cycle,files);};
  expect(await f.execute()).toMatchObject({status:'BOUND',canonicalRunId:100});
  expect(order).toEqual(['PREPARED','RESPONSE','RESPONSE:bound']);
  expect(f.calls.filter(call=>call.method==='POST')).toEqual([{method:'POST',path:'/repos/example/product/actions/workflows/10/dispatches',body:{ref:f.cycle.dispatches[0]!.ref,inputs:f.cycle.dispatches[0]!.inputs}}]);
  const before=f.calls.length;expect(await f.execute(1)).toMatchObject({status:'BOUND'});expect(f.calls).toHaveLength(before);
});
it.each(['UNKNOWN','CONFLICT','UNCHANGED'])('does not send when PREPARED is not newly adopted: %s',async status=>{
  const f=fixture();f.setStore(status);expect((await f.execute()).status).toBe('UNKNOWN');expect(f.calls.some(call=>call.method==='POST')).toBe(false);
});
it('recovers a lost response to the earliest matching Run, leaving duplicates noncanonical',async()=>{
  const f=fixture();f.setLost();expect((await f.execute()).status).toBe('UNKNOWN');
  f.setRuns([f.run(200),{...f.run(50),actor:{id:4243096}},f.run(70)]);
  expect(await f.execute(2)).toMatchObject({status:'BOUND',canonicalRunId:70});
  expect(f.observations.at(-1)!.matches.map(run=>run.id)).toEqual([70,200]);
  expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(1);
});
it('requires two fully empty searches five minutes apart and uses 5/15/60 minute resend spacing',async()=>{
  const f=fixture();f.setLost();await f.execute();
  expect(await f.execute(1)).toMatchObject({status:'WAIT',nextCheckAt:time(6)});
  await f.execute(5);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(1);
  await f.execute(6);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(2);
  await f.execute(7);await f.execute(12);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(2);
  await f.execute(21);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(3);
  await f.execute(22);await f.execute(27);await f.execute(80);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(3);
  await f.execute(81);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(4);
  expect(new Set(f.observations.map(value=>value.requestKey)).size).toBe(1);
});
it('archives a native 200 before a failed Run read, then binds that returned ID instead of a search duplicate',async()=>{
  const f=fixture(),request=f.io.request;let unavailable=true;
  f.io.request=async(method,path,limit,body)=>path.endsWith('/actions/runs/100')&&unavailable?f.f.response({},503):request(method,path,limit,body);
  expect((await f.execute()).status).toBe('UNKNOWN');expect(f.observations.some(value=>value.response?.workflow_run_id===100)).toBe(true);
  unavailable=false;f.setRuns([f.run(70),f.run(100)]);expect(await f.execute(6)).toMatchObject({status:'BOUND',canonicalRunId:100});
  expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(1);
});
it.each(['repository','workflow','sha','ref','actor','event','path','frozen'])('rejects native source mismatch: %s',kind=>{
  const f=fixture(),actual=nativeRunFact(f.run());
  if(kind==='repository')actual.headRepositoryId=2;if(kind==='workflow')actual.workflowId=11;if(kind==='sha')actual.headSha='c'.repeat(40);
  if(kind==='ref')actual.headBranch='main';if(kind==='actor')actual.actorId=4243096;if(kind==='event')actual.event='push';if(kind==='path')actual.path='foreign.yml';
  expect(()=>verifyExecutionSource(actual,{...f.context,request:f.cycle.dispatches[0]!},kind==='frozen'?{canonicalRunId:99}:undefined)).toThrow('execution source');
});
it.each([403,429,500])('failed native reads do not count as successful empty windows: %s',async status=>{
  const f=fixture();f.setLost();await f.execute();const request=f.io.request;
  f.io.request=async(method,path,limit,body)=>path.includes('/runs?')?f.f.response({},status,{'retry-after':'1800'}):request(method,path,limit,body);
  expect(await f.execute(1)).toMatchObject({status:'UNKNOWN',nextCheckAt:time(31)});
  expect(f.observations.some(value=>value.kind==='SEARCH')).toBe(false);expect(f.calls.filter(call=>call.method==='POST')).toHaveLength(1);
});
it('splits the 1000-result search window and binds the earliest Run from complete subwindows',async()=>{
  const f=fixture();f.setLost();await f.execute();const request=f.io.request;let searches=0;
  f.io.request=async(method,path,limit,body)=>{
    if(path.includes('/runs?')) {searches++;return f.f.response(searches===1?{total_count:1000,workflow_runs:[]}:{total_count:searches===2?1:0,workflow_runs:searches===2?[f.run(70)]:[]});}
    return request(method,path,limit,body);
  };
  expect(await f.execute(2)).toMatchObject({status:'BOUND',canonicalRunId:70});expect(searches).toBe(3);expect(f.observations.at(-1)!.pages).toHaveLength(3);
});
it('refuses an incomplete page even when it contains a matching Run',async()=>{
  const f=fixture();f.setLost();await f.execute();const request=f.io.request;
  f.io.request=async(method,path,limit,body)=>path.includes('/runs?')?f.f.response({total_count:101,workflow_runs:[f.run()]}):request(method,path,limit,body);
  expect((await f.execute(1)).status).toBe('UNKNOWN');expect(f.cycle.dispatches[0]!.canonicalRunId).toBeNull();expect(f.observations.some(value=>value.kind==='SEARCH')).toBe(false);
});
it('pins API version and sends only ref and inputs in the dispatch body',async()=>{
  let captured:RequestInit|undefined;const transport=(async(_url,options)=>{captured=options;return new Response('{}',{status:200});}) as typeof fetch;
  await nativeEvidenceTransport('fixture-token',transport).request('POST','/repos/example/product/actions/workflows/10/dispatches',1024,{ref:'branch',inputs:{cycle_id:'cycle'}});
  expect(new Headers(captured!.headers).get('x-github-api-version')).toBe('2026-03-10');expect(JSON.parse(String(captured!.body))).toEqual({ref:'branch',inputs:{cycle_id:'cycle'}});
});
it('accepts only the fixed new release commands and removes the legacy write namespace',()=>{
  for(const entry of ['candidate','dispatch-build','publish','dispatch-channel','observe-channel','rerun']) {
    expect(parseNativeInvocation(['release',entry,'--context','local.json','--output','out.json']).command).toBe(`release ${entry}`);
    expect(()=>parseNativeInvocation(['release',entry,'--context','local.json','--output','out.json','--phase','execute'])).toThrow('unknown');
  }
  expect(nativeCommands.has('release-plan')).toBe(false);expect(()=>parseNativeInvocation(['release-plan','dispatch'])).toThrow('unknown');
});
