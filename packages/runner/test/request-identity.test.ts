import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {nativeRequestIdentity,sameChannelOperation,validateEvidenceContext,type EvidenceTransport} from '../src/native-release-evidence.js';
import {prepareChannelDispatch,prepareBuildDispatch,dispatchNativeRun,selectChannelDispatch,type DispatchStore} from '../src/release-run.js';
import {decodeNativeDispatchObservation,type NativeDispatchObservation} from '../../core/src/native-evidence.js';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/dispatch-format3.json',import.meta.url),'utf8'));
const now='2026-11-03T00:02:00.000Z';
function prepared() {
  const f=fixture(),targets=JSON.parse(f.channel.inputs.targets_json);
  const make=(value=targets)=>prepareChannelDispatch(f.context,10,'main',f.channel.executionSha,'submit',value,f.channel.sentAt);
  return {f,targets,make};
}
it('distinguishes exchanged unit/channel pairs even when both marginal sets are unchanged',()=>{
  const {targets,make}=prepared(),first=make(),swapped=make(targets.map((t:any,i:number)=>({...t,channelId:targets[1-i].channelId})));
  expect(first.operationKey).not.toBe(swapped.operationKey);expect(first.requestKey).not.toBe(swapped.requestKey);
  expect(sameChannelOperation(first,swapped)).toBe(false);
});
it('keeps identity stable under unit, target and object-key reordering',()=>{
  const {f,targets,make}=prepared(),first=make();f.context.cycle.units.reverse();
  const second=make([...targets].reverse().map((t:any)=>({manifestDigest:t.manifestDigest,releaseId:t.releaseId,version:t.version,channelId:t.channelId,unitId:t.unitId})));
  expect(second.requestKey).toBe(first.requestKey);expect(second.inputDigest).toBe(first.inputDigest);
  second.inputs.targets_json=JSON.stringify([...targets].reverse());expect(sameChannelOperation(first,second)).toBe(true);
});
it('includes versions of all frozen units even when only one unit is selected',()=>{
  const {f,targets,make}=prepared(),first=make([targets[0]]);f.context.cycle.units[1].version='2.0.0';
  expect(make([targets[0]]).inputDigest).not.toBe(first.inputDigest);
});
it.each(['version','releaseId','manifestDigest'])('changes channel identity when frozen %s changes',field=>{
  const {f,targets,make}=prepared(),first=make();
  const next=field==='version'?'1.1.0':field==='releaseId'?40:'9'.repeat(64);
  f.context.cycle.units[0][field]=next;targets[0][field]=next;
  expect(make().requestKey).not.toBe(first.requestKey);
});
it.each(['duplicate','missing','version','releaseId','manifestDigest','channelId'])('rejects invalid target %s',kind=>{
  const {f,targets,make}=prepared();
  if(kind==='duplicate')targets.push({...targets[0]});
  else if(kind==='missing')delete targets[0].version;
  else targets[0][kind]=kind==='releaseId'?999:kind==='manifestDigest'?'9'.repeat(64):'other';
  expect(()=>make()).toThrow();
  const raw=structuredClone(f.channel);raw.inputs.targets_json=JSON.stringify(targets);
  expect(()=>nativeRequestIdentity(1,f.context.cycle,raw)).toThrow();
});
it('new build identity covers every unit and does not depend on later Release metadata',()=>{
  const {f}=prepared(),first=prepareBuildDispatch(f.context,10,f.build.sentAt);
  f.context.cycle.units.reverse();f.context.cycle.units[0].releaseId=99;f.context.cycle.units[0].manifestDigest='9'.repeat(64);
  expect(prepareBuildDispatch(f.context,10,f.build.sentAt).requestKey).toBe(first.requestKey);
  expect(first.requestKey).not.toBe(f.build.requestKey);
  expect(JSON.parse(first.targetKey)[0]).toBe(2);
});
it.each(['build','channel'])('verifies archived format 3 %s without rewriting its key, inputs or canonical Run',kind=>{
  const f=fixture(),request=f[kind];request.canonicalRunId=100;request.nativeResponseEvidencePath='evidence/dispatch.json';f.context.cycle.dispatches=[request];
  const before=structuredClone(f.context),verified=validateEvidenceContext(f.context);
  expect(verified).toEqual(before);expect(f.context).toEqual(before);
});
it('selects an old in-flight channel request before creating a new-format request',()=>{
  const f=fixture();f.context.cycle.dispatches=[f.channel];
  const selected=selectChannelDispatch(f.context,[],[]);
  expect(selected).toEqual({kind:'existing',request:f.channel});expect(selected.request?.requestKey).toBe(f.channel.requestKey);
});
it('rejects old operations whose identical key would refer to a different target pairing',()=>{
  const f=fixture(),first=f.channel;first.canonicalRunId=100;first.nativeResponseEvidencePath='evidence/dispatch.json';
  const second=structuredClone(first);second.canonicalRunId=null;second.nativeResponseEvidencePath=null;second.continuationOfRunId=100;second.retryLimitEvidencePath='evidence/limit.json';
  const targets=JSON.parse(second.inputs.targets_json);targets.reverse();const channel=targets[0].channelId;targets[0].channelId=targets[1].channelId;targets[1].channelId=channel;
  second.inputs.targets_json=JSON.stringify(targets);
  // The archived format 3 operation key is preserved; only the continuation request key changes.
  const key=createHash('sha256').update(JSON.stringify([first.operationKey,100])).digest('hex');second.requestKey=key;second.inputs.request_key=key;
  f.context.cycle.dispatches=[first,second];expect(()=>validateEvidenceContext(f.context)).toThrow('legacy request target conflict');
});
it.each(['build','channel'])('recovers a lost response on old format 3 %s using the original key without a second send',async kind=>{
  const f=fixture(),request=f[kind];let cycle=structuredClone(f.context.cycle);cycle.dispatches=[request];
  const observations:NativeDispatchObservation[]=[];let posts=0;
  const run={id:100,repository:{id:1},head_repository:{id:1},workflow_id:10,path:`.github/workflows/steward-release-${kind==='build'?'publish':'channels'}.yml`,event:'workflow_dispatch',
    head_sha:request.executionSha,head_branch:request.ref,actor:{id:42},triggering_actor:{id:42},run_attempt:1,status:'in_progress',conclusion:null,created_at:request.sentAt,updated_at:now,
    display_title:kind==='build'?request.operationKey:request.requestKey};
  const response=(value:any)=>({status:200,headers:new Headers(),bytes:Buffer.from(JSON.stringify(value))});
  const io:EvidenceTransport={async request(method,path){
    if(method==='POST'){posts++;throw Error('lost response');}
    if(path.endsWith('/product'))return response({id:1,full_name:'example/product',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/actions/workflows/10'))return response({id:10,path:run.path,state:'active'});
    if(path.includes('/git/ref/heads/'))return response({ref:`refs/heads/${request.ref}`,object:{type:'commit',sha:request.executionSha}});
    if(path.includes('/actions/workflows/10/runs?'))return response({total_count:1,workflow_runs:[run]});
    if(path.endsWith('/actions/runs/100'))return response(run);
    throw Error('unexpected read '+path);
  }};
  const store:DispatchStore={async save(next,files){cycle=structuredClone(next);for(const file of files)observations.push(decodeNativeDispatchObservation(Buffer.from(file.content)));return {status:'APPLIED',head:'d'.repeat(40)};}};
  expect((await dispatchNativeRun({...f.context,cycle},request.requestKey,store,{complete:true,observations},io,request.sentAt)).status).toBe('UNKNOWN');
  expect(await dispatchNativeRun({...f.context,cycle},request.requestKey,store,{complete:true,observations},io,now)).toMatchObject({status:'BOUND',canonicalRunId:100});
  expect(posts).toBe(1);expect(cycle.dispatches[0].requestKey).toBe(request.requestKey);expect(cycle.dispatches[0].inputs).toEqual(request.inputs);
});
