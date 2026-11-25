import {createHash} from 'node:crypto';
import {CENTRAL,TARGET,digest,ensure,type GitReader,type BoundedEnv} from './bounded-recheck-github.js';
import {type Identity,type Registration,type Intent,type RecordState,objectKey} from './bounded-recheck.js';
const sha=(v:any)=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),key=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const APP_BOT_ID=301115370;
const wingetPackage='SPLRAD.LayerScape.Deployer';
function exact(v:any,keys:string){ensure(v&&Object.keys(v).sort().join(',')===keys,'CHANNEL_SCHEMA');}
export function wingetInputs(c:any,executionSha:string){
 ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(c.id)&&sha(c.sourceSha)&&sha(c.controllerSha)&&sha(c.deliveryConfigSha)&&sha(executionSha)&&c.units?.length===1,'CHANNEL_CYCLE');
 const u=c.units[0];ensure(u.id==='layerscape'&&/^[A-Za-z0-9_.-]{1,128}$/.test(u.version)&&Number.isSafeInteger(u.releaseId)&&u.releaseId>0&&key(u.manifestDigest)&&c.requiredChannels?.some((x:any)=>x.unitId===u.id&&x.channelId==='winget'),'CHANNEL_TARGET');
 const targets=[{unitId:u.id,channelId:'winget',version:u.version,releaseId:u.releaseId,manifestDigest:u.manifestDigest}],operationKey=digest(JSON.stringify([1,TARGET.id,c.id,c.sourceSha,c.deliveryConfigSha,targets.map(t=>[t.unitId,t.channelId,t.version,t.releaseId,t.manifestDigest])])).slice(7);
 return {cycle_id:c.id,source_sha:c.sourceSha,execution_sha:executionSha,controller_sha:c.controllerSha,targets_json:JSON.stringify(targets),mode:'observe',operation_key:operationKey,request_key:digest(JSON.stringify(['observe',operationKey,executionSha])).slice(7)};
}
export async function readCycle(g:GitReader,id:string){
 ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(id),'CYCLE_PATH');const target=g.target??TARGET,base=`/repos/${target.name}/`;
 const ref=await g.json(target.id,base+'git/ref/heads/steward/release-state');ensure(ref.ref==='refs/heads/steward/release-state'&&ref.object?.type==='commit'&&sha(ref.object.sha),'CYCLE_REF');
 const cycle=await readReleaseStateDocument(g,`cycles/${id}.json`,ref.object.sha);ensure(cycle.id===id,'CYCLE_ID');
 ensure((await g.json(target.id,base+'git/ref/heads/steward/release-state')).object?.sha===ref.object.sha,'CYCLE_MOVED');return {cycle,commit:ref.object.sha};
}
async function readReleaseStateDocument(g:GitReader,path:string,commit:string){
 return readPinnedDocument(g,g.target??TARGET,path,commit);
}
async function readPinnedDocument(g:GitReader,repository:{id:number;name:string},path:string,commit:string){
 const f=await g.json(repository.id,`/repos/${repository.name}/contents/${path}?ref=${commit}`);
 ensure(f.type==='file'&&f.path===path&&f.encoding==='base64'&&Number.isSafeInteger(f.size)&&f.size<=512*1024,'CYCLE_FILE');
 const bytes=Buffer.from(f.content,'base64');
 ensure(bytes.length===f.size&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===f.sha,'CYCLE_BLOB');
 return JSON.parse(bytes.toString('utf8'));
}
async function verifyWingetRegistration(g:GitReader,controllerSha:string,unitId:string){
 const registry=await readPinnedDocument(g,CENTRAL,'config/release/event-repositories.json',controllerSha);
 ensure(Array.isArray(registry),'CHANNEL_REGISTRY');
 // Both the global package owner and the frozen unit's channel must resolve to the same single row.
 const matches=registry.flatMap(repository=>(repository.externalAdapters??[])
   .filter((adapter:any)=>adapter.channelId==='winget'&&(adapter.location===wingetPackage
     || (repository.id===TARGET.id&&adapter.unitId===unitId)))
   .map((adapter:any)=>({repository,adapter})));
 ensure(matches.length===1,'CHANNEL_WINGET_REGISTRATION');
 const {repository,adapter}=matches[0];
 ensure(repository.id===TARGET.id&&repository.name===TARGET.name&&repository.defaultBranch===TARGET.defaultBranch
   &&adapter.unitId===unitId&&adapter.location===wingetPackage,'CHANNEL_WINGET_REGISTRATION');
}
export async function readOfficialDraftReceipt(g:GitReader,id:string,commit:string){
 ensure(/^pr-[1-9][0-9]*-[0-9a-f]{40}$/.test(id)&&sha(commit),'PUBLICATION_DRAFT_RECEIPT');
 return readReleaseStateDocument(g,`official/draft/${id}.json`,commit);
}
export async function upstreamPull(number:number,g:GitReader){
 ensure(Number.isSafeInteger(number)&&number>0&&g.upstreamPull,'UPSTREAM_READER');const value=await g.upstreamPull(number);ensure(value.number===number&&typeof value.node_id==='string'&&value.base?.repo?.full_name==='microsoft/winget-pkgs'&&value.head?.repo?.full_name==='axiomoth/winget-pkgs'&&typeof value.merged==='boolean'&&['open','closed'].includes(value.state),'UPSTREAM_IDENTITY');return value;
}
export function bindPull(p:any,version:string,nodeId?:string){ensure(p.head?.ref===`steward/${wingetPackage}/${version}`&&(!nodeId||p.node_id===nodeId),'UPSTREAM_PACKAGE');}
export function bindChannelRun(run:any,env:BoundedEnv){ensure(run.repository?.id===TARGET.id&&run.head_repository?.id===TARGET.id&&run.path==='.github/workflows/steward-release-channels.yml'&&run.head_sha===env.BOUNDED_PRODUCT_SHA&&run.event==='workflow_dispatch'&&run.head_branch==='main'&&run.actor?.id===APP_BOT_ID&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0,'CHANNEL_RUN');}
export async function channelJob(g:GitReader,run:any,name:string){const list=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);ensure(Array.isArray(list.jobs)&&list.total_count===list.jobs.length,'CHANNEL_JOBS');const jobs=list.jobs.filter((j:any)=>j.name===name);ensure(jobs.length===1,'CHANNEL_JOB_UNIQUE');return verifiedJob(jobs[0],run);}
function verifiedJob(j:any,run:any){ensure(j.run_id===run.id&&j.run_attempt===run.run_attempt&&j.head_sha===run.head_sha&&j.status==='completed'&&j.conclusion==='success'&&Number.isFinite(Date.parse(j.started_at))&&Number.isFinite(Date.parse(j.completed_at)),'CHANNEL_JOB');return j;}
export function reportBinding(v:any,run:any,c:any,operationKey:string,job:any,createdAt:string|undefined){
 exact(v,'controllerSha,cycleId,executionSha,items,nativeRunId,runAttempt,schemaVersion,sourceSha,targetsDigest');
 ensure(v.schemaVersion===1&&v.cycleId===c.id&&v.sourceSha===c.sourceSha&&v.controllerSha===c.controllerSha&&v.executionSha===run.head_sha&&v.nativeRunId===run.id&&v.runAttempt===run.run_attempt&&v.targetsDigest===operationKey&&Array.isArray(v.items)&&v.items.length===1&&Buffer.byteLength(JSON.stringify(v))<=8192,'CHANNEL_REPORT');
 const created=Date.parse(createdAt??''),start=Date.parse(job.started_at),end=Date.parse(job.completed_at),observed=Date.parse(v.items[0].observedAt);ensure([created,start,end,observed].every(Number.isFinite)&&created>start&&created<=end&&observed>=start&&observed<=end&&observed<=Date.now(),'CHANNEL_TIME');return v.items[0];
}
/** Entry only receives an HMAC-verified fixed product workflow_run; all body facts are reread. */
export async function registerWingetRun(env:BoundedEnv,event:string,payload:any,g:GitReader,readPull=(number:number)=>upstreamPull(number,g)){
 if(env.BOUNDED_RECHECK_ENABLED!=='true'||event!=='workflow_run'||payload.action!=='completed'||payload.repository?.id!==TARGET.id||payload.workflow_run?.path!=='.github/workflows/steward-release-channels.yml')return;
 if(!/^Channels submit [a-f0-9]{64}$/.test(payload.workflow_run.display_title??''))return;
 const id=payload.workflow_run.id,attempt=payload.workflow_run.run_attempt;ensure(Number.isSafeInteger(id)&&id>0&&Number.isSafeInteger(attempt)&&attempt>0,'CHANNEL_EVENT');
 const run=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/runs/${id}/attempts/${attempt}`);
 ensure(sha(env.BOUNDED_PRODUCT_SHA)&&sha(run.head_sha),'CHANNEL_EXECUTION_PIN');
 if(run.head_sha!==env.BOUNDED_PRODUCT_SHA){
  const githubTree=async(commit:string)=>{
   const tree=await g.json(TARGET.id,`/repos/${TARGET.name}/git/trees/${commit}`);
   ensure(tree.truncated===false&&Array.isArray(tree.tree),'CHANNEL_EXECUTION_TREE');
   const paths=tree.tree.filter((entry:any)=>entry.path==='.github'&&entry.type==='tree'&&entry.mode==='040000'&&sha(entry.sha));
   ensure(paths.length===1,'CHANNEL_EXECUTION_TREE');return paths[0].sha;
  };
  ensure(await githubTree(run.head_sha)===await githubTree(env.BOUNDED_PRODUCT_SHA!),'CHANNEL_EXECUTION_CHANGED');
 }
 bindChannelRun(run,{...env,BOUNDED_PRODUCT_SHA:run.head_sha});ensure(run.id===id&&run.run_attempt===attempt&&run.status==='completed','CHANNEL_COMPLETED');
 const match=/^Channels submit ([a-f0-9]{64})$/.exec(run.display_title??'');if(!match)return;
 const jobName='submit/winget/layerscape';
 const jobs=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`);
 ensure(Array.isArray(jobs.jobs)&&jobs.total_count===jobs.jobs.length,'CHANNEL_JOBS');
 const matches=jobs.jobs.filter((j:any)=>j.name===jobName);
 if(matches.length===1&&matches[0].conclusion!=='success')return;
 ensure(matches.length===1,'CHANNEL_JOB_UNIQUE');
 const job=verifiedJob(matches[0],run);
 const a=await g.artifact(TARGET.id,id,`channel-${match[1]}-layerscape-winget-${id}-${attempt}`,'report.json');const {cycle:c}=await readCycle(g,a.value.cycleId);wingetInputs(c,run.head_sha);
 if(c.controllerSha!==env.BOUNDED_CONTROLLER_SHA){
  ensure(sha(c.controllerSha)&&sha(env.BOUNDED_DEPLOYMENT_SHA),'CHANNEL_CONTROLLER');
  const path='config/bounded-recheck.json',f=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/contents/${path}?ref=${c.controllerSha}`);
  ensure(f.path===path&&f.type==='file'&&f.encoding==='base64'&&f.size>0&&f.size<4096,'CHANNEL_POLICY');
  const cfg=JSON.parse(Buffer.from(f.content,'base64').toString('utf8'));
  ensure(cfg.schemaVersion===1&&cfg.enabled===true&&cfg.deploymentSha===(env.RELEASE_RELAY_DEPLOYMENT_SHA??env.BOUNDED_DEPLOYMENT_SHA),'CHANNEL_CONTROLLER');
 }
 const requests=c.dispatches?.filter((x:any)=>x.canonicalRunId===id&&x.requestKey===match[1]&&x.purpose==='channel-submit');ensure(requests?.length===1,'CHANNEL_DISPATCH_PROVENANCE');const request=requests[0];
 ensure(request.executionSha===run.head_sha&&request.workflowId===run.workflow_id&&request.ref==='main'&&request.inputs?.mode==='submit'&&request.inputs.cycle_id===c.id&&request.inputs.source_sha===c.sourceSha&&request.inputs.controller_sha===c.controllerSha&&request.inputs.execution_sha===run.head_sha&&request.inputs.request_key===match[1]&&Date.parse(run.created_at)>=Math.floor(Date.parse(request.sentAt)/1000)*1000,'CHANNEL_DISPATCH_BINDING');
 const targets=JSON.parse(request.inputs.targets_json),u=c.units[0];
 ensure(Array.isArray(targets)&&targets.length>0&&targets.length<=2,'CHANNEL_SUBMIT_TARGETS');
 const channels=new Set<string>();
 for(const t of targets){
  exact(t,'channelId,manifestDigest,releaseId,unitId,version');
  ensure(t.unitId===u.id&&t.releaseId===u.releaseId&&t.manifestDigest===u.manifestDigest&&t.version===u.version
   &&['winget','ghcr-assets'].includes(t.channelId)&&c.requiredChannels.some((r:any)=>r.unitId===u.id&&r.channelId===t.channelId)
   &&!channels.has(t.channelId),'CHANNEL_SUBMIT_TARGETS');
  channels.add(t.channelId);
 }
 ensure(channels.has('winget'),'CHANNEL_SUBMIT_TARGETS');
 const sorted=[...targets].sort((a,b)=>a.channelId.localeCompare(b.channelId));
 const targetsDigest=digest(JSON.stringify([1,TARGET.id,c.id,c.sourceSha,c.deliveryConfigSha,sorted.map(t=>[t.unitId,t.channelId,t.version,t.releaseId,t.manifestDigest])])).slice(7);
 const item=reportBinding(a.value,run,c,targetsDigest,job,a.createdAt);
 exact(item,'accepted,channelId,consumed,digest,indexed,manifestDigest,nativeObjectId,observedAt,releaseId,unitId,version');ensure(item.unitId==='layerscape'&&item.channelId==='winget'&&item.version===u.version&&item.releaseId===u.releaseId&&item.manifestDigest===u.manifestDigest&&item.digest===u.manifestDigest&&typeof item.accepted==='boolean'&&typeof item.indexed==='boolean'&&item.consumed===false&&/^[1-9][0-9]*$/.test(item.nativeObjectId),'CHANNEL_SUBMISSION');
 const pull=await readPull(Number(item.nativeObjectId));bindPull(pull,u.version);const t0=Date.parse(pull.created_at);ensure(Number.isSafeInteger(t0)&&t0<=Date.now(),'UPSTREAM_CREATED');
 const identity:Identity={repositoryId:TARGET.id,cycleId:c.id,channel:'winget',version:u.version,artifactDigest:'sha256:'+u.manifestDigest,sourceSha:c.sourceSha,stage:'winget-pr',epoch:digest(JSON.stringify([TARGET.id,c.id,c.sourceSha,u.version,u.manifestDigest,pull.node_id])).slice(7),upstreamPR:{number:pull.number,nodeId:pull.node_id}};
 const registration:Registration={identity,t0,policySha:c.controllerSha,deploymentSha:env.BOUNDED_DEPLOYMENT_SHA!};ensure(env.BOUNDED_RECHECK,'CHANNEL_NAMESPACE');const stub=env.BOUNDED_RECHECK.get(env.BOUNDED_RECHECK.idFromName('recheck:v1:'+digest(objectKey(identity)).slice(7)));
 const current=await (await stub.fetch(new Request('https://bounded.internal/status',{method:'POST',body:'{}'}))).json() as RecordState|null;
 // A repeated submit event cannot replace the unique index stage or its clock.
 if(current){ensure(objectKey(current.identity)===objectKey(identity),'CHANNEL_OBJECT_CONFLICT');return true;}
 await verifyWingetRegistration(g,c.controllerSha,u.id);
 const result=await stub.fetch(new Request('https://bounded.internal/winget-register',{method:'POST',body:JSON.stringify({registration,executionSha:run.head_sha,anchorSha:env.BOUNDED_PRODUCT_SHA})}));ensure(result.ok,'CHANNEL_REGISTRATION');
 return true;
}
export async function currentWinget(g:GitReader,r:RecordState,env:BoundedEnv){ensure(sha(r.executionSha)&&(r.executionAnchorSha??r.executionSha)===env.BOUNDED_PRODUCT_SHA,'CHANNEL_EXECUTION_PIN');const {cycle}=await readCycle(g,r.identity.cycleId),inputs=wingetInputs(cycle,r.executionSha!);const u=cycle.units[0];ensure(cycle.controllerSha===r.policySha&&cycle.sourceSha===r.identity.sourceSha&&u.version===r.identity.version&&'sha256:'+u.manifestDigest===r.identity.artifactDigest,'CHANNEL_ORIGINAL_IDENTITY');return {cycle,inputs};}
export function verifyIndexItem(item:any,r:RecordState){exact(item,'accepted,channelId,digest,evidenceKind,exists,indexed,observedAt,readStatus,unitId,version');ensure(item.unitId==='layerscape'&&item.channelId==='winget'&&item.version===r.identity.version&&['OK','NOT_FOUND_CONFIRMED','PENDING','AUTH_UNKNOWN','TRANSIENT','CONFLICT'].includes(item.readStatus),'INDEX_ITEM');if(['AUTH_UNKNOWN','TRANSIENT','CONFLICT'].includes(item.readStatus)){ensure([item.exists,item.digest,item.accepted,item.indexed].every(x=>x===null),'INDEX_UNKNOWN');return false;}ensure([item.exists,item.accepted,item.indexed].every(x=>typeof x==='boolean')&&(item.digest===null||/^sha256:[a-f0-9]{64}$/.test(item.digest)),'INDEX_FACTS');if(item.readStatus==='NOT_FOUND_CONFIRMED')ensure(!item.exists&&!item.accepted&&!item.indexed&&item.digest===null,'INDEX_ABSENCE');return item.readStatus==='OK'&&item.exists&&item.accepted&&item.indexed&&item.evidenceKind===`github-pr:${r.identity.upstreamPR!.number}`&&Date.now()-Date.parse(item.observedAt)<=600000;}
