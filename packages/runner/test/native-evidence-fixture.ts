import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { CycleRecord } from '../../core/src/release-observation.js';
import type { NativeResult } from '../../core/src/native-evidence.js';
import { nativeRequestIdentity, type EvidenceContext, type EvidenceResponse, type EvidenceTransport, type EvidenceStore } from '../src/native-release-evidence.js';
export const S='a'.repeat(40), C='b'.repeat(40), D='c'.repeat(40), START='2026-10-26T00:00:00.000Z', END='2026-10-26T00:01:00.000Z', NOW='2026-10-26T00:02:00.000Z';
export const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function zipResult(value:unknown,name='result.json') {
  const data=Buffer.from(JSON.stringify(value)),n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22),crc=crc32(data);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+data.length,16);
  return Buffer.concat([local,n,data,central,n,end]);
}
export function evidenceFixture(attempts=1) {
  const cycle:CycleRecord={id:`pr-12-${S}`,prNumber:12,sourceSha:S,controllerSha:C,deliveryConfigSha:D,units:[{id:'app',version:'1.0.0',tag:'v1.0.0',releaseId:null,assets:[],notesDigest:null,manifestDigest:null}],requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
  const request:CycleRecord['dispatches'][number]={requestKey:'0'.repeat(64),operationKey:'0'.repeat(64),purpose:'build',workflowId:10,ref:`steward/build/${cycle.id}`,sourceSha:S,targetKey:'pending',inputs:{cycle_id:cycle.id,operation_key:'0'.repeat(64),source_sha:S,controller_sha:C},inputDigest:'0'.repeat(64),executionSha:S,sentAt:START,searchWindows:[],canonicalRunId:100,nativeResponseEvidencePath:'evidence/dispatch.json',continuationOfRunId:null,retryLimitEvidencePath:null};
  Object.assign(request,nativeRequestIdentity(1,cycle,request));request.inputs.operation_key=request.operationKey;cycle.dispatches.push(request);
  const context:EvidenceContext={repository:'example/product',repositoryId:1,appBotId:42,cycle};
  const calls:string[]=[],artifacts:any[]=[],downloads=new Map<number,Buffer>(),overrides=new Map<string,EvidenceResponse|(()=>EvidenceResponse)>();
  const runs=new Map<number,any>(),jobs=new Map<number,any[]>(),results=new Map<number,NativeResult>();
  let latest=attempts, logs=true, accepted=false, throwPost=false;
  const workflow=`on: workflow_dispatch\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@${D}\n        with:\n          repository: splrad/steward\n          ref: ${C}\n`;
  const workflowBytes=Buffer.from(workflow),blobSha=createHash('sha1').update(`blob ${workflowBytes.length}\0`).update(workflowBytes).digest('hex');
  const response=(value:unknown,status=200,headers:Record<string,string>={}):EvidenceResponse=>({status,headers:new Headers(headers),bytes:typeof value==='string'?Buffer.from(value):Buffer.from(JSON.stringify(value))});
  for(let attempt=1;attempt<=attempts;attempt++) {
    const start=new Date(Date.parse(START)+(attempt-1)*1000).toISOString(),end=new Date(Date.parse(END)+(attempt-1)*1000).toISOString();
    runs.set(attempt,{id:100,repository:{id:1},head_repository:{id:1},workflow_id:10,path:'.github/workflows/steward-release-publish.yml',event:'workflow_dispatch',head_sha:S,head_branch:request.ref,actor:{id:42},triggering_actor:{id:42},run_attempt:attempt,status:'completed',conclusion:'failure',created_at:START,updated_at:END,display_title:`Build ${request.operationKey}`});
    jobs.set(attempt,[{id:attempt*1000,run_id:100,run_attempt:attempt,head_sha:S,name:'build',status:'completed',conclusion:'failure',started_at:start,completed_at:end,steps:[{number:2,name:'business-build',started_at:start,completed_at:end,conclusion:'failure'}]}]);
    const execution={repositoryId:1,cycleId:cycle.id,workflowId:10,runId:100,runAttempt:attempt,entry:'build' as const,jobId:attempt*1000,unitId:'app',channelId:null,inputDigest:request.inputDigest,
      invocationKey:digest(JSON.stringify([1,cycle.id,10,100,attempt,'build',attempt*1000,2,'app',null,request.inputDigest])),startedAt:start,businessStartedProven:true,nativeEvidencePath:'evidence/native.json',outcome:'BUSINESS_FAILED' as const,completedAt:end,objectEvidencePaths:[],observedAt:end};
    results.set(attempt,{schemaVersion:1,sourceSha:S,executionSha:S,stepNumber:2,reasonCode:'RESULT',execution,objects:[]});
  }
  const io:EvidenceTransport={anonymous:()=>io,async request(method,path) {
    calls.push(`${method} ${path}`);
    const override=overrides.get(`${method} ${path}`);if(override)return typeof override==='function'?override():override;
    if(path==='/repos/example/product/')return response({message:'Not Found'},404);
    const suffix=path==='/repos/example/product'?'':path.replace('/repos/example/product/','');
    if(method==='POST') {
      if(accepted) {latest++;runs.set(latest,{...runs.get(latest-1),run_attempt:latest,status:'queued',conclusion:null});}
      if(throwPost)throw new Error('secret-shaped transport failure');return response('',201);
    }
    if(suffix==='')return response({id:1,full_name:context.repository,private:false,default_branch:'main',archived:false,disabled:false});
    if(suffix==='actions/runs/100')return response(runs.get(latest));
    if(suffix==='actions/workflows/10')return response({id:10,path:runs.get(1).path});
    if(suffix.startsWith('contents/'))return response({type:'file',encoding:'base64',content:workflowBytes.toString('base64'),size:workflowBytes.length,sha:blobSha});
    if(suffix==='actions/runs/100/artifacts?per_page=100')return response({total_count:artifacts.length,artifacts});
    let match=/^actions\/runs\/100\/attempts\/(\d+)(\/jobs\?per_page=100)?$/.exec(suffix);
    if(match){const n=Number(match[1]);return match[2]?response({total_count:jobs.get(n)!.length,jobs:jobs.get(n)}):response(runs.get(n));}
    match=/^actions\/jobs\/(\d+)\/logs$/.exec(suffix);
    if(match) {if(!logs)return response({},410);const n=Number(match[1])/1000,result=results.get(n)!;
      const start=structuredClone(result);start.execution.outcome=null;start.execution.completedAt=null;
      return response(`${result.execution.startedAt} BUSINESS_STARTED ${JSON.stringify(start)}\n${result.execution.completedAt} STEWARD_RESULT ${JSON.stringify(result)}\n`);}
    match=/^actions\/artifacts\/(\d+)(\/zip)?$/.exec(suffix);
    if(match){const id=Number(match[1]),item=artifacts.find(a=>a.id===id);if(!item)return response({},404);return match[2]?{status:200,headers:new Headers(),bytes:downloads.get(id)!}:response(item);}
    throw new Error('Unexpected fixture endpoint: '+suffix);
  }};
  const saved:string[]=[],store:EvidenceStore={async archive(files){saved.push(...files.map(f=>f.path));calls.push('ARCHIVE_READBACK');return {status:'APPLIED',head:D,records:files.filter(file=>file.path.startsWith('evidence/native/')).map(file=>({path:file.path,commit:D,value:JSON.parse(file.content)}))};}};
  function artifact(attempt=1,value:unknown=results.get(attempt),name?:string) {
    const id=700+artifacts.length,bytes=zipResult(value);downloads.set(id,bytes);
    artifacts.push({id,name:name??`steward-result-100-${attempt}-${attempt*1000}-2`,expired:false,workflow_run:{id:100,head_sha:S},digest:`sha256:${digest(bytes)}`,size_in_bytes:bytes.length,created_at:results.get(attempt)!.execution.completedAt,expires_at:'2026-12-01T00:00:00Z'});return id;
  }
  return {context,request,io,store,calls,saved,runs,jobs,results,artifacts,downloads,overrides,response,artifact,setLogs:(value:boolean)=>{logs=value;},setAccepted:(value=true)=>{accepted=value;},setThrowPost:()=>{throwPost=true;}};
}
