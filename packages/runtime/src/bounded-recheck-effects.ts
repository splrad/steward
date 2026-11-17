import {verifyGeneratedProjection} from './bounded-candidate-projection.js';
import {exactManual,verifyManualProjection} from './bounded-manual-evidence.js';
import {upstreamPull,bindPull,currentWinget,bindChannelRun,channelJob,reportBinding,verifyIndexItem,APP_BOT_ID} from './bounded-winget-evidence.js';
import {identityKey,type Effects,type RecordState,type Intent,type Outcome} from './bounded-recheck.js';
import {BoundedGitHub,TARGET,CENTRAL,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';
import {candidateFacts} from './bounded-candidate-evidence.js';
export async function dispatchFixed(g:GitReader,id:number,file:'release-observe.yml'|'bounded-release-event.yml'|'release-candidate-event.yml'|'steward-release-channels.yml',sha:string,inputs:Record<string,string>){
 const name=id===CENTRAL.id?CENTRAL.name:TARGET.name;
 ensure(/^[a-f0-9]{40}$/.test(sha),'OBSERVATION_PIN');
 const workflow=await g.json(id,`/repos/${name}/actions/workflows/${file}`);
 ensure(workflow.path===`.github/workflows/${file}`&&workflow.state==='active','WORKFLOW_PAUSED_OR_DISABLED');
 const ref=await g.json(id,`/repos/${name}/git/ref/heads/main`);ensure(ref.object?.sha===sha,'OBSERVATION_SOURCE_CHANGED');
 return g.json(id,`/repos/${name}/actions/workflows/${file}/dispatches`,'POST',{ref:'main',inputs});
}
export class FixedRecheckEffects implements Effects {
 constructor(private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env)){}
 async observe(r:RecordState,intent:Intent):Promise<Outcome>{
  if(this.env.BOUNDED_RECHECK_ENABLED!=='true')return {kind:'stop',reason:'QUIESCED'};
  const g=this.reader();
  if(r.identity.stage==='winget-pr')return this.upstream(r);
  if(r.identity.stage==='winget-index'){const {inputs}=await currentWinget(g,r,this.env);const p=await upstreamPull(r.identity.upstreamPR!.number,g);bindPull(p,r.identity.version,r.identity.upstreamPR!.nodeId);ensure(p.merged===true,'INDEX_REQUIRES_MERGED');await dispatchFixed(g,TARGET.id,'steward-release-channels.yml',this.env.BOUNDED_PRODUCT_SHA!,inputs);return {kind:'unknown'};}
  const facts=await candidateFacts(g);if(identityKey(facts.identity)!==identityKey(r.identity))return {kind:'stop',reason:'SOURCE_CHANGED'};
  ensure(Array.isArray(facts.pull.labels),'CANDIDATE_LABELS_UNKNOWN');if(facts.pull.state!=='open'||facts.pull.merged)return {kind:'stop',reason:'CANDIDATE_CLOSED'};if(facts.pull.labels.some((l:any)=>l.name==='release:editing'))return {kind:'pause',reason:'EDITING_PAUSED'};
  await dispatchFixed(g,CENTRAL.id,'release-observe.yml',r.policySha,{identity_json:JSON.stringify(r.identity),request_key:intent.key,policy_sha:r.policySha});
  return {kind:'unknown'}; // Accepted dispatch is not observation completion.
 }
 async confirm(r:RecordState,intent:Intent):Promise<Outcome>{
  if(this.env.BOUNDED_RECHECK_ENABLED!=='true')return {kind:'stop',reason:'QUIESCED'};
  if(r.identity.stage==='winget-pr')return this.upstream(r);
  if(r.identity.stage==='winget-index')return this.index(r,intent);
  const g=this.reader();const list=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/workflows/release-observe.yml/runs?event=workflow_dispatch&head_sha=${r.policySha}&created=${encodeURIComponent(new Date(intent.claimedAt-30_000).toISOString()+'..'+new Date(intent.claimedAt+30_000).toISOString())}&per_page=100`);
  ensure(Array.isArray(list.workflow_runs)&&list.total_count===list.workflow_runs.length,'RUN_WINDOW_INCOMPLETE');
  const hits=list.workflow_runs.filter((x:any)=>x.repository?.id===CENTRAL.id&&x.head_repository?.id===CENTRAL.id&&x.path==='.github/workflows/release-observe.yml'&&x.head_sha===r.policySha&&x.event==='workflow_dispatch'&&x.display_title===`Observe candidate ${intent.key}`);
  if(hits.length!==1)return {kind:'unknown'};const run=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/runs/${hits[0].id}`);
  ensure(run.id===hits[0].id&&run.run_attempt===1&&run.repository?.id===CENTRAL.id&&run.head_repository?.id===CENTRAL.id&&run.head_sha===r.policySha&&run.path==='.github/workflows/release-observe.yml'&&run.event==='workflow_dispatch'&&run.actor?.id===APP_BOT_ID&&run.head_branch==='main'&&run.display_title===`Observe candidate ${intent.key}`,'RUN_BINDING');
  if(run.status!=='completed')return {kind:'unknown',runId:run.id};if(run.conclusion!=='success')return {kind:'stop',reason:'OBSERVATION_RUN_FAILED'};
  const a=await g.artifact(CENTRAL.id,run.id,`candidate-observation-${intent.key}`,'result.json'),v=a.value;
  exactManual(v,'controllerSha,identity,observedAt,outcome,projectionEvidence,reason,repositoryId,requestKey,runAttempt,runId,schemaVersion,sourceSha,stateAfter,stateBefore,status');
  exactManual(v.identity,'artifactDigest,channel,cycleId,epoch,repositoryId,sourceSha,stage,upstreamPR,version');exactManual(v.stateBefore,'documentDigest,head,path,prNumber,stateCommit');exactManual(v.stateAfter,'documentDigest,head,path,prNumber,stateCommit');
  ensure(v.schemaVersion===1&&v.requestKey===intent.key&&identityKey(v.identity)===identityKey(r.identity)&&v.runId===run.id&&v.runAttempt===run.run_attempt&&v.repositoryId===CENTRAL.id&&v.controllerSha===r.policySha,'OBSERVATION_ARTIFACT_IDENTITY');
  const facts=await candidateFacts(g);if(identityKey(facts.identity)!==identityKey(r.identity))return {kind:'stop',reason:'SOURCE_CHANGED'};
  ensure(Array.isArray(facts.pull.labels),'CANDIDATE_LABELS_UNKNOWN');if(facts.pull.state!=='open'||facts.pull.merged)return {kind:'stop',reason:'CANDIDATE_CLOSED'};if(facts.pull.labels.some((l:any)=>l.name==='release:editing'))return {kind:'pause',reason:'EDITING_PAUSED'};
  const observed=Date.parse(v.observedAt),start=Date.parse(run.run_started_at),end=Date.parse(run.updated_at),created=Date.parse(a.createdAt??'');
  ensure([observed,start,end,created].every(Number.isFinite)&&observed>=start&&observed<=end&&created>=start&&created<=end&&v.sourceSha===r.identity.sourceSha,'OBSERVATION_TIME');
  ensure(v.stateBefore&&v.stateAfter&&Object.entries(facts.evidence).every(([k,x])=>v.stateAfter[k]===x)&&v.stateBefore.head===v.stateAfter.head,'OBSERVATION_GIT_EVIDENCE');
  if(facts.manual&&v.outcome==='done'){ensure(v.status==='READY'&&v.reason==='MANUAL_PROJECTION','MANUAL_OBSERVATION_RESULT');const finalPull=await verifyManualProjection(g,facts,v.projectionEvidence);if(finalPull.state!=='open'||finalPull.merged)return {kind:'stop',reason:'CANDIDATE_CLOSED'};if(finalPull.labels.some((l:any)=>l.name==='release:editing'))return {kind:'pause',reason:'EDITING_PAUSED'};return {kind:'done',evidence:JSON.stringify({runId:run.id,attempt:run.run_attempt,artifactId:a.artifactId,digest:a.digest,projectionEvidence:v.projectionEvidence,state:v.stateAfter})};}
  if(v.outcome==='paused'&&v.reason==='EDITING')return {kind:'pause',reason:'EDITING_PAUSED'};
  if(v.outcome==='done'&&v.reason==='CACHED_OBSERVATION'&&v.status==='READY'){const finalPull=await verifyGeneratedProjection(g,facts,v.projectionEvidence);if(finalPull.state!=='open'||finalPull.merged)return {kind:'stop',reason:'CANDIDATE_CLOSED'};if(finalPull.labels.some((l:any)=>l.name==='release:editing'))return {kind:'pause',reason:'EDITING_PAUSED'};return {kind:'done',evidence:JSON.stringify({runId:run.id,attempt:run.run_attempt,artifactId:a.artifactId,digest:a.digest,reason:v.reason,projectionEvidence:v.projectionEvidence,state:v.stateAfter})};}
  return {kind:'stop',reason:v.outcome==='source_changed'?'SOURCE_CHANGED':'OBSERVATION_NEEDS_ATTENTION'};
 }
 private async index(r:RecordState,intent:Intent):Promise<Outcome>{
  const g=this.reader(),{cycle,inputs}=await currentWinget(g,r,this.env);const window=encodeURIComponent(new Date(intent.claimedAt-1000).toISOString()+'..'+new Date(intent.claimedAt+30000).toISOString());
  const list=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/workflows/steward-release-channels.yml/runs?event=workflow_dispatch&head_sha=${this.env.BOUNDED_PRODUCT_SHA}&created=${window}&per_page=100`);ensure(Array.isArray(list.workflow_runs)&&list.total_count===list.workflow_runs.length,'INDEX_RUN_WINDOW');
  const hits=list.workflow_runs.filter((x:any)=>x.display_title===`Channels observe ${inputs.request_key}`&&Date.parse(x.created_at)>=Math.floor(intent.claimedAt/1000)*1000);
  if(hits.length!==1)return {kind:'unknown'};const run=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/runs/${hits[0].id}/attempts/1`);bindChannelRun(run,this.env);ensure(run.id===hits[0].id&&run.run_attempt===1&&run.display_title===`Channels observe ${inputs.request_key}`,'INDEX_RUN_BINDING');
  if(run.status!=='completed')return {kind:'unknown',runId:run.id};if(run.conclusion!=='success')return {kind:'stop',reason:'INDEX_OBSERVATION_FAILED'};
  const job=await channelJob(g,run,'observe');ensure(Date.parse(job.completed_at)-Date.parse(job.started_at)<=5*60000,'INDEX_QUERY_TIMEOUT');
  const a=await g.artifact(TARGET.id,run.id,`probe-${cycle.id}-${inputs.operation_key}-${run.id}-${run.run_attempt}`,'report.json'),item=reportBinding(a.value,run,cycle,inputs.operation_key,job,a.createdAt);
  const pull=await upstreamPull(r.identity.upstreamPR!.number,g);bindPull(pull,r.identity.version,r.identity.upstreamPR!.nodeId);ensure(pull.merged===true&&Date.parse(pull.merged_at)===r.t0,'INDEX_MERGE_BINDING');
  if(verifyIndexItem(item,r))return {kind:'done',evidence:JSON.stringify({runId:run.id,attempt:run.run_attempt,artifactId:a.artifactId,digest:a.digest,upstreamPR:r.identity.upstreamPR,observedAt:item.observedAt})};
  return ['AUTH_UNKNOWN','TRANSIENT','CONFLICT'].includes(item.readStatus)?{kind:'stop',reason:'INDEX_FACT_UNKNOWN'}:{kind:'pending'};
 }
 private async upstream(r:RecordState):Promise<Outcome>{
  ensure(r.identity.upstreamPR,'UPSTREAM_IDENTITY');const p=r.identity.upstreamPR;
  const g=this.reader();await currentWinget(g,r,this.env);const v=await upstreamPull(p.number,g);bindPull(v,r.identity.version,p.nodeId);
  if(v.merged){ensure(Number.isFinite(Date.parse(v.merged_at)),'UPSTREAM_MERGE_TIME');return {kind:'index',mergedAt:Date.parse(v.merged_at),evidence:JSON.stringify({number:p.number,nodeId:p.nodeId,mergedAt:v.merged_at})};}
  return v.state==='closed'?{kind:'stop',reason:'UPSTREAM_CLOSED'}:{kind:'pending'};
 }
}
