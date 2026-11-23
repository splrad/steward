import {upstreamPull,bindPull,currentWinget,bindChannelRun,channelJob,reportBinding,verifyIndexItem} from './bounded-winget-evidence.js';
import {type Effects,type RecordState,type Intent,type Outcome} from './bounded-recheck.js';
import {BoundedGitHub,TARGET,CENTRAL,ensure,type BoundedEnv,type GitReader} from './bounded-recheck-github.js';

export async function dispatchFixed(g:GitReader,id:number,file:'steward-release-channels.yml'|'pages-maintenance-event.yml'|'quality-language-summary.yml',sha:string,inputs:Record<string,string>,claim?:()=>Promise<boolean>){
 const name=id===CENTRAL.id?CENTRAL.name:TARGET.name;
 ensure(/^[a-f0-9]{40}$/.test(sha),'OBSERVATION_PIN');
 const workflow=await g.json(id,`/repos/${name}/actions/workflows/${file}`);
 ensure(workflow.path===`.github/workflows/${file}`&&workflow.state==='active','WORKFLOW_PAUSED_OR_DISABLED');
 const ref=await g.json(id,`/repos/${name}/git/ref/heads/main`);ensure(ref.object?.sha===sha,'OBSERVATION_SOURCE_CHANGED');
 await g.prepareDispatch?.(id);
 if(claim&&!await claim())return;
 return g.json(id,`/repos/${name}/actions/workflows/${file}/dispatches`,'POST',{ref:'main',inputs});
}

export class FixedRecheckEffects implements Effects {
 constructor(private env:BoundedEnv,private reader:()=>GitReader=()=>new BoundedGitHub(env)){}
 async observe(r:RecordState):Promise<Outcome>{
  if(this.env.BOUNDED_RECHECK_ENABLED!=='true')return {kind:'stop',reason:'QUIESCED'};
  if(r.identity.stage==='winget-pr')return this.upstream(r);
  if(r.identity.stage!=='winget-index')return {kind:'stop',reason:'CANDIDATE_OBSERVATION_RETIRED'};
  const g=this.reader(),{inputs}=await currentWinget(g,r,this.env);
  const p=await upstreamPull(r.identity.upstreamPR!.number,g);
  bindPull(p,r.identity.version,r.identity.upstreamPR!.nodeId);
  ensure(p.merged===true,'INDEX_REQUIRES_MERGED');
  await dispatchFixed(g,TARGET.id,'steward-release-channels.yml',r.executionSha!,inputs);
  return {kind:'unknown'};
 }
 async confirm(r:RecordState,intent:Intent):Promise<Outcome>{
  if(this.env.BOUNDED_RECHECK_ENABLED!=='true')return {kind:'stop',reason:'QUIESCED'};
  if(r.identity.stage==='winget-pr')return this.upstream(r);
  if(r.identity.stage==='winget-index')return this.index(r,intent);
  return {kind:'stop',reason:'CANDIDATE_OBSERVATION_RETIRED'};
 }
 private async index(r:RecordState,intent:Intent):Promise<Outcome>{
  const g=this.reader(),{cycle,inputs}=await currentWinget(g,r,this.env);const window=encodeURIComponent(new Date(intent.claimedAt-1000).toISOString()+'..'+new Date(intent.claimedAt+30000).toISOString());
  const list=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/workflows/steward-release-channels.yml/runs?event=workflow_dispatch&head_sha=${r.executionSha}&created=${window}&per_page=100`);ensure(Array.isArray(list.workflow_runs)&&list.total_count===list.workflow_runs.length,'INDEX_RUN_WINDOW');
  const hits=list.workflow_runs.filter((x:any)=>x.display_title===`Channels observe ${inputs.request_key}`&&Date.parse(x.created_at)>=Math.floor(intent.claimedAt/1000)*1000);
  if(hits.length!==1)return {kind:'unknown'};const run=await g.json(TARGET.id,`/repos/${TARGET.name}/actions/runs/${hits[0].id}/attempts/1`);bindChannelRun(run,{...this.env,BOUNDED_PRODUCT_SHA:r.executionSha!});ensure(run.id===hits[0].id&&run.run_attempt===1&&run.display_title===`Channels observe ${inputs.request_key}`,'INDEX_RUN_BINDING');
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
